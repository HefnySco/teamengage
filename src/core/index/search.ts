/**
 * Deep search over finished work, decisions and lessons (GL-0354). Plain
 * in-memory word matching — every query word must occur in the doc, ranked
 * by match count, one ≤30-word snippet per hit. No database.
 */

export interface SearchDoc {
  kind: "item" | "decision" | "lesson" | "discussion" | "transcript";
  id: string;
  title: string;
  domains: string[];
  /** last activity stamp — tie-break, newest first */
  date: string;
  /** the whole searchable text */
  text: string;
}

export interface SearchHit {
  kind: SearchDoc["kind"];
  id: string;
  title: string;
  snippet: string;
  score: number;
}

const wordsOf = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** A ≤`maxWords`-word window around the first query word in `text`. */
export function makeSnippet(text: string, words: string[], maxWords = 30): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  let at = tokens.length;
  const low = tokens.map((t) => t.toLowerCase());
  for (const w of words) {
    const i = low.findIndex((t) => t.includes(w));
    if (i >= 0 && i < at) at = i;
  }
  if (at === tokens.length) at = 0;
  const from = Math.max(0, at - 5);
  const slice = tokens.slice(from, from + maxWords);
  return `${from > 0 ? "…" : ""}${slice.join(" ")}${from + slice.length < tokens.length ? "…" : ""}`;
}

/**
 * All query words must occur. Score = title hits ×5 + body hits (capped at
 * 5 per word). Ties: newer `date`, then id.
 */
export function searchDocs(
  docs: SearchDoc[],
  text: string,
  opts: { domain?: string; limit?: number } = {},
): SearchHit[] {
  const words = wordsOf(text);
  if (!words.length) return [];
  const hits: SearchHit[] = [];
  for (const d of docs) {
    if (opts.domain && !d.domains.includes(opts.domain)) continue;
    const body = d.text.toLowerCase();
    const title = d.title.toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      let n = 0;
      let at = 0;
      while ((at = body.indexOf(w, at)) >= 0 && n < 5) {
        n++;
        at += w.length;
      }
      const inTitle = title.includes(w);
      if (!n && !inTitle) {
        ok = false;
        break;
      }
      score += n + (inTitle ? 5 : 0);
    }
    if (ok) hits.push({ kind: d.kind, id: d.id, title: d.title, snippet: makeSnippet(d.text, words), score });
  }
  const byId = new Map(docs.map((d) => [d.kind + ":" + d.id, d]));
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (byId.get(b.kind + ":" + b.id)?.date ?? "").localeCompare(byId.get(a.kind + ":" + a.id)?.date ?? "") ||
      a.id.localeCompare(b.id),
  );
  return hits.slice(0, opts.limit ?? 10);
}
