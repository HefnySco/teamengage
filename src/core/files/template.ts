import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { withTeTag } from "./source.js";

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
  /** repos / paths the work touches, free text (`droneengage_mavlink: src/mission/**`) */
  touches?: string[];
  /** checkable acceptance criteria, one per line */
  acceptance?: string[];
}

/** Body of a task file (without the `te:` frontmatter). */
export function renderTaskBody(d: TaskDraft): string {
  const deps = d.depends_on?.length ? d.depends_on.join(", ") : "nothing";
  const head = [`# ${d.title}`, "", `**Depends on:** ${deps}`];
  if (d.parent) head.push(`**Parent:** ${d.parent}`);
  head.push(`**Touches:** ${d.touches?.length ? d.touches.join("; ") : "TBD"}`);
  const acceptance = d.acceptance?.length
    ? d.acceptance.map((a) => `- [ ] ${a.replace(/^-\s*(\[[ x]\]\s*)?/i, "")}`)
    : ["- [ ] TBD — the human or the planner fills this in before approval"];
  return [
    ...head,
    "",
    "## Summary",
    (d.summary ?? d.title).trim(),
    "",
    "## Acceptance",
    ...acceptance,
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

/** `TASK` for work items, `PHASE` for epics. */
export function filePrefix(type: string): "TASK" | "PHASE" {
  return type === "epic" ? "PHASE" : "TASK";
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
  const bare = title.replace(/^\s*(?:task|phase)[-\s]*[\d.]+[a-z]?\s*[—–:-]*\s*/i, "") || title;
  return `${prefix}-${String(n).padStart(2, "0")}-${slugify(bare)}.md`;
}

/** Authoring rules for agent instruction files (`te agents-md`, GET /agent). */
export const AUTHORING_RULES = `Writing plans and tasks (overlay mode — the task folder is the plan)
- One task per file: <project>/TASK-<NN>-<slug>.md. Epics are PHASE-*.md or
  *-MEGAPLAN.md. Optional plain-English companion: X.simple.md.
- Every task file has: a "# Title", a "**Depends on:**" line (ids, or
  "nothing"), a "**Touches:**" line (repos/paths), and a "## Acceptance"
  checklist an agent can verify. Format: \`te template\`.
- Create tasks with propose (it writes the file from the template and
  tracks it) — never by hand.
- Never edit or remove the "te:" frontmatter line; never move files into
  done/ — status lives in TeamEngage, the human moves files.
- Existing task files: additive edits only — append to "## Acceptance" or
  "## Notes" — and record each edit with log.
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
