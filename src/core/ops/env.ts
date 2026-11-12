import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import YAML from "yaml";
import type { Finding } from "../validate/validate.js";
import { kebab, splitFrontmatter } from "./machine.js";
import { runnerMachine } from "./runner.js";

/**
 * Envs (DESIGN §14): one `envs/<id>.env.md` file per diagram — a group of
 * machines with positions, the reach edges that are true in that place,
 * and the expected network (wifi names). One machine can be in many
 * envs (ENV home, ENV work, ENV all). Env files carry no status and no
 * claim — they are documents, like task files.
 */

export const REACH_VIA = ["ssh", "https", "git"] as const;
export type ReachVia = (typeof REACH_VIA)[number];

export const EnvMachine = z.object({
  id: z.string().min(1).transform(kebab),
  row: z.number().int().default(0),
  col: z.number().int().default(0),
});

export const EnvReach = z.object({
  from: z.string().min(1).transform(kebab),
  to: z.string().min(1).transform(kebab),
  via: z.string().min(1), // checked against REACH_VIA as a finding
  note: z.string().optional(),
});

export const Env = z.object({
  id: z.string().min(1).transform(kebab),
  title: z.string().optional(),
  /** wifi/network names where this env is the expected topology */
  network: z.array(z.string()).default([]),
  machines: z.array(EnvMachine).default([]),
  reach: z.array(EnvReach).default([]),
});
export type Env = z.infer<typeof Env>;

/** One `envs/*.env.md` — parsed env or its load error. */
export interface LoadedEnv {
  /** workspace-relative path, e.g. envs/home.env.md */
  file: string;
  env?: Env;
  body?: string;
  error?: string;
}

/** Load every `<root>/envs/*.env.md`. Missing dir means no envs. */
export function loadEnvs(root: string): LoadedEnv[] {
  const dir = join(root, "envs");
  if (!existsSync(dir)) return [];
  const out: LoadedEnv[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".env.md")).sort()) {
    const rel = `envs/${name}`;
    try {
      const { fm, body } = splitFrontmatter(readFileSync(join(dir, name), "utf8"), rel);
      if (fm && typeof fm === "object" && (fm as Record<string, unknown>).id === undefined) {
        (fm as Record<string, unknown>).id = name.replace(/\.env\.md$/, "");
      }
      const parsed = Env.safeParse(fm);
      if (parsed.success) out.push({ file: rel, env: parsed.data, body });
      else out.push({ file: rel, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    } catch (e) {
      out.push({ file: rel, error: (e as Error).message.split("\n")[0] });
    }
  }
  return out;
}

/**
 * The semantic checks `te validate` runs on every env file (GL-0286):
 * load errors, duplicate ids, an unknown machine id in machines or
 * reach, a via outside the list.
 */
export function envFindings(loaded: LoadedEnv[], machineIds: ReadonlySet<string>): Finding[] {
  const out: Finding[] = [];
  const f = (file: string, message: string) => out.push({ severity: "error", kind: "env", path: file, message });
  const seen = new Map<string, string>();
  for (const l of loaded) {
    if (!l.env) {
      f(l.file, `env ${l.file} does not parse: ${l.error}`);
      continue;
    }
    const e = l.env;
    const dup = seen.get(e.id);
    if (dup) f(l.file, `env id '${e.id}' is also declared in ${dup}`);
    seen.set(e.id, l.file);
    for (const m of e.machines) {
      if (!machineIds.has(m.id)) f(l.file, `env ${e.id} names unknown machine id '${m.id}'`);
    }
    for (const r of e.reach) {
      if (!machineIds.has(r.from)) f(l.file, `env ${e.id}: reach from unknown machine '${r.from}'`);
      if (!machineIds.has(r.to)) f(l.file, `env ${e.id}: reach to unknown machine '${r.to}'`);
      if (!(REACH_VIA as readonly string[]).includes(r.via)) {
        f(l.file, `env ${e.id}: reach via '${r.via}' is not in ${REACH_VIA.join("|")}`);
      }
    }
  }
  return out;
}

/**
 * The active env (GL-0288/0289): a manual `env:` pin in the runner
 * machine's .machine.local wins; else the env whose `network:` list holds
 * the current wifi name; else none. Shared by the CLI (te env) and the
 * daemon (the active flag on the machines API) — lives here so the
 * daemon never imports from cli/.
 */
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

/** The `env:` pinned in the runner machine's .machine.local — raw read; the Machine schema strips it. */
export function runnerLocalFile(root: string): { file: string; data: Record<string, unknown> } | undefined {
  const m = runnerMachine(root, hostname());
  if (!m) return undefined;
  const file = join(root, "machines", `${m.id}.machine.local`);
  if (!existsSync(file)) return { file, data: {} };
  const data = (YAML.parse(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
  return { file, data };
}

/** The active env: manual pin in the runner's .machine.local, else wifi-name match. */
export function currentEnv(
  root: string,
  envs: LoadedEnv[],
  wifi: string | undefined,
): { env?: Env; how: "manual" | "wifi" | "none" } {
  const pinned = runnerLocalFile(root)?.data.env;
  if (typeof pinned === "string") {
    return { env: envs.flatMap((l) => (l.env ? [l.env] : [])).find((e) => e.id === pinned), how: "manual" };
  }
  if (wifi) {
    const hit = envs.flatMap((l) => (l.env ? [l.env] : [])).find((e) => e.network.includes(wifi));
    if (hit) return { env: hit, how: "wifi" };
  }
  return { how: "none" };
}

/** Pin an env in the runner machine's .machine.local — returns the file written. */
export function setEnvPin(root: string, envId: string): string | undefined {
  const local = runnerLocalFile(root);
  if (!local) return undefined;
  local.data.env = kebab(envId);
  writeFileSync(local.file, YAML.stringify(local.data));
  return local.file;
}
