import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
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
});
