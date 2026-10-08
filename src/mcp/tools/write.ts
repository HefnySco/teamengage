import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import type { AgentBinding } from "../server/mcp.js";
import type { WorkspaceOps } from "../../daemon/api/ops.js";
import { okText, errFrom, type ToolResult } from "../format.js";
import { opsFor, needSession, isToolResult } from "./read.js";

/**
 * Write tools (DESIGN §7): claim, release, log, ask, submit, propose.
 * All mutations go through the store — serialized, CAS-checked, committed.
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
        "Take an item: writes the claim file, locks targets, sets up worktrees/snapshots.",
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
    "propose",
    {
      description: "Create draft items for the human to approve (agents cannot set other statuses).",
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
        const { ids } = await o.propose(items, s);
        return okText(`proposed ${ids.join(", ")}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );
}
