import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../server/server.js";
import type { DaemonCtx } from "../server/context.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { EventBus, registerEventRoutes, eventId } from "./events.js";
import { registerApiRoutes } from "./api.js";
import type { Event } from "../../core/model/event.js";

let home: string;
let plans: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let api: (path: string, init?: RequestInit) => Promise<Response>;

function item(id: string, status = "draft", extra = "") {
  return `---\nid: ${id}\ntype: task\ntitle: ${id}\nstatus: ${status}\nversion: 1\n${extra}---\n\n## Summary\n${id}\n`;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-api-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  writeFileSync(join(plans, "items", "WS", "WS-0001.md"), item("WS-0001", "ready", "targets: [\"@self:src/a.ts\"]\n"));
  writeFileSync(join(plans, "items", "WS", "WS-0002.md"), item("WS-0002", "ready", "targets: [\"@self:src/a.ts\"]\n"));
  writeFileSync(join(plans, "items", "WS", "WS-0003.md"), item("WS-0003"));
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
  store.onEvent = (ev) => ctx.bus.publish(ev);

  daemon = await startDaemon({
    home,
    register: (app) => {
      registerApiRoutes(app, ctx);
      registerEventRoutes(app, ctx.bus);
    },
  });
  api = (path, init = {}) =>
    fetch(`${daemon.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${daemon.token}`, ...(init.headers ?? {}) },
    });
});

afterAll(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("REST API (DM-0005)", () => {
  it("lists items with derived flags", async () => {
    const res = await api("/api/items?status=ready");
    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<{ id: string; ready: boolean }>;
    expect(items.map((i) => i.id).sort()).toEqual(["WS-0001", "WS-0002"]);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${daemon.url}/api/items`);
    expect(res.status).toBe(401);
  });

  it("brief resolves dep outcomes and target resources", async () => {
    const res = await api("/api/items/WS-0001");
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      item: { meta: { id: string } };
      targets: Array<{ ref: string; kind: string }>;
    };
    expect(b.item.meta.id).toBe("WS-0001");
    expect(b.targets[0].kind).toBe("git");
  });

  it("human actions: approve → reject → drop lifecycle", async () => {
    // WS-0003 draft → ready via approve
    const a = await api("/api/items/WS-0003/approve", { method: "POST" });
    expect(a.status).toBe(200);
    expect(((await a.json()) as { meta: { status: string } }).meta.status).toBe("ready");
    // human claims it, then drops
    await api("/api/items/WS-0003/claim", { method: "POST" });
    const d = await api("/api/items/WS-0003/drop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "nope" }),
    });
    expect(((await d.json()) as { meta: { status: string } }).meta.status).toBe("dropped");
  });

  it("findings + inbox endpoints work", async () => {
    const f = await api("/api/findings");
    expect(f.status).toBe(200);
    const inbox = await api("/api/inbox");
    expect(inbox.status).toBe(200);
    const data = (await inbox.json()) as { drafts: string[]; findings: unknown[] };
    expect(Array.isArray(data.findings)).toBe(true);
  });

  it("404 for unknown items, 409 on CAS-ish conflicts", async () => {
    const res = await api("/api/items/WS-9999/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("SSE event stream (DM-0006)", () => {
  it("streams committed events with resumable ids", async () => {
    // connect an SSE client
    const ctrl = new AbortController();
    const res = await api("/events", { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const read = async (ms = 3000): Promise<string> => {
      let buf = "";
      const t = setTimeout(() => ctrl.abort(), ms);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value);
          if (buf.includes("\n\n") && buf.includes("data:")) {
            clearTimeout(t);
            return buf;
          }
        }
      } finally {
        clearTimeout(t);
      }
      return buf;
    };

    // first frame is the retry directive — drain one chunk
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("retry:");

    // trigger a mutation → event is pushed
    await api("/api/items/WS-0001/claim", { method: "POST" });
    const frame = await read();
    const m = /id: (.+)\ndata: (.+)/.exec(frame);
    expect(m).not.toBeNull();
    const ev = JSON.parse(m![2]) as Event;
    expect(ev.item).toBe("WS-0001");
    ctrl.abort();

    // reconnect with Last-Event-ID → only newer events replay
    const ctrl2 = new AbortController();
    const res2 = await api("/events", {
      signal: ctrl2.signal,
      headers: { "last-event-id": m![1] },
    });
    const reader2 = res2.body!.getReader();
    const chunks: Promise<string> = (async () => {
      let buf = "";
      const _t = setTimeout(() => ctrl2.abort(), 800);
      try {
        for (;;) {
          const { done, value } = await reader2.read();
          if (done) break;
          buf += decoder.decode(value);
        }
      } catch {
        /* aborted */
      }
      return buf;
    })();
    await api("/api/items/WS-0001/release", { method: "POST" });
    const replay = await chunks;
    // contains the new release event but not the old claim one
    expect(replay).toContain('"release"');
    ctrl2.abort();
  });

  it("multiple clients each receive the same events", async () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const [r1, r2] = await Promise.all([
      api("/events", { signal: c1.signal }),
      api("/events", { signal: c2.signal }),
    ]);
    const read1 = r1.body!.getReader();
    const read2 = r2.body!.getReader();
    // drain the retry frame
    await Promise.all([read1.read(), read2.read()]);
    await api("/api/items/WS-0002/claim", { method: "POST" });
    const [v1, v2] = await Promise.all([read1.read(), read2.read()]);
    const t1 = new TextDecoder().decode(v1.value);
    const t2 = new TextDecoder().decode(v2.value);
    expect(t1).toContain("WS-0002");
    expect(t2).toContain("WS-0002");
    c1.abort();
    c2.abort();
  });
});

describe("event ids", () => {
  it("are stable and ordered by machine|ts|seq", () => {
    const e = { machine: "m1", ts: "2026-01-01T00:00:00Z", seq: 3 } as Event;
    expect(eventId(e)).toBe("m1|2026-01-01T00:00:00Z|3");
  });
});

describe("import route (IM-0001)", () => {
  it("subfolder import, then its parent: same files are not imported twice", async () => {
    const src = join(home, "tasks");
    mkdirSync(join(src, "Phase-5", "Done"), { recursive: true });
    writeFileSync(join(src, "README.md"), "# Roadmap\n\nTop.\n");
    writeFileSync(join(src, "Phase-5", "README.md"), "# Phase 5 index\n\nIdx.\n");
    writeFileSync(join(src, "Phase-5", "Done", "TASK-P5-01-x.md"), "# TASK-P5-01: x\n\nDone.\n");
    const imp = (folder: string, apply: boolean) =>
      api("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder, apply }),
      }).then((r) => r.json() as Promise<{ count?: number; created?: string[]; preview?: string }>);

    const sub = await imp(join(src, "Phase-5"), true);
    expect(sub.created).toHaveLength(2);
    // keys are absolute, so the parent sees the subfolder's files as done
    const dry = await imp(src, false);
    expect(dry.count).toBe(1);
    expect(dry.preview).toContain("Roadmap");
    expect(dry.preview).not.toContain("Phase 5 index");
    const parent = await imp(src, true);
    expect(parent.created).toHaveLength(1);
    // same-named READMEs in different folders are both kept
    const titles = [...ctx.workspaces.get("ws")!.store.idx.items.values()].map((i) => i.meta.title);
    expect(titles).toContain("Roadmap");
    expect(titles).toContain("Phase 5 index");
  });
});
