import type { Event } from "../model/event.js";
import type { IndexedItem } from "../index/index.js";
import { isStale } from "../model/claim.js";

/**
 * Daily digest for the human (GL-0320). Reads only the event log and the
 * item index — nothing is stored. The window runs from the last human
 * action (or a --since the caller parsed) to now. Three lists:
 * finished (accepted items grouped by plan), stuck (holds, max_attempts,
 * stale claims, open questions) and waits-for-you (flagged submissions,
 * drafts to approve).
 */

export interface DigestLine {
  id: string;
  title: string;
  /** why the line is in the list ("stale claim", "draft to approve") */
  why?: string;
}

export interface Digest {
  /** ISO ts the window starts at */
  since: string;
  /** accepted/done items in the window, grouped by top-level plan */
  finished: { plan?: string; items: DigestLine[] }[];
  stuck: DigestLine[];
  waits: DigestLine[];
  warnings: string[];
}

const OPEN = new Set(["draft", "ready", "in_progress", "in_review", "waiting", "hold"]);

/** ts the digest covers — the last human event, or fallback when none. */
export function digestSince(events: Event[], fallback: string): string {
  let last: string | undefined;
  for (const e of events) if (e.actor === "human" && e.ts > (last ?? "")) last = e.ts;
  return last ?? fallback;
}

export function buildDigest(
  events: Event[],
  items: Map<string, IndexedItem>,
  opts: { since?: string; staleAfterMs: number; maxAttempts: number; now?: number },
): Digest {
  const now = opts.now ?? Date.now();
  const since = opts.since ?? digestSince(events, new Date(now - 24 * 3600_000).toISOString());
  const line = (id: string, why?: string): DigestLine => ({
    id,
    title: items.get(id)?.meta.title ?? "",
    ...(why ? { why } : {}),
  });
  const topPlan = (id: string): string | undefined => {
    const seen = new Set([id]);
    let p = items.get(id)?.meta.parent;
    while (p && !seen.has(p)) {
      seen.add(p);
      const a = items.get(p);
      if (!a) return undefined;
      if (a.meta.type === "epic") return p;
      p = a.meta.parent;
    }
    return undefined;
  };

  // finished: one line per item accepted/completed inside the window
  const done = new Map<string, string>(); // id → plan id
  for (const e of events) {
    if (!e.item || e.ts < since) continue;
    if (e.action === "accept" || e.action === "complete") done.set(e.item, topPlan(e.item) ?? "");
  }
  const plans = new Map<string, DigestLine[]>();
  for (const [id, plan] of [...done.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!plans.has(plan)) plans.set(plan, []);
    plans.get(plan)!.push(line(id));
  }
  const finished = [...plans.entries()].map(([plan, list]) => ({
    plan: plan || undefined,
    items: list,
  }));

  const stuck: DigestLine[] = [];
  const waits: DigestLine[] = [];
  for (const it of items.values()) {
    const m = it.meta;
    if (m.archived) continue;
    if (!OPEN.has(m.status)) continue;
    const why: string[] = [];
    if (m.status === "hold") why.push("on hold");
    if ((m.attempts ?? 0) >= opts.maxAttempts) why.push(`at max attempts (${opts.maxAttempts})`);
    if (it.claim && isStale(it.claim, opts.staleAfterMs, now)) why.push("stale claim");
    if (m.status === "waiting") why.push("question open");
    if (why.length) stuck.push(line(m.id, why.join(", ")));
    if (m.status === "in_review" && (m.ai_review?.needs_human || m.ai_review?.verdict === "issues")) {
      waits.push(line(m.id, m.ai_review.needs_human ? "review ok, needs your call" : "review flagged issues"));
    } else if (m.status === "draft") {
      waits.push(line(m.id, "draft to approve"));
    }
  }
  stuck.sort((a, b) => a.id.localeCompare(b.id));
  waits.sort((a, b) => a.id.localeCompare(b.id));
  return { since, finished, stuck, waits, warnings: [] };
}
