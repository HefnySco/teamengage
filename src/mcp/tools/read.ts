import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import type { AgentBinding } from "../server/mcp.js";
import { pickWorkspace } from "../server/mcp.js";
import { WorkspaceOps } from "../../daemon/api/ops.js";
import type { Session } from "../../core/model/session.js";
import { okText, errText, errFrom, itemLine, type ToolResult } from "../format.js";
import { handoffStatus, handoffLines } from "../../daemon/sync/sync.js";

/**
 * Read tools (DESIGN §7): hello, next, brief, query, graph.
 * Output is compact text — ids and one-liners.
 */

export function opsFor(binding: AgentBinding, ctx: DaemonCtx, workspace?: string) {
  const wsr = pickWorkspace(binding, ctx, workspace);
  if ("content" in wsr) return wsr; // ToolResult error
  return new WorkspaceOps(wsr, ctx.sessions, wsr.links, ctx.home);
}

export function needSession(binding: AgentBinding): ToolResult | Session {
  if (!binding.session) return errText("NO_SESSION", "call hello first");
  return binding.session;
}

/** Zod passthrough objects defeat `in`-narrowing — use a real type guard. */
export function isToolResult(x: unknown): x is ToolResult {
  return (
    typeof x === "object" &&
    x !== null &&
    Array.isArray((x as ToolResult).content)
  );
}

/** One line every session sees, whatever its instruction files say. */
export const HELLO_RULES =
  "rules: claim before code · new tasks only via propose · never edit te: lines or .teamengage/, never move files to done/ · task-file edits additive + log · never push · ask, don't guess";

export function registerReadTools(server: McpServer, binding: AgentBinding, ctx: DaemonCtx): void {
  server.registerTool(
    "hello",
    {
      description:
        "Register a session; returns session id, machine, workspace summary, claims to resume.",
      inputSchema: { agent: z.string(), workspace: z.string().optional() },
    },
    async ({ agent, workspace }) => {
      try {
        const ops = opsFor(binding, ctx, workspace);
        if ("content" in ops) return ops;
        // a repeat hello on this connection replaces the old session —
        // retire it so its claims rebind instead of looking "live"
        if (binding.session) ctx.sessions.disconnect(binding.session.id);
        const { session, resume } = await ops.hello(agent, binding.clientPid);
        binding.session = session;
        const ws = ops.wsr.ws;
        const counts = { ready: ops.index.readyItems().length, items: ops.index.items.size };
        const lines = [
          `session ${session.id} on ${session.machine}`,
          `workspace ${ws.name} items:${counts.items} ready:${counts.ready}`,
        ];
        if (resume.length) {
          lines.push(`resume: ${resume.map((c) => c.item).join(", ")}`);
        }
        lines.push(...handoffLines(await handoffStatus(ops.wsr)));
        lines.push(HELLO_RULES);
        return okText(lines.join("\n"));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "next",
    {
      description: "Ready, unclaimed items whose targets are free, best first. domain: only items tagged with it.",
      inputSchema: { limit: z.number().int().min(1).max(20).optional(), domain: z.string().optional() },
    },
    ({ limit, domain }) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        const items = ops.next(limit ?? 3, domain);
        if (!items.length) return okText("nothing ready");
        return okText(items.map(itemLine).join("\n"));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "brief",
    {
      description:
        "What an agent needs to work an item: summary, acceptance, dep outcomes, decisions, resolved targets.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        const b = await ops.brief(id);
        const it = b.item;
        const sec = (n: string) =>
          it.sections.find((s) => s.heading.toLowerCase() === n.toLowerCase())?.body.trim() ?? "";
        const lines: string[] = [
          `${it.meta.id} ${it.meta.status}${it.meta.archived ? " [archived]" : ""} "${it.meta.title}" v${it.meta.version}`,
        ];
        if (it.meta.domains.length) lines.push(`domains: ${it.meta.domains.map((d) => `#${d}`).join(" ")}`);
        if (!b.source) lines.push(`summary: ${sec("Summary")}`);
        else if ("missing" in b.source) lines.push(`source: ${b.source.path} (MISSING — ask the human)`);
        else lines.push(`source: ${b.source.path}${b.source.moved ? " (moved)" : ""}`, b.source.text.trim());
        const acc = sec("Acceptance");
        if (acc) lines.push(`acceptance:\n${acc}`);
        for (const d of b.deps) {
          lines.push(
            `dep ${d.ref} ${d.status}${d.pending ? " (not accepted yet — build on it, but it may still change)" : ""}${d.archived ? " [archived]" : ""}${d.outcome ? ` — ${d.outcome}` : ""}`,
          );
        }
        for (const d of b.decisions) {
          lines.push(`decision ${d.meta.id}: ${d.meta.title}`);
        }
        for (const t of b.targets) {
          lines.push(`target ${t.ref} → ${t.kind}${t.host ? ` ${t.host}` : ""}${t.path ? ` ${t.path}` : ""}`);
        }
        return okText(lines.join("\n"));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "query",
    {
      description: "Search items by status/type/project/domain/resource/text.",
      inputSchema: {
        status: z.string().optional(),
        domain: z.string().optional(),
        type: z.string().optional(),
        project: z.string().optional(),
        resource: z.string().optional(),
        text: z.string().optional(),
      },
    },
    (args) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        const items = ops.query({
          status: args.status as never,
          type: args.type,
          project: args.project,
          domain: args.domain,
          resource: args.resource,
          text: args.text,
        });
        if (!items.length) return okText("no matches");
        return okText(items.slice(0, 50).map(itemLine).join("\n"));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "graph",
    {
      description: "Mermaid flowchart of a scoped subgraph.",
      inputSchema: {
        root: z.string().optional(),
        depth: z.number().int().min(0).optional(),
        status: z.string().optional(),
        project: z.string().optional(),
      },
    },
    ({ root, depth, status, project }) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        return okText(
          ops.graph({
            roots: root ? [root] : undefined,
            depth,
            filter: { status: status as never, project },
          }),
        );
      } catch (e) {
        return errFrom(e);
      }
    },
  );
}
