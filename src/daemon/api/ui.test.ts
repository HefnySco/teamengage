import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../server/server.js";
import { registerUiRoutes } from "./ui.js";

let home: string;
let daemon: DaemonHandle;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-ui-"));
  daemon = await startDaemon({ home, register: (app) => registerUiRoutes(app) });
});

afterAll(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("UI serving (UI-0001)", () => {
  it("/ui serves index.html with token auth", async () => {
    const res = await fetch(`${daemon.url}/ui?token=${daemon.token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("TeamEngage");
    expect(html).toContain("/assets/app.js");
  });

  it("cookie token authenticates API + assets", async () => {
    const res = await fetch(`${daemon.url}/assets/app.js`, {
      headers: { cookie: `te_token=${daemon.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("rejects without token; blocks traversal", async () => {
    expect((await fetch(`${daemon.url}/ui`)).status).toBe(401);
    const t = await fetch(`${daemon.url}/assets/..%2Fapp.js?token=${daemon.token}`);
    expect(t.status).toBe(404);
  });
});
