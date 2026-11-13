import type { Event } from "../model/event.js";

/**
 * Derived metrics from the merged event log (GL-0317). Nothing is stored —
 * every call replays the events in ts order. Per item: claim→submit and
 * submit→accept durations, review rounds (one per submit), bounces and
 * handoffs. `rollUp` then aggregates a set of item stats — the callers use it
 * for per-agent, per-tier, per-domain and per-plan views.
 */

/** Agent name from a session actor (`devin-desktop@mhefnyDT#1419` → `devin-desktop`). */
export function agentName(actor: string): string | undefined {
  if (!actor || actor === "human" || actor === "daemon") return undefined;
  const name = actor.split("@")[0];
  return name || undefined;
}

export interface ItemMetrics {
  id: string;
  claims: number;
  /** submit events — each submit is one review round */
  review_rounds: number;
  bounces: number;
  handoffs: number;
  rejects: number;
  /** accept + complete events (terminal → done) */
  done: number;
  /** ms from the claim that opened each working round to its submit */
  claim_to_submit_ms: number[];
  /** ms from each submit to the accept/complete that closed the review */
  submit_to_accept_ms: number[];
  /** ms from the last claim before each terminal accept */
  claim_to_accept_ms: number[];
  /** agent name of the most recent submit — the item's work is credited to it */
  worker?: string;
}

export function deriveMetrics(events: Event[]): Map<string, ItemMetrics> {
  const per = new Map<string, ItemMetrics>();
  const lastClaimTs = new Map<string, number>();
  const lastSubmitTs = new Map<string, number>();
  const ms = (ts: string) => Date.parse(ts);
  const item = (id: string): ItemMetrics => {
    let m = per.get(id);
    if (!m) {
      m = {
        id,
        claims: 0,
        review_rounds: 0,
        bounces: 0,
        handoffs: 0,
        rejects: 0,
        done: 0,
        claim_to_submit_ms: [],
        submit_to_accept_ms: [],
        claim_to_accept_ms: [],
      };
      per.set(id, m);
    }
    return m;
  };
  for (const e of events) {
    if (!e.item || !e.ts) continue;
    const m = item(e.item);
    switch (e.action) {
      case "claim":
        m.claims++;
        lastClaimTs.set(e.item, ms(e.ts));
        break;
      case "submit": {
        m.review_rounds++;
        const c = lastClaimTs.get(e.item);
        if (c !== undefined) m.claim_to_submit_ms.push(ms(e.ts) - c);
        lastSubmitTs.set(e.item, ms(e.ts));
        const w = agentName(e.actor);
        if (w) m.worker = w;
        break;
      }
      case "accept":
      case "complete": {
        m.done++;
        const s = lastSubmitTs.get(e.item);
        if (s !== undefined) m.submit_to_accept_ms.push(ms(e.ts) - s);
        const c = lastClaimTs.get(e.item);
        if (c !== undefined) m.claim_to_accept_ms.push(ms(e.ts) - c);
        break;
      }
      case "bounce":
        m.bounces++;
        break;
      case "handoff":
        m.handoffs++;
        break;
      case "reject":
        m.rejects++;
        break;
    }
  }
  return per;
}

export function median(ns: number[]): number | undefined {
  if (!ns.length) return undefined;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface Rollup {
  items: number;
  done: number;
  claims: number;
  review_rounds: number;
  bounces: number;
  handoffs: number;
  rejects: number;
  /** bounces / review_rounds, 0..1 — undefined when nothing was submitted */
  bounce_rate?: number;
  median_claim_to_submit_ms?: number;
  median_submit_to_accept_ms?: number;
  median_claim_to_accept_ms?: number;
}

/** Aggregate a set of per-item stats into one row. */
export function rollUp(stats: ItemMetrics[]): Rollup {
  const flat = (key: "claim_to_submit_ms" | "submit_to_accept_ms" | "claim_to_accept_ms") =>
    stats.flatMap((m) => m[key]);
  const sums = stats.reduce(
    (a, m) => ({
      items: a.items + 1,
      done: a.done + m.done,
      claims: a.claims + m.claims,
      review_rounds: a.review_rounds + m.review_rounds,
      bounces: a.bounces + m.bounces,
      handoffs: a.handoffs + m.handoffs,
      rejects: a.rejects + m.rejects,
    }),
    { items: 0, done: 0, claims: 0, review_rounds: 0, bounces: 0, handoffs: 0, rejects: 0 },
  );
  return {
    ...sums,
    bounce_rate: sums.review_rounds ? sums.bounces / sums.review_rounds : undefined,
    median_claim_to_submit_ms: median(flat("claim_to_submit_ms")),
    median_submit_to_accept_ms: median(flat("submit_to_accept_ms")),
    median_claim_to_accept_ms: median(flat("claim_to_accept_ms")),
  };
}
