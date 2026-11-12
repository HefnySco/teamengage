import YAML from "yaml";
import { hostname } from "node:os";
import { daemonApi } from "../client.js";
import { kebab, loadMachines, type LoadedMachine } from "../../core/ops/machine.js";
import { currentEnv, loadEnvs, setEnvPin, wifiName, type Env } from "../../core/ops/env.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { JobStore } from "../../core/ops/job.js";
import { loadProbes } from "../../core/ops/probe.js";
import { deployedAppLine, deployedForMachine, type DeployedApp } from "../../core/ops/deployed.js";
import { runnerMachine } from "../../core/ops/runner.js";

/**
 * `te machines` / `te env` (GL-0288) — the human/agent window onto the
 * machine + env files from GL-0286. Reads the files straight from the
 * workspace root (the daemon only resolves where that root is).
 *
 *   te machines                    list id, tier, host, roles
 *   te machines show <id>          rules first, then fields, then the notes body
 *   te machines graph [--env <id>] machines in dev/test/prod rows, one line per edge
 *   te machines note <id> "text"   add a human note; a ready task asks an agent to apply it (GL-0297)
 *   te env                         the active env and how it was picked
 *   te env use <id>                pin an env in the runner's .machine.local
 *
 * Env select order: the manual `env:` in the runner machine's
 * .machine.local wins; else the env whose `network:` list holds the
 * current wifi name; else none.
 */

async function root(home?: string): Promise<string> {
  const wsc = (await daemonApi("GET", "/api/workspace", undefined, home)) as { root: string };
  return wsc.root;
}

export { currentEnv, wifiName };

function showMachine(l: LoadedMachine, deployed?: DeployedApp[]): void {
  const m = l.machine!;
  if (m.rules.length) {
    console.log("rules:");
    for (const r of m.rules) console.log(`  - ${r}`);
  }
  // GL-0305: what runs on the machine now — the same join the Ops panel shows
  if (deployed?.length) {
    console.log("running now:");
    for (const a of deployed) console.log(`  ${deployedAppLine(a)}`);
  }
  const { rules: _rules, runner: _runner, ...rest } = m;
  const fm = Object.fromEntries(Object.entries(rest).filter(([, v]) => !(Array.isArray(v) && !v.length) && !(typeof v === "object" && v !== null && !Array.isArray(v) && !Object.keys(v).length)));
  console.log(YAML.stringify(fm).trim());
  const body = l.body?.trim();
  if (body) console.log(`\n${body}`);
}

function graph(machines: LoadedMachine[], env: Env | undefined): void {
  const ok = machines.flatMap((l) => (l.machine ? [l.machine] : []));
  for (const tier of ["dev", "test", "prod"] as const) {
    const ids = ok.filter((m) => (m.tier ?? "dev") === tier).map((m) => m.id);
    console.log(`${tier}: ${ids.join("  ") || "—"}`);
  }
  for (const m of ok) {
    for (const e of m.edges) {
      console.log(`${m.id} --${e.kind}--> ${e.to}${e.repo ? ` (${e.repo})` : ""}${e.note ? ` — ${e.note}` : ""}`);
    }
  }
  if (env) {
    console.log(`env ${env.id}${env.network.length ? ` (wifi: ${env.network.join(", ")})` : ""}`);
    for (const r of env.reach) console.log(`${r.from} --${r.via}--> ${r.to}${r.note ? ` — ${r.note}` : ""}`);
  }
}

export async function machinesCmd(args: string[], home?: string): Promise<number> {
  const sub = args[0];
  const root_ = await root(home);
  if (sub === undefined || sub === "list") {
    for (const l of loadMachines(root_)) {
      if (!l.machine) {
        console.log(`${l.file}: ERROR ${l.error}`);
        continue;
      }
      const m = l.machine;
      console.log(`${m.id}  ${m.tier ?? "dev"}  ${m.host ?? "—"}  ${m.roles.join(",") || "—"}`);
    }
    return 0;
  }
  if (sub === "show") {
    const id = args[1];
    if (!id) return console.log("usage: te machines show <id>"), 4;
    const l = loadMachines(root_).find((x) => x.machine?.id === kebab(id));
    if (!l?.machine) return console.log(`no machine '${id}' under machines/`), 4;
    // the deployed join reads job files and stored probes — never runs a probe
    const ws = resolveWorkspace(root_, { home });
    const jobs = new JobStore(root_, ws.plansDir, runnerMachine(root_, hostname())?.id ?? hostname()).listAll();
    const deployed = deployedForMachine(l.machine, ws.config.targets, jobs, loadProbes(home));
    showMachine(l, deployed);
    return 0;
  }
  if (sub === "probe") {
    const i = args.indexOf("--env");
    let envId = i === -1 ? undefined : kebab(args[i + 1]);
    const envs = loadEnvs(root_);
    if (!envId) envId = currentEnv(root_, envs, wifiName() || undefined).env?.id;
    if (!envId) return console.log("no env selected — te machines probe --env <id>"), 4;
    const results = await daemonApi("POST", `/api/ops/envs/${envId}/probe`, {}, home) as { from: string; to: string; via: string; status: string; reason?: string }[];
    for (const r of results) console.log(`${r.from} --${r.via}--> ${r.to}  ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
    return 0;
  }
  if (sub === "note") {
    // te machines note <id> "text" (GL-0297) — the human's words go into the
    // machine file; a ready task asks an agent to turn them into YAML
    const id = args[1];
    const text = args.slice(2).join(" ").trim();
    if (!id || !text) return console.log('usage: te machines note <id> "text"'), 4;
    const r = (await daemonApi("POST", `/api/ops/machines/${encodeURIComponent(kebab(id))}/notes`, { text }, home)) as { file: string; item: string };
    console.log(`note added to ${r.file} — ${r.item} asks an agent to apply it`);
    return 0;
  }
  if (sub === "graph") {
    const envId = (() => {
      const i = args.indexOf("--env");
      return i === -1 ? undefined : args[i + 1];
    })();
    const env = envId ? loadEnvs(root_).find((l) => l.env?.id === kebab(envId))?.env : undefined;
    if (envId && !env) return console.log(`no env '${envId}' under envs/`), 4;
    graph(loadMachines(root_), env);
    return 0;
  }
  console.log('usage: te machines [show <id> | graph [--env <id>] | probe [--env <id>] | note <id> "text"]');
  return 4;
}

export async function envCmd(args: string[], home?: string): Promise<number> {
  const root_ = await root(home);
  const envs = loadEnvs(root_);
  if (args[0] === "use") {
    const id = args[1];
    if (!id) return console.log("usage: te env use <id>"), 4;
    const env = envs.find((l) => l.env?.id === kebab(id));
    if (!env?.env) return console.log(`no env '${id}' under envs/`), 4;
    const file = setEnvPin(root_, env.env.id);
    if (!file) return console.log("no runner machine record — mark this computer with runner: true in a machines/<id>.machine.local first"), 4;
    console.log(`env ${env.env.id} — manual select stored in ${file.replace(`${root_}/`, "")}`);
    return 0;
  }
  const { env, how } = currentEnv(root_, envs, wifiName() || undefined);
  if (!env) return console.log(how === "manual" ? "manual env points at a missing env file" : "no env selected — te env use <id>, or no env matches this wifi"), 0;
  console.log(`${env.id}  (${how})`);
  return 0;
}
