import { describe, it, expect } from "vitest";
import { looksLikeJsonl, transcriptToMarkdown, foldReminderTurns } from "./transcript.js";

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
    expect(r.text).toContain('### tool: Read — {"file_path":"/x/gate.ts"}');
    expect(r.text).toContain("### tool result — 16 chars");
  });

  it("a 1 MB tool result lands as a one-line summary; user and assistant text stays whole (TE-0181)", () => {
    const big = "x".repeat(1024 * 1024);
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "first question" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "running the tool" },
            { type: "tool_use", name: "Bash", input: { command: "npm test", pad: "y".repeat(500) } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: big }] },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "last question" } }),
    ].join("\n");
    const r = transcriptToMarkdown(jsonl);
    expect(r.text.length).toBeLessThan(10 * 1024);
    expect(r.text).toContain("first question");
    expect(r.text).toContain("running the tool");
    expect(r.text).toContain("last question");
    expect(r.text).toContain('### tool: Bash — {"command":"npm test"');
    expect(r.text).toContain(`### tool result — ${big.length} chars`);
    expect(r.text).not.toContain(big.slice(0, 100));
  });

  it("passes plain text and Markdown through unchanged", () => {
    const raw = "## user\n\nhi there\n\n## assistant\n\nhello\n";
    const r = transcriptToMarkdown(raw);
    expect(r.format).toBe("markdown");
    expect(r.text).toBe(raw);
  });

  it("folds <system-reminder> user text into ### blocks, not fake user turns", () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-11-14T10:31:16.443Z",
        message: { role: "user", content: "study these docs please" },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/x/a.md"}\n</system-reminder>',
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: `<system-reminder>\nResult of calling the Read tool:\n${"x".repeat(600)}\n</system-reminder>`,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<task-notification>\n<task-id>abc123</task-id>\n<status>failed</status>\n</task-notification>",
            },
          ],
        },
      }),
    ].join("\n");
    const r = transcriptToMarkdown(jsonl);
    expect((r.text.match(/^## user/gm) ?? []).length).toBe(1);
    expect(r.text).toContain("## user — 2026-11-14T10:31:16.443Z\n\nstudy these docs please");
    expect(r.text).toContain('### tool: Read — {"file_path":"/x/a.md"}');
    expect(r.text).toContain("### tool result — 600 chars");
    expect(r.text).toContain("### system\n\nCodebase and user instructions");
    expect(r.text).toContain("### system\n\n<task-id>abc123</task-id>");
  });

  it("keeps real words around a reminder in the same user text", () => {
    const jsonl = JSON.stringify({
      type: "user",
      timestamp: "2026-11-14T10:00:00Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "before\n<system-reminder>Result of calling the Bash tool:\nok\n</system-reminder>\nafter",
          },
        ],
      },
    });
    const r = transcriptToMarkdown(jsonl);
    expect(r.text).toContain("## user — 2026-11-14T10:00:00Z\n\nbefore");
    expect(r.text).toContain("### tool result — 2 chars");
    expect(r.text).toContain("## user\n\nafter");
  });
});

describe("foldReminderTurns", () => {
  it("refolds reminder-only ## user turns in a stored transcript", () => {
    const stored =
      "## user — 2026-11-14T10:31:16.443Z\n\nreal words\n\n" +
      '## user\n\n<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/x"}\n</system-reminder>\n\n' +
      "## assistant\n\nok\n";
    const out = foldReminderTurns(stored);
    expect(out).toContain("## user — 2026-11-14T10:31:16.443Z\n\nreal words");
    expect(out).toContain('### tool: Read — {"file_path":"/x"}');
    expect(out).toContain("## assistant\n\nok");
    expect((out.match(/^## user/gm) ?? []).length).toBe(1);
  });

  it("does not split a turn on ## lines inside a reminder body", () => {
    const stored =
      "## user\n\n<system-reminder>\nContents of AGENTS.md:\n\n## Writing\n\nuse STE\n</system-reminder>\n\n## assistant\n\ndone\n";
    const out = foldReminderTurns(stored);
    expect(out).toContain("### system\n\nContents of AGENTS.md:\n\n## Writing\n\nuse STE");
    expect((out.match(/^## (user|assistant)/gm) ?? []).length).toBe(1); // only ## assistant
  });

  it("leaves text without reminders byte-identical", () => {
    const raw =
      "# Title\n\n## user — ts\n\nhi\n\n### tool result\n\nfolded\n\n## assistant\n\nyo\n";
    expect(foldReminderTurns(raw)).toBe(raw);
  });
});
