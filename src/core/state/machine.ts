import type { Claim } from "../model/claim.js";
import type {
  AiReview,
  ItemMeta,
  Question,
  ReviewFinding,
  StarColor,
  Status,
  SubmitCost,
  Tier,
} from "../model/item.js";
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
  /** declared model id of an agent session (GL-0360) */
  model?: string;
}

export type Action =
  | { type: "approve_plan" }
  | { type: "propose" }
  | { type: "claim"; claim: Claim }
  | { type: "release"; note?: string }
  | { type: "log"; note: string }
  | { type: "ask"; question: Question; to?: "peer" }
  | { type: "answer"; decisionId: string; decisionTitle: string }
  /** GL-0345: an ask_human option click — records a decision, status untouched. */
  | { type: "record_decision"; decisionId: string; decisionTitle: string; question?: Question }
  /** A peer session answers a `to: "peer"` question — item stays with its holder (GL-0324). */
  | { type: "answer_peer"; answer: string }
  /** Daemon sweep: a peer question unanswered past peer_answer_after becomes the human's (GL-0324). */
  | { type: "peer_timeout" }
  /** Human revises the answer already given (the item's latest decision). */
  | { type: "change_answer"; decisionId: string; decisionTitle: string; previous: string }
  /** TE-0164: human marks a decision record processed — it leaves the inbox. */
  | { type: "process_decision"; decisionId: string }
  | {
      type: "submit";
      note?: string;
      evidence?: {
        commits?: string[];
        tests?: string;
        /** TE-0178: the one short line for the human — lands under ## For the human */
        summary?: string;
        /** one-release compat (TE-0178): folds into summary at the ops layer */
        notes?: string;
        /** "walk me through this code" — plain-English explanation of the change for the human (required on heavy-tier items) */
        walkthrough?: string;
        /** one-release compat (TE-0178): GL-0343's `what` — folds into summary */
        what?: string;
        /** one-release compat (TE-0178): GL-0343's `how` — folds into summary */
        how?: string;
        /** reported run cost (GL-0318) — one `cost:` line in ## Evidence + event data */
        cost?: SubmitCost;
        /**
         * GL-0349: submit without the checks gate — the reason lands as an
         * `unverified:` line in ## Evidence and the ok review gets
         * needs_human, so the item is never auto-accepted.
         */
        unverified_reason?: string;
        /**
         * Answers to the latest review's findings (GL-0321): `finding` is the
         * 1-based index into meta.findings. Every `must` finding needs an
         * entry — `done` or `skipped` with a reason — or the submit refuses.
         */
        finding_states?: Array<{ finding: number; state: "done" | "skipped"; reason?: string }>;
        /**
         * What this task now provides (GL-0325): an API, a file, a message
         * id, a command — short lines a dependent task builds on. Written
         * as `provides:` lines in ## Evidence and shown in dependents'
         * brief dep outcomes.
         */
        provides?: string[];
        /**
         * Files the commit touched outside the task's Touches (TE-0183):
         * `repo: path` strings, at most `extra_touches_max`, each an
         * `outside scope:` Evidence line the reviewer judges.
         */
        extra_touches?: string[];
        /** Why the outside-scope files belong in this change. */
        extra_touches_reason?: string;
      };
    }
  /**
   * A second agent session records a peer review of the submission
   * (advisory: no status change, the human still accepts). Not the holder.
   * `summary` is the plain-English line for the human; `note` the technical
   * detail for whoever fixes it. `needs_human` marks an "ok, but…" verdict —
   * it keeps the accept strictly the human's (no auto-accept). `report` is the
   * optional multi-line decision report for the human; nothing parses it.
   */
  | { type: "review"; verdict: AiReview["verdict"]; note?: string; summary?: string; needs_human?: boolean; report?: string; findings?: ReviewFinding[]; ask_human?: AiReview["ask_human"] }
  /**
   * The holder pulls its own submission back to keep working
   * (in_review → in_progress, claim kept) — before the human looks at it.
   */
  | { type: "withdraw" }
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
   * Internal (daemon only): the sweep found every part and problem of this
   * plan finished — the stored status catches up with the derived
   * plan_state. Forward only: work added later shows `ready` again until
   * the human re-drafts the epic.
   */
  | { type: "dispatch_block"; reason: string }
  | { type: "dispatch_unblock" }
  | { type: "dispatch_push" }
  | { type: "dispatch_unpush" }
  | { type: "dispatch_reset" }
  | { type: "plan_auto_done" }
  /**
   * Internal (daemon only): the sweep found every live referrer of this
   * source finished (≥1 referrer) — the stored status catches up with
   * the derived idea_state.
   */
  | { type: "source_auto_done" }
  /**
   * A saved source lands ready under its capturer's own name (TE-0180).
   * Capture is the gate — not a plan approval — so the actor is whoever
   * saved it (agent, human or daemon); sources only.
   */
  | { type: "source_ready" }
  /** Internal: merge on accept hit conflicts — bounce back to the agent. */
  | { type: "merge_conflict"; conflicts: string[] }
  /**
   * Internal (daemon only): the item is done or dropped but a claim file
   * survived (synced from another machine, a path that missed the delete) —
   * remove it and clean up; branches stay (TE-0192).
   */
  | { type: "drop_orphan_claim" };

export interface TransitionCtx {
  /** ISO timestamp for updated/log lines. */
  now: string;
  /** The item's current claim file, if any. */
  claim?: Claim | null;
  /** Whether all depends_on items are done (needed for claim). */
  depsDone?: boolean;
  /** Id of an ancestor plan on hold — a held plan pauses its subtree, claim refused. */
  planHold?: string;
  /** Issues verdicts this item already took since the last human action (review cap). */
  priorBounces?: number;
  /** workspace escalate_after / max_attempts (defaults 2 / 5) */
  escalation?: { after: number; max: number };
  /**
   * The claim's holder can't act from this daemon: it lives on another
   * machine or its session is no longer live. An `issues` verdict on a
   * dead local holder releases the claim to `ready` instead of sending it
   * back to a session that will never answer; a holder on another machine
   * keeps its claim — a synced copy may be stale (never set for human claims).
   */
  holderAway?: boolean;
  /** workspace review_models (GL-0361) — which declared model may review which tier */
  reviewModels?: { deep?: string; quick?: string; deep_from_tier: Tier };
}

export type Effect =
  | { type: "write_claim"; claim: Claim }
  | { type: "delete_claim" }
  | { type: "setup_work" } // worktrees / snapshots for the claim's targets
  | { type: "cleanup_work"; keepBranches?: boolean }
  | { type: "merge_required" }
  | { type: "create_decision"; decisionId: string; title: string; question?: Question }
  | { type: "update_decision"; decisionId: string; title: string }
  | { type: "decision_processed"; decisionId: string };

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
 * One more failed attempt (issues verdict or handoff). Every `after` attempts the
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
 * Peer review of a submission is a *second opinion*: agent-only, never
 * the holder, and never the same model (DE-0161) — a model reviewing its
 * own output would just manufacture a trust marker. The reviewer key is
 * its declared model, falling back to its agent name when undeclared;
 * the submitter key is meta.submitted_model, falling back to the holder's
 * agent name. Either side unknown → the review stands.
 */
function requireReviewer(actor: Actor, ctx: TransitionCtx, action: string, meta: ItemMeta): void {
  if (actor.kind !== "agent") {
    throw new ForbiddenError(`${action} is an agent-only action (the human has accept/reject)`);
  }
  if (ctx.claim && ctx.claim.holder === actor.session) {
    throw new ForbiddenError(`${action}: the holder may not review its own submission`);
  }
  const nameOf = (session: string) => session.split("@")[0];
  const submitter = meta.submitted_model ?? (ctx.claim ? nameOf(ctx.claim.holder) : undefined);
  const reviewer = actor.model ?? nameOf(actor.session);
  if (submitter && reviewer === submitter) {
    throw new ForbiddenError(
      `${action}: the reviewer must be a different model — ${reviewer} submitted this work`,
    );
  }
  // GL-0361: review_models — a declared model, gated by the item's tier
  const rm = ctx.reviewModels;
  if (rm) {
    if (!actor.model) {
      throw new ForbiddenError(
        `${action}: review_models is set — the reviewer session must declare a model at hello`,
      );
    }
    if (tierRank(meta.tier) >= tierRank(rm.deep_from_tier)) {
      if (actor.model !== rm.deep) {
        throw new ForbiddenError(
          `${action}: an item at or above deep_from_tier (${rm.deep_from_tier}) needs the deep model` +
            (rm.deep ? ` (${rm.deep})` : " — review_models.deep is not set"),
        );
      }
    } else {
      const allowed = [rm.quick, rm.deep].filter((m): m is string => !!m);
      if (allowed.length && !allowed.includes(actor.model)) {
        throw new ForbiddenError(
          `${action}: an item below deep_from_tier (${rm.deep_from_tier}) needs the quick or deep model`,
        );
      }
    }
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
  const out = apply(meta, action, actor, ctx);
  // TE-0192: a finished item never keeps its claim file. A path that misses
  // the delete (an auto-done sweep, a file synced from another machine)
  // leaves a lock that keeps paths busy and makes the bank lie — drop it
  // here, keep the branches.
  if (
    TERMINAL.includes(out.meta.status) &&
    ctx.claim &&
    !out.effects.some((e) => e.type === "delete_claim")
  ) {
    out.effects.push({ type: "delete_claim" });
    out.effects.push({ type: "cleanup_work", keepBranches: true });
    out.log.push(`- ${ctx.now} removed the claim — the item is ${out.meta.status}`);
  }
  return out;
}

function apply(
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
    if (TERMINAL.includes(to)) out.meta.finished_at = ctx.now;
    else delete out.meta.finished_at;
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
      if (meta.type === "discussion") {
        throw new ClaimRefusedError(
          "discussions are never claimed — a saved chat is a source; plan from it",
        );
      }
      if (meta.type === "feature") {
        throw new ClaimRefusedError("features are deliveries — claim their plans' tasks");
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
      // TE-0236: the push flag is one-shot — a successful claim consumes it
      delete out.meta.dispatch_push;
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
      // the daemon sweeps a stale claim under auto_release_after (dead or
      // idle holder) — ops decides when; here it only needs an existing claim
      const claim =
        actor.kind === "daemon"
          ? ctx.claim ??
            (() => {
              throw new InvalidTransitionError("cannot release: item is not claimed", undefined, action.type);
            })()
          : requireHolder(actor, ctx, action.type);
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
      if (meta.question) {
        throw new InvalidTransitionError("a question is already open", from, action.type);
      }
      delete out.meta.peer_answer;
      if (action.to === "peer") {
        // GL-0324: peers answer first — the item stays with its holder
        out.meta.question = {
          ...action.question,
          to: "peer",
          ...(ctx.claim?.tier ? { peer_tier: ctx.claim.tier } : {}),
        };
        out.log.push(`- ${stamp} ${who} asked a peer: ${action.question.text}`);
        out.events.push(ev(actor, stamp, meta.id, "ask_peer", from, from, action.question.text));
        return out;
      }
      out.meta.question = action.question;
      set("waiting");
      out.log.push(`- ${stamp} ${who} asked: ${action.question.text}`);
      return out;
    }

    case "answer_peer": {
      if (actor.kind !== "agent") requireHumanOrDaemon(actor, action.type);
      const q = meta.question;
      if (!q || q.to !== "peer") {
        throw new InvalidTransitionError("no open peer question", from, action.type);
      }
      if (actor.session === q.asked_by) {
        throw new ForbiddenError(`${action.type}: you asked it — a peer answers`);
      }
      if (actor.kind === "agent" && tierRank(actor.tier ?? "standard") < tierRank(q.peer_tier ?? "standard")) {
        throw new ForbiddenError(
          `${action.type}: needs a ${q.peer_tier}-tier-or-higher session (you are ${actor.tier ?? "standard"})`,
        );
      }
      delete out.meta.question;
      out.meta.peer_answer = { by: actor.session, text: action.answer, at: ctx.now };
      out.log.push(`- ${stamp} ${who} answered the peer question: ${action.answer}`);
      out.sectionWrites.push({
        heading: "Notes",
        text: `- ${stamp} peer ${actor.session} answered: ${action.answer}\n`,
      });
      out.events.push(ev(actor, stamp, meta.id, "answer_peer", from, from, action.answer));
      return out;
    }

    case "peer_timeout": {
      requireHumanOrDaemon(actor, action.type);
      const q = meta.question;
      if (!q || q.to !== "peer") {
        throw new InvalidTransitionError("no open peer question", from, action.type);
      }
      // strip the peer marker — it is a normal human question now
      const { to: _to, peer_tier: _pt, ...human } = q;
      out.meta.question = human;
      set("waiting", `peer question unanswered — escalated to the human`);
      out.log.push(`- ${stamp} peer question timed out → waiting for the human`);
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

    case "record_decision": {
      requireHuman(actor, action.type);
      // the human's pick on a review's option buttons — a note for the
      // record, never a status move (answer still owns waiting)
      if (TERMINAL.includes(from)) fail(from, action.type);
      out.log.push(`- ${stamp} ${who} picked "${action.decisionTitle}" → ${action.decisionId}`);
      out.effects.push({
        type: "create_decision",
        decisionId: action.decisionId,
        title: action.decisionTitle,
        ...(action.question ? { question: action.question } : {}),
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

    case "process_decision": {
      requireHuman(actor, action.type);
      // TE-0164: a D-record outlives its item — no status gate. The decision
      // file gets `processed:` so the inbox stops listing it; the item's
      // status and question are untouched.
      out.log.push(`- ${stamp} ${who} marked decision ${action.decisionId} processed`);
      out.events.push(ev(actor, stamp, meta.id, action.type, from, from, action.decisionId));
      out.effects.push({ type: "decision_processed", decisionId: action.decisionId });
      return out;
    }

    case "submit": {
      requireHolder(actor, ctx, action.type);
      if (from !== "in_progress") fail(from, action.type);
      // GL-0321: the holder answers the last review's findings. Every `must`
      // needs done or skipped — an unanswered must refuses the submit.
      const findingStates = action.evidence?.finding_states;
      const findings = meta.findings ?? [];
      const stateByFinding = new Map<number, { state: "done" | "skipped"; reason?: string }>();
      for (const s of findingStates ?? []) {
        if (!Number.isInteger(s.finding) || s.finding < 1 || s.finding > findings.length) {
          throw new InvalidTransitionError(
            `submit: finding ${s.finding} does not exist — the last review left ${findings.length} findings`,
          );
        }
        stateByFinding.set(s.finding, s);
      }
      for (let i = 0; i < findings.length; i++) {
        if (findings[i].severity === "must" && !stateByFinding.has(i + 1)) {
          throw new InvalidTransitionError(
            `submit: must-finding ${i + 1} ("${findings[i].text.slice(0, 60)}") has no state — set it done or skipped (with a reason)`,
          );
        }
      }
      if (stateByFinding.size) {
        out.meta.findings = findings.map((f, i) => {
          const s = stateByFinding.get(i + 1);
          return s ? { ...f, state: s.state, ...(s.reason ? { reason: s.reason } : {}) } : f;
        });
        out.sectionWrites.push({
          heading: "Review",
          text:
            `- ${stamp} ${who} answered findings:\n` +
            [...stateByFinding.entries()]
              .map(([n, s]) => `  ${n}. ${s.state}${s.reason ? ` — ${s.reason}` : ""}`)
              .join("\n") +
            "\n",
        });
      }
      set("in_review", action.note);
      delete out.meta.ai_review; // a fresh submission starts unreviewed
      delete out.meta.auto_accept_off; // …and is eligible for auto-accept again
      delete out.meta.unverified_reason; // a verified resubmit clears the gate mark
      // GL-0360: remember which model produced this submission — on the
      // item and on the submit event's data (metrics reads it later)
      if (actor.model) {
        out.meta.submitted_model = actor.model;
        const last = out.events[out.events.length - 1];
        last.data = { ...(last.data ?? {}), model: actor.model };
      } else delete out.meta.submitted_model;
      out.log.push(`- ${stamp} ${who} submitted for review${action.note ? `: ${action.note}` : ""}`);
      if (action.evidence) {
        const lines: string[] = [];
        for (const c of action.evidence.commits ?? []) lines.push(`- commit ${c}`);
        for (const p of action.evidence.provides ?? []) lines.push(`- provides: ${p}`);
        for (const p of action.evidence.extra_touches ?? [])
          lines.push(
            `- outside scope: ${p}${action.evidence.extra_touches_reason ? ` — ${action.evidence.extra_touches_reason}` : ""}`,
          );
        if (action.evidence.tests) lines.push(`- tests: ${action.evidence.tests}`);
        if (action.evidence.notes) lines.push(`- ${action.evidence.notes}`);
        if (action.evidence.cost) {
          const parts: string[] = [];
          if (action.evidence.cost.model) parts.push(action.evidence.cost.model);
          if (action.evidence.cost.tokens_in !== undefined)
            parts.push(`in=${action.evidence.cost.tokens_in}`);
          if (action.evidence.cost.tokens_out !== undefined)
            parts.push(`out=${action.evidence.cost.tokens_out}`);
          if (action.evidence.cost.usd !== undefined)
            parts.push(`usd=${action.evidence.cost.usd}`);
          if (parts.length) {
            lines.push(`- cost: ${parts.join(" ")}`);
            // the submit event carries the cost too — metrics sums it
            // without parsing the Evidence line (GL-0318)
            const last = out.events[out.events.length - 1];
            last.data = { ...(last.data ?? {}), cost: action.evidence.cost };
          }
        }
        // GL-0349: an unverified submit says so in Evidence and marks the
        // item — the review transition turns it into needs_human
        if (action.evidence.unverified_reason?.trim()) {
          out.meta.unverified_reason = action.evidence.unverified_reason.trim();
          out.sectionWrites.push({
            heading: "Evidence",
            text: `- unverified: ${out.meta.unverified_reason}\n`,
          });
        }
        if (lines.length) out.sectionWrites.push({ heading: "Evidence", text: lines.join("\n") + "\n" });
        // TE-0178: one short summary for the human under its own managed
        // section — ops folds old-style what/how/notes into it. Callers
        // that skip ops still render their what/how lines for one release.
        const humanLines: string[] = [];
        if (action.evidence.summary?.trim()) humanLines.push(`- summary: ${action.evidence.summary.trim()}`);
        else {
          if (action.evidence.what?.trim()) humanLines.push(`- what: ${action.evidence.what.trim()}`);
          if (action.evidence.how?.trim()) humanLines.push(`- how: ${action.evidence.how.trim()}`);
        }
        if (humanLines.length)
          out.sectionWrites.push({ heading: "For the human", text: humanLines.join("\n") + "\n" });
        // the submitter's own walkthrough, kept per submission like Handoff
        if (action.evidence.walkthrough?.trim()) {
          out.sectionWrites.push({
            heading: "Walkthrough",
            text: `### ${stamp} ${who}\n\n${action.evidence.walkthrough.trim()}\n\n`,
          });
        }
      }
      return out;
    }

    case "review": {
      // TE-0176: the human's review is the send-back button — issues verdict
      // only, and never capped (the human is the cap). Agents get the full
      // peer-review flow through requireReviewer.
      const humanBack = actor.kind === "human";
      if (humanBack) {
        if (action.verdict !== "issues")
          throw new ForbiddenError(
            "ok reviews are agent-only — the human's review is the send-back (verdict issues; accept/reject cover the rest)",
          );
      } else {
        requireReviewer(actor, ctx, action.type, meta);
      }
      if (from !== "in_review") fail(from, action.type);
      const verdict = `${action.verdict}${action.note ? `: ${action.note}` : ""}`;
      // TE-0175: issues is the one send-back path — a live holder on this
      // machine keeps the claim and fixes; a dead or outgrown holder loses
      // it to `ready` (branch kept); attempts exhausted → `hold`. A claim
      // on another machine is a synced copy that may be stale, so the item
      // stays in_review and the claim is never touched from here. Past
      // MAX_AI_BOUNCES in a row the same applies: in_review for the human.
      const issues = action.verdict === "issues";
      const capped = issues && !humanBack && (ctx.priorBounces ?? 0) >= MAX_AI_BOUNCES;
      const otherMachine = issues && !!ctx.claim && ctx.claim.machine !== actor.machine;
      if (issues && !capped && ctx.claim) {
        const f = recordFailure(meta, out, ctx);
        const outgrown =
          !!f.escalated && !!ctx.claim.tier && tierRank(ctx.claim.tier) < tierRank(f.escalated);
        if (otherMachine) {
          // DE-0250: the send-back counts as an attempt (attempts and the
          // tier move, as the old bounce did) — but the synced remote claim
          // is never touched: the item stays in_review for that machine
          out.events.push(ev(actor, stamp, meta.id, "review", from, from, verdict));
          out.log.push(`- ${stamp} ${who} sent the submission back with issues (attempt ${out.meta.attempts})`);
          out.log.push(`- ${stamp} holder ${ctx.claim.holder}@${ctx.claim.machine} is on another machine — claim left for it`);
          if (f.escalated) out.log.push(`- ${stamp} escalated → tier ${f.escalated}`);
          if (f.held) out.log.push(`- ${stamp} ${out.meta.attempts} failed attempts — the item stays in review for the human`);
        } else {
          if (f.held) set("hold", `stuck after ${out.meta.attempts} attempts: ${action.note ?? "issues"}`);
          else if (outgrown || ctx.holderAway === true) set("ready", verdict);
          else set("in_progress", verdict);
          if (f.held || outgrown || ctx.holderAway === true) {
            out.effects.push({ type: "delete_claim" });
            out.effects.push({ type: "cleanup_work", keepBranches: true });
          }
          out.log.push(`- ${stamp} ${who} sent the submission back with issues (attempt ${out.meta.attempts})`);
          if (ctx.holderAway === true && !f.held && !outgrown)
            out.log.push(`- ${stamp} claim released — holder ${ctx.claim.holder}@${ctx.claim.machine} can't act from here`);
          if (f.escalated)
            out.log.push(`- ${stamp} escalated → tier ${f.escalated}${outgrown ? " (claim released for a stronger agent)" : ""}`);
          if (f.held) out.log.push(`- ${stamp} on hold: ${out.meta.attempts} failed attempts — the human decides`);
        }
      } else {
        out.events.push(ev(actor, stamp, meta.id, "review", from, from, verdict));
        if (capped) out.log.push(`- ${stamp} ${ctx.priorBounces} issues verdicts in a row — the item stays in review for the human`);
        if (otherMachine && ctx.claim)
          out.log.push(`- ${stamp} holder ${ctx.claim.holder}@${ctx.claim.machine} is on another machine — claim left for it`);
      }
      // the human's send-back never flags needs_human — the human decided
      const flagHuman = !humanBack && !!(action.needs_human || capped || meta.unverified_reason);
      out.meta.ai_review = {
        verdict: action.verdict,
        reviewed_by: actor.session,
        ...(actor.tier ? { reviewer_tier: actor.tier } : {}),
        ...(actor.model ? { reviewer_model: actor.model } : {}),
        reviewed_at: ctx.now,
        ...(action.note ? { note: action.note } : {}),
        ...(action.summary ? { summary: action.summary } : {}),
        // GL-0349: an unverified submission is never auto-accepted — every
        // review on it is needs_human, whatever the verdict; at the issues
        // cap the item waits for the human the same way
        ...(flagHuman ? { needs_human: true } : {}),
        ...(action.report ? { report: action.report } : {}),
        ...(action.ask_human ? { ask_human: action.ask_human } : {}),
      };
      // GL-0365: the reviewer table keys verdicts by model
      if (actor.model && out.events.length) {
        const last = out.events[out.events.length - 1];
        last.data = { ...(last.data ?? {}), model: actor.model };
      }
      out.log.push(
        `- ${stamp} ${who} ${humanBack ? "sent the submission back" : `ai-reviewed ${verdict}`}${flagHuman ? " (needs the human's call)" : ""}`,
      );
      // the Review section reads for the human first: summary, detail after
      out.sectionWrites.push({
        heading: "Review",
        text: action.summary
          ? `- ${stamp} ${who} ${action.verdict}${flagHuman ? " — needs your call" : ""} — ${action.summary}\n`
          : `- ${stamp} ${who} ${verdict}${flagHuman ? " (needs the human's call)" : ""}\n`,
      });
      // GL-0321: a new review replaces the findings checklist; a review
      // without findings clears the old list (it was already answered).
      // TE-0178 compat: an old-style report, note and ask_human options
      // render inside the same numbered list for one release — only real
      // findings land on meta.findings (the holder answers those). The
      // report's non-empty lines become numbered items, the note shows
      // once, here (DE-0252).
      const compatFindings: string[] = [];
      for (const line of action.report?.split("\n") ?? []) {
        const t = line.trim();
        if (t) compatFindings.push(`[report] ${t}`);
      }
      if (action.note?.trim()) compatFindings.push(`[note] ${action.note.trim()}`);
      for (const o of action.ask_human?.options ?? []) compatFindings.push(`[option] ${o}`);
      if (action.findings?.length || compatFindings.length) {
        if (action.findings?.length) out.meta.findings = action.findings;
        else delete out.meta.findings;
        const numbered = [
          ...(action.findings ?? []).map(
            (f) => `[${f.severity}] ${f.text}${f.where ? ` (${f.where})` : ""}`,
          ),
          ...compatFindings,
        ];
        out.sectionWrites.push({
          heading: "Review",
          text: `  findings:\n` + numbered.map((t, i) => `  ${i + 1}. ${t}`).join("\n") + "\n",
        });
      } else {
        delete out.meta.findings;
      }
      return out;
    }

    case "withdraw": {
      // holder only: pulls the submission back to keep working before the
      // human looks at it — the claim and the worktree stay
      requireHolder(actor, ctx, action.type);
      if (from !== "in_review") fail(from, action.type);
      set("in_progress");
      out.log.push(`- ${stamp} ${who} withdrew the submission to keep working`);
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
      if (from !== "draft" && from !== "ready" && from !== "in_review") fail(from, action.type);
      set("hold", action.reason);
      out.log.push(`- ${stamp} ${who} put on hold (from ${from})${action.reason ? `: ${action.reason}` : ""}`);
      if (from === "in_review" && ctx.claim) {
        // a parked review frees the claim; the submission's branches stay
        out.effects.push({ type: "delete_claim" });
        out.effects.push({ type: "cleanup_work", keepBranches: true });
      }
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
      requireHumanOrDaemon(actor, action.type);
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

    case "dispatch_block": {
      // TE-0208: the daemon's per-item breaker (two failed runs) or the
      // human blocks an item from dispatch — status untouched.
      // TE-0237: an agent may self-eject — holder only, so a session can
      // never block another agent's work; the human's unblock lifts it.
      if (actor.kind === "agent") {
        requireHolder(actor, ctx, action.type);
      } else {
        requireHumanOrDaemon(actor, action.type);
      }
      if (TERMINAL.includes(from)) fail(from, action.type);
      out.meta.dispatch_blocked = {
        reason: action.reason,
        at: stamp,
        by: actor.session,
        actor: actor.kind,
      };
      out.events.push(ev(actor, stamp, meta.id, "dispatch_block", from, from, action.reason));
      out.log.push(`- ${stamp} ${who} blocked dispatch: ${action.reason}`);
      return out;
    }

    case "dispatch_unblock": {
      if (actor.kind !== "daemon" && actor.kind !== "human")
        throw new ForbiddenError("dispatch_unblock is a daemon/human action");
      if (!meta.dispatch_blocked)
        throw new InvalidTransitionError("not dispatch_blocked", from, action.type);
      delete out.meta.dispatch_blocked;
      out.events.push(ev(actor, stamp, meta.id, "dispatch_unblock", from, from));
      out.log.push(`- ${stamp} ${who} unblocked dispatch`);
      return out;
    }

    case "dispatch_push": {
      // TE-0236: the human's per-item queue lever — the positive mirror of
      // dispatch_blocked. A work pick admits the item past the filter;
      // the flag is one-shot and clears on claim.
      if (actor.kind !== "daemon" && actor.kind !== "human")
        throw new ForbiddenError("dispatch_push is a daemon/human action");
      if (TERMINAL.includes(from)) fail(from, action.type);
      out.meta.dispatch_push = { at: stamp, by: actor.session };
      out.events.push(ev(actor, stamp, meta.id, "dispatch_push", from, from));
      out.log.push(`- ${stamp} ${who} pushed to dispatch`);
      return out;
    }

    case "dispatch_unpush": {
      if (actor.kind !== "daemon" && actor.kind !== "human")
        throw new ForbiddenError("dispatch_unpush is a daemon/human action");
      if (!meta.dispatch_push)
        throw new InvalidTransitionError("not dispatch_push", from, action.type);
      delete out.meta.dispatch_push;
      out.events.push(ev(actor, stamp, meta.id, "dispatch_unpush", from, from));
      out.log.push(`- ${stamp} ${who} unpushed from dispatch`);
      return out;
    }

    case "dispatch_reset": {
      // TE-0209: the human cleared the dispatcher's in-memory state for the
      // item (tried versions, fix count, failure count) — Log line only
      if (actor.kind !== "daemon" && actor.kind !== "human")
        throw new ForbiddenError("dispatch_reset is a daemon/human action");
      if (TERMINAL.includes(from)) fail(from, action.type);
      out.events.push(ev(actor, stamp, meta.id, "dispatch_reset", from, from));
      out.log.push(`- ${stamp} ${who} reset dispatch state`);
      return out;
    }

    case "plan_auto_done": {
      if (actor.kind !== "daemon")
        throw new ForbiddenError("plan_auto_done is a daemon-only action");
      if (meta.type !== "epic") {
        throw new InvalidTransitionError(
          `cannot plan_auto_done: ${meta.id} is a ${meta.type}, not an epic`,
          from,
          action.type,
        );
      }
      if (TERMINAL.includes(from)) fail(from, action.type);
      set("done");
      out.log.push(`- ${stamp} auto-completed: every part and problem finished`);
      return out;
    }

    case "source_auto_done": {
      if (actor.kind !== "daemon")
        throw new ForbiddenError("source_auto_done is a daemon-only action");
      if (meta.type !== "idea" && meta.type !== "discussion") {
        throw new InvalidTransitionError(
          `cannot source_auto_done: ${meta.id} is a ${meta.type}, not a source`,
          from,
          action.type,
        );
      }
      if (TERMINAL.includes(from)) fail(from, action.type);
      set("done");
      out.log.push(`- ${stamp} auto-completed: every referrer finished`);
      return out;
    }

    case "source_ready": {
      // TE-0180: a captured source lands ready under its capturer's name —
      // saving the record is the gate, so any actor kind may do it
      if (meta.type !== "idea" && meta.type !== "discussion") {
        throw new InvalidTransitionError(
          `cannot source_ready: ${meta.id} is a ${meta.type}, not a source`,
          from,
          action.type,
        );
      }
      if (from !== "draft") fail(from, action.type);
      set("ready");
      out.log.push(`- ${stamp} ${who} saved the ${meta.type}`);
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

    case "drop_orphan_claim": {
      if (actor.kind !== "daemon")
        throw new ForbiddenError("drop_orphan_claim is a daemon-only action");
      if (!TERMINAL.includes(from)) fail(from, action.type);
      if (!ctx.claim) {
        throw new InvalidTransitionError(`cannot drop_orphan_claim: ${meta.id} has no claim`, from, action.type);
      }
      out.events.push(ev(actor, stamp, meta.id, action.type, from, from));
      out.log.push(`- ${stamp} daemon removed the claim on the finished item`);
      out.effects.push({ type: "delete_claim" });
      out.effects.push({ type: "cleanup_work", keepBranches: true });
      return out;
    }
  }
}
