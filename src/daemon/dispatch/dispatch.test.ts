import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Dispatcher } from "./dispatch.js";
import { resolveWorkspace, type LoadedWorkspace } from "../../core/config/config.js";
import { PlansStore } from "../store/store.js";
import { SessionRegistry } from "../sessions/sessions.js";
import type { WorkspaceRuntime } from "../server/context.js";

/**
 * GL-0328 — the daemon starts a role's command when work for it exists and
 * live sessions are under max_sessions; 3 failures in a row switch it off.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let home: string;
let sessions: SessionRegistry;
const events: Array<{ kind: string; data: Record<string, unknown> }> = [];

async function makeWs(config: string): Promise<WorkspaceRuntime> {
  const root = join(home, `ws-${Math.random().toString(36).slice(2, 7)}`);
  const plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    `name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: ., worktree: false }\n${config}`,
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0001.md"),
    `---\nid: WS-0001\ntype: task\ntitle: t\nstatus: ready\nversion: 1\n---\n\n## Summary\nx\n`,
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });
  const ws: LoadedWorkspace = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  return { ws, store };
}

const dispatcher = (wsr: WorkspaceRuntime) =>
  new Dispatcher(wsr, sessions, home, (kind, data) => events.push({ kind, data }));

const untilEvent = async (kind: string, n: number, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (events.filter((e) => e.kind === kind).length < n && Date.now() < deadline) {
    await sleep(50);
  }
};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "te-dispatch-"));
  sessions = new SessionRegistry("test");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("Dispatcher (GL-0328)", () => {
  it("dispatch on + one ready item starts the coder command once", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_sessions: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    const d = dispatcher(wsr);
    d.tick();
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(1);
    expect(events[0].data.role).toBe("coder");
    expect(d.status().running).toEqual(["coder"]);
  });

  it("no start when live sessions reach max_sessions", async () => {
    events.length = 0;
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_sessions: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    sessions.hello("someone"); // 1 live session = at the cap
    dispatcher(wsr).tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(0);
    // free the seat — the next workspace's dispatcher may start again
    for (const s of sessions.list()) sessions.disconnect(s.id);
  });

  it("a command that fails 3 times in a row turns dispatch off and writes an event", async () => {
    events.length = 0;
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_sessions: 2\n  agents:\n    - { role: coder, command: "exit 1" }\n`,
    );
    const d = dispatcher(wsr);
    for (let i = 0; i < 3; i++) {
      d.tick();
      await untilEvent("dispatch_fail", i + 1);
    }
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(3);
    const off = events.find((e) => e.kind === "dispatch_off");
    expect(off?.data.reason).toContain("3 times");
    expect(d.isEnabled()).toBe(false);
    // off now — a further tick starts nothing even though work exists
    const n = events.filter((e) => e.kind === "dispatch_start").length;
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(n);
  });

  it("with dispatch unset the daemon starts nothing", async () => {
    events.length = 0;
    const wsr = await makeWs("");
    dispatcher(wsr).tick();
    expect(events).toHaveLength(0);
  });

  it("disabled dispatch starts nothing even with agents configured", async () => {
    events.length = 0;
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  max_sessions: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    dispatcher(wsr).tick();
    expect(events).toHaveLength(0);
  });
});
