import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { PlansStore } from "../../daemon/store/store.js";
import { PlansWatcher } from "../../daemon/watch/watch.js";
import { resolveWorkspace, teHome } from "../../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../../daemon/server/server.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import { SessionRegistry } from "../../daemon/sessions/sessions.js";
import { EventBus } from "../../daemon/api/events.js";
import { registerApiRoutes } from "../../daemon/api/api.js";
import { verifyCmd } from "./verify.js";

/**
 * `te verify` (GL-0357): runs an item's ## Checks under bash in the claim
 * worktree of each repo — prints pass / not passed / timeout per check with
 * the repo HEAD commit, masks secret values, exits 1 on any failure, and
 * prints one line + exits 0 on an item with no checks.
 */

let home: string;
let root: string;
let plans: string;
let repo: string;
let globRepo: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let watcher: PlansWatcher;

const item = (id: string, extra = "", body = "") =>
  `---\nid: ${id}\ntype: task\ntitle: ${id}\nstatus: ready\nversion: 1\n${extra}---\n\n${body}## Summary\n${id}\n`;

const checksItem = (id: string, checks: Record<string, unknown>[]) =>
  item(
    id,
    'targets: ["@code:src/a.ts"]\n',
    `**Touches:** code: src/a.ts\n## Checks\n${YAML.stringify(checks)}`,
  );

async function capture(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    return { code: await fn(), text: lines.join("\n") };
  } finally {
    console.log = origLog;
  }
}


beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-verify-"));
  root = join(home, "ws");
  plans = join(root, ".teamengage");
  repo = join(home, "repo");
  globRepo = join(home, "codebank", "myrepo");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(globRepo, { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    `name: ws\nprefix: WS\nresources:\n  code: { kind: git, path: ${JSON.stringify(repo)} }\nrepos: ["../repo", "../codebank/*"]\n`,
  );
  for (const [cwd, a] of [
    [plans, ["init", "-b", "main"]],
    [plans, ["config", "user.email", "t@t"]],
    [plans, ["config", "user.name", "t"]],
    [repo, ["init", "-b", "main"]],
    [repo, ["config", "user.email", "t@t"]],
    [repo, ["config", "user.name", "t"]],
    [globRepo, ["init", "-b", "main"]],
    [globRepo, ["config", "user.email", "t@t"]],
    [globRepo, ["config", "user.name", "t"]],
  ] as const) {
    execFileSync("git", [...a], { cwd });
  }
  writeFileSync(join(repo, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  writeFileSync(join(globRepo, "b.txt"), "two\n");
  execFileSync("git", ["add", "-A"], { cwd: globRepo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: globRepo });

  writeFileSync(join(plans, "items", "WS", "WS-0001.md"), item("WS-0001"));
  writeFileSync(
    join(plans, "items", "WS", "WS-0002.md"),
    checksItem("WS-0002", [{ name: "hello", repo: "code", run: "echo hi" }]),
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0003.md"),
    checksItem("WS-0003", [
      { name: "boom", repo: "code", run: "echo bad; exit 1" },
      { name: "slow", repo: "code", run: "sleep 30", timeout: 1 },
    ]),
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0004.md"),
    checksItem("WS-0004", [{ name: "leak", repo: "code", run: "echo $TE_TEST_SECRET" }]),
  );
  // DE-0244: repo names may come from `repos:` entries, not only resources —
  // WS-0005 uses a path entry (../repo → basename repo), WS-0006 a glob dir
  writeFileSync(
    join(plans, "items", "WS", "WS-0005.md"),
    checksItem("WS-0005", [{ name: "viapath", repo: "repo", run: "cat a.txt" }]),
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0006.md"),
    checksItem("WS-0006", [{ name: "viaglob", repo: "myrepo", run: "cat b.txt" }]),
  );
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
}, 30_000);

afterAll(async () => {
  await watcher.close();
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("te verify", () => {
  it("an item with no checks prints one line and exits 0", async () => {
    const { code, text } = await capture(() => verifyCmd(["WS-0001"], home));
    expect(code).toBe(0);
    expect(text.trim()).toBe("WS-0001: no checks");
  });

  it("a passing check prints pass and the repo commit id", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const { code, text } = await capture(() => verifyCmd(["WS-0002"], home));
    expect(code).toBe(0);
    expect(text).toContain("hello: passed (exit 0)");
    expect(text).toContain(`@${head.slice(0, 10)}`);
    expect(text).toContain("1/1 checks passed");
  });

  it("a check that exits 1 prints not passed and verify exits 1; a slow check is killed and prints timeout", async () => {
    const { code, text } = await capture(() => verifyCmd(["WS-0003"], home));
    expect(code).toBe(1);
    expect(text).toContain("boom: not passed (exit 1, want 0)");
    expect(text).toContain("slow: timeout");
    expect(text).toContain("0/2 checks passed");
  }, 15_000);

  it("a check repo resolves through a repos: path entry and a repos: glob (DE-0244)", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const globHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: globRepo }).toString().trim();
    const viaPath = await capture(() => verifyCmd(["WS-0005"], home));
    expect(viaPath.code).toBe(0);
    expect(viaPath.text).toContain(`viapath: passed (exit 0) @${head.slice(0, 10)}`);
    const viaGlob = await capture(() => verifyCmd(["WS-0006"], home));
    expect(viaGlob.code).toBe(0);
    expect(viaGlob.text).toContain(`viaglob: passed (exit 0) @${globHead.slice(0, 10)}`);
  });

  it("secret-looking env values are masked in check output", async () => {
    process.env.TE_TEST_SECRET = "s3cr3t-value-99";
    try {
      const { code, text } = await capture(() => verifyCmd(["WS-0004", "--json"], home));
      expect(code).toBe(0);
      const data = JSON.parse(text);
      expect(data.results[0].output).toContain("***");
      expect(data.results[0].output).not.toContain("s3cr3t-value-99");
      expect(text).not.toContain("s3cr3t-value-99");
    } finally {
      delete process.env.TE_TEST_SECRET;
    }
  });

  it("a claimed item's checks run in the claim worktree, not the base repo", async () => {
    const { WorkspaceOps } = await import("../../daemon/api/ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    await ops.claim("WS-0002", ctx.sessions.hello("verify-test"));
    const wt = join(plans, "worktrees", "WS-0002", "code");
    const { code, text } = await capture(() => verifyCmd(["WS-0002", "--json"], home));
    expect(code).toBe(0);
    const data = JSON.parse(text);
    expect(data.results[0].dir).toBe(wt);
    // the worktree is a real git worktree — its HEAD is the branch commit
    expect(data.results[0].commit).toBeTruthy();
  });
});

describe("verify results land on the item (GL-0358)", () => {
  it("te verify writes one verified line per check in ## Evidence with the commit id", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const { code } = await capture(() => verifyCmd(["WS-0002"], home));
    expect(code).toBe(0);
    // the watcher needs a beat to reindex — the file itself is written sync
    const text = readFileSync(join(plans, "items", "WS", "WS-0002.md"), "utf8");
    expect(text).toContain(`- verified: hello — passed (exit 0) @${head.slice(0, 10)}`);
  });

  it("a result for a check name the item does not have is refused with INVALID", async () => {
    const { port, token } = JSON.parse(readFileSync(join(teHome(home), "daemon.json"), "utf8"));
    const res = await fetch(`http://127.0.0.1:${port}/api/items/WS-0002/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ check: "nope", exit_code: 0, passed: true }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("INVALID");
  });

  it("the item API returns each result with passed, commit and time", async () => {
    const { port, token } = JSON.parse(readFileSync(join(teHome(home), "daemon.json"), "utf8"));
    const res = await fetch(`http://127.0.0.1:${port}/api/items/WS-0002`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const b = await res.json();
    const r = b.verify.find((x: { check: string }) => x.check === "hello");
    expect(r.passed).toBe(true);
    expect(r.commit).toBeTruthy();
    expect(r.at).toBeTruthy();
  });

  it("the stored output tail keeps only the last 50 lines", async () => {
    const { port, token } = JSON.parse(readFileSync(join(teHome(home), "daemon.json"), "utf8"));
    const tail = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const res = await fetch(`http://127.0.0.1:${port}/api/items/WS-0002/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ check: "hello", exit_code: 0, passed: true, output_tail: tail }),
    });
    expect(res.status).toBeLessThan(300);
    const stored = (await res.json()).output_tail as string;
    expect(stored.split("\n")).toHaveLength(50);
    expect(stored.startsWith("line 11")).toBe(true);
  });
});
