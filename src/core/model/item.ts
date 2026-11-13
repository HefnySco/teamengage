import { z } from "zod";
import { ItemId, ItemRef, TargetRef, Name, DateStr } from "./refs.js";

export const ItemType = z.enum(["epic", "task", "bug", "wish", "spike", "review", "idea"]);
export type ItemType = z.infer<typeof ItemType>;

/** Stored statuses. `blocked` and `turn` are derived, never stored (DESIGN §5). */
export const Status = z.enum([
  "draft",
  "ready",
  /** parked by the human: approved-ish, but not for agents yet (next/claim skip it) */
  "hold",
  "in_progress",
  "in_review",
  "waiting",
  "done",
  "dropped",
]);
export type Status = z.infer<typeof Status>;

/** Whose move it is — derived from status. */
export type Turn = "human" | "agent";

/**
 * Latest AI peer review of a submission (review/bounce by an agent session
 * that is not the holder). Advisory only: the human still accepts.
 */
export const AiReview = z.object({
  verdict: z.enum(["ok", "issues"]),
  /** reviewing session id (`agent@machine#hex`) */
  reviewed_by: z.string(),
  reviewed_at: z.string(),
  /** reviewer session's declared model tier */
  reviewer_tier: z.enum(["light", "standard", "heavy"]).optional(),
  /** technical detail for whoever fixes it (file:line, what broke) */
  note: z.string().optional(),
  /** one plain-English sentence for the human — what the verdict means */
  summary: z.string().optional(),
  /**
   * "ok, but…" — the reviewer leans positive yet wants the human's own
   * judgement (risky area, an unverifiable step, a call that isn't theirs).
   * Such a review is never auto-accepted under autonomy: solo.
   */
  needs_human: z.boolean().optional(),
  /** Multi-line plain report for the human. Agents use summary and note. */
  report: z.string().optional(),
});
export type AiReview = z.infer<typeof AiReview>;

/**
 * One structured review finding (GL-0321): what to fix, where, how bad.
 * `must` blocks resubmission until the holder sets it done or skipped;
 * `should` is advisory. `state`/`reason` are filled by the holder on
 * submit — the checklist travels with the latest review on the item.
 */
export const ReviewFinding = z.object({
  text: z.string().min(1),
  /** file:line or another pointer — free text */
  where: z.string().optional(),
  severity: z.enum(["must", "should"]),
  /** holder's answer on the next submit: done or skipped */
  state: z.enum(["done", "skipped"]).optional(),
  /** why skipped (or a short done note) */
  reason: z.string().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/**
 * Optional cost a session reports with its submission (GL-0318). Every
 * field is optional — agents send what their runner gives them. Written as
 * one `cost:` line in ## Evidence and carried on the submit event's `data`
 * so `te metrics` can sum it without parsing text.
 */
export const SubmitCost = z.object({
  model: z.string().optional(),
  tokens_in: z.number().nonnegative().optional(),
  tokens_out: z.number().nonnegative().optional(),
  usd: z.number().nonnegative().optional(),
});
export type SubmitCost = z.infer<typeof SubmitCost>;

/**
 * Model tier — how capable an agent must be to work an item (light ≈ Haiku,
 * standard ≈ Sonnet, heavy ≈ Opus). Sessions declare theirs at hello; an
 * item's tier is the minimum that may claim it (unset = anyone).
 */
export const Tier = z.enum(["light", "standard", "heavy"]);
export type Tier = z.infer<typeof Tier>;
export const TIERS: Tier[] = ["light", "standard", "heavy"];
export function tierRank(t: Tier | undefined): number {
  return t ? TIERS.indexOf(t) : -1;
}

/** An open question attached to an item. `to: "peer"`: peers answer first (GL-0324)
 * and the item stays in_progress; unset: a human question on a `waiting` item. */
export const Question = z.object({
  text: z.string().min(1),
  options: z.array(z.string()).optional(),
  asked_by: z.string(),
  asked_at: z.string(),
  /** peers answer first — another session of the same or a higher tier */
  to: z.literal("peer").optional(),
  /** the asking session's tier — recorded so a dead session's tier still gates answers */
  peer_tier: Tier.optional(),
});
export type Question = z.infer<typeof Question>;

/** A peer's answer to a `to: "peer"` question — written to ## Notes and kept for brief. */
export const PeerAnswer = z.object({
  by: z.string(),
  text: z.string(),
  at: z.string(),
});
export type PeerAnswer = z.infer<typeof PeerAnswer>;
/** One tier up (heavy stays heavy). */
export function nextTier(t: Tier): Tier {
  return TIERS[Math.min(TIERS.indexOf(t) + 1, TIERS.length - 1)];
}

/** The board ★ colours (bootstrap warning/danger/success/primary). */
export const StarColor = z.enum(["yellow", "red", "green", "blue"]);
export type StarColor = z.infer<typeof StarColor>;

/**
 * Item frontmatter (DESIGN §4 'Item file'). Unknown fields are preserved via
 * passthrough — never rejected, never lost on rewrite.
 */
export const ItemMeta = z
  .object({
    id: ItemId,
    type: ItemType,
    title: z.string().min(1),
    status: Status.default("draft"),
    project: Name.optional(),
    /** hashtag-like labels; many per item (see core/domains) */
    domains: z.array(z.string()).default([]),
    targets: z.array(TargetRef).default([]),
    depends_on: z.array(ItemRef).default([]),
    parent: ItemRef.optional(),
    relates: z.array(ItemRef).default([]),
    /** items where the problem this item fixes was found — reference only, no ordering, no gate; omitted when empty */
    found_by: z.array(ItemRef).optional(),
    priority: z.number().int().min(1).max(5).default(2),
    version: z.number().int().min(1).default(1),
    created: DateStr.optional(),
    updated: DateStr.optional(),
    legacy_id: z.string().optional(),
    /** relative path of the file an item was imported from (idempotency key) */
    imported_from: z.string().optional(),
    /** overlay mode: task file holding the content, relative to the workspace root */
    source: z.string().optional(),
    /** overlay mode: companion `.simple.md`, relative to the workspace root */
    simple_source: z.string().optional(),
    question: Question.optional(),
    /** last peer answer (GL-0324) — cleared on the next ask */
    peer_answer: PeerAnswer.optional(),
    /**
     * Latest AI review of the current submission; cleared on every `submit`
     * (a new submission starts unreviewed). Shown as a triage badge in review.
     */
    ai_review: AiReview.optional(),
    /**
     * The latest review's structured findings checklist (GL-0321).
     * `review`/`bounce` replace it (a review without findings clears it);
     * `submit` fills each entry's `state`/`reason` from finding_states.
     */
    findings: z.array(ReviewFinding).optional(),
    /**
     * When this item's dependents may start: "done" = a key task, they wait
     * for acceptance; "review" = once it is submitted. Unset → workspace
     * review_unblocks.
     */
    unblocks_on: z.enum(["review", "done"]).optional(),
    /** hidden from board/inbox/graph/next; status kept underneath (archive page) */
    archived: z.boolean().optional(),
    archived_at: z.string().optional(),
    /** when the status last entered done/dropped — drives auto_archive_after */
    finished_at: z.string().optional(),
    /** minimum model tier that may claim it (unset = any); raised on escalation */
    tier: Tier.optional(),
    /** failed attempts so far — AI bounces + handoffs (drives escalation) */
    attempts: z.number().int().min(0).optional(),
    /** tier of the agent session that proposed it (light-authored drafts need vetting) */
    authored_tier: Tier.optional(),
    /** a stronger session checked a light-authored draft (`vet ok`) */
    vetted_by: z.string().optional(),
    /**
     * An agent asked the human to drop this item (flag_drop). Advisory only —
     * the status is untouched; the human drops it or clears the flag.
     */
    drop_request: z
      .object({
        /** flagging session id (`agent@machine#hex`) */
        by: z.string(),
        reason: z.string().optional(),
        at: z.string(),
      })
      .optional(),
    /** the human's watch marker — board ★ colour, no workflow effect; unset = not starred */
    star_color: StarColor.optional(),
    /** autonomy: solo — the human stopped auto-accept for this submission (cleared on submit) */
    auto_accept_off: z.boolean().optional(),
    starred_at: z.string().optional(),
    /**
     * epic only: the human closed the plan — no more parts are coming.
     * plan_state stays derived (see Index.planState), never stored.
     */
    plan_closed: z.boolean().optional(),
  })
  .passthrough();
export type ItemMeta = z.infer<typeof ItemMeta>;

/** A parsed item: frontmatter meta + markdown body sections (see core/files). */
export interface Section {
  heading: string;
  body: string;
}

export interface ItemDoc {
  meta: ItemMeta;
  sections: Section[];
}

/**
 * One file attached to an item — a `## Artifacts` list line:
 * `- <path under .artifacts/> — <caption> [#domain ...] [!sensitive]`.
 * `domains` is the effective set: the line's own #tags, else the item's.
 */
export interface Artifact {
  /** workspace-relative path under `.artifacts/` (e.g. `andruav/an0133-v2-sms.png`) */
  path: string;
  caption: string;
  domains: string[];
  /** `!sensitive` — the file may hold private data */
  sensitive: boolean;
}

/** turn derivation per DESIGN §5. */
export function turnOf(status: Status): Turn {
  return status === "draft" || status === "hold" || status === "in_review" || status === "waiting"
    ? "human"
    : "agent";
}
