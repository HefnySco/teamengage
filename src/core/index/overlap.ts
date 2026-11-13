/**
 * Touches-path overlap between items (GL-0326). Target locks stop two
 * claims on the same resource; they don't see that two ready or
 * in-progress items name the same `**Touches:**` paths. Pure helpers —
 * the warning lives in claim/brief/board, never a refusal.
 */

export interface Touch {
  /** the part before the first colon — a repo/workspace name, "" for bare paths */
  repo: string;
  /** path or glob after the colon */
  path: string;
}

/** Parse the `**Touches:** repo: p1; repo2: p2` line of an item's text. */
export function parseTouches(text: string): Touch[] {
  const m = /^\**touches:?\**:?[ \t]*(.+)$/im.exec(text);
  if (!m) return [];
  return m[1]
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => {
      const i = e.indexOf(":");
      return i < 0
        ? { repo: "", path: e }
        : { repo: e.slice(0, i).trim(), path: e.slice(i + 1).trim() };
    })
    .filter((t) => t.path && t.path !== "TBD");
}

/** Does path `a` cover path `b`? Exact match, or a glob whose literal prefix reaches b. */
function covers(a: string, b: string): boolean {
  if (a === b) return true;
  const star = a.indexOf("*");
  if (star < 0) return false;
  return b.startsWith(a.slice(0, star));
}

/** Two touches paths overlap when either covers the other. */
export function pathOverlap(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a);
}

/**
 * The `repo:path` texts of `theirs` that `mine` overlaps — same repo only
 * (different repos never warn). De-duplicated.
 */
export function touchesOverlap(mine: Touch[], theirs: Touch[]): string[] {
  const out = new Set<string>();
  for (const m of mine)
    for (const t of theirs)
      if (m.repo === t.repo && pathOverlap(m.path, t.path)) out.add(`${t.repo}: ${t.path}`);
  return [...out];
}
