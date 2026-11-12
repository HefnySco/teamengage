import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { daemonApi } from "../client.js";
import { kebab, loadMachines, type LoadedMachine } from "../../core/ops/machine.js";
import { loadEnvs, type Env, type LoadedEnv } from "../../core/ops/env.js";
import { runnerMachine } from "../../core/ops/runner.js";

/**
 * `te machines` / `te env` (GL-0288) — the human/agent window onto the
 * machine + env files from GL-0286. Reads the files straight from the
 * workspace root (the daemon only resolves where that root is).
 *
 *   te machines                    list id, tier, host, roles
 *   te machines show <id>          rules first, then fields, then the notes body
 *   te machines graph [--env <id>] machines in dev/test/prod rows, one line per edge
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

/** The current wifi SSID — iwgetid first, nmcli fallback; empty when neither is here. */
export function wifiName(): string {
  try {
    return execFileSync("iwgetid", ["-r"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    /* no iwgetid or not on wifi */
  }
  try {
    const out = execFileSync("nmcli", ["-t", "-f", "ACTIVE,SSID", "dev", "wifi"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").find((l) => l.startsWith("yes:"))?.slice(4) ?? "";
  } catch {
    return "";
  }
}

/** The `env:` pinned in the runner machine's .machine.local — raw read, the Machine schema strips it. */
function runnerLocalFile(root_: string): { file: string; data: Record<string, unknown> } | undefined {
  const m = runnerMachine(root_, hostname());
  if (!m) return undefined;
  const file = join(root_, "machines", `${m.id}.machine.local`);
  if (!existsSync(file)) return { file, data: {} };
  const data = (YAML.parse(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
  return { file, data };
}

/** The active env: manual pin in the runner's .machine.local, else wifi-name match. */
export function currentEnv(
  root_: string,
  envs: LoadedEnv[],
  wifi: string | undefined,
): { env?: Env; how: "manual" | "wifi" | "none" } {
  const local = runnerLocalFile(root_);
  const pinned = typeof local?.data.env === "string" ? (local.data.env as string) : undefined;
  if (pinned) return { env: envs.flatMap((l) => (l.env ? [l.env] : [])).find((e) => e.id === pinned), how: "manual" };
  if (wifi) {
    const hit = envs.flatMap((l) => (l.env ? [l.env] : [])).find((e) => e.network.includes(wifi));
    if (hit) return { env: hit, how: "wifi" };
  }
  return { how: "none" };
}

function showMachine(l: LoadedMachine): void {
  const m = l.machine!;
  if (m.rules.length) {
    console.log("rules:");
    for (const r of m.rules) console.log(`  - ${r}`);
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
    showMachine(l);
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
  console.log("usage: te machines [show <id> | graph [--env <id>]]");
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
    const local = runnerLocalFile(root_);
    if (!local) return console.log("no runner machine record — mark this computer with runner: true in a machines/<id>.machine.local first"), 4;
    local.data.env = env.env.id;
    writeFileSync(local.file, YAML.stringify(local.data));
    console.log(`env ${env.env.id} — manual select stored in ${local.file.replace(`${root_}/`, "")}`);
    return 0;
  }
  const { env, how } = currentEnv(root_, envs, wifiName() || undefined);
  if (!env) return console.log(how === "manual" ? "manual env points at a missing env file" : "no env selected — te env use <id>, or no env matches this wifi"), 0;
  console.log(`${env.id}  (${how})`);
  return 0;
}
