import { z } from "zod";
import { DecisionId, ItemRef, DateStr } from "./refs.js";
import type { Section } from "./item.js";

/**
 * A decision recorded by the human answering a question
 * (`decisions/D-0007.md`). Inherited by the item's dependents (DESIGN §3).
 */
export const DecisionMeta = z
  .object({
    id: DecisionId,
    title: z.string().min(1),
    /** Item whose question this answers. */
    item: ItemRef,
    decided_by: z.string().default("human"),
    created: DateStr.optional(),
    version: z.number().int().min(1).default(1),
  })
  .passthrough();
export type DecisionMeta = z.infer<typeof DecisionMeta>;

export interface DecisionDoc {
  meta: DecisionMeta;
  sections: Section[];
}
