import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../../daemon/store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { startDaemon, runningDaemon, type DaemonHandle } from "../../daemon/server/server.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import { SessionRegistry } from "../../daemon/sessions/sessions.js";
import { EventBus } from "../../daemon/api/events.js";
import { registerMcpRoutes } from "../server/mcp.js";
import { registerReadTools } from "../tools/read.js";
import { registerWriteTools } from "../tools/write.js";

let home: string;
let daemon: DaemonHandle;
let ctx: DaemonCtx;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-shim-"));
  const root = join(home, "ws");
  const plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  ctx = {
    home,
    machine: "test",
    workspaces: new Map([["ws", { ws, store }]]),
    sessions: new SessionRegistry("test"),
    bus: new EventBus(),
  };
  daemon = await startDaemon({
    home,
    register: (app) =>
      registerMcpRoutes(app, {
        ctx,
        tools: (s, b, c) => {
          registerReadTools(s, b, c);
          registerWriteTools(s, b, c);
        },
      }),
  });
});

afterAll(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("shim proxy (MC-0004)", () => {
  it("runningDaemon reports the live instance so two shims start only one daemon", async () => {
    const info = await runningDaemon(home);
    expect(info).not.toBeNull();
    expect(info!.port).toBe(daemon.port);
    expect(info!.token).toBe(daemon.token);
  });

  it("forwards arbitrary JSON-RPC (tools/list, tools/call) verbatim", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const { z } = await import("zod");
    const client = new Client({ name: "shim-test", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${daemon.token}` } },
      }),
    );
    const res = (await client.request(
      { method: "tools/list", params: {} },
      z.object({ tools: z.array(z.object({ name: z.string() })) }).passthrough(),
    )) as { tools: Array<{ name: string }> };
    expect(res.tools.map((t) => t.name)).toContain("hello");
    const hello = (await client.request(
      { method: "tools/call", params: { name: "hello", arguments: { agent: "shimmed" } } },
      z.object({ content: z.array(z.object({ text: z.string() })) }).passthrough(),
    )) as { content: Array<{ text: string }> };
    expect(hello.content[0].text).toMatch(/session shimmed@test#/);
    await client.close();
  });
});
