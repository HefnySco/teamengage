import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Web UI static serving (UI-0001): the daemon serves `web/` at `/` — the
 * preact bundle and lazy chunks from `web/dist` (built by `npm run build:web`).
 * Auth rides the global hook (te_token cookie / ?token=).
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

export function registerUiRoutes(app: FastifyInstance): void {
  const send = (reply: FastifyReply, path: string) => {
    if (!existsSync(path) || !path.startsWith(webRoot)) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.type(MIME[extname(path)] ?? "application/octet-stream").send(readFileSync(path));
  };

  app.get("/", async (_req, reply) => send(reply, join(webRoot, "index.html")));
  app.get("/ui", async (_req, reply) => send(reply, join(webRoot, "index.html")));
  // the mark: favicon and header logo (web/favicon.svg, web/logo.svg)
  app.get("/favicon.svg", async (_req, reply) => send(reply, join(webRoot, "favicon.svg")));
  app.get("/favicon.ico", async (_req, reply) => send(reply, join(webRoot, "favicon.svg")));
  app.get("/logo.svg", async (_req, reply) => send(reply, join(webRoot, "logo.svg")));
  app.get("/assets/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (file.includes("..")) return reply.code(404).send({ error: "not found" });
    return send(reply, join(webRoot, "dist", file));
  });
}
