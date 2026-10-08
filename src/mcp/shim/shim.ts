#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { JSONRPCRequest, Notification } from "@modelcontextprotocol/sdk/types.js";
import { runningDaemon } from "../../daemon/server/server.js";

/**
 * `teamengage mcp` — stdio MCP shim for IDEs that only spawn local commands
 * (DESIGN §6.1). Proxies JSON-RPC verbatim to the daemon's Streamable HTTP
 * `/mcp`; starts the daemon detached when `daemon.json` is missing/stale and
 * reconnects (replaying the last `hello`) if the daemon restarts.
 */

const here = dirname(fileURLToPath(import.meta.url));
// dist/mcp/shim/shim.js → dist/daemon/main.js
const daemonEntry = join(here, "..", "..", "daemon", "main.js");

async function ensureDaemon(home?: string): Promise<{ port: number; token: string }> {
  for (let i = 0; i < 60; i++) {
    const info = await runningDaemon(home);
    if (info) return info;
    if (i === 0) {
      const child = spawn(process.execPath, [daemonEntry], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      });
      child.unref();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("daemon did not start");
}

class Shim {
  private client!: Client;
  private lastHello?: { agent: string; workspace?: string };
  private reconnecting = false;

  constructor(
    private url: URL,
    private token: string,
    private home?: string,
  ) {}

  private transport() {
    return new StreamableHTTPClientTransport(this.url, {
      requestInit: { headers: { authorization: `Bearer ${this.token}` } },
    });
  }

  async connect(): Promise<void> {
    this.client = new Client({ name: "teamengage-shim", version: "0.1.0" });
    const t = this.transport();
    t.onclose = () => void this.onClose();
    await this.client.connect(t);
  }

  private async onClose(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    for (let i = 0; i < 120; i++) {
      try {
        const info = await runningDaemon(this.home);
        if (info) {
          this.token = info.token;
          await this.connect();
          if (this.lastHello) {
            await this.client
              .request(
                { method: "tools/call", params: { name: "hello", arguments: this.lastHello } },
                z.object({}).passthrough(),
              )
              .catch(() => {});
          }
          this.reconnecting = false;
          return;
        }
      } catch {
        /* daemon not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.reconnecting = false;
  }

  /** Forward any JSON-RPC request to the daemon; remember hello args. */
  async forward(req: JSONRPCRequest): Promise<unknown> {
    if (req.method === "tools/call") {
      const params = req.params as { name?: string; arguments?: { agent?: string; workspace?: string } };
      if (params?.name === "hello" && params.arguments?.agent) {
        this.lastHello = { agent: params.arguments.agent, workspace: params.arguments.workspace };
      }
    }
    return this.client.request(req as never, z.object({}).passthrough());
  }

  async forwardNotification(n: Notification): Promise<void> {
    await this.client.notification(n as never).catch(() => {});
  }

  clientCaps() {
    return this.client.getServerCapabilities() as Record<string, unknown> | undefined;
  }
}

export async function runShim(home?: string): Promise<void> {
  if (!existsSync(daemonEntry)) {
    process.stderr.write(`teamengage mcp: daemon entry not found at ${daemonEntry}\n`);
    process.exit(1);
  }
  const { port, token } = await ensureDaemon(home);
  const shim = new Shim(new URL(`http://127.0.0.1:${port}/mcp`), token, home);
  await shim.connect();

  const server = new Server(
    { name: "teamengage-shim", version: "0.1.0" },
    { capabilities: { tools: {}, ...(shim.clientCaps() ?? {}) } },
  );
  server.fallbackRequestHandler = async (req) => (await shim.forward(req)) as never;
  server.fallbackNotificationHandler = (n) => shim.forwardNotification(n);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runShim(process.env.TEAMENGAGE_HOME).catch((e) => {
    process.stderr.write(`teamengage mcp: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
