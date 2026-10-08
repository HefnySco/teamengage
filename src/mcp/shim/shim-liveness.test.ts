import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PlansStore } from "../../daemon/store/store.js";
import { PlansWatcher } from "../../daemon/watch/watch.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../../daemon/server/server.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import { SessionRegistry, pidAlive } from "../../daemon/sessions/sessions.js";
import { EventBus } from "../../daemon/api/events.js";
import { registerMcpRoutes } from "../server/mcp.js";
import { registerReadTools } from "../tools/read.js";
import { registerWriteTools } from "../tools/write.js";

/**
 * Claim liveness through the REAL `te mcp` shim, spawned as a child process
 * exactly like an IDE does. Calling terminateSession() by hand (as the
 * in-process e2e test does) proves nothing about IDEs: they just close stdin,
 * get SIGTERM, or crash. Each case must leave the agent able to resume.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let shimBundle: string;
let home: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let watcher: PlansWatcher;

const text = (r: unknown) =>
  (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("");

interface Agent {
  client: Client;
  transport: StdioClientTransport;
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
}

async function spawnAgent(): Promise<Agent> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [shimBundle],
    env: { ...(process.env as Record<string, string>), TEAMENGAGE_HOME: home },
    stderr: "ignore",
  });
  const client = new Client({ name: "ide", version: "0.0.1" });
  await client.connect(transport);
  return {
    client,
    transport,
    call: async (name, args = {}) => text(await client.callTool({ name, arguments: args })),
  };
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const holderOf = (id: string) => ctx.workspaces.get("ws")!.store.idx.claims.get(id)?.holder;

beforeAll(async () => {
  // bundle the current shim source — never trust a possibly stale dist/
  shimBundle = join(repo, "node_modules", ".cache", "te-test", `shim-${process.pid}.mjs`);
  await build({
    entryPoints: [join(repo, "src", "mcp", "shim", "shim.ts")],
    outfile: shimBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });

  home = mkdtempSync(join(tmpdir(), "te-live-"));
  const root = join(home, "ws");
  const plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: ., worktree: false }\n",
  );
  for (const n of [1, 2, 3]) {
    const id = `WS-000${n}`;
    writeFileSync(
      join(plans, "items", "WS", `${id}.md`),
      `---\nid: ${id}\ntype: task\ntitle: t${n}\nstatus: ready\nversion: 1\ntargets: ["@self:src/f${n}.ts"]\n---\n\n## Summary\nx\n`,
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
  daemon = await startDaemon({
    home,
    register: (app) =>
      registerMcpRoutes(app, {
        ctx,
        tools: (server, binding, c) => {
          registerReadTools(server, binding, c);
          registerWriteTools(server, binding, c);
        },
      }),
  });
}, 30_000);

afterAll(async () => {
  await watcher.close();
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(shimBundle, { force: true });
});

describe("claim liveness through the real `te mcp` shim", () => {
  it("IDE crash (SIGKILL, no goodbye): the reconnecting agent resumes its claim", async () => {
    const a = await spawnAgent();
    await a.call("hello", { agent: "claude-code" });
    expect(await a.call("claim", { id: "WS-0001" })).toMatch(/^claimed WS-0001/);
    const pid = a.transport.pid!;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !pidAlive(pid));
    await a.client.close().catch(() => {});

    const b = await spawnAgent();
    expect(await b.call("hello", { agent: "claude-code" })).toContain("resume: WS-0001");
    expect(await b.call("log", { id: "WS-0001", note: "after crash" })).toBe("logged WS-0001");
    await b.client.close();
  });

  it("clean IDE exit (stdin closed): the shim ends its session and the agent resumes", async () => {
    const a = await spawnAgent();
    await a.call("hello", { agent: "gemini-cli" });
    expect(await a.call("claim", { id: "WS-0002" })).toMatch(/^claimed WS-0002/);
    const holder = holderOf("WS-0002")!;
    const pid = a.transport.pid!;
    await a.client.close(); // closes the shim's stdin, like an IDE quitting
    await waitFor(() => !pidAlive(pid));
    expect(ctx.sessions.isLive(holder)).toBe(false);

    const b = await spawnAgent();
    expect(await b.call("hello", { agent: "gemini-cli" })).toContain("resume: WS-0002");
    expect(await b.call("log", { id: "WS-0002", note: "after exit" })).toBe("logged WS-0002");
    await b.client.close();
  });

  it("a second live window of the same agent cannot take the first window's claim", async () => {
    const w1 = await spawnAgent();
    await w1.call("hello", { agent: "cursor" });
    expect(await w1.call("claim", { id: "WS-0003" })).toMatch(/^claimed WS-0003/);
    const holder = holderOf("WS-0003");

    const w2 = await spawnAgent();
    expect(await w2.call("hello", { agent: "cursor" })).not.toContain("WS-0003");
    expect(holderOf("WS-0003")).toBe(holder);
    expect(await w2.call("log", { id: "WS-0003", note: "steal" })).toContain("FORBIDDEN");
    expect(await w1.call("log", { id: "WS-0003", note: "mine" })).toBe("logged WS-0003");
    await w1.client.close();
    await w2.client.close();
  });
});
