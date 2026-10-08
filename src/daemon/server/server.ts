import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { teHome } from "../../core/config/config.js";

/**
 * Daemon process and HTTP server (DESIGN §6.1). One `teamengaged` per machine:
 * binds 127.0.0.1 on a random port, writes {pid, port, token} to
 * `~/.teamengage/daemon.json` (0600). All routes except /health need the
 * bearer token. Graceful shutdown drains plugin-provided async work.
 */

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  started: string;
}

export interface DaemonHandle {
  port: number;
  token: string;
  url: string;
  app: FastifyInstance;
  close: () => Promise<void>;
}

export function daemonJsonPath(home?: string): string {
  return join(teHome(home), "daemon.json");
}

export function readDaemonInfo(home?: string): DaemonInfo | null {
  try {
    const p = daemonJsonPath(home);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Is a healthy daemon already running for this HOME? */
export async function runningDaemon(home?: string): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(home);
  if (!info || !pidAlive(info.pid)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? info : null;
  } catch {
    return null;
  }
}

export interface StartOpts {
  home?: string;
  /** Extra route registrars (API, MCP, UI, SSE). */
  register?: (app: FastifyInstance) => void | Promise<void>;
  /** Called on shutdown — drain write queues, close watchers. */
  onShutdown?: () => Promise<void>;
  /** Data for /health. */
  health?: () => Record<string, unknown>;
}

export async function startDaemon(opts: StartOpts = {}): Promise<DaemonHandle> {
  const token = randomBytes(24).toString("hex");
  // forceCloseConnections: SSE/keep-alive clients would otherwise hold
  // server.close() open forever — SIGTERM must actually stop the daemon
  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    forceCloseConnections: true,
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const auth = req.headers.authorization;
    // browsers can't set headers on navigation/SSE — accept the same token
    // via ?token= or a te_token cookie (set by the UI once, then dropped from
    // the URL). Still loopback-only.
    const q = (req.query ?? {}) as { token?: string };
    const cookie = /(?:^|;\s*)te_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (auth !== `Bearer ${token}` && q.token !== token && cookie !== token) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    // a successful ?token= login plants the cookie so subresource requests
    // (app.js, SSE, API) authenticate without the query param
    if (q.token === token && cookie !== token) {
      void reply.header("set-cookie", `te_token=${token}; path=/; samesite=strict; httponly`);
    }
  });

  app.get("/health", async () => ({ ok: true, ...(opts.health?.() ?? {}) }));

  if (opts.register) await opts.register(app);

  // random port on loopback only
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const home = teHome(opts.home);
  mkdirSync(home, { recursive: true });
  const info: DaemonInfo = {
    pid: process.pid,
    port,
    token,
    started: new Date().toISOString(),
  };
  const infoPath = daemonJsonPath(opts.home);
  writeFileSync(infoPath, JSON.stringify(info, null, 2));
  chmodSync(infoPath, 0o600);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await opts.onShutdown?.();
    await app.close();
    try {
      const cur = readDaemonInfo(opts.home);
      if (cur?.pid === process.pid) unlinkSync(infoPath);
    } catch {
      /* gone already */
    }
  };

  const onSig = () => void close().then(() => process.exit(0));
  process.once("SIGTERM", onSig);
  process.once("SIGINT", onSig);

  return { port, token, url: `http://127.0.0.1:${port}`, app, close };
}
