import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Human notes on machines and playbooks (GL-0297). The human writes a
 * free note; TeamEngage keeps the words verbatim in the file and opens a
 * task for an agent to turn the note into a YAML change. The daemon never
 * runs an LLM — the conversion is ordinary agent work (claim → submit →
 * review).
 *
 * Where a note lives:
 *   machine  — appended to the body of machines/<id>.machine.md
 *   playbook — appended to ops/<name>.notes.md, a sidecar; the playbook
 *              YAML (and its sha256, which jobs pin) does not change
 *
 * One note is one block:
 *
 *   ### note 2026-11-12T13:30:00.000Z · pending · GL-0300
 *   <the human's text, verbatim>
 *
 * The state is `pending` until the agent that applies it changes the
 * word to `applied`. The item id is the task that applies it.
 */

export type NoteState = "pending" | "applied";

export interface OpsNote {
  ts: string;
  state: NoteState;
  item?: string;
  text: string;
}

export const NOTES_HEADING = "## Human notes";
const HEAD_RE = /^### note (\S+) · (pending|applied)(?: · ([A-Z]+-\d+))?[ \t]*$/;

/** The file a note for this machine or playbook goes to (workspace-relative). */
export function noteFile(kind: "machine" | "playbook", id: string): string {
  return kind === "machine" ? `machines/${id}.machine.md` : `ops/${id}.notes.md`;
}

/** Parse every note block in a file's text, oldest first. */
export function parseNotes(text: string): OpsNote[] {
  const out: OpsNote[] = [];
  let cur: (OpsNote & { lines: string[] }) | undefined;
  const close = () => {
    if (cur) out.push({ ts: cur.ts, state: cur.state, item: cur.item, text: cur.lines.join("\n").trim() });
    cur = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    const m = HEAD_RE.exec(line);
    if (m) {
      close();
      cur = { ts: m[1], state: m[2] as NoteState, item: m[3], text: "", lines: [] };
      continue;
    }
    if (cur && /^#{1,3} /.test(line)) close();
    else if (cur) cur.lines.push(line);
  }
  close();
  return out;
}

/**
 * The task a note opens: one change to one machine file, or to one
 * playbook plus its note sidecar. `repo` is the workspace folder name
 * that Touches lines use for the plans folder.
 */
export function noteTaskDraft(kind: "machine" | "playbook", id: string, ts: string, text: string, repo: string) {
  const file = noteFile(kind, id);
  const what = kind === "machine" ? `machine ${id}` : `playbook ${id}`;
  const yamlFile = kind === "machine" ? file : `ops/${id}.playbook.yaml`;
  return {
    type: "task",
    title: `Apply note to ${what}`,
    tier: (kind === "machine" ? "light" : "standard") as "light" | "standard",
    domains: ["ops"],
    summary:
      `The human added a note to ${file} at ${ts}. Turn it into a change of ${yamlFile}. ` +
      `Follow the te-ops skill section 'Apply a machine or playbook note'. Change only what the note asks. ` +
      `Ask when the note is unclear. Never write a secret into the file. The note:\n\n${text.trim()}`,
    touches: kind === "machine" ? [`${repo}: ${file}`] : [`${repo}: ${yamlFile}`, `${repo}: ${file}`],
    acceptance: [
      `te validate is clean`,
      `the note ${ts} in ${file} is marked applied`,
      ...(kind === "playbook"
        ? ["every gate step, start: human and every run command stay as they were, unless the note asks for that change in clear words"]
        : []),
      `the submit walkthrough holds the unified diff of ${yamlFile}`,
    ],
  };
}

/** A machine body without its "## Human notes" section — the panel lists the notes on their own. */
export function bodyWithoutNotes(body: string): string {
  const i = body.search(/^## Human notes[ \t]*$/m);
  return (i === -1 ? body : body.slice(0, i)).trimEnd();
}

/** Read the notes of one machine or playbook — [] when the file has none. */
export function readNotes(root: string, kind: "machine" | "playbook", id: string): OpsNote[] {
  const file = join(root, noteFile(kind, id));
  return existsSync(file) ? parseNotes(readFileSync(file, "utf8")) : [];
}

/**
 * Append one pending note and return its timestamp (the note's key). The
 * machine file must exist; a playbook sidecar is created on first use.
 */
export function appendNote(root: string, kind: "machine" | "playbook", id: string, text: string, now = new Date()): string {
  const body = text.trim();
  if (!body) throw new Error("a note needs text");
  if (/^### note /m.test(body)) throw new Error("a note cannot hold a line that starts with '### note '");
  const file = join(root, noteFile(kind, id));
  let cur = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (cur === undefined) {
    if (kind === "machine") throw new Error(`no machine file ${noteFile(kind, id)}`);
    cur = `# Notes for playbook ${id}\n\nHuman notes on ops/${id}.playbook.yaml. An agent applies each pending note as a playbook change.\n`;
  }
  const ts = now.toISOString();
  let out = cur.replace(/\s*$/, "\n");
  if (!out.includes(`\n${NOTES_HEADING}\n`) && !out.startsWith(`${NOTES_HEADING}\n`)) out += `\n${NOTES_HEADING}\n`;
  out += `\n### note ${ts} · pending\n${body}\n`;
  writeFileSync(file, out);
  return ts;
}

/** Set the item id on the note with this timestamp (after the task exists). */
export function linkNote(root: string, kind: "machine" | "playbook", id: string, ts: string, item: string): void {
  const file = join(root, noteFile(kind, id));
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const i = lines.findIndex((l) => {
    const m = HEAD_RE.exec(l);
    return m !== null && m[1] === ts;
  });
  if (i === -1) throw new Error(`no note ${ts} in ${noteFile(kind, id)}`);
  const m = HEAD_RE.exec(lines[i])!;
  lines[i] = `### note ${ts} · ${m[2]} · ${item}`;
  writeFileSync(file, lines.join("\n"));
}
