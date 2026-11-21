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

/** tiny glob: `*` → any run, `?` → one char; anchored, case already folded. */
function globRe(pattern: string): RegExp {
  return new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
}

/**
 * Agent kind for a session name (GL-0364). `agent_kinds` in workspace.yaml
 * maps kind → glob patterns; the first matching pattern (config order)
 * wins, compared in lowercase — `Forge` and `forge` are one kind. With no
 * match the kind is the text before the first `-`/`_`, so `devin-sl0005`
 * and `devin-fix-de0040` both roll up to `devin`.
 */
export function agentKind(name: string, kinds?: Record<string, string[]>): string {
  const lower = name.toLowerCase();
  for (const [kind, patterns] of Object.entries(kinds ?? {})) {
    if (patterns.some((p) => globRe(p.toLowerCase()).test(lower))) return kind;
  }
  const cut = lower.search(/[-_]/);
  return cut > 0 ? lower.slice(0, cut) : lower;
}

/**
 * Model id for a session name — `agent_models` in workspace.yaml maps
 * model → globs on the agent name, same rules as agent_kinds (lowercase,
 * first match wins). Fallback for events with no declared model —
 * everything from before GL-0360 and sessions that never declare one.
 * No match → undefined, the caller keeps "unknown".
 */
export function agentModel(name: string, models?: Record<string, string[]>): string | undefined {
  const lower = name.toLowerCase();
  for (const [model, patterns] of Object.entries(models ?? {})) {
    if (patterns.some((p) => globRe(p.toLowerCase()).test(lower))) return model;
  }
  return undefined;
}

/** Declared model on the event, else the actor-name fallback, else "unknown". */
function eventModel(e: Event, models?: Record<string, string[]>): string {
  const declared = e.data?.model as string | undefined;
  if (declared) return declared;
  const name = agentName(e.actor);
  return (name && agentModel(name, models)) || "unknown";
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
  /** GL-0365: every model that produced a submit (a submit with none counts as "unknown") */
  models: Set<string>;
  /** reported run cost summed over submits (GL-0318) */
  tokens_in: number;
  tokens_out: number;
  usd: number;
}

export function deriveMetrics(events: Event[], agentModels?: Record<string, string[]>): Map<string, ItemMetrics> {
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
        models: new Set<string>(),
        tokens_in: 0,
        tokens_out: 0,
        usd: 0,
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
        m.models.add(eventModel(e, agentModels));
        const cost = e.data?.cost as { tokens_in?: number; tokens_out?: number; usd?: number } | undefined;
        if (cost) {
          if (typeof cost.tokens_in === "number") m.tokens_in += cost.tokens_in;
          if (typeof cost.tokens_out === "number") m.tokens_out += cost.tokens_out;
          if (typeof cost.usd === "number") m.usd += cost.usd;
        }
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
      case "review":
        // TE-0175: an issues verdict is the send-back now — it counts as a bounce
        if ((e.note ?? "").startsWith("issues")) m.bounces++;
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
  /** reported run cost summed over the items' submits (GL-0318) */
  tokens_in: number;
  tokens_out: number;
  usd: number;
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
      tokens_in: a.tokens_in + m.tokens_in,
      tokens_out: a.tokens_out + m.tokens_out,
      usd: a.usd + m.usd,
    }),
    {
      items: 0,
      done: 0,
      claims: 0,
      review_rounds: 0,
      bounces: 0,
      handoffs: 0,
      rejects: 0,
      tokens_in: 0,
      tokens_out: 0,
      usd: 0,
    },
  );
  return {
    ...sums,
    bounce_rate: sums.review_rounds ? sums.bounces / sums.review_rounds : undefined,
    median_claim_to_submit_ms: median(flat("claim_to_submit_ms")),
    median_submit_to_accept_ms: median(flat("submit_to_accept_ms")),
    median_claim_to_accept_ms: median(flat("claim_to_accept_ms")),
  };
}

/** One verdict event behind a reviewer count — the drill-down lists these. */
export interface ReviewRef {
  item: string;
  /** the verdict's ts — for wrong_ok the reject that caught it */
  ts: string;
  /** session that wrote the verdict */
  actor?: string;
}

export interface ReviewerRow {
  model: string;
  ok: number;
  issues: number;
  /** ok verdicts the human later rejected — the wrong calls (GL-0365) */
  wrong_ok: number;
  /** the item ids behind each count — the UI's drill-down lists */
  ok_items: string[];
  issues_items: string[];
  wrong_ok_items: string[];
  /** the verdict events behind each count — one row per verdict, items repeat */
  ok_events: ReviewRef[];
  issues_events: ReviewRef[];
  wrong_ok_events: ReviewRef[];
}

/**
 * Per-reviewer-model verdict counts (GL-0365). `review` events carry the
 * verdict in the note ("ok", "issues", optionally ": note"); a `bounce`
 * counts as an issues verdict. An `ok` verdict the human later rejects —
 * before any resubmit — is a wrong ok. Events with no declared model fall
 * back to `agent_models` on the actor name, then land in "unknown".
 */
export function deriveReviewers(events: Event[], agentModels?: Record<string, string[]>): ReviewerRow[] {
  const rows = new Map<
    string,
    {
      ok: number;
      issues: number;
      wrong_ok: number;
      ok_items: Set<string>;
      issues_items: Set<string>;
      wrong_ok_items: Set<string>;
      ok_events: ReviewRef[];
      issues_events: ReviewRef[];
      wrong_ok_events: ReviewRef[];
    }
  >();
  const lastReview = new Map<string, { ok: boolean; model: string; actor?: string }>();
  const row = (model: string) => {
    let r = rows.get(model);
    if (!r) {
      r = {
        ok: 0,
        issues: 0,
        wrong_ok: 0,
        ok_items: new Set<string>(),
        issues_items: new Set<string>(),
        wrong_ok_items: new Set<string>(),
        ok_events: [],
        issues_events: [],
        wrong_ok_events: [],
      };
      rows.set(model, r);
    }
    return r;
  };
  for (const e of events) {
    if (!e.item || !e.ts) continue;
    const model = eventModel(e, agentModels);
    switch (e.action) {
      case "review": {
        const ok = (e.note ?? "").split(":")[0].trim() === "ok";
        lastReview.set(e.item, { ok, model, actor: e.actor });
        const r = row(model);
        const ref = { item: e.item, ts: e.ts, actor: e.actor };
        if (ok) {
          r.ok++;
          r.ok_items.add(e.item);
          r.ok_events.push(ref);
        } else {
          r.issues++;
          r.issues_items.add(e.item);
          r.issues_events.push(ref);
        }
        break;
      }
      case "bounce": {
        lastReview.set(e.item, { ok: false, model, actor: e.actor });
        const r = row(model);
        r.issues++;
        r.issues_items.add(e.item);
        r.issues_events.push({ item: e.item, ts: e.ts, actor: e.actor });
        break;
      }
      case "submit":
        lastReview.delete(e.item);
        break;
      case "reject": {
        const lr = lastReview.get(e.item);
        if (lr?.ok && e.actor === "human") {
          const r = row(lr.model);
          r.wrong_ok++;
          r.wrong_ok_items.add(e.item);
          r.wrong_ok_events.push({ item: e.item, ts: e.ts, actor: lr.actor });
        }
        lastReview.delete(e.item);
        break;
      }
      case "accept":
      case "complete":
        lastReview.delete(e.item);
        break;
    }
  }
  return [...rows.entries()]
    .map(([model, r]) => ({
      model,
      ok: r.ok,
      issues: r.issues,
      wrong_ok: r.wrong_ok,
      ok_items: [...r.ok_items].sort(),
      issues_items: [...r.issues_items].sort(),
      wrong_ok_items: [...r.wrong_ok_items].sort(),
      ok_events: r.ok_events,
      issues_events: r.issues_events,
      wrong_ok_events: r.wrong_ok_events,
    }))
    .sort((a, b) => b.ok + b.issues - (a.ok + a.issues) || a.model.localeCompare(b.model));
}
