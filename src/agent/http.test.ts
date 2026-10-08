import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { PlansStore } from "../daemon/store/store.js";
import { PlansWatcher } from "../daemon/watch/watch.js";
import { resolveWorkspace } from "../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../daemon/server/server.js";
import type { DaemonCtx } from "../daemon/server/context.js";
import { SessionRegistry } from "../daemon/sessions/sessions.js";
import { EventBus } from "../daemon/api/events.js";
import { registerAgentRoutes, SESSION_HEADER } from "./http.js";

/**
 * Plain-HTTP agent API: the protocol an AI with only curl and a URL can use.
 * Same handlers as the MCP tools, so these tests focus on the HTTP layer —
 * discovery, sessions, arg parsing, status codes, and the browser guards.
 */

let home: string;
let plans: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let watcher: PlansWatcher;

const url = (p: string) => `${daemon.url}${p}`;
const dirty = () =>
  execFileSync("git", ["status", "--porcelain"], { cwd: plans, encoding: "utf8" }).trim();

async function call(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(url(path), {
    method,
    headers: {
      ...(opts.token ? { [SESSION_HEADER]: opts.token } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, text: await res.text() };
}

async function hello(agent: string): Promise<string> {
  const r = await call("POST", "/agent/hello", { body: { agent } });
  expect(r.status).toBe(200);
  const token = /^token (\S+)/.exec(r.text)?.[1];
  expect(token).toBeDefined();
  return token!;
}

/** Raw request with a forged Host header (fetch forbids setting Host). */
function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: daemon.port, path, method: "GET", headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-agent-http-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: ., worktree: false }\n",
  );
  for (const n of [1, 2, 3]) {
    const id = `WS-000${n}`;
    writeFileSync(
      join(plans, "items", "WS", `${id}.md`),
      `---\nid: ${id}\ntype: task\ntitle: task ${n}\nstatus: ready\nversion: 1\ntargets: ["@self:src/f${n}.ts"]\n---\n\n## Summary\nx\n`,
    );
  }
  for (const a of [
    ["init", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "-m", "init"],
  ]) {
    execFileSync("git", a, { cwd: plans });
  }
  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  watcher = new PlansWatcher(store, { debounceMs: 50 });
  ctx = {
    home,
    machine: "test",
    workspaces: new Map([["ws", { ws, store, watcher }]]),
    sessions: new SessionRegistry("test"),
    bus: new EventBus(),
  };
  await watcher.start();
  daemon = await startDaemon({ home, register: (app) => registerAgentRoutes(app, ctx) });
}, 30_000);

afterAll(async () => {
  await watcher.close();
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("plain-HTTP agent API", () => {
  it("GET /agent describes the protocol without any token", async () => {
    const r = await call("GET", "/agent");
    expect(r.status).toBe(200);
    expect(r.text).toContain("RULES");
    expect(r.text).toContain(`${daemon.url}/agent/hello`);
    for (const tool of ["next", "brief", "claim", "log", "ask", "submit", "propose"]) {
      expect(r.text).toMatch(new RegExp(`^  ${tool}\\s`, "m"));
    }
  });

  it("refuses browsers: any Origin header, or a non-loopback Host (DNS rebinding)", async () => {
    const o = await call("GET", "/agent", { headers: { origin: "https://evil.example" } });
    expect(o.status).toBe(403);
    expect(await rawGet("/agent", "evil.example")).toBe(403);
    expect(await rawGet("/agent", `localhost:${daemon.port}`)).toBe(200);
  });

  it("calls without a session token are 401 with a hint", async () => {
    const r = await call("GET", "/agent/next");
    expect(r.status).toBe(401);
    expect(r.text).toContain("POST /agent/hello");
  });

  it("full loop: hello → next → brief → claim → log → ask; errors map to HTTP codes", async () => {
    const t = await hello("gemini-cli");
    const next = await call("GET", "/agent/next?limit=2", { token: t });
    expect(next.status).toBe(200);
    expect(next.text.trim().split("\n")).toHaveLength(2); // query limit coerced to a number
    const brief = await call("GET", "/agent/brief/WS-0001", { token: t });
    expect(brief.text).toContain("WS-0001");
    expect((await call("POST", "/agent/claim/WS-0001", { token: t })).text).toMatch(
      /^claimed WS-0001/,
    );
    const log = await call("POST", "/agent/log/WS-0001", { token: t, body: { note: "halfway" } });
    expect(log.text.trim()).toBe("logged WS-0001");
    const ask = await call("POST", "/agent/ask/WS-0001", {
      token: t,
      body: { question: "A or B?", options: ["A", "B"] },
    });
    expect(ask.status).toBe(200);

    // another agent can't touch it; a missing item is 404; bad args are 400
    const other = await hello("cursor");
    expect((await call("POST", "/agent/claim/WS-0001", { token: other })).status).toBe(409);
    expect(
      (await call("POST", "/agent/log/WS-0001", { token: other, body: { note: "x" } })).status,
    ).toBe(403);
    expect((await call("GET", "/agent/brief/WS-9999", { token: other })).status).toBe(404);
    const bad = await call("POST", "/agent/log/WS-0001", { token: t, body: {} });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("note");
    expect((await call("POST", "/agent/nope", { token: t })).status).toBe(404);
    await new Promise((r) => setTimeout(r, 300));
    expect(dirty()).toBe("");
  });

  it("works with plain curl (form content-type body, path id)", async () => {
    // async: the daemon under test runs in this process — a sync spawn would
    // block the event loop it needs to answer curl
    const curl = async (...args: string[]) =>
      (await promisify(execFile)("curl", ["-s", ...args])).stdout;
    const t = await hello("claude-code");
    const out = await curl(
      "-X",
      "POST",
      url("/agent/claim/WS-0002"),
      "-H",
      `${SESSION_HEADER}: ${t}`,
    );
    expect(out).toMatch(/^claimed WS-0002/);
    const log = await curl(
      url("/agent/log/WS-0002"),
      "-H",
      `${SESSION_HEADER}: ${t}`,
      "-d",
      '{"note":"via curl"}',
    );
    expect(log.trim()).toBe("logged WS-0002");
  });

  it("bye ends the session; hello again resumes the claim", async () => {
    const t1 = await hello("devin");
    expect((await call("POST", "/agent/claim/WS-0003", { token: t1 })).text).toMatch(/^claimed/);
    expect((await call("POST", "/agent/bye", { token: t1 })).text.trim()).toBe("bye");
    expect((await call("GET", "/agent/next", { token: t1 })).status).toBe(401);
    const h = await call("POST", "/agent/hello", { body: { agent: "devin" } });
    expect(h.text).toContain("resume: WS-0003");
    const t2 = /^token (\S+)/.exec(h.text)![1];
    expect(
      (await call("POST", "/agent/log/WS-0003", { token: t2, body: { note: "resumed" } })).status,
    ).toBe(200);
  });

  it("a live session's claims are not taken by a second hello of the same agent", async () => {
    // WS-0001 is held by the live gemini-cli session from the full-loop test
    const h = await call("POST", "/agent/hello", { body: { agent: "gemini-cli" } });
    expect(h.text).not.toContain("WS-0001");
  });
});

describe("fixed port", () => {
  it("falls back to a random port when the preferred one is taken", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const busy = (blocker.address() as { port: number }).port;
    const h2 = mkdtempSync(join(tmpdir(), "te-port-"));
    const d = await startDaemon({ home: h2, port: busy });
    expect(d.portFallback).toBe(true);
    expect(d.port).not.toBe(busy);
    await d.close();
    blocker.close();
    rmSync(h2, { recursive: true, force: true });
  });
});
