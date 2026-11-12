import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { startDaemon, type DaemonHandle } from "../server/server.js";
import { registerUiRoutes } from "./ui.js";
import { registerApiRoutes } from "./api.js";
import { PlansStore } from "../store/store.js";
import { PlansWatcher } from "../watch/watch.js";
import { resolveWorkspace } from "../../core/config/config.js";
import type { DaemonCtx } from "../server/context.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { EventBus } from "./events.js";

let home: string;
let daemon: DaemonHandle;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-ui-"));
  daemon = await startDaemon({ home, register: (app) => registerUiRoutes(app) });
});

afterAll(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("UI serving (UI-0001)", () => {
  it("/ui serves index.html with token auth", async () => {
    const res = await fetch(`${daemon.url}/ui?token=${daemon.token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("TeamEngage");
    expect(html).toContain("/assets/app.js");
    expect(html).toMatch(/v\d+\.\d+\.\d+/); // __TE_VERSION__ replaced
  });

  it("cookie token authenticates API + assets", async () => {
    const res = await fetch(`${daemon.url}/assets/app.js`, {
      headers: { cookie: `te_token=${daemon.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("rejects without token; blocks traversal", async () => {
    expect((await fetch(`${daemon.url}/ui`)).status).toBe(401);
    const t = await fetch(`${daemon.url}/assets/..%2Fapp.js?token=${daemon.token}`);
    expect(t.status).toBe(404);
  });
});

// the Ops pages read /api/ops/* under the same te_token cookie as every
// other UI call — prove the ops routes answer that auth shape (GL-0276)
describe("ops UI API (GL-0276)", () => {
  let home2: string;
  let daemon2: DaemonHandle;
  let watcher: PlansWatcher;
  const cookie = () => ({ cookie: `te_token=${daemon2.token}` });

  beforeAll(async () => {
    home2 = mkdtempSync(join(tmpdir(), "te-ui-ops-"));
    const root = join(home2, "ws");
    const plans = join(root, ".teamengage");
    mkdirSync(join(plans, "items", "WS"), { recursive: true });
    writeFileSync(join(plans, "workspace.yaml"), "name: ws\nprefix: WS\ntargets:\n  stage: { title: staging }\n");
    mkdirSync(join(root, "ops"), { recursive: true });
    writeFileSync(
      join(root, "ops", "demo.playbook.yaml"),
      YAML.stringify({ name: "demo", target: "stage", steps: [{ id: "a", kind: "cmd", run: "true" }] }),
    );
    for (const a of [
      ["init", "-b", "main"],
      ["config", "user.email", "t@t"],
      ["config", "user.name", "t"],
      ["add", "-A"],
      ["commit", "-m", "init"],
    ]) {
      execFileSync("git", a, { cwd: plans });
    }
    const ws = resolveWorkspace(root, { home: home2 });
    const store = new PlansStore(ws, "test");
    await store.init();
    watcher = new PlansWatcher(store, { debounceMs: 50 });
    const ctx: DaemonCtx = {
      home: home2,
      machine: "test",
      workspaces: new Map([["ws", { ws, store, watcher }]]),
      sessions: new SessionRegistry("test"),
      bus: new EventBus(),
    };
    await watcher.start();
    daemon2 = await startDaemon({ home: home2, register: (app) => { registerUiRoutes(app); registerApiRoutes(app, ctx); } });
  }, 30_000);

  afterAll(async () => {
    await watcher.close();
    await daemon2.close();
    rmSync(home2, { recursive: true, force: true });
  });

  it("/api/ops/* answer the cookie auth the UI uses", async () => {
    const pbs = await fetch(`${daemon2.url}/api/ops/playbooks`, { headers: cookie() });
    expect(pbs.status).toBe(200);
    expect((await pbs.json())[0].playbook.name).toBe("demo");
    const tgts = await fetch(`${daemon2.url}/api/ops/targets`, { headers: cookie() });
    expect((await tgts.json()).stage.title).toBe("staging");
    const jobs = await fetch(`${daemon2.url}/api/ops/jobs`, { headers: cookie() });
    expect(jobs.status).toBe(200);
    expect(await jobs.json()).toEqual([]);
    // no token → the same 401 the UI banner catches
    expect((await fetch(`${daemon2.url}/api/ops/jobs`)).status).toBe(401);
  });

  it("job list filters and job detail serve the ops page", async () => {
    const start = await fetch(`${daemon2.url}/api/ops/start`, {
      method: "POST",
      headers: { ...cookie(), "content-type": "application/json" },
      body: JSON.stringify({ playbook: "demo" }),
    });
    expect(start.status).toBe(200);
    const job = await start.json();
    const filtered = await fetch(`${daemon2.url}/api/ops/jobs?playbook=demo&status=running&machine=test`, { headers: cookie() });
    const list = await filtered.json();
    expect(list.map((j: { id: string }) => j.id)).toContain(job.id);
    const detail = await fetch(`${daemon2.url}/api/ops/job/${job.id}`, { headers: cookie() });
    const j = await detail.json();
    expect(j.steps[0].id).toBe("a");
    expect(j.playbook_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
