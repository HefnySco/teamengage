import { z } from "zod";

/** Item/decision ID: `GL-0013`, `TE-0001`, `D-0007`. */
export const ID_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;
/** Item reference: `MP-0042` or cross-workspace `mcp:SL-0007`. */
export const ITEM_REF_RE = /^([a-z][a-z0-9_-]*:)?[A-Z][A-Z0-9]*-[0-9]+$/;
/** Decision ID. */
export const DECISION_ID_RE = /^D-[0-9]+$/;
/** Target reference: `@res`, `@res:glob/**`, `@res:/abs/path`. */
export const TARGET_RE = /^@[a-z][a-z0-9_-]*(:.+)?$/;
/** Workspace/project name. */
export const NAME_RE = /^[a-z][a-z0-9_-]*$/;
/** ID prefix: `GL`, `TE`, `MP`. */
export const PREFIX_RE = /^[A-Z][A-Z0-9]*$/;

export const ItemId = z.string().regex(ID_RE, "expected an id like GL-0013");
export const ItemRef = z.string().regex(ITEM_REF_RE, "expected ID or ws:ID");
export const DecisionId = z.string().regex(DECISION_ID_RE, "expected D-0007");
export const TargetRef = z.string().regex(TARGET_RE, "expected @resource[:glob]");
export const Name = z.string().regex(NAME_RE, "lowercase name");
export const Prefix = z.string().regex(PREFIX_RE, "uppercase prefix");

/** `YYYY-MM-DD` or full ISO timestamp. */
export const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}([T ].*)?$/, "expected YYYY-MM-DD or ISO datetime");

export type ItemRefT = z.infer<typeof ItemRef>;
export type TargetRefT = z.infer<typeof TargetRef>;
