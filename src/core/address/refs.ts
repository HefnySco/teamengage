import { ITEM_REF_RE, TARGET_RE, DECISION_ID_RE, ID_RE } from "../model/refs.js";
import { ValidationError, NotFoundError } from "../model/errors.js";

/**
 * Addressing (DESIGN §4.1). References: `MP-0042`, `ws:SL-0007`, `@res`,
 * `@res:glob`, `@res:/abs/path`, `D-0007`.
 */

export interface ParsedItemRef {
  workspace?: string;
  id: string;
}

export function parseItemRef(ref: string): ParsedItemRef {
  if (!ITEM_REF_RE.test(ref)) throw new ValidationError(`bad item reference '${ref}'`);
  const i = ref.indexOf(":");
  if (i === -1) return { id: ref };
  return { workspace: ref.slice(0, i), id: ref.slice(i + 1) };
}

export function formatItemRef(r: ParsedItemRef): string {
  return r.workspace ? `${r.workspace}:${r.id}` : r.id;
}

export interface ParsedTarget {
  resource: string;
  /** Glob or path after the colon; undefined = whole resource. */
  pattern?: string;
  /** True when pattern is an absolute path (`@res:/home/pi/x`). */
  absolute?: boolean;
}

export function parseTargetRef(ref: string): ParsedTarget {
  if (!TARGET_RE.test(ref)) throw new ValidationError(`bad target reference '${ref}'`);
  const body = ref.slice(1);
  const i = body.indexOf(":");
  if (i === -1) return { resource: body };
  const pattern = body.slice(i + 1);
  return { resource: body.slice(0, i), pattern, absolute: pattern.startsWith("/") };
}

export function formatTargetRef(t: ParsedTarget): string {
  return `@${t.resource}${t.pattern !== undefined ? `:${t.pattern}` : ""}`;
}

export const isDecisionId = (s: string) => DECISION_ID_RE.test(s);
export const isItemId = (s: string) => ID_RE.test(s);

/** `GL-0013` → `GL`. */
export function idPrefix(id: string): string {
  const i = id.indexOf("-");
  return i === -1 ? id : id.slice(0, i);
}

/** Numeric part: `GL-0013` → 13. */
export function idNumber(id: string): number {
  return Number(id.slice(id.indexOf("-") + 1));
}

/** Next free id for a prefix: max existing + 1, zero-padded to ≥4. */
export function allocateId(prefix: string, existing: Iterable<string>): string {
  let max = 0;
  for (const id of existing) {
    if (idPrefix(id) !== prefix) continue;
    const n = idNumber(id);
    if (n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

/**
 * What an item reference resolves to. `resolveRef` never does I/O — the caller
 * supplies the lookup so the same code serves index, brief and validator.
 */
export interface ResolvedItem {
  ref: ParsedItemRef;
  /** Workspace the resolved item lives in. */
  workspace: string;
}

export function resolveRef(
  ref: string,
  ctx: { currentWorkspace: string; linkedWorkspaces?: Set<string> },
): ResolvedItem {
  const parsed = parseItemRef(ref);
  if (!parsed.workspace) return { ref: parsed, workspace: ctx.currentWorkspace };
  if (parsed.workspace === ctx.currentWorkspace) {
    return { ref: parsed, workspace: ctx.currentWorkspace };
  }
  if (!ctx.linkedWorkspaces?.has(parsed.workspace)) {
    throw new NotFoundError(`workspace '${parsed.workspace}' is not linked`);
  }
  return { ref: parsed, workspace: parsed.workspace };
}
