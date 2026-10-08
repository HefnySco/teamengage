import { TeError } from "../core/model/errors.js";

/**
 * Compact agent-facing output (DESIGN §7, principle 8): IDs and one-liners;
 * detail only on request. Errors are one line `ERROR <code>: message`.
 * See docs/AGENT-OUTPUT.md.
 */

export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

export const errText = (code: string, message: string): ToolResult => ({
  content: [{ type: "text", text: `ERROR ${code}: ${message}` }],
  isError: true,
});

export function errFrom(e: unknown): ToolResult {
  if (e instanceof TeError) return errText(e.code, e.message);
  return errText("INTERNAL", e instanceof Error ? e.message : String(e));
}

/** `GL-0013 in_progress agent "title" [claimed by x]` — the one-line item form. */
export function itemLine(it: {
  meta: { id: string; status: string; title: string };
  claim?: { holder: string; machine: string };
  ready?: boolean;
  blocked?: boolean;
}): string {
  const flags: string[] = [];
  if (it.claim) flags.push(`held:${it.claim.holder}`);
  if (it.blocked) flags.push("blocked");
  else if (it.ready) flags.push("ready");
  const suffix = flags.length ? `  ${flags.join(" ")}` : "";
  return `${it.meta.id} ${it.meta.status} "${it.meta.title}"${suffix}`;
}
