#!/usr/bin/env node
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  teHome,
  loadMachineConfig,
  loadRegistry,
  resolveWorkspace,
} from "../core/config/config.js";
import { PlansStore } from "./store/store.js";
import { PlansWatcher } from "./watch/watch.js";
import { startDaemon, runningDaemon } from "./server/server.js";
import type { DaemonCtx } from "./server/context.js";
import { SessionRegistry } from "./sessions/sessions.js";
import { EventBus, registerEventRoutes } from "./api/events.js";
import { registerApiRoutes } from "./api/api.js";
import { LinkedWorkspaces } from "./links/links.js";
import { registerUiRoutes } from "./api/ui.js";
import { registerMcpRoutes } from "../mcp/server/mcp.js";
import { registerAgentRoutes } from "../agent/http.js";
import { registerReadTools } from "../mcp/tools/read.js";
import { registerWriteTools } from "../mcp/tools/write.js";
import { parseDuration } from "../core/model/workspace.js";
import { reconcile } from "./sync/sync.js";


/** Default agent-facing port — a stable URL for `GET /agent`. */
const DEFAULT_PORT = 4747;
/**
 * teamengaged — one instance per machine (DESIGN §6.1).
 * Loads every registered workspace, serializes all plan writes through each
 * workspace's store, and serves the agent/human interfaces on 127.0.0.1.
 */
async function main(): Promise<number | undefined> {
  const home = process.env.TEAMENGAGE_HOME;
  const teDir = teHome(home);
  mkdirSync(teDir, { recursive: true });

  // machine.yaml: created on first run from the hostname
  const machinePath = join(teDir, "machine.yaml");
  if (!existsSync(machinePath)) {
    writeFileSync(machinePath, `name: ${hostname()}\n`);
  }
  const machine = loadMachineConfig(home).name;
  const registry = loadRegistry(home);

  const ctx: DaemonCtx = {
    home: home ?? "",
    machine,
    workspaces: new Map(),
    sessions: new SessionRegistry(machine),
    bus: new EventBus(),
  };
  for (const [name, entry] of Object.entries(registry.workspaces)) {
    try {
      const ws = resolveWorkspace(entry.root, { home });
      const store = new PlansStore(ws, machine);
      await store.init();
      store.onEvent = (ev) => ctx.bus.publish(ev);
      const links = await LinkedWorkspaces.load(ws, home);
      const watcher = new PlansWatcher(store, {
        staleAfterMs: parseDuration(ws.config.stale_after),
        onEvent: (e) => {
          ctx.bus.notify("watch", { workspace: name, kind: e.kind, path: e.path, item: e.item, message: e.message });
          if (e.kind === "claim_change") {
            const wsr = ctx.workspaces.get(name);
            if (wsr) {
              reconcile(wsr, (msg) =>
                ctx.bus.notify("reconcile", { workspace: name, message: msg }),
              ).catch((err: Error) =>
                // an unhandled rejection here would kill the daemon
                ctx.bus.notify("reconcile", {
                  workspace: name,
                  message: `reconcile failed: ${err.message}`,
                }),
              );
            }
          }
        },
      });
      await watcher.start();
      ctx.workspaces.set(name, { ws, store, watcher, links });
    } catch (e) {
      process.stderr.write(`teamengaged: skipping workspace '${name}': ${(e as Error).message}\n`);
    }
  }

  const running = await runningDaemon(home);
  if (running) {
    // second start: report the live instance and exit 0
    process.stdout.write(`teamengaged already running at http://127.0.0.1:${running.port}\n`);
    return 0;
  }

  const handle = await startDaemon({
    home,
    // stable agent URL http://127.0.0.1:4747/agent (TE_PORT overrides)
    port: Number(process.env.TE_PORT) || DEFAULT_PORT,
    health: () => ({
      machine,
      workspaces: [...ctx.workspaces.keys()],
    }),
    register: async (app) => {
      registerApiRoutes(app, ctx);
      registerEventRoutes(app, ctx.bus);
      registerUiRoutes(app);
      registerAgentRoutes(app, ctx);
      registerMcpRoutes(app, {
        ctx,
        tools: (server, binding, c) => {
          registerReadTools(server, binding, c);
          registerWriteTools(server, binding, c);
        },
      });
    },
    onShutdown: async () => {
      for (const w of ctx.workspaces.values()) {
        await w.watcher?.close();
        await w.store.enqueue(async () => {}); // drain queued writes
      }
    },
  });
  process.stdout.write(
    `teamengaged ${machine} listening at ${handle.url} (${ctx.workspaces.size} workspace(s))\n` +
      `agents: ${handle.url}/agent\n` +
      (handle.portFallback ? `note: port ${Number(process.env.TE_PORT) || DEFAULT_PORT} was busy — using a random port\n` : ""),
  );
  return undefined; // keep process alive via server
}

main().then(
  (code) => {
    if (typeof code === "number") process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`teamengaged: ${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
