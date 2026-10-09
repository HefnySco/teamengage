import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DaemonCtx, WorkspaceRuntime } from "../../daemon/server/context.js";
import type { Session } from "../../core/model/session.js";
import { errText, CLIENT_PID_HEADER, type ToolResult } from "../format.js";
import { AUTHORING_RULES } from "../../core/files/template.js";

/** Sent at initialize — MCP clients put it in the agent's system prompt. */
export const MCP_INSTRUCTIONS = `TeamEngage coordinates the human's plans and the agents working on them.
Workflow: hello (once) → next → brief <id> → claim <id> → log / ask → submit. Claim before
touching code and work only in the paths brief/claim return. Ask instead of guessing. Never
mark work done, never git push — the human approves and accepts. Never edit files under
.teamengage/; change state only through these tools.

${AUTHORING_RULES}`;

/**
 * MCP over Streamable HTTP (DESIGN §6.1, §7). Mounted at `/mcp` on the daemon
 * (bearer-token auth is enforced globally by the daemon's auth hook).
 *
 * One MCP connection = one TeamEngage session after `hello` — the binding is
 * keyed by the transport's mcp-session-id, so agents never pass credentials
 * to tools.
 */

export interface AgentBinding {
  session?: Session;
  wsr?: WorkspaceRuntime;
  /** Local client pid from the `x-te-client-pid` header (set by the shim). */
  clientPid?: number;
}

function clientPidOf(req: FastifyRequest): number | undefined {
  const raw = req.headers[CLIENT_PID_HEADER];
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export interface McpDeps {
  ctx: DaemonCtx;
  /** Per-connection tool registrars (read tools, write tools). */
  tools: (server: McpServer, binding: AgentBinding, ctx: DaemonCtx) => void;
}

const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

export function createMcpServer(deps: McpDeps): {
  server: McpServer;
  binding: AgentBinding;
} {
  const server = new McpServer({ name: "teamengage", version: "0.1.0" }, { instructions: MCP_INSTRUCTIONS });
  const binding: AgentBinding = {};
  deps.tools(server, binding, deps.ctx);
  return { server, binding };
}

function pickWorkspace(binding: AgentBinding, ctx: DaemonCtx, name?: string): WorkspaceRuntime | ToolResult {
  if (binding.wsr) return binding.wsr;
  if (name) {
    const w = ctx.workspaces.get(name);
    if (!w) return errText("NOT_FOUND", `workspace '${name}' not registered`);
    return (binding.wsr = w);
  }
  if (ctx.workspaces.size === 1) return (binding.wsr = ctx.workspaces.values().next().value!);
  return errText("USAGE", `workspace required (have: ${[...ctx.workspaces.keys()].join(", ")})`);
}

export { pickWorkspace };

export function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): void {
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let entry = sessionId ? sessions.get(sessionId) : undefined;

      if (!entry) {
        // new connection: only an initialize request may open a session
        const { server, binding } = createMcpServer(deps);
        binding.clientPid = clientPidOf(req);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        // transport.onclose belongs to the connected protocol, and McpServer
        // wraps the inner Protocol — hook THAT one's onclose
        server.server.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          // the session is dead — a later hello() by the same agent may
          // rebind its claims; while it was live they were unreachable
          if (binding.session) deps.ctx.sessions.disconnect(binding.session.id);
        };
        await server.connect(transport);
        entry = { transport, server };
        // session id is assigned when the transport processes the initialize
        await transport.handleRequest(req.raw, reply.raw, req.body);
        if (transport.sessionId) sessions.set(transport.sessionId, entry);
        return;
      }
      await entry.transport.handleRequest(req.raw, reply.raw, req.body);
    },
  });
}
