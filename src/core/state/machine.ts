import type { Claim } from "../model/claim.js";
import type { ItemMeta, Question, Status } from "../model/item.js";
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
}

export type Action =
  | { type: "approve_plan" }
  | { type: "propose" }
  | { type: "claim"; claim: Claim }
  | { type: "release"; note?: string }
  | { type: "log"; note: string }
  | { type: "ask"; question: Question }
  | { type: "answer"; decisionId: string; decisionTitle: string }
  | {
      type: "submit";
      note?: string;
      evidence?: { commits?: string[]; tests?: string; notes?: string };
    }
  | { type: "accept" }
  | { type: "reject"; reason?: string }
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
  /** Human sends a ready or held item back to draft (re-approval needed). */
  | { type: "to_draft"; reason?: string }
  /** Internal: merge on accept hit conflicts — bounce back to the agent. */
  | { type: "merge_conflict"; conflicts: string[] };

export interface TransitionCtx {
  /** ISO timestamp for updated/log lines. */
  now: string;
  /** The item's current claim file, if any. */
  claim?: Claim | null;
  /** Whether all depends_on items are done (needed for claim). */
  depsDone?: boolean;
}

export type Effect =
  | { type: "write_claim"; claim: Claim }
  | { type: "delete_claim" }
  | { type: "setup_work" } // worktrees / snapshots for the claim's targets
  | { type: "cleanup_work"; keepBranches?: boolean }
  | { type: "merge_required" }
  | { type: "create_decision"; decisionId: string; title: string };

export interface TransitionResult {
  meta: ItemMeta;
  log: string[];
  events: Omit<Event, "seq">[];
  effects: Effect[];
  /** Text to append to named body sections (e.g. ## Evidence on submit). */
  sectionWrites: Array<{ heading: string; text: string }>;
}

const TERMINAL: Status[] = ["done", "dropped"];

function fail(from: Status, action: string): never {
  throw new InvalidTransitionError(`cannot ${action} from ${from}`, from, action);
}

function requireHuman(actor: Actor, action: string): void {
  if (actor.kind !== "human") {
    throw new ForbiddenError(`${action} is a human-only action`);
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
    meta: { ...meta, updated: ctx.now.slice(0, 10) },
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
      requireHuman(actor, action.type);
      if (from !== "draft") fail(from, action.type);
      set("ready");
      out.log.push(`- ${stamp} ${who} approved plan`);
      return out;
    }

    case "claim": {
      if (from !== "ready") fail(from, action.type);
      if (actor.kind === "daemon") throw new ForbiddenError("daemon cannot claim");
      if (ctx.depsDone === false) {
        throw new InvalidTransitionError("cannot claim: dependencies not done", from, "claim");
      }
      if (ctx.claim) {
        throw new ClaimRefusedError(
          `already claimed by ${ctx.claim.holder} on ${ctx.claim.machine}`,
          ctx.claim.holder,
          ctx.claim.machine,
        );
      }
      set("in_progress");
      out.log.push(`- ${stamp} ${who} claimed`);
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
      });
      return out;
    }

    case "submit": {
      requireHolder(actor, ctx, action.type);
      if (from !== "in_progress") fail(from, action.type);
      set("in_review", action.note);
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

    case "accept": {
      requireHuman(actor, action.type);
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

    case "drop": {
      requireHuman(actor, action.type);
      if (TERMINAL.includes(from)) fail(from, action.type);
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
      if (from !== "ready" && from !== "hold") fail(from, action.type);
      set("draft", action.reason);
      out.log.push(`- ${stamp} ${who} moved back to draft (from ${from})${action.reason ? `: ${action.reason}` : ""}`);
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
