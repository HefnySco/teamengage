/**
 * History by file path (GL-0353): the finished items that changed a path —
 * matched by their `**Touches:**` globs and by the files of their Evidence
 * commits. Pure helpers; the WorkspaceOps wrapper resolves repo names to
 * local checkouts and runs git.
 */

import type { IndexedItem } from "./index.js";
import type { Status } from "../model/index.js";
import { covers, type Touch } from "./overlap.js";

export interface HistoryRow {
  id: string;
  title: string;
  /** last ## Log timestamp, else meta.updated — may be "" */
  date: string;
  /** the `what:` line, or the first walkthrough sentence for old items */
  what: string;
  /** problem items found here, still open */
  problems: { id: string; status: Status }[];
}

export interface HistoryQuery {
  path: string;
  /** limit matching to Touches/commits of this repo name */
  repo?: string;
  limit?: number;
}

const section = (it: IndexedItem, name: string) =>
  it.sections.find((s) => s.heading.toLowerCase() === name.toLowerCase())?.body ?? "";

/**
 * `repo@sha` (+ extra `+ sha`) pairs from an item's `## Evidence` — one entry
 * per `- commit` line. Bare-sha lines carry no repo and are skipped: they
 * cannot be resolved to a checkout.
 */
export function evidenceCommits(it: IndexedItem): { repo: string; shas: string[] }[] {
  const out: { repo: string; shas: string[] }[] = [];
  for (const line of section(it, "Evidence").split("\n")) {
    const m = /^- commit\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const first = /^(\S+)@([0-9a-f]{7,40})\b/.exec(m[1]);
    if (!first) continue;
    const shas = [first[2]];
    for (const extra of m[1].matchAll(/\+\s*([0-9a-f]{7,40})\b/g)) shas.push(extra[1]);
    out.push({ repo: first[1], shas });
  }
  return out;
}

/** True when the item's Touches glob covers the queried path (same repo, when given). */
export function touchMatches(touch: Touch, q: HistoryQuery): boolean {
  if (q.repo !== undefined && touch.repo !== q.repo) return false;
  const pattern = touch.path.endsWith("/") ? `${touch.path}**` : touch.path;
  return covers(pattern, q.path);
}

/**
 * True when a commit's changed files contain the queried path — the file
 * itself, a file under it (dir query) or a file its glob covers.
 */
export function fileMatches(files: string[], path: string): boolean {
  const dir = path.endsWith("/") ? path : `${path}/`;
  return files.some((f) => f === path || f.startsWith(dir) || covers(path, f));
}

/** The one-line row history/brief show for a finished item. */
export function historyRow(it: IndexedItem): HistoryRow {
  let what =
    [...section(it, "For the human").matchAll(/^- what:\s*(.+)$/gm)].map((m) => m[1]).at(-1)?.trim() ??
    "";
  if (!what) {
    // old items predate ## For the human — first walkthrough sentence instead
    const first = section(it, "Walkthrough")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (first) {
      const m = /^(.{3,240}?[.!?])(?=\s|$)/.exec(first);
      what = m ? m[1] : first.slice(0, 240);
    }
  }
  const stamps = [
    ...section(it, "Log").matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g),
  ].map((m) => m[0]);
  return {
    id: it.meta.id,
    title: it.meta.title,
    date: stamps.at(-1) ?? it.meta.updated ?? "",
    what,
    problems: it.found_here.filter((f) => f.status !== "done" && f.status !== "dropped"),
  };
}

/** Compact text form shared by the history tool and `te history`. */
export function historyLine(r: HistoryRow): string {
  const date = r.date ? `${r.date.slice(0, 10)} ` : "";
  const problems = r.problems.length
    ? ` [open problems: ${r.problems.map((p) => `${p.id} ${p.status}`).join(", ")}]`
    : "";
  return `${r.id} ${date}"${r.title}"${r.what ? ` — ${r.what}` : ""}${problems}`;
}
