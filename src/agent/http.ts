import { randomBytes } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonCtx } from "../daemon/server/context.js";
import type { AgentBinding } from "../mcp/server/mcp.js";
import { registerReadTools } from "../mcp/tools/read.js";
import { registerWriteTools } from "../mcp/tools/write.js";
import { AUTHORING_RULES } from "../core/files/template.js";
import type { ToolResult } from "../mcp/format.js";

/**
 * Plain-HTTP agent interface (DESIGN §7): any local AI that can run `curl`
 * drives TeamEngage with no MCP setup. `GET /agent` describes the protocol;
 * every MCP tool is reachable as `/agent/<tool>[/<id>]` with the SAME handler
 * (collected from registerRead/WriteTools), so output and rules are identical.
 *
 * Auth: no daemon token. Instead the daemon is loopback-only and these routes
 * refuse browsers — a non-loopback Host (DNS rebinding) or any Origin header
 * (cross-site requests) is rejected. Local processes are trusted, as with the
 * plans files themselves. `POST /agent/hello` mints a session token that the
 * agent sends as `X-TE-Session` on every later call.
 */

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;

interface Tool {
  description: string;
  shape: Record<string, ZodTypeAny>;
  handler: Handler;
}

/** Captures `registerTool` calls so the MCP handlers can be called over HTTP. */
function collectTools(binding: AgentBinding, ctx: DaemonCtx): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const collector = {
    registerTool(
      name: string,
      meta: { description?: string; inputSchema?: Record<string, ZodTypeAny> },
      handler: Handler,
    ) {
      tools.set(name, {
        description: meta.description ?? "",
        shape: meta.inputSchema ?? {},
        handler,
      });
    },
  } as unknown as McpServer;
  registerReadTools(collector, binding, ctx);
  registerWriteTools(collector, binding, ctx);
  return tools;
}

interface HttpSession {
  binding: AgentBinding;
  tools: Map<string, Tool>;
}

export const SESSION_HEADER = "x-te-session";

const STATUS: Record<string, number> = {
  NO_SESSION: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CLAIM_REFUSED: 409,
  INVALID_TRANSITION: 409,
  USAGE: 400,
  VALIDATION: 400,
};

/** `ERROR CODE: msg` → HTTP status; plain text otherwise → 200. */
function statusOf(r: ToolResult): number {
  if (!r.isError) return 200;
  const code = /^ERROR ([A-Z_]+):/.exec(r.content[0]?.text ?? "")?.[1] ?? "";
  return STATUS[code] ?? (code === "INTERNAL" ? 500 : 400);
}

/** Query strings are text; coerce what the tool schemas expect as numbers/bools/arrays. */
function coerce(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  if (v.startsWith("[") || v.startsWith("{")) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function describeArgs(shape: Record<string, ZodTypeAny>): string {
  const parts = Object.entries(shape).map(([k, s]) => (s.isOptional() ? `${k}?` : k));
  return parts.length ? parts.join(", ") : "—";
}

export function agentGuide(base: string, tools: Map<string, Tool>): string {
  const rows = [...tools.entries()]
    .filter(([name]) => name !== "hello")
    .map(([name, t]) => `  ${name.padEnd(8)} ${describeArgs(t.shape).padEnd(34)} ${t.description}`);
  return `TeamEngage — agent interface (plain HTTP)
=========================================
Base URL: ${base}/agent        (loopback only; no MCP needed — use curl)

RULES
  1. Read freely: GET endpoints, or the plan files themselves.
  2. Change state ONLY through these endpoints — never edit .teamengage/ files.
  3. claim before touching code; work only in the paths brief/claim return.
  4. ask instead of guessing; submit with evidence. Never mark work done.
     Never git push. The human approves, answers, and accepts.

AUTHORING
${AUTHORING_RULES.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")}
SESSION
  curl -s -X POST ${base}/agent/hello -d '{"agent":"<your-name>"}'
    → first line: "token <TOKEN>"; send it on every later call:
  -H "X-TE-Session: <TOKEN>"
  Keep the token for the whole task. After a daemon restart, call hello again:
  claims you held are rebound to your new session automatically.

CALLS  (POST with a JSON body, or GET with query args; <id> may go in the path)
  ${"tool".padEnd(8)} ${"args".padEnd(34)} what it does
${rows.join("\n")}
  bye      —                                  end this session (claims stay; hello again to resume)

EXAMPLES
  T=$(curl -s -X POST ${base}/agent/hello -d '{"agent":"gemini-cli"}' | sed -n 's/^token //p')
  curl -s ${base}/agent/next -H "X-TE-Session: $T"
  curl -s ${base}/agent/brief/MP-0002 -H "X-TE-Session: $T"
  curl -s -X POST ${base}/agent/claim/MP-0002 -H "X-TE-Session: $T"
  curl -s -X POST ${base}/agent/log/MP-0002 -H "X-TE-Session: $T" -d '{"note":"tests green"}'
  curl -s -X POST ${base}/agent/ask/MP-0002 -H "X-TE-Session: $T" -d '{"question":"A or B?","options":["A","B"]}'
  curl -s -X POST ${base}/agent/submit/MP-0002 -H "X-TE-Session: $T" -d '{"commits":["abc123"],"tests":"42 passed"}'

Responses are compact text. Errors: "ERROR <CODE>: message" with HTTP 4xx/5xx.
`;
}

export function registerAgentRoutes(app: FastifyInstance, ctx: DaemonCtx): void {
  const sessions = new Map<string, HttpSession>(); // token → session

  void app.register(async (scope) => {
    // agents send JSON with whatever content-type curl picks (-d defaults to
    // form-urlencoded): parse any body as JSON, empty → {}
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
      const s = String(body ?? "").trim();
      if (!s) return done(null, {});
      try {
        done(null, JSON.parse(s));
      } catch {
        const err = new Error("body must be JSON") as Error & { statusCode: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    });

    // browsers are not agents: block DNS rebinding and cross-site requests
    scope.addHook("onRequest", async (req, reply) => {
      if (!isLoopbackHost(req.headers.host) || req.headers.origin !== undefined) {
        await reply
          .code(403)
          .type("text/plain")
          .send("ERROR FORBIDDEN: agent API is for local tools, not browsers\n");
      }
    });

    const base = (req: FastifyRequest) => `http://${req.headers.host}`;
    const send = (reply: FastifyReply, code: number, text: string) =>
      reply
        .code(code)
        .type("text/plain; charset=utf-8")
        .send(text.endsWith("\n") ? text : `${text}\n`);

    scope.get("/agent", async (req, reply) => {
      // a throwaway binding just to list the tools for the guide
      const tools = collectTools({}, ctx);
      return send(reply, 200, agentGuide(base(req), tools));
    });

    scope.post("/agent/hello", async (req, reply) => {
      const b = (req.body ?? {}) as { agent?: unknown; workspace?: unknown };
      const binding: AgentBinding = {};
      const tools = collectTools(binding, ctx);
      const hello = tools.get("hello")!;
      const parsed = z.object(hello.shape).safeParse(b);
      if (!parsed.success) {
        return send(reply, 400, `ERROR USAGE: hello needs {"agent":"<name>"}`);
      }
      const r = await hello.handler(parsed.data, {});
      if (r.isError || !binding.session) return send(reply, statusOf(r), r.content[0].text);
      const token = randomBytes(18).toString("base64url");
      sessions.set(token, { binding, tools });
      return send(reply, 200, `token ${token}\n${r.content.map((c) => c.text).join("\n")}`);
    });

    const call = async (req: FastifyRequest, reply: FastifyReply) => {
      const { tool, id } = req.params as { tool: string; id?: string };
      const token = req.headers[SESSION_HEADER];
      const s = typeof token === "string" ? sessions.get(token) : undefined;
      if (!s) {
        return send(
          reply,
          401,
          `ERROR NO_SESSION: POST /agent/hello first, then send ${SESSION_HEADER}`,
        );
      }
      if (tool === "bye") {
        if (s.binding.session) ctx.sessions.disconnect(s.binding.session.id);
        sessions.delete(token as string);
        return send(reply, 200, "bye");
      }
      const t = s.tools.get(tool);
      if (!t || tool === "hello")
        return send(reply, 404, `ERROR NOT_FOUND: no tool '${tool}' (see GET /agent)`);
      const raw: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>))
        raw[k] = coerce(v);
      Object.assign(raw, (req.body ?? {}) as Record<string, unknown>);
      if (id !== undefined) raw.id = id;
      const parsed = z.object(t.shape).safeParse(raw);
      if (!parsed.success) {
        const why = parsed.error.issues
          .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
          .join("; ");
        return send(reply, 400, `ERROR USAGE: ${tool} — ${why} (args: ${describeArgs(t.shape)})`);
      }
      const r = await t.handler(parsed.data, {});
      return send(reply, statusOf(r), r.content.map((c) => c.text).join("\n"));
    };
    scope.get("/agent/:tool", call);
    scope.post("/agent/:tool", call);
    scope.get("/agent/:tool/:id", call);
    scope.post("/agent/:tool/:id", call);
  });
}
