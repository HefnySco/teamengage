import { isAbsolute, relative, resolve, sep } from "node:path";
import { readTeTag, globToRegExp } from "../files/source.js";

/**
 * Agent guard (Claude Code PreToolUse / SessionStart hooks, `te guard`).
 * Written rules get ignored; this enforces the ones that protect tracking:
 *
 * - nothing writes under a workspace's plans dir (`.teamengage/`)
 * - in overlay workspaces, task files are never created by hand (propose),
 *   their `te:` line is never changed or removed, and edits to them are
 *   additive (every existing line survives, in order)
 * - shell commands don't write into the plans dir, edit task files in place
 *   (sed -i …), move files into done/, or git push from a workspace
 *
 * Pure: file reads are injected. Anything it can't decide is allowed — a
 * guard bug must never brick the agent.
 */

export interface GuardWorkspace {
  name: string;
  root: string;
  plansDir: string;
  overlay: boolean;
  ignore: string[];
}

export interface ToolUse {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
}

export type ReadFile = (abs: string) => string | null;

const within = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

function wsFor(abs: string, wss: GuardWorkspace[]): GuardWorkspace | undefined {
  // innermost root wins when workspaces nest
  return wss.filter((w) => within(abs, w.root)).sort((a, b) => b.root.length - a.root.length)[0];
}

const rel = (ws: GuardWorkspace, abs: string) => abs.slice(ws.root.length + 1).split(sep).join("/");

/** Every line of `before` still present in `after`, in order. */
export function isAdditive(before: string, after: string): boolean {
  const a = after.split(/\r?\n/);
  let j = 0;
  for (const line of before.split(/\r?\n/)) {
    while (j < a.length && a[j] !== line) j++;
    if (j === a.length) return false;
    j++;
  }
  return true;
}

/** File text after an Edit / MultiEdit, or null when an edit doesn't apply. */
function applyEdits(text: string, edits: Array<Record<string, unknown>>): string | null {
  let out = text;
  for (const e of edits) {
    const from = String(e.old_string ?? "");
    const to = String(e.new_string ?? "");
    if (!from) return null;
    if (!out.includes(from)) return null; // the tool itself will fail — let it
    out = e.replace_all ? out.split(from).join(to) : out.replace(from, () => to);
  }
  return out;
}

const PLANS_MSG =
  "files under .teamengage/ belong to TeamEngage — change state with the te tools " +
  "(claim, log, ask, submit, propose), never by editing tracking files";

/** Decide one file write. Returns a deny reason, or null to allow. */
function checkWrite(
  abs: string,
  next: (before: string | null) => string | null,
  wss: GuardWorkspace[],
  read: ReadFile,
): string | null {
  const ws = wsFor(abs, wss);
  if (!ws) return null;
  if (within(abs, ws.plansDir)) return `${rel(ws, abs)}: ${PLANS_MSG}.`;
  if (!ws.overlay || !abs.toLowerCase().endsWith(".md")) return null;
  const r = rel(ws, abs);
  if (ws.ignore.some((g) => globToRegExp(g).test(r))) return null;

  const before = read(abs);
  if (before === null) {
    return (
      `${r}: task files are created with propose (it writes the file from the template and ` +
      `tracks it) — never by hand. Notes or findings: propose a review/spike item, or append ` +
      `to an existing task's "## Notes".`
    );
  }
  const tag = readTeTag(before);
  if (!tag) return null; // not a tracked task file
  const after = next(before);
  if (after === null) return null;
  if (readTeTag(after) !== tag) {
    return `${r}: never change or remove the "te: ${tag}" frontmatter line — it is how TeamEngage tracks this task.`;
  }
  if (!isAdditive(before, after)) {
    return (
      `${r} is task ${tag}: edits must be additive — append to "## Acceptance" or "## Notes", ` +
      `keep every existing line, and record the edit with log ${tag}. ` +
      `If existing text is wrong, ask the human (ask ${tag}).`
    );
  }
  return null;
}

// shell heuristics ----------------------------------------------------------

// commands that modify files; redirects count only when they target .teamengage/
const WRITE_VERB = /(^|[\s;&|(])(rm|mv|cp|tee|touch|truncate|install|ln|git\s+(rm|mv|checkout|restore))\s|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i/;
const REDIRECT_INTO_PLANS = />>?\s*['"]?[^\s'"|;&]*\.teamengage\//;
const IN_PLACE = /\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\bawk\s+-i\s+inplace/;
const MOVE = /(^|[\s;&|(])(git\s+mv|mv)\s/;
const PUSH = /(^|[\s;&|(])git(\s+-C\s+\S+)?\s+push\b/;

function checkBash(cmd: string, cwd: string | undefined, wss: GuardWorkspace[]): string | null {
  const absCwd = cwd ? resolve(cwd) : undefined;
  const here = absCwd ? wsFor(absCwd, wss) : undefined;
  for (const ws of wss) {
    // the command runs inside the workspace, names its root, or (from a
    // parent dir such as drone_engage/) names it relatively ("Tasks/…")
    const below = absCwd && within(ws.root, absCwd) && ws.root !== absCwd ? relative(absCwd, ws.root) : undefined;
    const mentions = cmd.includes(ws.root) || here === ws || (below !== undefined && cmd.includes(`${below}/`));
    if (!mentions) continue;
    if (REDIRECT_INTO_PLANS.test(cmd) || (/\.teamengage\//.test(cmd) && WRITE_VERB.test(cmd))) {
      return `this command writes under ${ws.name}'s .teamengage/: ${PLANS_MSG}. (Only reading? Use the Read tool.)`;
    }
    if (!ws.overlay) continue;
    if (MOVE.test(cmd) && /(^|[\s/'"])done\/?(\s|$|['"])|\/done\//.test(cmd)) {
      return "never move task files into done/ — status lives in TeamEngage; submit, and the human moves files.";
    }
    if (IN_PLACE.test(cmd) && /\.md\b/.test(cmd)) {
      return "don't edit task files in place from the shell — use the Edit tool (edits must be additive and keep the te: line).";
    }
    if (PUSH.test(cmd)) {
      return "never git push from a TeamEngage workspace — the human pushes.";
    }
  }
  return null;
}

/** PreToolUse decision: a deny reason, or null to allow. */
export function guardToolUse(input: ToolUse, wss: GuardWorkspace[], read: ReadFile): string | null {
  const t = input.tool_input ?? {};
  const absOf = (p: unknown) => {
    const s = String(p ?? "");
    if (!s) return undefined;
    return isAbsolute(s) ? resolve(s) : resolve(input.cwd ?? process.cwd(), s);
  };
  switch (input.tool_name) {
    case "Write": {
      const abs = absOf(t.file_path);
      return abs ? checkWrite(abs, () => String(t.content ?? ""), wss, read) : null;
    }
    case "Edit": {
      const abs = absOf(t.file_path);
      return abs ? checkWrite(abs, (b) => (b === null ? null : applyEdits(b, [t])), wss, read) : null;
    }
    case "MultiEdit": {
      const abs = absOf(t.file_path);
      const edits = Array.isArray(t.edits) ? (t.edits as Array<Record<string, unknown>>) : [];
      return abs ? checkWrite(abs, (b) => (b === null ? null : applyEdits(b, edits)), wss, read) : null;
    }
    case "NotebookEdit": {
      const abs = absOf(t.notebook_path);
      const ws = abs ? wsFor(abs, wss) : undefined;
      return ws && abs && within(abs, ws.plansDir) ? `${rel(ws, abs)}: ${PLANS_MSG}.` : null;
    }
    case "Bash":
      return checkBash(String(t.command ?? ""), input.cwd, wss);
    default:
      return null;
  }
}

/**
 * SessionStart context: when the session's directory is inside a
 * workspace, or contains one (drone_engage/ holds Tasks/), the rules are
 * injected so the agent starts with them.
 */
export function sessionContext(cwd: string, wss: GuardWorkspace[], rules: string): string | null {
  const abs = resolve(cwd);
  const hits = wss.filter((w) => within(abs, w.root) || within(w.root, abs));
  if (!hits.length) return null;
  const where = hits.map((w) => `${w.name} (${w.root}${w.overlay ? ", task folder" : ""})`).join(", ");
  return [
    `TeamEngage coordinates work here: ${where}.`,
    `Before picking up, creating or editing any task, read the workspace's AGENTS.md and follow it.`,
    `Use the TeamEngage tools: http://127.0.0.1:4747/agent (curl) or the "teamengage" MCP server —`,
    `hello → next → brief → claim → log/ask → submit. Never mark work done, never git push.`,
    `A guard hook enforces the file rules below and will refuse violating edits.`,
    "",
    rules.trim(),
  ].join("\n");
}
