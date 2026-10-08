import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PlansStore } from "./store/store.js";
import { PlansWatcher } from "./watch/watch.js";
import { resolveWorkspace } from "../core/config/config.js";
import { startDaemon, type DaemonHandle } from "./server/server.js";
import type { DaemonCtx } from "./server/context.js";
import { SessionRegistry } from "./sessions/sessions.js";
import { EventBus, registerEventRoutes } from "./api/events.js";
import { registerMcpRoutes } from "../mcp/server/mcp.js";
import { registerReadTools } from "../mcp/tools/read.js";
import { registerWriteTools } from "../mcp/tools/write.js";
import { registerApiRoutes } from "./api/api.js";

/**
 * E2E: real daemon + real watcher + real MCP transport (StreamableHTTP).
 * Reconnecting an agent must keep its claims usable, the daemon's own writes
 * must not be re-detected as human edits, and the plans repo must stay clean.
 */

let home: string;
let plans: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let watcher: PlansWatcher;

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("");

const dirty = () =>
  execFileSync("git", ["status", "--porcelain"], { cwd: plans, encoding: "utf8" }).trim();

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

async function mcpClient(name: string): Promise<Client> {
  const c = new Client({ name, version: "0.0.1" });
  const tr = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${daemon.token}` } },
  });
  await c.connect(tr);
  return c;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-e2e-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0001.md"),
    `---\nid: WS-0001\ntype: task\ntitle: t1\nstatus: ready\nversion: 1\ntargets: ["@self:src/a.ts"]\n---\n\n## Summary\nx\n`,
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  store.onEvent = (ev) => ctx.bus.publish(ev);
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
    register: (app) => {
      registerMcpRoutes(app, {
        ctx,
        tools: (server, binding, c) => {
          registerReadTools(server, binding, c);
          registerWriteTools(server, binding, c);
        },
      });
      registerApiRoutes(app, ctx);
      registerEventRoutes(app, ctx.bus);
    },
  });
}, 30_000);

afterAll(async () => {
  await watcher.close();
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("e2e daemon + watcher + MCP", () => {
  it("an agent's claim survives an MCP reconnect — hello rebinds it to the new session", async () => {
    const c1 = await mcpClient("first");
    await c1.callTool({ name: "hello", arguments: { agent: "claude" } });
    const claim = await c1.callTool({ name: "claim", arguments: { id: "WS-0001" } });
    expect(text(claim as never)).toMatch(/^claimed WS-0001/);
    await settle();
    expect(dirty()).toBe(""); // daemon writes are committed, not re-detected
    await c1.close();

    // reconnect: new MCP transport + new te session for the same agent
    const c2 = await mcpClient("second");
    const h = await c2.callTool({ name: "hello", arguments: { agent: "claude" } });
    expect(text(h as never)).toContain("resume: WS-0001");
    // without rebinding this is FORBIDDEN: held by claude@test#<old-hex>
    const l = await c2.callTool({ name: "log", arguments: { id: "WS-0001", note: "resumed" } });
    expect(text(l as never)).toBe("logged WS-0001");
    await settle();
    expect(dirty()).toBe("");
    const claimFile = ctx.workspaces.get("ws")!.store.idx.claims.get("WS-0001")!;
    expect(claimFile.holder).toContain("claude@test#");
    await c2.close();
  });

  it("daemon writes produce no human_edit version bumps or duplicate findings", async () => {
    await settle();
    const store = ctx.workspaces.get("ws")!.store;
    // every daemon write so far was committed by the store — nothing pending
    expect(dirty()).toBe("");
    // watcher never re-detected them as human edits → version stays at 2
    // (init v1 → claim v2 → log v3)
    expect(store.idx.get("WS-0001")!.meta.version).toBe(3);
    const findings = watcher.findings();
    expect(findings.filter((f) => f.kind === "duplicate_id")).toEqual([]);
  });
});
