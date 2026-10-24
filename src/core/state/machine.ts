import type { Claim } from "../model/claim.js";
import type { AiReview, ItemMeta, Question, StarColor, Status, Tier } from "../model/item.js";
import { nextTier, tierRank } from "../model/item.js";
import type { Event } from "../model/event.js";
import {
  ForbiddenError,
  InvalidTransitionError,
  ClaimRefusedError,
} from "../model/errors.js";

/**
 * Pure state machine (DESIGN §5). No I/O: side effects the daemon must perform
 * (claim file, merge, worktrees, decision file) are returned as `effects`.
 */

export type ActorKind = "agent" | "human" | "daemon";

export interface Actor {
  kind: ActorKind;
  /** Session id (`agent@machine#hex`) or `human`/`daemon`. */
  session: string;
  machine: string;
  /** declared model tier of an agent session (unset = not tier-limited) */
  tier?: Tier;
}

export type Action =
  | { type: "approve_plan" }
  | { type: "propose" }
  | { type: "claim"; claim: Claim }
  | { type: "release"; note?: string }
  | { type: "log"; note: string }
  | { type: "ask"; question: Question }
  | { type: "answer"; decisionId: string; decisionTitle: string }
  /** Human revises the answer already given (the item's latest decision). */
  | { type: "change_answer"; decisionId: string; decisionTitle: string; previous: string }
  | {
      type: "submit";
      note?: string;
      evidence?: { commits?: string[]; tests?: string; notes?: string };
    }
  /**
   * A second agent session records a peer review of the submission
   * (advisory: no status change, the human still accepts). Not the holder.
   * `summary` is the plain-English line for the human; `note` the technical
   * detail for whoever fixes it.
   */
  | { type: "review"; verdict: AiReview["verdict"]; note?: string; summary?: string }
  /**
   * A second agent session bounces a broken submission back to its holder
   * (in_review → in_progress, claim kept). Capped: after MAX_AI_BOUNCES in
   * a row the item stays in review for the human (record a review instead).
   */
  | { type: "bounce"; reason: string; summary?: string }
  /**
   * The holder is stuck: it stops, writes down the problem, what it tried
   * and where it left off, and gives the item back for a fresh session
   * (claim released, branches kept). Counts as a failed attempt.
   */
  | { type: "handoff"; problem: string; tried: string; state?: string; next?: string }
  /**
   * A session stronger than the draft's author checks a light-authored
   * draft. Annotation only; under solo the daemon approves an `ok`.
   */
  | { type: "vet"; verdict: "ok" | "issues"; note?: string }
  /** Human sets (or clears) the model tier an item needs; reset clears attempts. */
  | { type: "set_tier"; tier?: Tier; reset?: boolean }
  | { type: "accept" }
  /**
   * Human reject of a submission: back to in_progress, claim kept (the
   * holder fixes and resubmits). `release` instead sends it to ready —
   * the claim is freed for another agent while its branch is kept, so the
   * next claim resumes the same work rather than restarting.
   */
  | { type: "reject"; reason?: string; release?: boolean }
  /**
   * Agent asks the human to drop this item: sets `drop_request` (advisory —
   * the status is untouched). Any session may flag, including the holder.
   */
  | { type: "flag_drop"; reason?: string }
  /** Human dismisses a drop flag — the item stays. */
  | { type: "unflag_drop" }
  | { type: "drop"; reason?: string }
  /** Restore a dropped item to draft (re-approval required before claim). */
  | { type: "undrop" }
  /**
   * Human marks an item done from any status (e.g. work finished outside
   * TeamEngage). No review, no merge: a claim is released, branches kept.
   */
  | { type: "complete"; note?: string }
  /** Human parks an item: not a draft, but not for agents yet. */
  | { type: "hold"; reason?: string }
  /** Human releases a hold → ready. */
  | { type: "unhold" }
  /**
   * Human sends a ready, held or done item back to draft (re-approval
   * needed). `done` may have been set by mistake — drafting it reopens the
   * normal draft → ready → in_progress path.
   */
  | { type: "to_draft"; reason?: string }
  /** Human hides an item (any status, unclaimed); the status is kept. */
  | { type: "archive"; reason?: string }
  | { type: "unarchive" }
  /** Human bookmarks an item (any status, even claimed); a different colour re-stars it. */
  | { type: "star"; color?: StarColor }
  | { type: "unstar" }
  /**
   * Human closes a plan (epic): no more parts are coming — plan_state turns
   * active, then done when every part finishes. Status is untouched.
   */
  | { type: "close_plan" }
  /** Human reopens a closed plan (epic) — more parts may still be added. */
  | { type: "reopen_plan" }
  /** Internal: merge on accept hit conflicts — bounce back to the agent. */
  | { type: "merge_conflict"; conflicts: string[] };

export interface TransitionCtx {
  /** ISO timestamp for updated/log lines. */
  now: string;
  /** The item's current claim file, if any. */
  claim?: Claim | null;
  /** Whether all depends_on items are done (needed for claim). */
  depsDone?: boolean;
  /** Id of an ancestor plan on hold — a held plan pauses its subtree, claim refused. */
  planHold?: string;
  /** AI bounces this item already took since the last human action (bounce cap). */
  priorBounces?: number;
  /** workspace escalate_after / max_attempts (defaults 2 / 5) */
  escalation?: { after: number; max: number };
  /**
   * The claim's holder can't act from this daemon: it lives on another
   * machine or its session is no longer live. An `issues` verdict or a
   * bounce on such an item releases the claim to `ready` instead of sending
   * it back to a session that will never answer (never set for human claims).
   */
  holderAway?: boolean;
}

export type Effect =
  | { type: "write_claim"; claim: Claim }
  | { type: "delete_claim" }
  | { type: "setup_work" } // worktrees / snapshots for the claim's targets
  | { type: "cleanup_work"; keepBranches?: boolean }
  | { type: "merge_required" }
  | { type: "create_decision"; decisionId: string; title: string; question?: Question }
  | { type: "update_decision"; decisionId: string; title: string };

export interface TransitionResult {
  meta: ItemMeta;
  log: string[];
  events: Omit<Event, "seq">[];
  effects: Effect[];
  /** Text to append to named body sections (e.g. ## Evidence on submit). */
  sectionWrites: Array<{ heading: string; text: string }>;
}

const TERMINAL: Status[] = ["done", "dropped"];

/** After this many consecutive AI bounces the item stays in review for the human. */
export const MAX_AI_BOUNCES = 2;

/**
 * One more failed attempt (AI bounce or handoff). Every `after` attempts the
 * item's tier goes up a step; at `max` it is held for the human.
 */
function recordFailure(
  meta: ItemMeta,
  out: TransitionResult,
  ctx: TransitionCtx,
): { held: boolean; escalated?: Tier } {
  const attempts = (meta.attempts ?? 0) + 1;
  out.meta.attempts = attempts;
  const after = ctx.escalation?.after ?? 2;
  const max = ctx.escalation?.max ?? 5;
  if (attempts >= max) return { held: true };
  if (attempts % after !== 0) return { held: false };
  const base = meta.tier ?? ctx.claim?.tier ?? "standard";
  const up = nextTier(base);
  if (tierRank(up) <= tierRank(meta.tier)) return { held: false };
  out.meta.tier = up;
  return { held: false, escalated: up };
}

function fail(from: Status, action: string): never {
  throw new InvalidTransitionError(`cannot ${action} from ${from}`, from, action);
}

function requireHuman(actor: Actor, action: string): void {
  if (actor.kind !== "human") {
    throw new ForbiddenError(`${action} is a human-only action`);
  }
}

/**
 * Human, or the daemon acting for the human under `autonomy: solo` (the
 * daemon only does so through the solo paths in ops — never on an agent's say).
 */
function requireHumanOrDaemon(actor: Actor, action: string): void {
  if (actor.kind !== "human" && actor.kind !== "daemon") {
    throw new ForbiddenError(`${action} is a human-only action`);
  }
}

/**
 * Peer review of a submission is a *second opinion*: agent-only, and never
 * the holder — reviewing your own work would just manufacture a trust marker.
 */
function requireReviewer(actor: Actor, ctx: TransitionCtx, action: string): void {
  if (actor.kind !== "agent") {
    throw new ForbiddenError(`${action} is an agent-only action (the human has accept/reject)`);
  }
  if (ctx.claim && ctx.claim.holder === actor.session) {
    throw new ForbiddenError(`${action}: the holder may not review its own submission`);
  }
}

function requireHolder(actor: Actor, ctx: TransitionCtx, action: string): Claim {
  const claim = ctx.claim;
  if (!claim) throw new InvalidTransitionError(`cannot ${action}: item is not claimed`, undefined, action);
  if (actor.kind === "human") return claim;
  if (claim.holder !== actor.session) {
    throw new ForbiddenError(`${action}: held by ${claim.holder}@${claim.machine}`);
  }
  return claim;
}

function ev(
  actor: Actor,
  ts: string,
  item: string,
  action: string,
  from: Status,
  to: Status,
  note?: string,
) {
  const e: Omit<Event, "seq"> = {
    ts,
    machine: actor.machine,
    actor: actor.session,
    session: actor.kind === "agent" ? actor.session : undefined,
    item,
    action,
    from,
    to,
    note,
  };
  return e;
}

/**
 * Apply `action` to `meta`. Returns the new meta (status, question, updated)
 * plus log lines, event records and daemon effects — or throws a typed error.
 */
export function transition(
  meta: ItemMeta,
  action: Action,
  actor: Actor,
  ctx: TransitionCtx,
): TransitionResult {
  const from = meta.status;
  const out: TransitionResult = {
    meta: { ...meta, updated: ctx.now },
    log: [],
    events: [],
    effects: [],
    sectionWrites: [],
  };
  const who = actor.session;
  const stamp = ctx.now;

  const set = (to: Status, note?: string) => {
    out.meta.status = to;
    out.events.push(ev(actor, stamp, meta.id, action.type, from, to, note));
  };

  switch (action.type) {
    case "propose": {
      // Agents and humans may create items, but only as draft (DESIGN §5).
      if (from !== "draft") fail(from, action.type);
      out.events.push(ev(actor, stamp, meta.id, "propose", from, from));
      return out;
    }

    case "approve_plan": {
      requireHumanOrDaemon(actor, action.type);
      if (from !== "draft") fail(from, action.type);
      set("ready");
      out.log.push(`- ${stamp} ${who} approved plan`);
      return out;
    }

    case "claim": {
      // takeover: an AI-flagged submission (in_review + issues) can be
      // picked up for the fix by any agent on the claim's machine — the
      // holder re-claims or a fresh session takes the claim over. The
      // worktree is machine-local, so cross-machine takeover stays refused.
      // The same applies to an in_progress item whose holder can't act from
      // this daemon (dead session): it would strand otherwise — a session
      // on the claim's machine takes claim, worktree and branch over. A
      // live holder keeps its claim — a second window must not steal work.
      const takeover =
        actor.kind === "agent" &&
        !!ctx.claim &&
        ctx.claim.machine === actor.machine &&
        ((from === "in_review" && meta.ai_review?.verdict === "issues") ||
          (from === "in_progress" && ctx.holderAway === true));
      if (from !== "ready" && !takeover) fail(from, action.type);
      if (meta.type === "epic") {
        throw new ClaimRefusedError("epics are plans — claim their tasks");
      }
      if (meta.type === "idea") {
        throw new ClaimRefusedError("ideas are sources — plan from them");
      }
      if (meta.archived) throw new InvalidTransitionError("cannot claim: item is archived — unarchive first", from, "claim");
      if (actor.kind === "daemon") throw new ForbiddenError("daemon cannot claim");
      if (ctx.planHold) {
        throw new InvalidTransitionError(
          `cannot claim: plan ${ctx.planHold} is on hold — everything under it is paused`,
          from,
          "claim",
        );
      }
      if (ctx.depsDone === false) {
        throw new InvalidTransitionError("cannot claim: dependencies not done", from, "claim");
      }
      // a takeover fixes a flagged submission: one more failed attempt
      // (may raise the tier — checked below — or run out: the human decides)
      if (takeover) {
        const f = recordFailure(meta, out, ctx);
        if (f.held) {
          throw new ForbiddenError(
            `takeover: ${out.meta.attempts} failed attempts — out of attempts, the human decides`,
          );
        }
      }
      const need = out.meta.tier;
      if (need && actor.tier && tierRank(actor.tier) < tierRank(need)) {
        throw new ClaimRefusedError(
          `needs a ${need}-tier agent (you are ${actor.tier})${out.meta.attempts ? ` — ${out.meta.attempts} failed attempt(s) so far` : ""}`,
        );
      }
      if (ctx.claim && !takeover) {
        throw new ClaimRefusedError(
          `already claimed by ${ctx.claim.holder} on ${ctx.claim.machine} — release on ${ctx.claim.machine} or by the human here`,
          ctx.claim.holder,
          ctx.claim.machine,
        );
      }
      set("in_progress");
      out.log.push(
        takeover
          ? from === "in_progress"
            ? `- ${stamp} ${who} took over from ${ctx.claim!.holder} — its session can't act here`
            : `- ${stamp} ${who} took over the fix${ctx.claim!.holder !== who ? ` (was ${ctx.claim!.holder})` : ""}`
          : `- ${stamp} ${who} claimed`,
      );
      out.effects.push({ type: "write_claim", claim: action.claim });
      out.effects.push({ type: "setup_work" });
      return out;
    }

    case "release": {
      const claim = requireHolder(actor, ctx, action.type);
      if (from !== "in_progress" && from !== "waiting") fail(from, action.type);
      set("ready", action.note);
      out.log.push(
        `- ${stamp} ${who} released${claim.holder !== who ? ` (was ${claim.holder})` : ""}${action.note ? `: ${action.note}` : ""}`,
      );
      out.effects.push({ type: "delete_claim" });
      out.effects.push({ type: "cleanup_work", keepBranches: true });
      return out;
    }

    case "log": {
      requireHolder(actor, ctx, action.type);
      if (from !== "in_progress") fail(from, action.type);
      out.log.push(`- ${stamp} ${who} ${action.note}`);
      out.events.push(ev(actor, stamp, meta.id, "log", from, from, action.note));
      return out;
    }

    case "ask": {
      requireHolder(actor, ctx, action.type);
      if (from !== "in_progress") fail(from, action.type);
      out.meta.question = action.question;
      set("waiting");
      out.log.push(`- ${stamp} ${who} asked: ${action.question.text}`);
      return out;
    }

    case "answer": {
      requireHuman(actor, action.type);
      if (from !== "waiting") fail(from, action.type);
      delete out.meta.question;
      set("in_progress");
      out.log.push(`- ${stamp} ${who} answered → ${action.decisionId}`);
      out.effects.push({
        type: "create_decision",
        decisionId: action.decisionId,
        title: action.decisionTitle,
        // keep what was asked: the item's question is cleared on answer
        ...(meta.question ? { question: meta.question } : {}),
      });
      return out;
    }

    case "change_answer": {
      requireHuman(actor, action.type);
      // the human may revise an answer until the item is closed; a closed
      // item's answer is part of the record
      if (TERMINAL.includes(from)) fail(from, action.type);
      out.log.push(
        `- ${stamp} ${who} changed answer ${action.decisionId}: "${action.previous}" → "${action.decisionTitle}"`,
      );
      out.events.push(ev(actor, stamp, meta.id, action.type, from, from, action.decisionTitle));
      out.effects.push({
        type: "update_decision",
        decisionId: action.decisionId,
        title: action.decisionTitle,
      });
      return out;
    }

    case "submit": {
      requireHolder(actor, ctx, action.type);
      if (from !== "in_progress") fail(from, action.type);
      set("in_review", action.note);
      delete out.meta.ai_review; // a fresh submission starts unreviewed
      delete out.meta.auto_accept_off; // …and is eligible for auto-accept again
      out.log.push(`- ${stamp} ${who} submitted for review${action.note ? `: ${action.note}` : ""}`);
      if (action.evidence) {
        const lines: string[] = [];
        for (const c of action.evidence.commits ?? []) lines.push(`- commit ${c}`);
        if (action.evidence.tests) lines.push(`- tests: ${action.evidence.tests}`);
        if (action.evidence.notes) lines.push(`- ${action.evidence.notes}`);
        if (lines.length) out.sectionWrites.push({ heading: "Evidence", text: lines.join("\n") + "\n" });
      }
      return out;
    }

    case "review": {
      requireReviewer(actor, ctx, action.type);
      if (from !== "in_review") fail(from, action.type);
      out.meta.ai_review = {
        verdict: action.verdict,
        reviewed_by: actor.session,
        ...(actor.tier ? { reviewer_tier: actor.tier } : {}),
        reviewed_at: ctx.now,
        ...(action.note ? { note: action.note } : {}),
        ...(action.summary ? { summary: action.summary } : {}),
      };
      const verdict = `${action.verdict}${action.note ? `: ${action.note}` : ""}`;
      // an issues verdict only records the review: it never releases the claim.
      // The holder's view of another machine's claim is a synced copy and can be
      // stale, so a reviewer here must not delete a claim that may still be live.
      // Bounces still release it (see the bounce path) so the fix isn't stranded.
      const releaseClaim = false;
      out.events.push(ev(actor, stamp, meta.id, "review", from, releaseClaim ? "ready" : from, verdict));
      if (releaseClaim) {
        out.meta.status = "ready";
        out.effects.push({ type: "delete_claim" });
        out.effects.push({ type: "cleanup_work", keepBranches: true });
        out.log.push(
          `- ${stamp} claim released — holder ${ctx.claim!.holder}@${ctx.claim!.machine} can't act from here`,
        );
      }
      out.log.push(`- ${stamp} ${who} ai-reviewed ${verdict}`);
      // the Review section reads for the human first: summary, detail after
      out.sectionWrites.push({
        heading: "Review",
        text: action.summary
          ? `- ${stamp} ${who} ${action.verdict} — ${action.summary}${action.note ? ` (${action.note})` : ""}\n`
          : `- ${stamp} ${who} ${verdict}\n`,
      });
      return out;
    }

    case "bounce": {
      requireReviewer(actor, ctx, action.type);
      if (from !== "in_review") fail(from, action.type);
      if ((ctx.priorBounces ?? 0) >= MAX_AI_BOUNCES) {
        throw new ForbiddenError(
          `bounce: ${ctx.priorBounces} AI bounces already — the human must review now (record a review verdict instead)`,
        );
      }
      const f = recordFailure(meta, out, ctx);
      // escalated past the holder, out of attempts, or a holder that can't
      // act from here (other machine / dead session) → the claim goes;
      // otherwise the holder keeps it and fixes (it has the context)
      const outgrown = !!f.escalated && !!ctx.claim?.tier && tierRank(ctx.claim.tier) < tierRank(f.escalated);
      const holderAway = !!ctx.claim && ctx.holderAway === true;
      if (f.held) set("hold", `stuck after ${out.meta.attempts} attempts: ${action.reason}`);
      else if (outgrown || holderAway) set("ready", action.reason);
      else set("in_progress", action.reason);
      if (f.held || outgrown || holderAway) {
        out.effects.push({ type: "delete_claim" });
        out.effects.push({ type: "cleanup_work", keepBranches: true });
      }
      if (holderAway && !f.held && !outgrown) {
        out.log.push(
          `- ${stamp} claim released — holder ${ctx.claim!.holder}@${ctx.claim!.machine} can't act from here`,
        );
      }
      out.meta.ai_review = {
        verdict: "issues",
        ...(actor.tier ? { reviewer_tier: actor.tier } : {}),
        reviewed_by: actor.session,
        reviewed_at: ctx.now,
        note: action.reason,
        ...(action.summary ? { summary: action.summary } : {}),
      };
      out.log.push(`- ${stamp} ${who} ai-bounced submission: ${action.reason} (attempt ${out.meta.attempts})`);
      if (f.escalated) out.log.push(`- ${stamp} escalated → tier ${f.escalated}${outgrown ? " (claim released for a stronger agent)" : ""}`);
      if (f.held) out.log.push(`- ${stamp} on hold: ${out.meta.attempts} failed attempts — the human decides`);
      out.sectionWrites.push({
        heading: "Review",
        text: action.summary
          ? `- ${stamp} ${who} bounced — ${action.summary} (${action.reason})\n`
          : `- ${stamp} ${who} bounced: ${action.reason}\n`,
      });
      // the claim is kept on purpose: the holder has the context and the
      // worktree, so it fixes and resubmits (like the human's reject)
      return out;
    }

    case "handoff": {
      requireHolder(actor, ctx, action.type);
      if (from !== "in_progress") fail(from, action.type);
      if (actor.kind !== "agent") throw new ForbiddenError("handoff is for agent sessions (the human has release)");
      const f = recordFailure(meta, out, ctx);
      if (f.held) set("hold", `stuck after ${out.meta.attempts} attempts: ${action.problem}`);
      else set("ready", action.problem);
      out.effects.push({ type: "delete_claim" });
      out.effects.push({ type: "cleanup_work", keepBranches: true });
      const lines = [
        `### ${stamp} ${who}${actor.tier ? ` (${actor.tier})` : ""} — attempt ${out.meta.attempts}`,
        `- **Problem:** ${action.problem}`,
        `- **Tried:** ${action.tried}`,
        ...(action.state ? [`- **State:** ${action.state}`] : []),
        ...(action.next ? [`- **Next:** ${action.next}`] : []),
      ];
      out.sectionWrites.push({ heading: "Handoff", text: lines.join("\n") + "\n" });
      out.log.push(`- ${stamp} ${who} handed off (attempt ${out.meta.attempts}): ${action.problem}`);
      if (f.escalated) out.log.push(`- ${stamp} escalated → tier ${f.escalated}`);
      if (f.held) out.log.push(`- ${stamp} on hold: ${out.meta.attempts} failed attempts — the human decides`);
      return out;
    }

    case "vet": {
      if (actor.kind !== "agent") throw new ForbiddenError("vet is an agent-only action (the human approves)");
      if (from !== "draft") fail(from, action.type);
      if (!meta.authored_tier) {
        throw new InvalidTransitionError("vet: only drafts proposed by a tiered (light) session need vetting", from, action.type);
      }
      if (tierRank(actor.tier) <= tierRank(meta.authored_tier)) {
        throw new ForbiddenError(`vet needs a session above ${meta.authored_tier} tier (declare tier at hello)`);
      }
      if (action.verdict === "ok") out.meta.vetted_by = actor.session;
      const text = `${action.verdict}${action.note ? `: ${action.note}` : ""}`;
      out.events.push(ev(actor, stamp, meta.id, "vet", from, from, text));
      out.log.push(`- ${stamp} ${who} vetted ${text}`);
      out.sectionWrites.push({ heading: "Review", text: `- ${stamp} ${who} vet ${text}\n` });
      return out;
    }

    case "set_tier": {
      requireHuman(actor, action.type);
      if (TERMINAL.includes(from)) fail(from, action.type);
      if (action.tier) out.meta.tier = action.tier;
      else delete out.meta.tier;
      if (action.reset) delete out.meta.attempts;
      const what = `${action.tier ?? "any"}${action.reset ? ", attempts reset" : ""}`;
      out.events.push(ev(actor, stamp, meta.id, action.type, from, from, what));
      out.log.push(`- ${stamp} ${who} set tier ${what}`);
      return out;
    }

    case "accept": {
      requireHumanOrDaemon(actor, action.type);
      if (from !== "in_review") fail(from, action.type);
      set("done");
      out.log.push(`- ${stamp} ${who} accepted`);
      out.effects.push({ type: "merge_required" });
      out.effects.push({ type: "delete_claim" });
      out.effects.push({ type: "cleanup_work" });
      return out;
    }

    case "reject": {
      requireHuman(actor, action.type);
      if (from === "in_review") {
        if (action.release) {
          set("ready", action.reason);
          out.log.push(
            `- ${stamp} ${who} rejected submission and released the claim${action.reason ? `: ${action.reason}` : ""}`,
          );
          if (ctx.claim) {
            out.effects.push({ type: "delete_claim" });
            out.effects.push({ type: "cleanup_work", keepBranches: true });
          }
          return out;
        }
        set("in_progress", action.reason);
        out.log.push(`- ${stamp} ${who} rejected submission${action.reason ? `: ${action.reason}` : ""}`);
        return out;
      }
      if (from === "ready") {
        set("draft", action.reason);
        out.log.push(`- ${stamp} ${who} un-approved${action.reason ? `: ${action.reason}` : ""}`);
        return out;
      }
      fail(from, action.type);
      break;
    }

    case "merge_conflict": {
      if (actor.kind !== "daemon") requireHuman(actor, action.type);
      if (from !== "in_review") fail(from, action.type);
      set("in_progress", action.conflicts.join(", "));
      out.log.push(
        `- ${stamp} merge conflict on accept → back to agent: ${action.conflicts.join(", ")}`,
      );
      return out;
    }

    case "flag_drop": {
      if (actor.kind !== "agent") {
        throw new ForbiddenError("flag_drop is an agent-only action (the human has drop)");
      }
      if (TERMINAL.includes(from)) fail(from, action.type);
      out.meta.drop_request = {
        by: actor.session,
        ...(action.reason ? { reason: action.reason } : {}),
        at: stamp,
      };
      out.events.push(ev(actor, stamp, meta.id, action.type, from, from, action.reason));
      out.log.push(`- ${stamp} ${who} flagged for drop${action.reason ? `: ${action.reason}` : ""}`);
      return out;
    }

    case "unflag_drop": {
      requireHuman(actor, action.type);
      if (!meta.drop_request) {
        throw new InvalidTransitionError("cannot unflag_drop: not flagged for drop", from, action.type);
      }
      delete out.meta.drop_request;
      out.events.push(ev(actor, stamp, meta.id, action.type, from, from));
      out.log.push(`- ${stamp} ${who} dismissed the drop flag — kept`);
      return out;
    }

    case "drop": {
      requireHuman(actor, action.type);
      if (TERMINAL.includes(from)) fail(from, action.type);
      delete out.meta.drop_request;
      set("dropped", action.reason);
      out.log.push(`- ${stamp} ${who} dropped${action.reason ? `: ${action.reason}` : ""}`);
      if (ctx.claim) {
        out.effects.push({ type: "delete_claim" });
        out.effects.push({ type: "cleanup_work" });
      }
      return out;
    }

    case "complete": {
      requireHuman(actor, action.type);
      if (from === "done") fail(from, action.type);
      delete out.meta.question;
      set("done", action.note);
      out.log.push(`- ${stamp} ${who} marked done (from ${from})${action.note ? `: ${action.note}` : ""}`);
      if (ctx.claim) {
        out.effects.push({ type: "delete_claim" });
        out.effects.push({ type: "cleanup_work", keepBranches: true });
      }
      return out;
    }

    case "hold": {
      requireHuman(actor, action.type);
      if (from !== "draft" && from !== "ready") fail(from, action.type);
      set("hold", action.reason);
      out.log.push(`- ${stamp} ${who} put on hold (from ${from})${action.reason ? `: ${action.reason}` : ""}`);
      return out;
    }

    case "unhold": {
      requireHuman(actor, action.type);
      if (from !== "hold") fail(from, action.type);
      set("ready");
      out.log.push(`- ${stamp} ${who} resumed from hold → ready`);
      return out;
    }

    case "to_draft": {
      requireHuman(actor, action.type);
      if (from !== "ready" && from !== "hold" && from !== "done") fail(from, action.type);
      set("draft", action.reason);
      out.log.push(`- ${stamp} ${who} moved back to draft (from ${from})${action.reason ? `: ${action.reason}` : ""}`);
      // a done item shouldn't hold a claim, but don't let a stale one
      // block the reopened item's next claim
      if (ctx.claim) {
        out.effects.push({ type: "delete_claim" });
        out.effects.push({ type: "cleanup_work", keepBranches: true });
      }
      return out;
    }

    case "archive": {
      requireHuman(actor, action.type);
      if (meta.archived) throw new InvalidTransitionError("already archived", from, action.type);
      if (ctx.claim) {
        throw new InvalidTransitionError(`cannot archive: claimed by ${ctx.claim.holder} — release first`, from, action.type);
      }
      out.meta.archived = true;
      out.meta.archived_at = ctx.now;
      out.events.push(ev(actor, stamp, meta.id, "archive", from, from, action.reason));
      out.log.push(`- ${stamp} ${who} archived (status ${from})${action.reason ? `: ${action.reason}` : ""}`);
      return out;
    }

    case "unarchive": {
      requireHuman(actor, action.type);
      if (!meta.archived) throw new InvalidTransitionError("not archived", from, action.type);
      delete out.meta.archived;
      delete out.meta.archived_at;
      out.events.push(ev(actor, stamp, meta.id, "unarchive", from, from));
      out.log.push(`- ${stamp} ${who} unarchived (status ${from})`);
      return out;
    }

    case "star": {
      requireHuman(actor, action.type);
      const color = action.color ?? "yellow";
      if (meta.star_color === color) throw new InvalidTransitionError(`already starred ${color}`, from, action.type);
      delete (out.meta as Record<string, unknown>).starred; // legacy boolean → star_color
      out.meta.star_color = color;
      out.meta.starred_at = ctx.now;
      out.meta.updated = meta.updated; // a bookmark isn't an edit — keeps the card's place in date-sorted views
      out.events.push(ev(actor, stamp, meta.id, "star", from, from, color));
      out.log.push(`- ${stamp} ${who} starred ${color} (status ${from})`);
      return out;
    }

    case "unstar": {
      requireHuman(actor, action.type);
      const legacy = (meta as Record<string, unknown>).starred;
      if (!meta.star_color && !legacy) throw new InvalidTransitionError("not starred", from, action.type);
      delete out.meta.star_color;
      delete out.meta.starred_at;
      delete (out.meta as Record<string, unknown>).starred; // legacy boolean → star_color
      out.meta.updated = meta.updated; // a bookmark isn't an edit — keeps the card's place in date-sorted views
      out.events.push(ev(actor, stamp, meta.id, "unstar", from, from));
      out.log.push(`- ${stamp} ${who} unstarred (status ${from})`);
      return out;
    }

    case "close_plan": {
      requireHuman(actor, action.type);
      if (meta.type !== "epic") {
        throw new InvalidTransitionError(
          `cannot close_plan: ${meta.id} is a ${meta.type}, not an epic`,
          from,
          action.type,
        );
      }
      if (meta.plan_closed)
        throw new InvalidTransitionError("plan is already closed", from, action.type);
      out.meta.plan_closed = true;
      out.events.push(ev(actor, stamp, meta.id, action.type, from, from));
      out.log.push(`- ${stamp} ${who} closed the plan — no more parts expected`);
      return out;
    }

    case "reopen_plan": {
      requireHuman(actor, action.type);
      if (meta.type !== "epic") {
        throw new InvalidTransitionError(
          `cannot reopen_plan: ${meta.id} is a ${meta.type}, not an epic`,
          from,
          action.type,
        );
      }
      if (!meta.plan_closed)
        throw new InvalidTransitionError("plan is not closed", from, action.type);
      out.meta.plan_closed = false;
      out.events.push(ev(actor, stamp, meta.id, action.type, from, from));
      out.log.push(`- ${stamp} ${who} reopened the plan`);
      return out;
    }

    case "undrop": {
      requireHuman(actor, action.type);
      // back to draft: drop already deleted the claim and tore the work
      // down, so the item needs a fresh approve_plan before it can be claimed
      if (from !== "dropped") fail(from, action.type);
      set("draft");
      out.log.push(`- ${stamp} ${who} restored from dropped`);
      return out;
    }
  }
}
