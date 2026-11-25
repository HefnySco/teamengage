import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import YAML from "yaml";
import { z } from "zod";
import type { DaemonCtx, WorkspaceRuntime } from "../../daemon/server/context.js";
import type { Session } from "../../core/model/session.js";
import { errText, CLIENT_PID_HEADER, type ToolResult } from "../format.js";
import { AUTHORING_RULES } from "../../core/files/template.js";
import { repoSkillsDir } from "../../cli/commands/skills.js";

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

/* --- Skills over MCP (SEP-2640) ----------------------------------------- */

/** The skills extension id — declared in capabilities.extensions. */
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/** Cache fields SEP-2640 puts on skills/list|get results. */
const SKILL_CACHE = { ttlMs: 5 * 60 * 1000, cacheScope: "public" } as const;

const TEXT_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".csv": "text/csv",
  ".html": "text/html",
  ".sh": "text/x-shellscript",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
};

const mimeOf = (rel: string) => TEXT_MIME[extname(rel).toLowerCase()] ?? "application/octet-stream";

interface SkillFile {
  rel: string; // path inside the skill dir, "/" separated
  path: string; // absolute path on disk
  uri: string; // skill://<name>/<rel>
  size: number;
  digest: string; // sha256:<hex>
}

interface SkillEntry {
  name: string; // frontmatter name (dir basename as fallback)
  description?: string; // frontmatter description
  uri: string; // the SKILL.md file's uri
  frontmatter: Record<string, unknown>;
  files: SkillFile[]; // SKILL.md first
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const doc = m ? (YAML.parse(m[1]) as unknown) : undefined;
  return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
}

function walkFiles(dir: string, sub = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function skillUri(name: string, rel: string): string {
  return new URL(`skill://${name}/${rel.split("/").map(encodeURIComponent).join("/")}`).toString();
}

/** Scan the repo's skills/ and build each skill's file manifest once. */
function loadSkills(): SkillEntry[] {
  let root: string;
  try {
    root = repoSkillsDir();
  } catch {
    return []; // no skills/ next to this build — nothing to serve
  }
  const out: SkillEntry[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const skillMd = join(dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const frontmatter = parseFrontmatter(readFileSync(skillMd, "utf8"));
    const name = typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : e.name;
    const files = walkFiles(dir)
      .sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)))
      .map((rel) => {
        const path = join(dir, rel);
        const buf = readFileSync(path);
        return {
          rel,
          path,
          uri: skillUri(name, rel),
          size: buf.length,
          digest: `sha256:${createHash("sha256").update(buf).digest("hex")}`,
        };
      });
    out.push({
      name,
      description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
      uri: files[0].uri, // SKILL.md sorts first
      frontmatter,
      files,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const skillManifest = (s: SkillEntry) => ({
  uri: s.uri,
  frontmatter: s.frontmatter,
  resources: s.files.map((f) => ({ uri: f.uri, digest: f.digest, size: f.size })),
});

const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

const SkillsGetRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string() }).passthrough(),
});

/**
 * Serve the repo's skills/ tree over MCP (SEP-2640): declare the resources
 * capability and the io.modelcontextprotocol/skills extension, register
 * every file under skills/<name>/ as a skill:// resource, and answer
 * skills/list|get — the two methods a server declaring the extension must
 * implement.
 */
function registerSkills(server: McpServer): void {
  server.server.registerCapabilities({
    resources: {},
    extensions: { [SKILLS_EXTENSION]: {} },
  });
  const skills = loadSkills();
  for (const s of skills) {
    for (const f of s.files) {
      server.registerResource(
        s.name,
        f.uri,
        { title: `${s.name}/${f.rel}`, description: s.description, mimeType: mimeOf(f.rel), size: f.size },
        async (uri) => {
          const mime = mimeOf(f.rel);
          const buf = readFileSync(f.path);
          return {
            contents: [
              mime === "application/octet-stream"
                ? { uri: uri.toString(), mimeType: mime, blob: buf.toString("base64") }
                : { uri: uri.toString(), mimeType: mime, text: buf.toString("utf8") },
            ],
          };
        },
      );
    }
  }
  server.server.setRequestHandler(SkillsListRequestSchema, () => ({
    resultType: "complete",
    skills: skills.map(skillManifest),
    ...SKILL_CACHE,
  }));
  server.server.setRequestHandler(SkillsGetRequestSchema, (req) => {
    let uri = req.params.uri;
    try {
      uri = new URL(uri).toString();
    } catch {
      /* not a URL — it just won't match */
    }
    const s = skills.find((e) => e.uri === uri || e.uri === req.params.uri);
    if (!s) throw new McpError(ErrorCode.InvalidParams, `skill ${req.params.uri} not found`);
    return { resultType: "complete", skill: skillManifest(s), ...SKILL_CACHE };
  });
}

export function createMcpServer(deps: McpDeps): {
  server: McpServer;
  binding: AgentBinding;
} {
  const server = new McpServer({ name: "teamengage", version: "0.1.0" }, { instructions: MCP_INSTRUCTIONS });
  const binding: AgentBinding = {};
  deps.tools(server, binding, deps.ctx);
  registerSkills(server);
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
