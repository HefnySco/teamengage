import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { fireNotify, notifyKind, gateWait } from "./notify.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { PlansStore } from "../store/store.js";
import { SessionRegistry } from "../sessions/sessions.js";
import type { LoadedWorkspace } from "../../core/config/config.js";
import type { Event } from "../../core/model/event.js";
import type { ItemMeta } from "../../core/model/item.js";
import type { Job } from "../../core/ops/job.js";

/**
 * GL-0327 — notify: rules alert the human on decision events: command gets
 * the JSON on stdin, url gets one POST, a failed rule is logged not fatal,
 * and with no notify key nothing runs.
 */

const ws = (notify: unknown[] = []): LoadedWorkspace =>
  ({ config: { name: "t", notify } }) as unknown as LoadedWorkspace;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("fireNotify", () => {
  it("a command rule runs once with the JSON on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "te-notify-"));
    const out = join(dir, "out.json");
    await fireNotify(ws([{ on: "question", command: `cat > ${out}` }]), "question", {
      event: { item: "WS-0001", action: "ask" },
    });
    const got = JSON.parse(readFileSync(out, "utf8"));
    expect(got.on).toBe("question");
    expect(got.event.item).toBe("WS-0001");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a url rule gets one POST with the JSON body", async () => {
    const hits: string[] = [];
    const srv: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        hits.push(Buffer.concat(chunks).toString());
        res.end("ok");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    await fireNotify(
      ws([{ on: "needs_human", url: `http://127.0.0.1:${port}/hook` }]),
      "needs_human",
      {
        event: { item: "WS-0002", action: "review" },
      },
    );
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]).event.item).toBe("WS-0002");
    srv.close();
  });

  it("a command that exits 1 does not throw and the daemon continues", async () => {
    await expect(
      fireNotify(ws([{ on: "question", command: "exit 1" }]), "question", { event: {} }),
    ).resolves.toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "te-notify-"));
    const out = join(dir, "ok.json");
    // a later rule still runs after the failure
    await fireNotify(
      ws([
        { on: "question", command: "exit 1" },
        { on: "question", command: `cat > ${out}` },
      ]),
      "question",
      { event: { item: "WS-0003" } },
    );
    expect(existsSync(out)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("with no notify key nothing runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "te-notify-"));
    const out = join(dir, "never.json");
    await fireNotify(ws([]), "question", { event: { item: "X" } });
    await fireNotify(ws([{ on: "max_attempts", command: `cat > ${out}` }]), "question", {
      event: { item: "X" },
    });
    await sleep(50);
    expect(existsSync(out)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("notifyKind", () => {
  const ev = (action: string, to = "in_progress"): Event => ({ action, to }) as unknown as Event;
  it("ask → question; flag_drop → needs_human; review with needs_human → needs_human", () => {
    expect(notifyKind(ev("ask"), undefined, 5)).toBe("question");
    expect(notifyKind(ev("flag_drop"), undefined, 5)).toBe("needs_human");
    expect(
      notifyKind(ev("review", "in_review"), { ai_review: { needs_human: true } } as ItemMeta, 5),
    ).toBe("needs_human");
    expect(notifyKind(ev("review", "in_review"), { ai_review: {} } as ItemMeta, 5)).toBeUndefined();
  });
  it("a hold at max attempts → max_attempts; a plain hold and routine events → none", () => {
    expect(notifyKind(ev("bounce", "hold"), { attempts: 5 } as ItemMeta, 5)).toBe("max_attempts");
    expect(notifyKind(ev("hold", "hold"), { attempts: 1 } as ItemMeta, 5)).toBeUndefined();
    expect(notifyKind(ev("log"), undefined, 5)).toBeUndefined();
    expect(notifyKind(ev("claim"), undefined, 5)).toBeUndefined();
  });
});

describe("gateWait", () => {
  const job = (status: string, cursor = 1): Job =>
    ({ status, cursor, steps: [{ id: "s1" }, { id: "s2" }] }) as unknown as Job;
  const pb = {
    steps: [
      { id: "s1", kind: "cmd" },
      { id: "s2", kind: "gate", instruction: "approve to deploy" },
    ],
  } as never;
  it("a waiting job on a gate step names it; agent/cmd waits and running jobs do not", () => {
    expect(gateWait(job("waiting"), pb)).toEqual({ step: "s2", instruction: "approve to deploy" });
    expect(gateWait(job("running"), pb)).toBeUndefined();
    expect(gateWait(job("waiting", 0), pb)).toBeUndefined();
  });
});

describe("end to end: an ask fires the command once with the item id", () => {
  let home: string;
  let out: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "te-notify-e2e-"));
    const root = join(home, "ws");
    const plans = join(root, ".teamengage");
    mkdirSync(join(plans, "items", "WS"), { recursive: true });
    out = join(home, "asked.json");
    writeFileSync(
      join(plans, "workspace.yaml"),
      `name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: ., worktree: false }\nnotify:\n  - { on: question, command: "cat > ${out}" }\n`,
    );
    writeFileSync(
      join(plans, "items", "WS", "WS-0001.md"),
      `---\nid: WS-0001\ntype: task\ntitle: t\nstatus: ready\nversion: 1\ntargets: ["@self:src/f.ts"]\n---\n\n## Summary\nx\n`,
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: plans });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
    execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
    execFileSync("git", ["add", "-A"], { cwd: plans });
    execFileSync("git", ["commit", "-m", "init"], { cwd: plans });
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("claim → ask → the command file holds the item id once", async () => {
    const loaded = resolveWorkspace(join(home, "ws"), { home });
    const store = new PlansStore(loaded, "test");
    await store.init();
    // same wiring as daemon main.ts
    store.onEvent = (ev, meta) => {
      const kind = notifyKind(ev, meta, loaded.config.max_attempts);
      if (kind) void fireNotify(loaded, kind, { event: ev });
    };
    const sessions = new SessionRegistry("test");
    const wsr = { ws: loaded, store } as never;
    const { WorkspaceOps } = await import("../api/ops.js");
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const session = sessions.hello("asker");
    await ops.claim("WS-0001", session);
    await ops.ask("WS-0001", session, "which way?");
    await sleep(100);
    expect(existsSync(out)).toBe(true);
    const got = JSON.parse(readFileSync(out, "utf8"));
    expect(got.event.item).toBe("WS-0001");
    expect(got.event.action).toBe("ask");
  });
});
