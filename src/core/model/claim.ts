import { z } from "zod";
import { ItemId, TargetRef } from "./refs.js";

export const ActorKind = z.enum(["agent", "human"]);
export type ActorKind = z.infer<typeof ActorKind>;

/**
 * A live claim, one file per item: `claims/<ID>.yaml` (DESIGN §3, §6.5).
 * `stale` is derived from last_seen + workspace stale_after — never stored.
 * `conflicted` is set by post-pull reconciliation. `unsynced` marks a claim
 * made since the last plans-repo push (manual sync mode).
 */
export const Claim = z
  .object({
    item: ItemId,
    /** Session id (`claude-code@desktop#a1f3`) or `human` for human claims. */
    holder: z.string().min(1),
    actor: ActorKind,
    machine: z.string().min(1),
    targets: z.array(TargetRef).default([]),
    claimed_at: z.string(),
    last_seen: z.string(),
    conflicted: z.boolean().optional(),
    unsynced: z.boolean().optional(),
    note: z.string().optional(),
    /** resource name → working path handed to the claimant (worktree, ssh path). */
    paths: z.record(z.string()).optional(),
  })
  .passthrough();
export type Claim = z.infer<typeof Claim>;

/** Derived claim liveness. */
export type ClaimLiveness = "live" | "stale";

export function isStale(claim: Claim, staleAfterMs: number, now: number): boolean {
  if (claim.conflicted) return false;
  return now - Date.parse(claim.last_seen) > staleAfterMs;
}
