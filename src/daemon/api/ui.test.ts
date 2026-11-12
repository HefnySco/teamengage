import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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
    writeFileSync(
      join(plans, "workspace.yaml"),
      `name: ws\nprefix: WS\ntargets:\n  stage: { title: staging, service: auth, env: staging, probe: 'echo v1.0.0', machine: box, app: myapp }\n  slow: { title: slow, service: auth, env: prod, probe: 'sleep 5', probe_timeout_ms: 200 }\n  unprobed: { title: no probe, service: auth, env: dev }\n  panel: { machine: box, app: sideapp, probe: 'touch ${home2}/probe-ran' }\n`,
    );
    mkdirSync(join(root, "ops"), { recursive: true });
    mkdirSync(join(root, "machines"), { recursive: true });
    mkdirSync(join(root, "envs"), { recursive: true });
    const doc = (fm: Record<string, unknown>, body = "") => `---\n${YAML.stringify(fm)}---\n${body}`;
    writeFileSync(join(root, "machines", "lap.machine.md"), doc({ id: "lap", host: hostname(), tier: "dev", roles: ["runner"], rules: ["never cut over by hand"] }, "the laptop\n"));
    writeFileSync(join(root, "machines", "box.machine.md"), doc({ id: "box", host: "box.local", tier: "prod", ssh: { user: "pi", key: "~/.ssh/box" }, apps: [{ name: "myapp", port: 8080, env: "prod" }, { name: "sideapp", port: 8081 }] }));
    writeFileSync(
      join(root, "envs", "work.env.md"),
      doc({
        id: "work",
        network: ["MHEFNY4G"],
        machines: [{ id: "lap", row: 0 }, { id: "box", row: 1 }],
        reach: [
          { from: "lap", to: "box", via: "ssh" },
          { from: "box", to: "lap", via: "ssh" },
        ],
      }),
    );
    writeFileSync(
      join(root, "ops", "demo.playbook.yaml"),
      YAML.stringify({ name: "demo", target: "stage", version_from: "a", steps: [{ id: "a", kind: "cmd", run: "true" }] }),
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

  // GL-0278: the target probe is the one command the daemon runs — human-only,
  // 30 s ceiling (probe_timeout_ms shrinks it for the test), result stored
  // machine-local under <home>/ops-probes/
  it("POST /api/ops/probe runs the target probe and stores the result machine-local", async () => {
    const r = await fetch(`${daemon2.url}/api/ops/probe/stage`, { method: "POST", headers: cookie() });
    expect(r.status).toBe(200);
    const probe = await r.json();
    expect(probe.ok).toBe(true);
    expect(probe.version).toBe("v1.0.0");
    expect(probe.by).toBe("human");
    // stored under the daemon home — machine-local, not in the plans dir
    expect(JSON.parse(readFileSync(join(home2, ".teamengage", "ops-probes", "stage.json"), "utf8")).version).toBe("v1.0.0");
    const list = await fetch(`${daemon2.url}/api/ops/probes`, { headers: cookie() });
    expect((await list.json()).stage.version).toBe("v1.0.0");
  });

  it("a probe over the timeout is killed and marked timeout", async () => {
    const r = await fetch(`${daemon2.url}/api/ops/probe/slow`, { method: "POST", headers: cookie() });
    expect(r.status).toBe(200);
    const probe = await r.json();
    expect(probe.timeout).toBe(true);
    expect(probe.ok).toBe(false);
  });

  it("an agent session cannot start a probe through the UI API", async () => {
    // a session identity on the human route refuses
    const withSession = await fetch(`${daemon2.url}/api/ops/probe/stage`, {
      method: "POST",
      headers: { ...cookie(), "x-te-session": "agent-session-1" },
    });
    expect(withSession.status).toBe(403);
    // a session token is not the daemon token — the auth hook refuses it
    const bearer = await fetch(`${daemon2.url}/api/ops/probe/stage`, {
      method: "POST",
      headers: { authorization: "Bearer agent-session-1" },
    });
    expect(bearer.status).toBe(401);
    // a target without a probe command, and an unknown target, refuse cleanly
    expect((await fetch(`${daemon2.url}/api/ops/probe/unprobed`, { method: "POST", headers: cookie() })).status).toBe(400);
    expect((await fetch(`${daemon2.url}/api/ops/probe/nosuch`, { method: "POST", headers: cookie() })).status).toBe(404);
  });

  it("a probe that prints a different version than the ledger gives the drift condition", async () => {
    // the earlier test left a running job holding the stage lock — abort it
    for (const j of await (await fetch(`${daemon2.url}/api/ops/jobs?status=running`, { headers: cookie() })).json()) {
      await fetch(`${daemon2.url}/api/ops/abort/${j.id}`, { method: "POST", headers: cookie() });
    }
    // finish a demo job with version v2.0.0 — the ledger value for target stage
    const start = await fetch(`${daemon2.url}/api/ops/start`, {
      method: "POST",
      headers: { ...cookie(), "content-type": "application/json" },
      body: JSON.stringify({ playbook: "demo" }),
    });
    expect(start.status).toBe(200);
    const job = await start.json();
    const step = await fetch(`${daemon2.url}/api/ops/step/${job.id}`, {
      method: "POST",
      headers: { ...cookie(), "content-type": "application/json" },
      body: JSON.stringify({ step: "a", exit_code: 0, output: "v2.0.0\n" }),
    });
    expect((await step.json()).version).toBe("v2.0.0");
    const probe = await (await fetch(`${daemon2.url}/api/ops/probe/stage`, { method: "POST", headers: cookie() })).json();
    expect(probe.version).toBe("v1.0.0");
    // the matrix's drift rule: stored probe version ≠ ledger version
    expect(probe.version).not.toBe("v2.0.0");
  });

  // GL-0289: the machines API serves the GL-0286 files; env probes are
  // human-only like target probes and answer not_expected on the wrong wifi
  it("/api/ops/machines and /api/ops/envs serve the fixture data", async () => {
    const ms = await (await fetch(`${daemon2.url}/api/ops/machines`, { headers: cookie() })).json();
    expect(ms.runner).toBe("lap");
    expect(ms.machines.map((m: { id: string }) => m.id).sort()).toEqual(["box", "lap"]);
    const box = await (await fetch(`${daemon2.url}/api/ops/machines/box`, { headers: cookie() })).json();
    expect(box.host).toBe("box.local");
    const envs = await (await fetch(`${daemon2.url}/api/ops/envs`, { headers: cookie() })).json();
    expect(envs.envs[0].id).toBe("work");
    const env = await (await fetch(`${daemon2.url}/api/ops/envs/work`, { headers: cookie() })).json();
    expect(env.machines.map((p: { id: string }) => p.id).sort()).toEqual(["box", "lap"]);
    expect(env.machines.find((p: { id: string }) => p.id === "box").machine.host).toBe("box.local");
    expect(env.reach[0]).toMatchObject({ from: "lap", to: "box", via: "ssh" });
    expect(Array.isArray(env.probes)).toBe(true);
  });

  // GL-0305: the deployed join — apps × targets × last succeeded job ×
  // stored probe, computed by TeamEngage; reading it runs no probe
  it("GET machines/<id> and envs/<id> return deployed — last job + stored probe, no probe runs", async () => {
    const box = await (await fetch(`${daemon2.url}/api/ops/machines/box`, { headers: cookie() })).json();
    const myapp = box.deployed.find((a: { name: string }) => a.name === "myapp");
    // the earlier test left job v2.0.0 succeeded and probe v1.0.0 on stage — drift
    expect(myapp.state).toBe("drift");
    expect(myapp.targets[0].drift).toBe(true);
    expect(myapp.targets[0].job).toMatchObject({ version: "v2.0.0", machine: "test" });
    expect(myapp.targets[0].job.finished).toBeTruthy();
    expect(myapp.targets[0].probe).toMatchObject({ version: "v1.0.0", ok: true });
    const sideapp = box.deployed.find((a: { name: string }) => a.name === "sideapp");
    expect(sideapp.state).toBe("unknown"); // target 'panel' has no job and no stored probe
    const lap = await (await fetch(`${daemon2.url}/api/ops/machines/lap`, { headers: cookie() })).json();
    expect(lap.deployed).toEqual([]); // lap has no apps
    const env = await (await fetch(`${daemon2.url}/api/ops/envs/work`, { headers: cookie() })).json();
    const ebox = env.machines.find((p: { id: string }) => p.id === "box").machine;
    expect(ebox.deployed.find((a: { name: string }) => a.name === "myapp").state).toBe("drift");
    // reading the panel ran no probe: the 'panel' probe's sentinel file does not exist
    expect(existsSync(join(home2, "probe-ran"))).toBe(false);
    expect(existsSync(join(home2, ".teamengage", "ops-probes", "panel.json"))).toBe(false);
  });

  it("POST /api/ops/envs/:id/probe is human-only; the wrong wifi answers not_expected without ssh", async () => {
    // an agent session identity refuses — same rule as target probes
    const withSession = await fetch(`${daemon2.url}/api/ops/envs/work/probe`, {
      method: "POST",
      headers: { ...cookie(), "x-te-session": "agent-session-1" },
    });
    expect(withSession.status).toBe(403);
    // the fixture env names MHEFNY4G — this machine is not on it, so no command runs
    const r = await fetch(`${daemon2.url}/api/ops/envs/work/probe`, { method: "POST", headers: cookie() });
    expect(r.status).toBe(200);
    const results = await r.json();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ env: "work", from: "lap", to: "box", via: "ssh", status: "not_expected", reason: "needs network MHEFNY4G", output: "" });
    // GL-0301: the box→lap edge does not run from this machine — not_probed, nothing executed
    expect(results[1]).toMatchObject({ env: "work", from: "box", to: "lap", via: "ssh", status: "not_probed", output: "" });
    expect(results[1].reason).toContain("not probed from here");
    // stored machine-local under <home>/ops-probes/reach/
    const stored = JSON.parse(readFileSync(join(home2, ".teamengage", "ops-probes", "reach", "work.json"), "utf8"));
    expect(stored[0].status).toBe("not_expected");
    expect(stored[1].status).toBe("not_probed");
    const env = await (await fetch(`${daemon2.url}/api/ops/envs/work`, { headers: cookie() })).json();
    expect(env.probes[0].reason).toBe("needs network MHEFNY4G");
    expect(env.probes[1].status).toBe("not_probed");
    expect((await fetch(`${daemon2.url}/api/ops/envs/ghost/probe`, { method: "POST", headers: cookie() })).status).toBe(404);
  });

  // GL-0297: a human note keeps the words in the file and opens one ready
  // task that touches only that file; a playbook note never changes the
  // playbook YAML (its sha256 stays) and is a key task (no auto-accept)
  const note = (path: string, text: string, headers: Record<string, string> = {}) =>
    fetch(`${daemon2.url}${path}`, {
      method: "POST",
      headers: { ...cookie(), "content-type": "application/json", ...headers },
      body: JSON.stringify({ text }),
    });
  const item = async (id: string) =>
    ((await (await fetch(`${daemon2.url}/api/items`, { headers: cookie() })).json()) as Array<Record<string, unknown>>).find((i) => i.id === id);

  it("POST /api/ops/machines/:id/notes appends a pending note and opens one ready task on that file", async () => {
    const r = await note("/api/ops/machines/box/notes", "box holds the IMX500 camera on /dev/video0\nnever unplug it while de_camera runs");
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out.file).toBe("machines/box.machine.md");
    const text = readFileSync(join(home2, "ws", "machines", "box.machine.md"), "utf8");
    expect(text).toContain("## Human notes");
    expect(text).toContain(`### note ${out.ts} · pending · ${out.item}`);
    expect(text).toContain("never unplug it while de_camera runs");
    const it = await item(out.item);
    expect(it?.status).toBe("ready");
    expect(it?.title).toBe("Apply note to machine box"); // the task text itself: noteTaskDraft in notes.test.ts
    const box = await (await fetch(`${daemon2.url}/api/ops/machines/box`, { headers: cookie() })).json();
    expect(box.human_notes).toHaveLength(1);
    expect(box.human_notes[0]).toMatchObject({ ts: out.ts, state: "pending", item: out.item });
    expect(box.notes).not.toContain("Human notes");
    const listed = await (await fetch(`${daemon2.url}/api/ops/machines/box/notes`, { headers: cookie() })).json();
    expect(listed[0].text).toContain("IMX500");
  });

  it("POST /api/ops/playbooks/:id/notes writes ops/<name>.notes.md and leaves the playbook sha256 as it was", async () => {
    const before = await (await fetch(`${daemon2.url}/api/ops/playbooks`, { headers: cookie() })).json();
    const sha = before.find((l: { playbook?: { name: string } }) => l.playbook?.name === "demo").sha256;
    const r = await note("/api/ops/playbooks/demo/notes", "add a check step that the remote disk has 1 GB free");
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out.file).toBe("ops/demo.notes.md");
    expect(readFileSync(join(home2, "ws", "ops", "demo.notes.md"), "utf8")).toContain(`### note ${out.ts} · pending · ${out.item}`);
    const after = await (await fetch(`${daemon2.url}/api/ops/playbooks`, { headers: cookie() })).json();
    expect(after.find((l: { playbook?: { name: string } }) => l.playbook?.name === "demo").sha256).toBe(sha);
    const it = await item(out.item);
    expect(it?.status).toBe("ready");
    expect(it?.unblocks_on).toBe("done");
  });

  it("note endpoints are human-only, need text, and 404 on an unknown machine or playbook", async () => {
    expect((await note("/api/ops/machines/box/notes", "x", { "x-te-session": "agent-session-1" })).status).toBe(403);
    expect((await note("/api/ops/playbooks/demo/notes", "x", { "x-te-session": "agent-session-1" })).status).toBe(403);
    expect((await note("/api/ops/machines/box/notes", "   ")).status).toBe(400);
    expect((await note("/api/ops/machines/ghost/notes", "x")).status).toBe(404);
    expect((await note("/api/ops/playbooks/ghost/notes", "x")).status).toBe(404);
  });
});
