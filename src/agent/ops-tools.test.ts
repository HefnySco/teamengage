import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { PlansStore } from "../daemon/store/store.js";
import { PlansWatcher } from "../daemon/watch/watch.js";
import { resolveWorkspace } from "../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../daemon/server/server.js";
import type { DaemonCtx } from "../daemon/server/context.js";
import { SessionRegistry } from "../daemon/sessions/sessions.js";
import { EventBus } from "../daemon/api/events.js";
import { registerAgentRoutes, SESSION_HEADER } from "./http.js";

/**
 * Ops over the plain-HTTP agent API (GL-0271): the protocol text lists the
 * ops calls, the start policy refuses agent sessions, ops_step keeps strict
 * order, and gate steps stay human-only.
 */

let home: string;
let plans: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let watcher: PlansWatcher;

const url = (p: string) => `${daemon.url}${p}`;

async function call(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(url(path), {
    method,
    headers: { ...(opts.token ? { [SESSION_HEADER]: opts.token } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, text: await res.text() };
}

async function hello(agent: string, tier?: string): Promise<string> {
  const r = await call("POST", "/agent/hello", { body: { agent, tier } });
  expect(r.status).toBe(200);
  return /^token (\S+)/.exec(r.text)![1];
}

const humanPb = {
  name: "human-deploy",
  start: "human",
  target: "cloud",
  steps: [{ id: "one", kind: "cmd", run: "x" }],
};
const agentPb = {
  name: "agent-deploy",
  start: "agent",
  min_tier: "standard",
  target: "cloud",
  steps: [
    { id: "one", kind: "cmd", run: "x" },
    { id: "two", kind: "cmd", run: "y" },
  ],
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-agent-ops-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\ntargets:\n  cloud: { title: test target }\n",
  );
  mkdirSync(join(root, "ops"), { recursive: true });
  writeFileSync(join(root, "ops", "human-deploy.playbook.yaml"), YAML.stringify(humanPb));
  writeFileSync(join(root, "ops", "agent-deploy.playbook.yaml"), YAML.stringify(agentPb));
  for (const a of [
    ["init", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "-m", "init"],
  ]) {
    execFileSync("git", a, { cwd: plans });
  }
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
  daemon = await startDaemon({ home, register: (app) => registerAgentRoutes(app, ctx) });
}, 30_000);

afterAll(async () => {
  await watcher.close();
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("ops agent protocol", () => {
  it("the served protocol text lists the ops calls", async () => {
    const r = await call("GET", "/agent");
    expect(r.status).toBe(200);
    for (const t of ["ops_playbooks", "ops_targets", "ops_start", "ops_jobs", "ops_job", "ops_step", "ops_skip", "ops_approve", "ops_abort", "ops_resume"]) {
      expect(r.text).toContain(t);
    }
    expect(r.text).toContain("OPS — playbooks and jobs");
  });

  it("an agent session gets a refusal on ops_start of a start:human playbook", async () => {
    const token = await hello("ops-tester", "heavy");
    const r = await call("POST", "/agent/ops_start", { token, body: { playbook: "human-deploy" } });
    expect(r.status).toBe(403);
    expect(r.text).toContain("ERROR FORBIDDEN");
    expect(r.text).toContain("start: human");
  });

  it("an agent session gets a refusal on ops_approve", async () => {
    const token = await hello("ops-approver");
    const r = await call("POST", "/agent/ops_approve/whatever-0001", { token, body: { step: "gate" } });
    expect(r.status).toBe(403);
    expect(r.text).toContain("ERROR FORBIDDEN");
    expect(r.text).toContain("human-only");
  });

  it("a light-tier session is refused on a min_tier:standard playbook", async () => {
    const token = await hello("ops-light", "light");
    const r = await call("POST", "/agent/ops_start", { token, body: { playbook: "agent-deploy" } });
    expect(r.status).toBe(403);
    expect(r.text).toContain("standard");
  });

  it("start → strict order → succeed; ops_step out of order is ERROR OPS_ORDER", async () => {
    const token = await hello("ops-runner", "heavy");
    // playbooks list works without any job
    expect((await call("GET", "/agent/ops_playbooks", { token })).text).toContain("agent-deploy");

    const st = await call("POST", "/agent/ops_start", { token, body: { playbook: "agent-deploy" } });
    expect(st.status).toBe(200);
    const id = /started (\S+) /.exec(st.text)![1];

    // out of order: 'two' is not at the cursor
    const wrong = await call("POST", `/agent/ops_step/${id}`, { token, body: { step: "two", exit_code: 0 } });
    expect(wrong.status).toBe(409);
    expect(wrong.text).toContain("ERROR OPS_ORDER");

    // in order: one, then two → succeeded
    const s1 = await call("POST", `/agent/ops_step/${id}`, { token, body: { step: "one", exit_code: 0, output: "built" } });
    expect(s1.status).toBe(200);
    const s2 = await call("POST", `/agent/ops_step/${id}`, { token, body: { step: "two", exit_code: 0 } });
    expect(s2.status).toBe(200);
    expect(s2.text).toContain("succeeded");

    // the target lock was released — a new job may start
    const again = await call("POST", "/agent/ops_start", { token, body: { playbook: "agent-deploy" } });
    expect(again.status).toBe(200);
    const id2 = /started (\S+) /.exec(again.text)![1];
    expect(id2).not.toBe(id);
    // second job is live → its target is locked: a third start is busy
    const busy = await call("POST", "/agent/ops_start", { token, body: { playbook: "agent-deploy" } });
    expect(busy.status).toBe(409);
    expect(busy.text).toContain("OPS_TARGET_BUSY");

    // abort the live job — the lock frees
    const ab = await call("POST", `/agent/ops_abort/${id2}`, { token, body: {} });
    expect(ab.status).toBe(200);
    expect(ab.text).toContain("aborted");

    // job reads
    expect((await call("GET", `/agent/ops_job/${id}`, { token })).text).toContain("succeeded");
    expect((await call("GET", "/agent/ops_jobs", { token })).text).toContain(id);
  });
});
