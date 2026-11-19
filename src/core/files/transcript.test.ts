import { describe, it, expect } from "vitest";
import { looksLikeJsonl, transcriptToMarkdown } from "./transcript.js";

const CLAUDE_JSONL = [
  JSON.stringify({ type: "summary", summary: "Talk about gates" }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-05-01T10:00:00Z",
    message: { role: "user", content: "what does the gate do?" },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-01T10:00:01Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "It holds the mission until told to go." },
        { type: "tool_use", name: "Read", input: { file_path: "/x/gate.ts" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: "gate source here" }],
    },
  }),
].join("\n");

describe("looksLikeJsonl", () => {
  it("takes Claude Code exports, leaves plain text", () => {
    expect(looksLikeJsonl(CLAUDE_JSONL)).toBe(true);
    expect(looksLikeJsonl("user: hi\nassistant: hello\n")).toBe(false);
    expect(looksLikeJsonl("")).toBe(false);
  });
});

describe("transcriptToMarkdown", () => {
  it("converts JSONL to Markdown turns: user, assistant, short tool blocks", () => {
    const r = transcriptToMarkdown(CLAUDE_JSONL);
    expect(r.format).toBe("jsonl");
    expect(r.text).toContain("# Talk about gates");
    expect(r.text).toContain("## user — 2026-05-01T10:00:00Z\n\nwhat does the gate do?");
    expect(r.text).toContain("## assistant — 2026-05-01T10:00:01Z\n\nIt holds the mission");
    expect(r.text).toContain('### tool: Read\n\n{"file_path":"/x/gate.ts"}');
    expect(r.text).toContain("### tool result\n\ngate source here");
  });

  it("passes plain text and Markdown through unchanged", () => {
    const raw = "## user\n\nhi there\n\n## assistant\n\nhello\n";
    const r = transcriptToMarkdown(raw);
    expect(r.format).toBe("markdown");
    expect(r.text).toBe(raw);
  });
});
