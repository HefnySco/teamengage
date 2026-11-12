import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Finding } from "../validate/validate.js";
import { kebab, splitFrontmatter } from "./machine.js";

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
