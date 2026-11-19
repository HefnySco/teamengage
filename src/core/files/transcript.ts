/**
 * Chat transcripts → the Markdown a discussion keeps (TE-0157). Plain text
 * and Markdown pass through unchanged; a Claude Code JSONL export becomes
 * Markdown turns: `## user`, `## assistant` and `### tool:`/`### tool result`
 * headers, so the web reader can fold them later.
 */

export interface TranscriptResult {
  /** the Markdown text to store */
  text: string;
  /** what the input looked like */
  format: "jsonl" | "markdown";
}

const MAX_TOOL_RESULT = 400;
const MAX_TOOL_INPUT = 240;

interface JsonlEntry {
  type?: string;
  subtype?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<Record<string, unknown>>;
  };
}

/** ≥70% of the first non-empty lines parse as objects with a `type` → JSONL. */
export function looksLikeJsonl(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return false;
  let jsonl = 0;
  const sample = lines.slice(0, 50);
  for (const l of sample) {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o && typeof o === "object" && typeof o.type === "string") jsonl++;
    } catch {
      /* not json */
    }
  }
  return jsonl / sample.length >= 0.7;
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const stamp = (e: JsonlEntry) => (e.timestamp ? ` — ${e.timestamp}` : "");

function textBlocks(content: string | Array<Record<string, unknown>> | undefined): string[] {
  if (typeof content === "string") return content.trim() ? [content.trim()] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string" && b.text.trim())
    .map((b) => (b.text as string).trim());
}

function toolResultText(b: Record<string, unknown>): string {
  const c = b.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .filter((x): x is { type: string; text?: string } => typeof x === "object" && x !== null)
      .map((x) => (typeof x.text === "string" ? x.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

function jsonlToMarkdown(text: string): string {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let e: JsonlEntry;
    try {
      e = JSON.parse(raw) as JsonlEntry;
    } catch {
      continue;
    }
    if (e.type === "summary" && typeof (e as Record<string, unknown>).summary === "string") {
      out.unshift(`# ${(e as Record<string, unknown>).summary}\n`);
      continue;
    }
    const role = e.message?.role ?? e.type;
    const content = e.message?.content;
    if (role === "user") {
      for (const t of textBlocks(content)) out.push(`## user${stamp(e)}\n\n${t}\n`);
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== "tool_result") continue;
          const body = toolResultText(b).trim();
          if (body) out.push(`### tool result\n\n${trunc(body, MAX_TOOL_RESULT)}\n`);
        }
      }
    } else if (role === "assistant") {
      for (const t of textBlocks(content)) out.push(`## assistant${stamp(e)}\n\n${t}\n`);
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== "tool_use" || typeof b.name !== "string") continue;
          const input = trunc(JSON.stringify(b.input ?? {}), MAX_TOOL_INPUT);
          out.push(`### tool: ${b.name}\n\n${input}\n`);
        }
      }
    }
    // system/progress/file-history entries carry no conversation
  }
  return out.join("\n");
}

/** Convert a chat export to the stored Markdown form. */
export function transcriptToMarkdown(input: string): TranscriptResult {
  if (looksLikeJsonl(input)) return { text: jsonlToMarkdown(input), format: "jsonl" };
  return { text: input, format: "markdown" };
}
