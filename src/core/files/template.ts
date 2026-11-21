import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { withTeTag } from "./source.js";
import { renderChecks } from "./markdown.js";
import type { Check } from "../model/index.js";

/**
 * The task-file standard (docs/TASK-FORMAT.md). `propose` renders new task
 * files with it in overlay mode, `te agents-md` / the HTTP guide print the
 * authoring rules, and it is the target format for cleaning up older files.
 * The `**Depends on:**` line is the same one the importer parses.
 */

export interface TaskDraft {
  id: string;
  type: string;
  title: string;
  summary?: string;
  depends_on?: string[];
  parent?: string;
  /** loose references (e.g. the ideas a plan was generated from) — no ordering */
  relates?: string[];
  /** items where the problem was found — reference only */
  found_by?: string[];
  /** repos / paths the work touches, free text (`droneengage_mavlink: src/mission/**`) */
  touches?: string[];
  /** checkable acceptance criteria, one per line */
  acceptance?: string[];
  /** machine checks — `te verify` runs them in their repo (GL-0348) */
  checks?: Check[];
  /** discussion files only: body text for the fixed ## sections, keyed by heading */
  sections?: Record<string, string>;
  /** plain-English version for the human (STE) — a ## Simple section in the task file (TE-0178) */
  simple?: string;
}

/**
 * A discussion file's distilled layer — fixed sections in this order
 * (TE-0156). `## Summary`, `## Artifacts` and `## Notes` join them in
 * renderTaskBody; the rest can be filled through TaskDraft.sections.
 */
export const DISCUSSION_SECTIONS = [
  "Participants",
  "Context",
  "Key points",
  "Decisions reached",
  "Open questions",
  "Guidelines",
  "Actions",
] as const;

/** Body of a task file (without the `te:` frontmatter). */
export function renderTaskBody(d: TaskDraft): string {
  const idea = d.type === "idea";
  const discussion = d.type === "discussion";
  // ideas and discussions are source documents — no deps/touches/acceptance
  const source = idea || discussion;
  const block: string[] = [];
  if (!source) {
    const deps = d.depends_on?.length ? d.depends_on.join(", ") : "nothing";
    block.push(`**Depends on:** ${deps}`);
    if (d.parent) block.push(`**Parent:** ${d.parent}`);
  }
  if (d.relates?.length) block.push(`**Relates:** ${d.relates.join(", ")}`);
  if (d.found_by?.length) block.push(`**Found by:** ${d.found_by.join(", ")}`);
  if (!source) block.push(`**Touches:** ${d.touches?.length ? d.touches.join("; ") : "TBD"}`);
  const acceptance = d.acceptance?.length
    ? d.acceptance.map((a) => `- [ ] ${a.replace(/^-\s*(\[[ x]\]\s*)?/i, "")}`)
    : ["- [ ] TBD — the human or the planner fills this in before approval"];
  const checks = d.checks?.length ? renderChecks(d.checks) : "";
  return [
    `# ${d.title}`,
    "",
    ...(block.length ? [...block, ""] : []),
    "## Summary",
    (d.summary ?? d.title).trim(),
    "",
    ...(d.simple?.trim() ? ["## Simple", d.simple.trim(), ""] : []),
    ...(discussion
      ? DISCUSSION_SECTIONS.flatMap((h) => [`## ${h}`, (d.sections?.[h] ?? "").trim(), ""])
      : []),
    // an idea is a source document — no acceptance checklist
    ...(source ? [] : ["## Acceptance", ...acceptance, ""]),
    ...(source || !checks ? [] : ["## Checks", checks]),
    "## Artifacts",
    "",
    "## Notes",
    "",
  ].join("\n");
}

/** Full task file: `te:` frontmatter + body. */
export function renderTaskFile(d: TaskDraft): string {
  return withTeTag(renderTaskBody(d), d.id);
}

/** Plain-English companion (`X.simple.md`). */
export function renderSimpleFile(id: string, title: string, simple: string): string {
  return withTeTag(`# ${title} (simple)\n\n${simple.trim()}\n`, id);
}

/** `Mission re-run: reset seq!` → `mission-re-run-reset-seq` (≤ 48 chars, word-trimmed). */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= 48) return s || "task";
  const cut = s.slice(0, 48);
  // the cut ended exactly between two words → keep it; mid-word → drop the stub
  if (s[48] === "-") return cut;
  return cut.replace(/-[^-]*$/, "") || cut;
}

/** `TASK` for work items, `PHASE` for epics, `IDEA`/`DISC` for source documents. */
export function filePrefix(type: string): "TASK" | "PHASE" | "IDEA" | "FE" | "DISC" {
  return type === "epic"
    ? "PHASE"
    : type === "idea"
      ? "IDEA"
      : type === "feature"
        ? "FE"
        : type === "discussion"
          ? "DISC"
          : "TASK";
}

/**
 * Next free `<PREFIX>-NN` in a project folder: one above the highest number
 * used anywhere under it (done/ included, so numbers are never reused), two
 * digits minimum. `taken` adds numbers allocated earlier in the same batch.
 */
export function nextTaskNumber(dir: string, prefix: string, taken: Iterable<number> = []): number {
  const re = new RegExp(`^${prefix}-(\\d+)(?:[.-]|$)`, "i");
  let max = Math.max(0, ...taken);
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(join(d, e.name));
      else {
        const m = re.exec(e.name);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return max + 1;
}

/**
 * `TASK-NN-<slug>.md`. A title that carries its own number (`TASK-14 — Fix
 * x`, `PHASE-2: Y`) is slugged without it — the file gets the allocated one.
 */
export function taskFileName(prefix: string, n: number, title: string): string {
  const bare = title.replace(/^\s*(?:task|phase|idea|disc)[-\s]*[\d.]+[a-z]?\s*[—–:-]*\s*/i, "") || title;
  return `${prefix}-${String(n).padStart(2, "0")}-${slugify(bare)}.md`;
}

/**
 * How agents write text the human reads — and notes other agents work
 * from: ASD-STE100 Simplified Technical English. One definition, used by
 * `te agents-md`, GET /agent and `hello`; the write tools point at it.
 */
export const WRITING_RULES = `Write every text the human reads in ASD-STE100 Simplified Technical
English (STE) — and every note another agent works from:
- short sentences, one idea each, ~20 words max;
- active voice, present tense, one instruction per sentence;
- approved simple words only — one word, one meaning, used the same way
  everywhere ("show" not "indicate", "use" not "utilize");
- technical names stay as-is — functions, commands, file:line, field
  names; STE covers the prose around them.
Applies to: task titles, summaries, acceptance items, notes, the simple
version, questions, logs, walkthroughs, review text, handoffs.`;

/** Authoring rules for agent instruction files (`te agents-md`, GET /agent). */
export const AUTHORING_RULES = `Writing plans and tasks (overlay mode — the task folder is the plan)
- One task per file: <project>/TASK-<NN>-<slug>.md. Epics are PHASE-*.md or
  *-MEGAPLAN.md. The optional plain-English version for the human (in STE)
  is a ## Simple section in the task file.
- Ideas are IDEA-*.md — source documents (thoughts, specs, brainstorms) an
  agent can be asked to plan from. They are never claimed; tasks generated
  from one name it in "relates".
- Discussions are DISC-*.md — saved chats: a distilled summary plus the
  raw transcript in DISC-*.transcript.md. They are sources like ideas —
  never claimed; tasks name them in "relates". Save a chat with capture,
  read one with brief, and promote a guideline or decision line with
  promote — the human settles the result in the inbox.
- Every task file has: a "# Title", a "**Depends on:**" line (ids, or
  "nothing"), a "**Touches:**" line (repos/paths), and a "## Acceptance"
  checklist an agent can verify. Format: \`te template\`.
- Create tasks with propose (it writes the file from the template and
  tracks it) — never by hand. Work generated from an idea names it in
  "relates" (reference only — no ordering, no gate). Plain-English version
  for the human, in STE: simple <id> {text} (writes the task file's
  ## Simple section) — never by hand.
- Every task carries at least one domain (#tag). Give domains in propose,
  or they are inferred from the title/touches/summary — a proposal where
  nothing applies is refused. A fix (type bug, or fix/bug/defect/
  regression words in title or summary) always gets #bug.
- Never edit or remove the "te:" frontmatter line; never move files into
  done/ — status lives in TeamEngage, the human moves files.
- Notes worth keeping in a task: note <id> {text} (appends to its "## Notes").
  Other edits to existing task files: additive only (e.g. new "## Acceptance"
  items), each recorded with log.
- Scope is the human's. Never widen a task's "**Touches:**" or rewrite its
  acceptance — not while working, reviewing or taking over a fix. A commit
  that needs one or two files outside Touches declares them at submit
  (extra_touches + extra_touches_reason) — they show as 'outside scope'
  and the human judges them at acceptance. Work that needs more → propose
  a new task that depends on the original (its own Touches + acceptance);
  the human approves it and it is reviewed on its own.
  A task for a problem you found (a bug) names the item where you found it in
  found_by, not in depends_on. found_by is reference only: no ordering, no gate.
  Exceptions while a task is a draft: a planner may rewrite any of it with
  edit <id> {…fields, reason} (title, summary, acceptance, touches,
  depends_on, parent, tier, domains); rescope <id> still covers
  touches/add_acceptance. It stays a draft until the human approves again.
- A task that is stale, superseded, duplicated or wrong → flag_drop <id>
  {reason}. The human drops it or keeps it — agents never drop themselves.
`;

/** What `te template` prints: the standard, as a filled-in example. */
export const TEMPLATE_EXAMPLE = `<!-- <project>/TASK-<NN>-<slug>.md — written by propose; the te: line is added for you -->
${renderTaskBody({
  id: "XX-0000",
  type: "task",
  title: "TASK-14 — Clear latched events when a mission restarts",
  depends_on: ["GL-0019"],
  parent: "GL-0003",
  touches: ["droneengage_mavlink: src/mission/**", "droneengage_comm: src/de_mission/**"],
  summary:
    "When TASK-13 detects a mission restart, latched module events from the previous\n" +
    "run must be cleared so the second run fires them again.",
  acceptance: [
    "a second AUTO run of the same mission fires every module event again (SITL: tests/rerun.sh)",
    "jumping back to an earlier waypoint re-fires the events from that waypoint on",
    "unit test for the restart handler passes: ctest -R mission_restart",
  ],
})}`;
