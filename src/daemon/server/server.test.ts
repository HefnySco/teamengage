import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { startDaemon, runningDaemon, readDaemonInfo, daemonJsonPath } from "./server.js";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "te-daemon-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("daemon server", () => {
  it("binds 127.0.0.1, writes daemon.json 0600, serves /health", async () => {
    const h = await startDaemon({ home, health: () => ({ machine: "test" }) });
    const info = readDaemonInfo(home)!;
    expect(info.port).toBe(h.port);
    expect(info.token).toBe(h.token);
    expect(statSync(daemonJsonPath(home)).mode & 0o777).toBe(0o600);
    const res = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).machine).toBe("test");
    const addr = h.app.server.address();
    expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
    await h.close();
  });

  it("rejects requests without the token (401)", async () => {
    const h = await startDaemon({
      home,
      register: (app) => app.get("/x", async () => "ok"),
    });
    expect((await fetch(`http://127.0.0.1:${h.port}/x`)).status).toBe(401);
    const res = await fetch(`http://127.0.0.1:${h.port}/x`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(200);
    await h.close();
  });

  it("second start detects the running instance", async () => {
    const h = await startDaemon({ home });
    const running = await runningDaemon(home);
    expect(running?.port).toBe(h.port);
    await h.close();
    expect(await runningDaemon(home)).toBeNull();
  });

  it("close runs the shutdown hook (drains work)", async () => {
    let drained = false;
    const h = await startDaemon({
      home,
      onShutdown: async () => {
        drained = true;
      },
    });
    await h.close();
    expect(drained).toBe(true);
    expect(readDaemonInfo(home)).toBeNull();
  });

  it("close completes while an SSE client is still connected", async () => {
    const { EventBus, registerEventRoutes } = await import("../api/events.js");
    const bus = new EventBus();
    const h = await startDaemon({
      home,
      register: (app) => registerEventRoutes(app, bus),
    });
    // open an SSE stream and keep it open
    const res = await fetch(`${h.url}/events`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(200);
    expect(bus.clientCount).toBe(1);
    // server.close() alone waits for this connection forever — close() must
    // still resolve and remove daemon.json
    await h.close();
    expect(readDaemonInfo(home)).toBeNull();
    await res.body?.cancel().catch(() => {});
  });

  it("SIGTERM stops the daemon with an SSE client connected and removes daemon.json", async () => {
    const e2eHome = mkdtempSync(join(tmpdir(), "te-sigterm-"));
    const wsRoot = join(e2eHome, "ws");
    const plans = join(wsRoot, ".teamengage");
    mkdirSync(join(plans, "items", "WS"), { recursive: true });
    mkdirSync(join(e2eHome, ".teamengage"), { recursive: true });
    writeFileSync(
      join(e2eHome, ".teamengage", "workspaces.yaml"),
      `workspaces:\n  ws: { root: ${wsRoot} }\n`,
    );
    writeFileSync(
      join(plans, "workspace.yaml"),
      "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: plans });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
    execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
    execFileSync("git", ["add", "-A"], { cwd: plans });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: plans });

    const child = spawn(
      process.execPath,
      [join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"), "src/daemon/main.ts"],
      { env: { ...process.env, TEAMENGAGE_HOME: e2eHome }, cwd: process.cwd() },
    );
    try {
      // wait for daemon.json
      const djPath = daemonJsonPath(e2eHome);
      for (let i = 0; i < 300 && !existsSync(djPath); i++) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const info = readDaemonInfo(e2eHome);
      expect(info).not.toBeNull();
      // hold an SSE connection open
      const res = await fetch(`http://127.0.0.1:${info!.port}/events`, {
        headers: { authorization: `Bearer ${info!.token}` },
      });
      expect(res.status).toBe(200);
      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 30_000);
        child.on("exit", (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      await res.body?.cancel().catch(() => {});
      expect(code).toBe(0);
      expect(existsSync(djPath)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      rmSync(e2eHome, { recursive: true, force: true });
    }
  }, 90_000);

  it("two simultaneous starts: exactly one daemon binds, the other exits already-running", async () => {
    const e2eHome = mkdtempSync(join(tmpdir(), "te-race-"));
    const wsRoot = join(e2eHome, "ws");
    const plans = join(wsRoot, ".teamengage");
    mkdirSync(join(plans, "items", "WS"), { recursive: true });
    mkdirSync(join(e2eHome, ".teamengage"), { recursive: true });
    writeFileSync(
      join(e2eHome, ".teamengage", "workspaces.yaml"),
      `workspaces:\n  ws: { root: ${wsRoot} }\n`,
    );
    writeFileSync(
      join(plans, "workspace.yaml"),
      "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: plans });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
    execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
    execFileSync("git", ["add", "-A"], { cwd: plans });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: plans });

    const spawnDaemon = () => {
      const child = spawn(
        process.execPath,
        [join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"), "src/daemon/main.ts"],
        { env: { ...process.env, TEAMENGAGE_HOME: e2eHome }, cwd: process.cwd() },
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const exited = new Promise<number | null>((res) => child.on("exit", res));
      return { child, out: () => out, exited };
    };
    const a = spawnDaemon();
    const b = spawnDaemon();
    try {
      // the loser exits during the winner's load window — wait for that exit
      // plus the winner's daemon.json (60s covers slow vite-node cold starts)
      const djPath = daemonJsonPath(e2eHome);
      const deadline = Date.now() + 60_000;
      let loser: { code: number | null; out: string } | null = null;
      let codeA: number | null | undefined;
      let codeB: number | null | undefined;
      void a.exited.then((c) => (codeA = c));
      void b.exited.then((c) => (codeB = c));
      while (Date.now() < deadline) {
        const oneDone = codeA !== undefined || codeB !== undefined;
        if (oneDone && existsSync(djPath)) break;
        if (codeA !== undefined && codeB !== undefined) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (codeA !== undefined && codeB !== undefined) {
        throw new Error(`both daemons exited — a: ${a.out()} | b: ${b.out()}`);
      }
      const alive = codeA !== undefined ? b : a;
      loser = { code: (codeA !== undefined ? codeA : codeB) ?? null, out: codeA !== undefined ? a.out() : b.out() };
      expect(loser.code).toBe(0);
      expect(loser.out).toMatch(/teamengaged already running/);
      // the winner is the surviving daemon — it answers /health
      const info = readDaemonInfo(e2eHome);
      expect(info).not.toBeNull();
      const res = await fetch(`http://127.0.0.1:${info!.port}/health`);
      expect(res.status).toBe(200);
      alive.child.kill("SIGTERM");
      const code = await Promise.race([alive.exited, new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
      expect(code).toBe(0);
    } finally {
      a.child.kill("SIGKILL");
      b.child.kill("SIGKILL");
      rmSync(e2eHome, { recursive: true, force: true });
    }
  }, 90_000);

  it("a second teamengaged exits promptly instead of hanging", async () => {
    const e2eHome = mkdtempSync(join(tmpdir(), "te-second-"));
    const wsRoot = join(e2eHome, "ws");
    const plans = join(wsRoot, ".teamengage");
    mkdirSync(join(plans, "items", "WS"), { recursive: true });
    mkdirSync(join(e2eHome, ".teamengage"), { recursive: true });
    writeFileSync(
      join(e2eHome, ".teamengage", "workspaces.yaml"),
      `workspaces:\n  ws: { root: ${wsRoot} }\n`,
    );
    writeFileSync(
      join(plans, "workspace.yaml"),
      "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: plans });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
    execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
    execFileSync("git", ["add", "-A"], { cwd: plans });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: plans });

    const spawnDaemon = () =>
      spawn(
        process.execPath,
        [join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"), "src/daemon/main.ts"],
        { env: { ...process.env, TEAMENGAGE_HOME: e2eHome }, cwd: process.cwd() },
      );
    const first = spawnDaemon();
    try {
      // wait for the first instance to write daemon.json
      const djPath = daemonJsonPath(e2eHome);
      for (let i = 0; i < 300 && !existsSync(djPath); i++) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(readDaemonInfo(e2eHome)).not.toBeNull();

      // the second instance must print the message and exit 0 — not hang
      const second = spawnDaemon();
      let out = "";
      second.stdout.on("data", (d) => (out += d));
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 20_000);
        second.on("exit", (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      if (code === null) second.kill("SIGKILL"); // hung — clean up before failing
      expect(code).toBe(0);
      expect(out).toContain("already running");
      expect(second.exitCode).toBe(0);
      // the first instance is still the only live daemon
      expect(readDaemonInfo(e2eHome)?.pid).toBe(first.pid);
    } finally {
      first.kill("SIGKILL");
      rmSync(e2eHome, { recursive: true, force: true });
    }
  }, 90_000);
});
