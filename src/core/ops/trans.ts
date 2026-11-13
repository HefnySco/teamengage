import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Finding } from "../validate/validate.js";

/**
 * Machine activity log ("trans"). One append-only file per machine —
 * `machines/<id>.machine.trans.md` — that says what happened to the
 * machine, in order. Two producers write it:
 *
 *   adhoc — a change outside a playbook (`te machines trans <id> "text"`)
 *   job   — one line the JobStore appends when a job on a target of this
 *           machine reaches a terminal state (succeeded, stopped, failed,
 *           aborted) — the file is the readable ledger, the job record
 *           keeps the step detail
 *
 * One entry is one block, the same shape as a human note:
 *
 *   ### 2026-11-13T14:22:10.000Z · adhoc · mhefny-dt
 *   edited de_web_shadow build/config.local.json — DISABLE_DE_PILOT: true
 *
 *   ### 2026-11-13T15:02:44.000Z · job mhefny-dt-0042 · mhefny-dt
 *   webclient-shadow-deploy on cloud-web-shadow — succeeded · version 2bde9e57
 *
 * The file is a document: it syncs through the plans repo like every
 * other workspace file. Appends from two machines can conflict on a
 * plans merge — rare, and git resolves an append cleanly.
 */

export type TransKind = "adhoc" | "job";

export interface TransEntry {
  ts: string;
  kind: TransKind;
  /** the runner machine that did it */
  actor: string;
  /** job entries: the job id — the Ops log tab links it */
  job?: string;
  text: string;
}

/** <ts> · adhoc · <actor>  |  <ts> · job <job-id> · <actor> */
const HEAD_RE = /^### (\S+) · (adhoc|job)(?: (\S+))? · (.+?)[ \t]*$/;

/** The trans file of a machine (workspace-relative). */
export function transFile(id: string): string {
  return `machines/${id}.machine.trans.md`;
}

/** Parse every entry in a trans file's text, oldest first. */
export function parseTrans(text: string): TransEntry[] {
  const out: TransEntry[] = [];
  let cur: (TransEntry & { lines: string[] }) | undefined;
  const close = () => {
    if (cur) out.push({ ts: cur.ts, kind: cur.kind, actor: cur.actor, job: cur.job, text: cur.lines.join("\n").trim() });
    cur = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    const m = HEAD_RE.exec(line);
    if (m) {
      close();
      cur = { ts: m[1], kind: m[2] as TransKind, job: m[3], actor: m[4], text: "", lines: [] };
      continue;
    }
    if (cur && /^#{1,3} /.test(line)) close();
    else if (cur) cur.lines.push(line);
  }
  close();
  return out;
}

/** The entries of one machine — [] when it has no trans file. */
export function loadTrans(root: string, id: string): TransEntry[] {
  const file = join(root, transFile(id));
  return existsSync(file) ? parseTrans(readFileSync(file, "utf8")) : [];
}

/**
 * Append one entry and return its timestamp. The file is created with a
 * title block on first use — a machine id with no `.machine.md` still
 * takes entries (`te validate` warns on the orphan).
 */
export function appendTrans(
  root: string,
  id: string,
  entry: { kind: TransKind; actor: string; text: string; job?: string },
  now = new Date(),
): string {
  const text = entry.text.trim();
  if (!text) throw new Error("a trans entry needs text");
  if (/^### /m.test(text)) throw new Error("a trans entry cannot hold a line that starts with '### '");
  const file = join(root, transFile(id));
  let out = existsSync(file)
    ? readFileSync(file, "utf8").replace(/\s*$/, "\n")
    : `# ${id} — activity log\n\nWhat happened to this machine, in order. Ad-hoc changes (\`te machines trans\`)\nand the ops jobs that name a target on it. Append-only.\n`;
  const ts = now.toISOString();
  const head = entry.kind === "job" ? `### ${ts} · job ${entry.job} · ${entry.actor}` : `### ${ts} · adhoc · ${entry.actor}`;
  out += `\n${head}\n${text}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out);
  return ts;
}

/**
 * `te validate` check: a `<id>.machine.trans.md` for a machine that has
 * no `.machine.md` — almost always a typo'd id, so a warning.
 */
export function transFindings(root: string, machineIds: ReadonlySet<string>): Finding[] {
  const dir = join(root, "machines");
  if (!existsSync(dir)) return [];
  const out: Finding[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".machine.trans.md"))) {
    const id = name.slice(0, -".machine.trans.md".length);
    if (!machineIds.has(id)) {
      out.push({
        severity: "warning",
        kind: "machine",
        path: `machines/${name}`,
        message: `trans file for unknown machine '${id}' — no machines/${id}.machine.md`,
      });
    }
  }
  return out;
}
