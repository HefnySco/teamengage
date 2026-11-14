import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { PlansStore } from "../store/store.js";
import { PlansWatcher } from "../watch/watch.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../server/server.js";
import type { DaemonCtx } from "../server/context.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { EventBus } from "./events.js";
import { registerApiRoutes } from "./api.js";
import { WorkspaceOps } from "./ops.js";

/**
 * GL-0349: submit on an item with checks needs a passed verify result per
 * check at the current HEAD of its repo — missing, failed or stale results
 * refuse the submit and name the check. `unverified_reason` is the escape:
 * the reason lands in ## Evidence and the ok review becomes needs_human.
 */

let home: string;
let plans: string;
let repo: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let watcher: PlansWatcher;
let ops: WorkspaceOps;

const item = (id: string, extra = "", body = "") =>
  `---\nid: ${id}\ntype: task\ntitle: ${id}\nstatus: ready\nversion: 1\n${extra}---\n\n${body}## Summary\n${id}\n`;

const checksItem = (id: string, checks: Record<string, unknown>[]) =>
  item(
    id,
    `targets: ["@code:src/${id.toLowerCase()}.ts"]\n`,
    `**Touches:** code: src/${id.toLowerCase()}.ts\n## Checks\n${YAML.stringify(checks)}`,
  );

const wt = (id: string) => join(plans, "worktrees", id, "code");
const head = (dir: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
const newCommit = (dir: string) => {
  appendFileSync(join(dir, "a.txt"), `${Date.now()}\n`);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "more"], { cwd: dir });
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-gate-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  repo = join(home, "repo");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    `name: ws\nprefix: WS\nresources:\n  code: { kind: git, path: ${JSON.stringify(repo)} }\n`,
  );
  for (const [cwd, a] of [
    [plans, ["init", "-b", "main"]],
    [plans, ["config", "user.email", "t@t"]],
    [plans, ["config", "user.name", "t"]],
    [repo, ["init", "-b", "main"]],
    [repo, ["config", "user.email", "t@t"]],
    [repo, ["config", "user.name", "t"]],
  ] as const) {
    execFileSync("git", [...a], { cwd });
  }
  writeFileSync(join(repo, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

  const mk = (id: string, run: string) => checksItem(id, [{ name: `chk-${id}`, repo: "code", run }]);
  writeFileSync(join(plans, "items", "WS", "WS-0001.md"), item("WS-0001"));
  writeFileSync(join(plans, "items", "WS", "WS-0010.md"), item("WS-0010"));
  for (const id of ["WS-0005", "WS-0006", "WS-0007", "WS-0008", "WS-0009", "WS-0011"]) {
    writeFileSync(join(plans, "items", "WS", `${id}.md`), mk(id, "true"));
  }
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  watcher = new PlansWatcher(store, { debounceMs: 50 });
  ctx = {
    home,
    machine: "test",
    workspaces: new Map([["ws", { ws, store, watcher }]]),
    sessions: new SessionRegistry("test"),
    bus: new EventBus(),
  };
  await watcher.start();
  daemon = await startDaemon({ home, register: (app) => registerApiRoutes(app, ctx) });
  ops = new WorkspaceOps(ctx.workspaces.get("ws")!, ctx.sessions);
}, 30_000);

afterAll(async () => {
  await watcher.close();
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

const holder = (name: string) => ctx.sessions.hello(name);

describe("submit checks gate (GL-0349)", () => {
  it("an item with no checks submits as before", async () => {
    const s = holder("gate-a");
    await ops.claim("WS-0001", s);
    await ops.submit("WS-0001", s, { notes: "done", what: "the gate works", how: "ran the checks and posted the results" });
    expect(ops.item("WS-0001").meta.status).toBe("in_review");
  });

  it("a check with no result refuses the submit and names the check", async () => {
    const s = holder("gate-b");
    await ops.claim("WS-0005", s);
    await expect(ops.submit("WS-0005", s, { what: "x", how: "y" })).rejects.toThrow(/chk-WS-0005.*no verify result/);
    expect(ops.item("WS-0005").meta.status).toBe("in_progress");
  });

  it("a passed result at the current HEAD lets the submit through", async () => {
    const s = holder("gate-c");
    await ops.claim("WS-0007", s);
    await ops.verifyResult("WS-0007", { check: "chk-WS-0007", exit_code: 0, passed: true, commit: head(wt("WS-0007")) }, s);
    await ops.submit("WS-0007", s, { notes: "done", what: "the gate works", how: "ran the checks and posted the results" });
    expect(ops.item("WS-0007").meta.status).toBe("in_review");
  });

  it("a new commit after the verify makes the old result stale and submit is refused", async () => {
    const s = holder("gate-d");
    await ops.claim("WS-0006", s);
    await ops.verifyResult("WS-0006", { check: "chk-WS-0006", exit_code: 0, passed: true, commit: head(wt("WS-0006")) }, s);
    newCommit(wt("WS-0006"));
    await expect(ops.submit("WS-0006", s, { what: "x", how: "y" })).rejects.toThrow(/chk-WS-0006.*stale/);
    expect(ops.item("WS-0006").meta.status).toBe("in_progress");
  });

  it("a failed result refuses; unverified_reason submits, lands in Evidence, and the ok review is needs_human", async () => {
    const s = holder("gate-e");
    await ops.claim("WS-0008", s);
    await ops.verifyResult("WS-0008", { check: "chk-WS-0008", exit_code: 1, passed: false, commit: head(wt("WS-0008")) }, s);
    await expect(ops.submit("WS-0008", s, { what: "x", how: "y" })).rejects.toThrow(/chk-WS-0008.*did not pass/);
    await ops.submit("WS-0008", s, { notes: "done", what: "the gate works", how: "posted results", unverified_reason: "no runner on this box" });
    const it = ops.item("WS-0008");
    expect(it.meta.status).toBe("in_review");
    expect(it.meta.unverified_reason).toBe("no runner on this box");
    const text = (await import("node:fs")).readFileSync(join(plans, "items", "WS", "WS-0008.md"), "utf8");
    expect(text).toContain("- unverified: no runner on this box");
    // the ok review is needs_human → never auto-accepted
    const reviewer = holder("gate-review");
    await ops.review("WS-0008", reviewer, "ok", "looks fine");
    const rv = ops.item("WS-0008").meta.ai_review;
    expect(rv?.verdict).toBe("ok");
    expect(rv?.needs_human).toBe(true);
    expect(ops.autoAcceptAt(ops.item("WS-0008"))).toBeUndefined();
  });
});

describe("verified badge + require_verified (GL-0350)", () => {
  const wsr = () => ctx.workspaces.get("ws")!;

  it("an item with all checks passed shows the badge; a require_verified rule accepts it after its delay", async () => {
    const s = holder("badge-h");
    const reviewer = holder("badge-r");
    await ops.claim("WS-0009", s);
    await ops.verifyResult("WS-0009", { check: "chk-WS-0009", exit_code: 0, passed: true, commit: head(wt("WS-0009")) }, s);
    await ops.submit("WS-0009", s, { notes: "done", what: "badge", how: "verify" });
    await ops.review("WS-0009", reviewer, "ok");

    const brief = await ops.brief("WS-0009");
    expect(brief.verified?.ok).toBe(true);
    const listed = (await (
      await fetch(`${daemon.url}/api/items?status=in_review&ws=ws`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      })
    ).json()) as Array<{ id: string; verified?: boolean }>;
    expect(listed.find((i) => i.id === "WS-0009")?.verified).toBe(true);

    const cfg = wsr().ws.config;
    cfg.autonomy = "solo";
    cfg.auto_accept_after = "30m";
    cfg.auto_accept_rules = [{ require_verified: true, after: "5m" }];
    try {
      const it = ops.index.get("WS-0009")!;
      const at = ops.autoAcceptAt(it)!;
      expect(at).toBeTruthy();
      expect((await ops.brief("WS-0009")).autoAcceptRule).toContain("rule #1");
      const rv = Date.parse(it.meta.ai_review!.reviewed_at);
      expect(ops.autoAcceptDue(rv + 4 * 60_000)).not.toContain("WS-0009");
      expect(ops.autoAcceptDue(rv + 6 * 60_000)).toContain("WS-0009");
    } finally {
      cfg.autonomy = "strict";
      cfg.auto_accept_rules = [];
    }
  });

  it("a require_verified rule does not accept an item with no checks", async () => {
    const s = holder("badge-n");
    const reviewer = holder("badge-r2");
    await ops.claim("WS-0010", s);
    await ops.submit("WS-0010", s, { notes: "done", what: "no checks", how: "plain submit" });
    await ops.review("WS-0010", reviewer, "ok");
    expect(ops.verifiedBadge(ops.index.get("WS-0010")!).ok).toBe(false);

    const cfg = wsr().ws.config;
    cfg.autonomy = "solo";
    cfg.auto_accept_rules = [{ require_verified: true, after: "1m" }];
    try {
      const it = ops.index.get("WS-0010")!;
      expect(ops.autoAcceptAt(it)).toBeUndefined();
      const rv = Date.parse(it.meta.ai_review!.reviewed_at);
      expect(ops.autoAcceptDue(rv + 60 * 60_000)).not.toContain("WS-0010");
      expect((await ops.brief("WS-0010")).autoAcceptRule).toContain("waits for verified");
    } finally {
      cfg.autonomy = "strict";
      cfg.auto_accept_rules = [];
    }
  });

  it("a second te verify by a reviewer stores a second result with the reviewer name", async () => {
    const s = holder("badge-v");
    const reviewer = holder("badge-vr");
    await ops.claim("WS-0011", s);
    await ops.verifyResult("WS-0011", { check: "chk-WS-0011", exit_code: 0, passed: true, commit: head(wt("WS-0011")) }, s);
    await ops.submit("WS-0011", s, { notes: "done", what: "two results", how: "verify" });
    await ops.verifyResult("WS-0011", { check: "chk-WS-0011", exit_code: 0, passed: true, commit: head(wt("WS-0011")) }, reviewer);

    const results = ops.verifyOf(ops.index.get("WS-0011")!);
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.actor)).size).toBe(2);
  });
});
