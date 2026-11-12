import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { PlansStore } from "../../daemon/store/store.js";
import { PlansWatcher } from "../../daemon/watch/watch.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../../daemon/server/server.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import { SessionRegistry } from "../../daemon/sessions/sessions.js";
import { EventBus } from "../../daemon/api/events.js";
import { registerApiRoutes } from "../../daemon/api/api.js";
import { loadEnvs } from "../../core/ops/env.js";
import { machinesCmd, envCmd, currentEnv } from "./machines.js";

/**
 * `te machines` / `te env` (GL-0288): list, show (rules before notes),
 * graph with tier rows + edge lines, env select (manual pin beats wifi
 * match) — all through a real daemon for the workspace root.
 */

let home: string;
let root: string;
let daemon: DaemonHandle;
let watcher: PlansWatcher;

const doc = (fm: Record<string, unknown>, body = "") => `---\n${YAML.stringify(fm)}---\n${body}`;

async function capture(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    const code = await fn();
    return { code, text: lines.join("\n") };
  } finally {
    console.log = origLog;
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-cli-machines-"));
  root = join(home, "ws");
  const plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(join(plans, "workspace.yaml"), "name: ws\nprefix: WS\n");
  mkdirSync(join(root, "machines"), { recursive: true });
  mkdirSync(join(root, "envs"), { recursive: true });
  writeFileSync(
    join(root, "machines", "lap.machine.md"),
    doc({ id: "lap", host: hostname(), tier: "dev", roles: ["runner"], rules: ["never push without ok"] }, "the laptop — notes go here\n"),
  );
  writeFileSync(
    join(root, "machines", "rpi5.machine.md"),
    doc({ id: "rpi5", host: "rpi5.local", tier: "test", roles: ["build", "shadow"], edges: [{ kind: "deploy", to: "droneengage", repo: "~/de_code" }] }),
  );
  writeFileSync(
    join(root, "machines", "prod1.machine.md"),
    doc({ id: "prod1", host: "droneengage.local", tier: "prod", roles: ["production"] }),
  );
  writeFileSync(
    join(root, "envs", "work.env.md"),
    doc({ id: "work", network: ["MHEFNY4G"], machines: [{ id: "lap" }, { id: "rpi5" }], reach: [{ from: "lap", to: "rpi5", via: "ssh" }] }),
  );
  writeFileSync(join(root, "envs", "field.env.md"), doc({ id: "field", network: ["FIELDWIFI"], machines: [{ id: "prod1" }] }));
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
  const ctx: DaemonCtx = {
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

describe("te machines", () => {
  it("lists id, tier, host and roles", async () => {
    const { code, text } = await capture(() => machinesCmd([], home));
    expect(code).toBe(0);
    expect(text).toContain(`lap  dev  ${hostname()}  runner`);
    expect(text).toContain("rpi5  test  rpi5.local  build,shadow");
    expect(text).toContain("prod1  prod  droneengage.local  production");
  });

  it("show prints the rules before the notes body", async () => {
    const { code, text } = await capture(() => machinesCmd(["show", "lap"], home));
    expect(code).toBe(0);
    expect(text.indexOf("never push without ok")).toBeLessThan(text.indexOf("notes go here"));
    expect(text.indexOf("rules:")).toBeLessThan(text.indexOf("id: lap"));
  });

  it("probe runs the env's reach edges through the daemon — wrong wifi answers not_expected", async () => {
    const { code, text } = await capture(() => machinesCmd(["probe", "--env", "work"], home));
    expect(code).toBe(0);
    expect(text).toContain("lap --ssh--> rpi5  not_expected (needs network MHEFNY4G)");
  });

  it("graph prints dev/test/prod rows and one line per edge; --env adds reach lines", async () => {
    const { code, text } = await capture(() => machinesCmd(["graph", "--env", "work"], home));
    expect(code).toBe(0);
    expect(text).toMatch(/^dev: lap$/m);
    expect(text).toMatch(/^test: rpi5$/m);
    expect(text).toMatch(/^prod: prod1$/m);
    expect(text).toContain("rpi5 --deploy--> droneengage (~/de_code)");
    expect(text).toContain("env work (wifi: MHEFNY4G)");
    expect(text).toContain("lap --ssh--> rpi5");
  });
});

describe("te env", () => {
  it("with no manual choice a wifi name picks the env that lists it", () => {
    const envs = loadEnvs(root);
    expect(currentEnv(root, envs, "FIELDWIFI")).toEqual({ env: envs[0].env, how: "wifi" });
    expect(currentEnv(root, envs, "OTHERNET").how).toBe("none");
  });

  it("use pins the env in the runner's .machine.local; env prints it as manual", async () => {
    const use = await capture(() => envCmd(["use", "work"], home));
    expect(use.code).toBe(0);
    expect(use.text).toContain("env work");
    const { code, text } = await capture(() => envCmd([], home));
    expect(code).toBe(0);
    expect(text).toContain("work  (manual)");
  });

  it("a manual pin wins over the wifi match", () => {
    const envs = loadEnvs(root);
    const sel = currentEnv(root, envs, "FIELDWIFI");
    expect(sel.how).toBe("manual");
    expect(sel.env?.id).toBe("work");
  });
});
