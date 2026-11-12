import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Finding } from "../validate/validate.js";

/**
 * Machines (DESIGN §14): one `machines/<id>.machine.md` file per machine
 * that ops work touches — host, tier, ssh references (never secrets),
 * apps, folders, databases, rules and fixed edges. The markdown body is
 * free notes for the human. A `<id>.machine.local` file next to it is
 * git-ignored (`*.local`) and holds per-runner overrides — paths and
 * key paths differ between the laptop and the desktop.
 */

/** Lowercase kebab — ids are converted, never refused for case. */
export const kebab = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const EDGE_KINDS = ["deploy", "sync", "shadow_of", "talks_to"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const MachineApp = z.object({
  name: z.string().min(1),
  port: z.number().int().optional(),
  env: z.enum(["prod", "shadow"]).optional(),
  path: z.string().optional(),
  /** per-runner path overrides keyed by runner machine id */
  paths: z.record(z.string()).optional(),
});

export const MachineEdge = z.object({
  kind: z.string().min(1), // checked against EDGE_KINDS as a finding — a bad kind keeps a clear message
  to: z.string().min(1),
  note: z.string().optional(),
});

export const PathPurpose = z.object({
  path: z.string().min(1),
  purpose: z.string().optional(),
});

/**
 * ssh is a record of references — the only allowed keys are user, key
 * and port; anything else (a password, key text) is a secret and is a
 * validate finding, not a schema error, so the message names the field.
 */
export const Machine = z.object({
  id: z.string().min(1).transform(kebab),
  title: z.string().optional(),
  host: z.string().optional(),
  ip: z.string().optional(),
  tier: z.enum(["dev", "test", "prod"]).optional(),
  ssh: z.record(z.string()).default({}),
  roles: z.array(z.string()).default([]),
  apps: z.array(MachineApp).default([]),
  folders: z.array(PathPurpose).default([]),
  databases: z.array(PathPurpose).default([]),
  handled_by: z
    .object({
      agents: z.array(z.string()).default([]),
      skills: z.array(z.string()).default([]),
    })
    .default({ agents: [], skills: [] }),
  rules: z.array(z.string()).default([]),
  edges: z.array(MachineEdge).default([]),
});
export type Machine = z.infer<typeof Machine>;

/** One `machines/*.machine.md` — parsed machine or its load error. */
export interface LoadedMachine {
  /** workspace-relative path, e.g. machines/cloud.machine.md */
  file: string;
  machine?: Machine;
  /** markdown body — free notes for the human */
  body?: string;
  error?: string;
}

const SSH_KEYS = new Set(["user", "key", "port"]);
const SECRET_RE = /PRIVATE KEY|BEGIN [A-Z ]*KEY/i;

/** Split `---\n<yaml>\n---\n<body>` — the shape every .machine.md/.env.md file has. */
export function splitFrontmatter(text: string, file: string): { fm: unknown; body: string } {
  const m = /^---\r?\n/.exec(text);
  if (!m) throw new Error(`${file}: missing frontmatter (expected leading '---')`);
  const rest = text.slice(m[0].length);
  const end = /^---[ \t]*\r?\n/m.exec(rest) ?? /^---[ \t]*$/m.exec(rest);
  if (!end) throw new Error(`${file}: unterminated frontmatter`);
  return { fm: YAML.parse(rest.slice(0, end.index)) ?? {}, body: rest.slice(end.index + end[0].length) };
}

/** Recursive merge — override object values replace the shared file's; arrays replace whole. */
function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (Array.isArray(over) || typeof over !== "object" || over === null) return over;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out;
}

/** Load every `<root>/machines/*.machine.md`, with `<id>.machine.local` overrides merged. */
export function loadMachines(root: string): LoadedMachine[] {
  const dir = join(root, "machines");
  if (!existsSync(dir)) return [];
  const out: LoadedMachine[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".machine.md")).sort()) {
    const rel = `machines/${name}`;
    try {
      const { fm, body } = splitFrontmatter(readFileSync(join(dir, name), "utf8"), rel);
      const localFile = join(dir, name.replace(/\.machine\.md$/, ".machine.local"));
      const over = existsSync(localFile) ? (YAML.parse(readFileSync(localFile, "utf8")) ?? {}) : undefined;
      const merged = deepMerge(fm, over) as Record<string, unknown>;
      if (merged.id === undefined && typeof name === "string") merged.id = name.replace(/\.machine\.md$/, "");
      const parsed = Machine.safeParse(merged);
      if (parsed.success) out.push({ file: rel, machine: parsed.data, body });
      else out.push({ file: rel, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    } catch (e) {
      out.push({ file: rel, error: (e as Error).message.split("\n")[0] });
    }
  }
  return out;
}

/**
 * The semantic checks `te validate` runs on every machine file (GL-0286):
 * load errors, duplicate ids, an ssh field that is not a reference (a
 * password or private key text), an edge kind outside the list, an edge
 * to an unknown machine.
 */
export function machineFindings(loaded: LoadedMachine[]): Finding[] {
  const out: Finding[] = [];
  const f = (file: string, message: string) => out.push({ severity: "error", kind: "machine", path: file, message });
  const seen = new Map<string, string>();
  const ids = new Set(loaded.flatMap((l) => (l.machine ? [l.machine.id] : [])));
  for (const l of loaded) {
    if (!l.machine) {
      f(l.file, `machine ${l.file} does not parse: ${l.error}`);
      continue;
    }
    const m = l.machine;
    const dup = seen.get(m.id);
    if (dup) f(l.file, `machine id '${m.id}' is also declared in ${dup}`);
    seen.set(m.id, l.file);
    for (const [k, v] of Object.entries(m.ssh)) {
      if (!SSH_KEYS.has(k)) f(l.file, `machine ${m.id}: ssh field '${k}' is not allowed — only user, key and port (references, never secrets)`);
      else if (SECRET_RE.test(v)) f(l.file, `machine ${m.id}: ssh.${k} holds key text — keep a key path, never the key itself`);
    }
    for (const e of m.edges) {
      if (!(EDGE_KINDS as readonly string[]).includes(e.kind)) {
        f(l.file, `machine ${m.id}: edge kind '${e.kind}' is not in ${EDGE_KINDS.join("|")}`);
      }
      const to = kebab(e.to.split("/")[0]);
      if (!ids.has(to)) f(l.file, `machine ${m.id}: edge to unknown machine '${to}'`);
    }
  }
  return out;
}
