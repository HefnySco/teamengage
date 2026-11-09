import type { ItemMeta } from "../model/item.js";
import { isProblemItem } from "../index/index.js";

/** One problem item whose old origin link sits in depends_on. */
export interface BackfillRow {
  id: string;
  status: string;
  title: string;
  /** ids that move to found_by */
  move: string[];
  /** ids that stay in depends_on */
  keep: string[];
}

export interface BackfillPlan {
  /** problem items with depends_on and no found_by */
  candidates: BackfillRow[];
  /** problem items with neither depends_on nor found_by: the human sets these */
  unlinked: { id: string; status: string; title: string }[];
}

type Meta = Pick<ItemMeta, "id" | "status" | "title" | "type" | "domains" | "depends_on" | "found_by">;

/**
 * Pure rule. `keep` lists ids that stay in depends_on (real ordering);
 * every other depends_on id of a candidate moves to found_by.
 */
export function planOriginBackfill(items: Meta[], keep: string[] = []): BackfillPlan {
  const keepSet = new Set(keep.map((k) => k.toUpperCase()));
  const plan: BackfillPlan = { candidates: [], unlinked: [] };
  for (const m of items) {
    if (!isProblemItem(m as ItemMeta)) continue;
    const deps = m.depends_on ?? [];
    if (m.found_by?.length) continue;
    if (!deps.length) {
      plan.unlinked.push({ id: m.id, status: m.status, title: m.title });
      continue;
    }
    plan.candidates.push({
      id: m.id,
      status: m.status,
      title: m.title,
      move: deps.filter((d) => !keepSet.has(d.toUpperCase())),
      keep: deps.filter((d) => keepSet.has(d.toUpperCase())),
    });
  }
  return plan;
}
