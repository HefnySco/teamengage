import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import type { AgentBinding } from "../server/mcp.js";
import type { WorkspaceOps } from "../../daemon/api/ops.js";
import { okText, errFrom, type ToolResult } from "../format.js";
import { opsFor, needSession, isToolResult } from "./read.js";

/**
 * Write tools (DESIGN §7): claim, release, log, ask, submit, review, bounce,
 * propose. All mutations go through the store — serialized, CAS-checked,
 * committed.
 */

export function registerWriteTools(
  server: McpServer,
  binding: AgentBinding,
  ctx: DaemonCtx,
): void {
  const ops = (): WorkspaceOps | ToolResult => opsFor(binding, ctx);
  const session = () => needSession(binding);

  server.registerTool(
    "claim",
    {
      description:
        "Take an item: writes the claim file, locks targets, sets up worktrees/snapshots. " +
        "On an in_review item with an AI 'issues' verdict this takes the claim over — same machine only.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const { claim, version } = await o.claim(id, s);
        return okText(`claimed ${id} v${version} holder=${claim.holder}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "release",
    {
      description: "Give back an item (claim deleted, work kept).",
      inputSchema: { id: z.string(), note: z.string().optional() },
    },
    async ({ id, note }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.release(id, s, note);
        return okText(`released ${id} → ready`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "log",
    {
      description: "Progress note on a claimed item.",
      inputSchema: { id: z.string(), note: z.string() },
    },
    async ({ id, note }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.log(id, s, note);
        return okText(`logged ${id}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "note",
    {
      description:
        "Add a note (multi-line markdown) to an item: appended to the task file's ## Notes with a timestamp. " +
        "Use it for findings worth keeping in the task; progress goes in log. No claim needed.",
      inputSchema: { id: z.string(), text: z.string() },
    },
    async ({ id, text }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.note(id, s, text);
        return okText(`noted ${id} → ${r.path}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "simple",
    {
      description:
        "Write the item's plain-English version for the human (a short, non-technical explanation of what and why). " +
        "Creates or replaces <task>.simple.md and links it — never create .simple.md files by hand. No claim needed.",
      inputSchema: { id: z.string(), text: z.string() },
    },
    async ({ id, text }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.simple(id, s, text);
        return okText(`simple ${id} → ${r.path}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "ask",
    {
      description: "Record a question → item waits for the human.",
      inputSchema: {
        id: z.string(),
        question: z.string(),
        options: z.array(z.string()).optional(),
      },
    },
    async ({ id, question, options }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.ask(id, s, question, options);
        return okText(`waiting ${id}: human's turn`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "submit",
    {
      description: "Hand work to the human with evidence (commits/tests/notes).",
      inputSchema: {
        id: z.string(),
        commits: z.array(z.string()).optional(),
        tests: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async ({ id, commits, tests, notes }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.submit(id, s, { commits, tests, notes });
        return okText(`in_review ${id}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "review",
    {
      description:
        "Peer-review a submission as a different session than the holder (find them: query status=in_review). " +
        "Read the task file, the Evidence section and the actual diff/tests first, then record verdict ok|issues " +
        "with summary (one plain-English sentence for the human — what the verdict means, no jargon) " +
        "and a specific note for whoever fixes it (findings with file:line). " +
        "Advisory marker only — it never changes status; the human still accepts. Never review your own submission.",
      inputSchema: {
        id: z.string(),
        verdict: z.enum(["ok", "issues"]),
        summary: z.string(),
        note: z.string().optional(),
      },
    },
    async ({ id, verdict, summary, note }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.review(id, s, verdict, note, summary);
        return okText(`reviewed ${id}: ${verdict}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "bounce",
    {
      description:
        "Reviewer only (not the holder): send a broken submission back to its holder — in_review → in_progress, " +
        "the claim is kept so the holder fixes and resubmits. reason is required and goes to the holder; " +
        "summary is required too — one plain-English sentence for the human, no jargon. " +
        "Capped: after 2 AI bounces in a row the item stays in review for the human — record a review instead.",
      inputSchema: { id: z.string(), reason: z.string(), summary: z.string() },
    },
    async ({ id, reason, summary }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.bounce(id, s, reason, summary);
        return okText(`bounced ${id} → in_progress (holder fixes and resubmits)`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "close_plan",
    {
      description:
        "Close a plan (epic): no more parts coming — plan_state turns active, then done when every part finishes. Human-only; agents are refused.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.closePlan(id, s);
        return okText(`plan closed ${id}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "reopen_plan",
    {
      description: "Reopen a closed plan (epic) — more parts may still be added. Human-only; agents are refused.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.reopenPlan(id, s);
        return okText(`plan reopened ${id}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "propose",
    {
      description:
        "Create draft items for the human to approve (agents cannot set other statuses). " +
        "In a task-folder workspace each item becomes <project>/TASK-NN-<slug>.md (epics: PHASE-NN-…) " +
        "from the standard template — give acceptance criteria an agent can check and the repos/paths it touches. " +
        "depends_on/parent may use #N for the N-th (0-based) earlier item of the same call.",
      inputSchema: {
        items: z.array(
          z.object({
            type: z.string().optional(),
            title: z.string(),
            project: z.string().optional(),
            targets: z.array(z.string()).optional(),
            depends_on: z.array(z.string()).optional(),
            parent: z.string().optional(),
            summary: z.string().optional(),
            acceptance: z.array(z.string()).optional(),
            touches: z.array(z.string()).optional(),
            simple: z.string().optional(),
            domains: z.array(z.string()).optional(),
          }),
        ),
      },
    },
    async ({ items }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const { ids, files } = await o.propose(items, s);
        return okText(
          files.length
            ? ids.map((id, i) => `proposed ${id} → ${files[i]}`).join("\n")
            : `proposed ${ids.join(", ")}`,
        );
      } catch (e) {
        return errFrom(e);
      }
    },
  );
}
