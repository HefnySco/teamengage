import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runningDaemon } from "../daemon/server/server.js";

/**
 * Daemon client for the CLI: auto-starts `teamengaged` when needed (same
 * "second start is a no-op" guarantee the shim relies on) and talks to
 * 127.0.0.1 with the bearer token from daemon.json.
 */

const here = dirname(fileURLToPath(import.meta.url));
const daemonEntry = join(here, "..", "daemon", "main.js");

export async function ensureDaemon(home?: string): Promise<{ port: number; token: string }> {
  for (let i = 0; i < 60; i++) {
    const info = await runningDaemon(home);
    if (info) return info;
    if (i === 0) {
      const child = spawn(process.execPath, [daemonEntry], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("daemon did not start");
}

export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

/** GET/POST a daemon API route; returns parsed body or throws ApiError. */
export async function daemonApi(
  method: string,
  path: string,
  body?: unknown,
  home?: string,
): Promise<unknown> {
  const { port, token } = await ensureDaemon(home);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = (data ?? {}) as ApiError;
    throw Object.assign(new Error(err.message ?? `HTTP ${res.status}`), {
      code: err.error ?? "HTTP",
      status: res.status,
      details: err.details,
    });
  }
  return data;
}
