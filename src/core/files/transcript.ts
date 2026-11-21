/**
 * Chat transcripts → the Markdown a discussion keeps (TE-0157). A Claude
 * Code JSONL export becomes Markdown turns: `## user`, `## assistant` and
 * `### tool:`/`### tool result`/`### system` headers, so the web reader can
 * fold them later. Plain text and Markdown pass through — except `## user`
 * turns that carry <system-reminder> plumbing, which refold the same way.
 */

export interface TranscriptResult {
  /** the Markdown text to store */
  text: string;
  /** what the input looked like */
  format: "jsonl" | "markdown";
}

const MAX_TOOL_RESULT = 400;
const MAX_TOOL_INPUT = 240;
const MAX_SYSTEM = 4000;

// some exports carry tool plumbing as <system-reminder> or <task-notification>
// text inside user messages — fold it like a tool block, not a human turn
const REMINDER_RE = /<(system-reminder|task-notification)>\s*([\s\S]*?)\s*<\/\1>/g;
const TOOL_CALL_RE = /^Called the (.+?) tool with the following input:\s*([\s\S]*)$/;
const TOOL_RESULT_RE = /^Result of calling the (.+?) tool:?\s*([\s\S]*)$/;

const systemBlock = (body: string) => `### system\n\n${trunc(body.trim(), MAX_SYSTEM)}\n`;

/** A <system-reminder> body → the folded ### block it really is. */
function reminderBlock(body: string): string {
  const b = body.trim();
  let m = TOOL_CALL_RE.exec(b);
  if (m) return `### tool: ${m[1]}\n\n${trunc(m[2].trim(), MAX_TOOL_INPUT)}\n`;
  m = TOOL_RESULT_RE.exec(b);
  if (m) return `### tool result\n\n${trunc(m[2].trim(), MAX_TOOL_RESULT)}\n`;
  return systemBlock(b);
}

// turn headers the transcript format owns — "## Section" lines inside a
// body are content, not turns (dumps carry task files, docs, reports)
const TURN_HEAD_RE = /^##\s+(?:user|assistant|human)\b/i;
const TOOL_HEAD_RE = /^###\s+(?:tool|system)\b/i;

/**
 * One user text → `## user` turns for real words, folded ### blocks for
 * reminder plumbing. `stampStr` goes on the first user turn only.
 */
function userTurnBlocks(text: string, stampStr: string, headWord = "user"): string[] {
  const out: string[] = [];
  let last = 0;
  let first = true;
  const userBit = (t: string) => {
    out.push(`## ${headWord}${first ? stampStr : ""}\n\n${t}\n`);
    first = false;
  };
  for (const m of text.matchAll(REMINDER_RE)) {
    const pre = text.slice(last, m.index ?? 0).trim();
    if (pre) userBit(pre);
    out.push(m[1] === "task-notification" ? systemBlock(m[2]) : reminderBlock(m[2]));
    last = (m.index ?? 0) + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) userBit(tail);
  return out;
}

/**
 * Refold `## user` turns that carry <system-reminder> plumbing — fixes
 * already-converted transcripts on re-save. No reminders → input unchanged.
 */
export function foldReminderTurns(text: string): string {
  // reminder bodies can hold "## " lines (raw file dumps) — locate the
  // spans first so a header inside one does not start a new turn
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(REMINDER_RE)) {
    const s = m.index ?? 0;
    spans.push([s, s + m[0].length]);
  }
  const inSpan = (pos: number) => spans.some(([a, b]) => pos >= a && pos < b);
  const out: string[] = [];
  let buf: string[] = [];
  let head: string | null = null;
  let fence: string | null = null;
  let pos = 0;
  const flush = () => {
    if (!buf.length) return;
    const chunk = buf.join("\n");
    buf = [];
    const hm = head === null ? null : /^##\s+((?:user|human)\b)([\s\S]*)$/i.exec(head);
    head = null;
    if (!hm) {
      out.push(chunk);
      return;
    }
    const nl = chunk.indexOf("\n");
    const body = nl === -1 ? "" : chunk.slice(nl + 1);
    out.push(userTurnBlocks(body, hm[2], hm[1].toLowerCase()).join("\n"));
  };
  for (const line of text.split("\n")) {
    const start = pos;
    pos += line.length + 1;
    if (!inSpan(start)) {
      const f = /^(```|~~~)/.exec(line.trim());
      if (f) {
        if (fence === null) fence = f[1];
        else if (line.trim().startsWith(fence)) fence = null;
        buf.push(line);
        continue;
      }
      if (fence) {
        buf.push(line);
        continue;
      }
      if (TURN_HEAD_RE.test(line) || TOOL_HEAD_RE.test(line)) {
        flush();
        head = line;
      }
    }
    buf.push(line);
  }
  flush();
  return out.join("\n");
}

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
      for (const t of textBlocks(content)) out.push(...userTurnBlocks(t, stamp(e)));
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
  return { text: foldReminderTurns(input), format: "markdown" };
}
