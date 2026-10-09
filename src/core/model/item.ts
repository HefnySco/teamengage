import { z } from "zod";
import { ItemId, ItemRef, TargetRef, Name, DateStr } from "./refs.js";

export const ItemType = z.enum(["epic", "task", "bug", "wish", "spike", "review"]);
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

/** An open question attached to a `waiting` item (ask → waiting, answer → decision). */
export const Question = z.object({
  text: z.string().min(1),
  options: z.array(z.string()).optional(),
  asked_by: z.string(),
  asked_at: z.string(),
});
export type Question = z.infer<typeof Question>;

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
    targets: z.array(TargetRef).default([]),
    depends_on: z.array(ItemRef).default([]),
    parent: ItemRef.optional(),
    relates: z.array(ItemRef).default([]),
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
    /** hidden from board/inbox/graph/next; status kept underneath (archive page) */
    archived: z.boolean().optional(),
    archived_at: z.string().optional(),
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

/** turn derivation per DESIGN §5. */
export function turnOf(status: Status): Turn {
  return status === "draft" || status === "hold" || status === "in_review" || status === "waiting"
    ? "human"
    : "agent";
}
