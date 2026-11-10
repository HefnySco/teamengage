#!/usr/bin/env node
import { existsSync, writeFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  teHome,
  loadMachineConfig,
  MACHINE_RUN_TEMPLATE,
  loadRegistry,
  resolveWorkspace,
} from "../core/config/config.js";
import { PlansStore } from "./store/store.js";
import { PlansWatcher } from "./watch/watch.js";
import { OverlayTracker } from "./overlay/tracker.js";
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
import { WorkspaceOps } from "./api/ops.js";


/** Default agent-facing port — a stable URL for `GET /agent`. */
const DEFAULT_PORT = 4747;

/** pid liveness probe — signal 0 checks without delivering. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialize daemon startup. Two teamengaged in the same load window both pass
 * runningDaemon() — neither has written daemon.json yet — and then both bind.
 * An O_EXCL lock file closes the window: the first writer proceeds, the other
 * reports the already-running daemon. A lock whose pid is dead is stale (the
 * holder died mid-start) and is taken over.
 * Returns "acquired", the live holder's pid, or -1 when the lock kept
 * churning (treated as held).
 */
function acquireDaemonLock(lockPath: string): number | "acquired" {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      return "acquired";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = Number(readFileSync(lockPath, "utf8"));
    if (holder && pidAlive(holder)) return holder;
    try {
      unlinkSync(lockPath); // stale — take over; losers of this race see the new file
    } catch {
      /* already replaced */
    }
  }
  return -1;
}
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
    writeFileSync(machinePath, `name: ${hostname()}\n${MACHINE_RUN_TEMPLATE}`);
  }
  const machine = loadMachineConfig(home).name;

  // one daemon per machine: a healthy one answers /health — report and exit.
  // Checked before the workspace load so a second start stays cheap.
  let running = await runningDaemon(home);
  if (running) {
    process.stdout.write(`teamengaged already running at http://127.0.0.1:${running.port}\n`);
    return 0;
  }

  // same-window starts both pass that check — the lock decides which proceeds
  const lockPath = join(teDir, "daemon.lock");
  const holder = acquireDaemonLock(lockPath);
  if (holder !== "acquired") {
    running = await runningDaemon(home);
    process.stdout.write(
      running
        ? `teamengaged already running at http://127.0.0.1:${running.port}\n`
        : holder > 0
          ? `teamengaged already running (pid ${holder}, starting up)\n`
          : `teamengaged already running\n`,
    );
    return 0;
  }
  process.on("exit", () => {
    try {
      if (Number(readFileSync(lockPath, "utf8")) === process.pid) unlinkSync(lockPath);
    } catch {
      /* replaced or gone */
    }
  });

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
      let overlay: OverlayTracker | undefined;
      if (ws.config.mode === "overlay") {
        overlay = new OverlayTracker(store, {
          onEvent: (e) => ctx.bus.notify("watch", { workspace: name, kind: e.kind, item: e.items?.join(","), message: e.message }),
        });
        await overlay.start();
      }
      ctx.workspaces.set(name, { ws, store, watcher, overlay, links });
    } catch (e) {
      process.stderr.write(`teamengaged: skipping workspace '${name}': ${(e as Error).message}\n`);
    }
  }

  // recheck after the load: a daemon that never took the lock (embedded
  // startDaemon) may have come up meanwhile
  running = await runningDaemon(home);
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
        await w.overlay?.close();
        await w.store.enqueue(async () => {}); // drain queued writes
      }
    },
  });
  // autonomy: solo — accept submissions whose ok review has aged past
  // auto_accept_after (strict workspaces return nothing)
  const autoTimer = setInterval(() => {
    for (const [name, wsr] of ctx.workspaces) {
      new WorkspaceOps(wsr, ctx.sessions, wsr.links, ctx.home)
        .autoAccept()
        .then((ids) => {
          if (ids.length) ctx.bus.notify("auto_accept", { workspace: name, message: `auto-accepted ${ids.join(", ")}` });
        })
        .catch((err: Error) => ctx.bus.notify("auto_accept", { workspace: name, message: `auto-accept failed: ${err.message}` }));
    }
  }, 60_000);
  autoTimer.unref();
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
