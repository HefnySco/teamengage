import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../server/server.js";
import type { DaemonCtx } from "../server/context.js";
import type { WorkspaceOps } from "./ops.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { EventBus, registerEventRoutes, eventId } from "./events.js";
import { registerApiRoutes } from "./api.js";
import type { Event } from "../../core/model/event.js";
import { NotFoundError } from "../../core/model/errors.js";

let home: string;
let plans: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let api: (path: string, init?: RequestInit) => Promise<Response>;

function item(id: string, status = "draft", extra = "", body = "") {
  return `---\nid: ${id}\ntype: task\ntitle: ${id}\nstatus: ${status}\nversion: 1\n${extra}---\n\n${body}## Summary\n${id}\n`;
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
  writeFileSync(join(plans, "items", "WS", "WS-0001.md"), item("WS-0001", "ready", "targets: [\"@self:src/a.ts\"]\n", "**Touches:** self: src/a.ts\n"));
  writeFileSync(join(plans, "items", "WS", "WS-0002.md"), item("WS-0002", "ready", "targets: [\"@self:src/a.ts\"]\n", "**Touches:** self: src/a.ts\n"));
  writeFileSync(join(plans, "items", "WS", "WS-0003.md"), item("WS-0003"));
  writeFileSync(
    join(plans, "items", "WS", "WS-0009.md"),
    item("WS-0009", "waiting", "question:\n  text: which?\n  options: [a, b]\n  asked_by: x\n  asked_at: 2026-10-10T00:00:00Z\n"),
  );
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
  const { Dispatcher } = await import("../dispatch/dispatch.js");
  ctx.dispatchers = new Map([["ws", new Dispatcher(ctx.workspaces.get("ws")!, ctx.sessions, home)]]);
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

  it("items carry the Touches-overlap warning field (GL-0326)", async () => {
    const items = (await (await api("/api/items?status=ready")).json()) as Array<{
      id: string;
      overlap?: { id: string; paths: string[] }[];
    }>;
    const w1 = items.find((i) => i.id === "WS-0001")!;
    expect(w1.overlap).toEqual([{ id: "WS-0002", paths: ["self: src/a.ts"] }]);
    const w2 = items.find((i) => i.id === "WS-0002")!;
    expect(w2.overlap).toEqual([{ id: "WS-0001", paths: ["self: src/a.ts"] }]);
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

describe("complete — human marks done from any status", () => {
  it("draft → done, and a claimed item → done with its claim released", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "finished long ago" },
        { type: "task", title: "finished by hand" },
      ],
      human,
    );
    const post = (path: string, body: unknown = {}) =>
      api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const r1 = await post(`/api/items/${ids[0]}/complete`, { note: "already done" });
    expect(r1.status).toBe(200);
    expect(store.idx.get(ids[0])!.meta.status).toBe("done");

    expect((await post(`/api/items/${ids[1]}/approve`)).status).toBe(200);
    expect((await post(`/api/items/${ids[1]}/claim`)).status).toBe(200);
    expect(existsSync(join(plans, "claims", `${ids[1]}.yaml`))).toBe(true);
    expect((await post(`/api/items/${ids[1]}/complete`)).status).toBe(200);
    expect(store.idx.get(ids[1])!.meta.status).toBe("done");
    expect(store.idx.claims.has(ids[1])).toBe(false);
    expect(existsSync(join(plans, "claims", `${ids[1]}.yaml`))).toBe(false);

    // done is terminal for complete
    expect((await post(`/api/items/${ids[1]}/complete`)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("hold / unhold / to draft", () => {
  it("held items leave next and can't be claimed; resume and to-draft work", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems([{ type: "task", title: "parked" }], human);
    const id = ids[0];
    const post = (path: string, body: unknown = {}) =>
      api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const nextIds = async () =>
      ((await (await api("/api/next?limit=50")).json()) as Array<{ meta: { id: string } }>).map((i) => i.meta.id);

    expect((await post(`/api/items/${id}/approve`)).status).toBe(200);
    expect(await nextIds()).toContain(id);

    expect((await post(`/api/items/${id}/hold`, { reason: "after the release" })).status).toBe(200);
    expect(store.idx.get(id)!.meta.status).toBe("hold");
    expect(await nextIds()).not.toContain(id);
    expect((await post(`/api/items/${id}/claim`)).status).toBeGreaterThanOrEqual(400);
    const held = (await (await api(`/api/items?status=hold`)).json()) as Array<{ id: string; turn: string }>;
    expect(held.find((i) => i.id === id)?.turn).toBe("human");

    expect((await post(`/api/items/${id}/unhold`)).status).toBe(200);
    expect(store.idx.get(id)!.meta.status).toBe("ready");
    expect(await nextIds()).toContain(id);

    expect((await post(`/api/items/${id}/draft`, { reason: "rethink" })).status).toBe(200);
    expect(store.idx.get(id)!.meta.status).toBe("draft");
    expect(store.idx.get(id)!.sections.find((s) => s.heading === "Log")!.body).toMatch(
      /put on hold \(from ready\): after the release[\s\S]*resumed from hold[\s\S]*moved back to draft \(from ready\): rethink/,
    );
  });

  it("a done item goes back to draft and reopens the lifecycle", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems([{ type: "task", title: "done by mistake" }], human);
    const id = ids[0];
    const post = (path: string, body: unknown = {}) =>
      api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    expect((await post(`/api/items/${id}/complete`)).status).toBe(200);
    expect(store.idx.get(id)!.meta.status).toBe("done");

    expect((await post(`/api/items/${id}/draft`, { reason: "marked by mistake" })).status).toBe(200);
    expect(store.idx.get(id)!.meta.status).toBe("draft");
    expect(store.idx.get(id)!.sections.find((s) => s.heading === "Log")!.body).toMatch(
      /moved back to draft \(from done\): marked by mistake/,
    );

    // back through the normal path: approve → claim
    expect((await post(`/api/items/${id}/approve`)).status).toBe(200);
    expect((await post(`/api/items/${id}/claim`)).status).toBe(200);
    expect(store.idx.get(id)!.meta.status).toBe("in_progress");
  });
});

describe("archive", () => {
  it("archived items leave items/next/inbox/graph, show on archived=true, and come back", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems([{ type: "task", title: "old idea" }], human);
    const id = ids[0];
    const post = (path: string, body: unknown = {}) =>
      api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const listIds = async (q = "") => ((await (await api(`/api/items${q}`)).json()) as Array<{ id: string }>).map((i) => i.id);
    expect((await post(`/api/items/${id}/approve`)).status).toBe(200);

    expect((await post(`/api/items/${id}/archive`, { reason: "superseded" })).status).toBe(200);
    expect(store.idx.get(id)!.meta).toMatchObject({ status: "ready", archived: true });
    expect(await listIds()).not.toContain(id);
    expect(await listIds("?archived=true")).toEqual([id]);
    expect(await listIds("?archived=all")).toContain(id);
    const next = (await (await api("/api/next?limit=50")).json()) as Array<{ meta: { id: string } }>;
    expect(next.map((i) => i.meta.id)).not.toContain(id);
    expect((await post(`/api/items/${id}/claim`)).status).toBeGreaterThanOrEqual(400);
    const graph = (await (await api("/api/graph")).json()) as { mermaid: string };
    expect(graph.mermaid).not.toContain(id.replace("-", "_"));

    expect((await post(`/api/items/${id}/unarchive`)).status).toBe(200);
    expect(store.idx.get(id)!.meta.archived).toBeUndefined();
    expect(await listIds()).toContain(id);
    expect(store.idx.get(id)!.sections.find((s) => s.heading === "Log")!.body).toMatch(
      /archived \(status ready\): superseded[\s\S]*unarchived \(status ready\)/,
    );
  });
});

describe("star", () => {
  it("starred items keep their place; colour flips; ?starred=true lists only them; unstar clears", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems([{ type: "task", title: "watch me" }], human);
    const id = ids[0];
    const post = (path: string, body: unknown = {}) =>
      api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const listIds = async (q = "") => ((await (await api(`/api/items${q}`)).json()) as Array<{ id: string }>).map((i) => i.id);

    expect((await post(`/api/items/${id}/star`)).status).toBe(200);
    expect(store.idx.get(id)!.meta.star_color).toBe("yellow");
    expect(await listIds()).toContain(id); // starring hides nothing
    expect(await listIds("?starred=true")).toEqual([id]);

    expect((await post(`/api/items/${id}/star`, { color: "blue" })).status).toBe(200);
    expect(store.idx.get(id)!.meta.star_color).toBe("blue");
    expect((await post(`/api/items/${id}/star`, { color: "purple" })).status).toBe(400);

    expect((await post(`/api/items/${id}/unstar`)).status).toBe(200);
    expect(store.idx.get(id)!.meta.star_color).toBeUndefined();
    expect(await listIds("?starred=true")).toEqual([]);
  });
});

describe("notes (standard workspace)", () => {
  it("go into the item's ## Notes section", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const { ids } = await store.createItems([{ type: "task", title: "std note" }], { kind: "human", session: "human", machine: "test" });
    const r = await api(`/api/items/${ids[0]}/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "line 1\nline 2" }),
    });
    expect(r.status).toBe(200);
    const notes = store.idx.get(ids[0])!.sections.find((s) => s.heading === "Notes")!.body;
    expect(notes).toMatch(/· human\*\*\n\nline 1\nline 2/);
  });

  it("delnote removes the block identified by its ts · who header", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const { ids } = await store.createItems([{ type: "task", title: "std note rm" }], { kind: "human", session: "human", machine: "test" });
    const post = (p: string, body: unknown) =>
      api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(`/api/items/${ids[0]}/note`, { text: "keep me" })).status).toBe(200);
    expect((await post(`/api/items/${ids[0]}/note`, { text: "remove me" })).status).toBe(200);
    const body = store.idx.get(ids[0])!.sections.find((s) => s.heading === "Notes")!.body;
    const heads = [...body.matchAll(/^\*\*(\d{4}-\d\d-\d\d \d\d:\d\d) · (\S+)\*\*$/gm)];
    expect(heads.length).toBe(2);
    const r = await post(`/api/items/${ids[0]}/delnote`, { ts: heads[1][1], who: heads[1][2], body: "remove me" });
    expect(r.status).toBe(200);
    const after = store.idx.get(ids[0])!.sections.find((s) => s.heading === "Notes")!.body;
    expect(after).toContain("keep me");
    expect(after).not.toContain("remove me");
    // deleting a note that isn't there → 404-ish error, section untouched
    const r2 = await post(`/api/items/${ids[0]}/delnote`, { ts: "1999-01-01 00:00", who: "human" });
    expect(r2.status).not.toBe(200);
    expect(store.idx.get(ids[0])!.sections.find((s) => s.heading === "Notes")!.body).toContain("keep me");
  });
});

describe("review_unblocks: a dependency in review lets dependents start", () => {
  it("B can start once A is submitted; rejecting A flags B; off → B waits for done", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "A first" },
        { type: "task", title: "B builds on A", depends_on: ["#0"] },
      ],
      human,
    );
    const [a, b] = ids;
    await ops.approve(a);
    await ops.approve(b);
    expect(store.idx.get(b)!.blocked).toBe(true); // A not started

    const s1 = ctx.sessions.hello("agent-a");
    await ops.claim(a, s1);
    expect(store.idx.get(b)!.blocked).toBe(true); // A in progress still blocks
    await ops.submit(a, s1, { notes: "done", what: "task done", how: "ran the steps" });
    expect(store.idx.get(a)!.meta.status).toBe("in_review");

    // default (review_unblocks: true): B is ready and claimable now
    expect(store.idx.get(b)!.blocked).toBe(false);
    expect(ops.next(50).map((i) => i.meta.id)).toContain(b);
    const brief = await ops.brief(b);
    expect(brief.deps.find((d) => d.ref === a)).toMatchObject({ status: "in_review", pending: true });
    const s2 = ctx.sessions.hello("agent-b");
    await ops.claim(b, s2);
    expect(store.idx.get(b)!.meta.status).toBe("in_progress");

    // A is rejected → B started on top of it: inbox warning
    await ops.reject(a, "needs rework");
    expect((await ops.findings()).some((f) => f.kind === "started_on_open_dep" && f.item === b)).toBe(true);

    // review_unblocks: false → only done unblocks
    const { ids: more } = await store.createItems(
      [
        { type: "task", title: "C first" },
        { type: "task", title: "D after C", depends_on: ["#0"] },
      ],
      human,
    );
    const [c, d] = more;
    await ops.approve(c);
    await ops.approve(d);
    await ops.claim(c, s1);
    await ops.submit(c, s1, { what: "task done", how: "ran the steps" });
    expect(store.idx.get(d)!.blocked).toBe(false);
    wsr.ws.config.review_unblocks = false;
    store.idx.setReviewUnblocks(false);
    try {
      expect(store.idx.get(d)!.blocked).toBe(true);
      await expect(ops.claim(d, s2)).rejects.toThrow(/dependencies not done/);
    } finally {
      wsr.ws.config.review_unblocks = true;
      store.idx.setReviewUnblocks(true);
    }
  });
});

describe("accept waits for dependencies (TE-0194)", () => {
  it("B depends on A: accept refuses while A is open, --force lands it, auto-accept skips then takes it", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "Accept-order A" },
        { type: "task", title: "Accept-order B", depends_on: ["#0"] },
      ],
      human,
    );
    const [a, b] = ids;
    await ops.approve(a);
    await ops.approve(b);
    const worker = ctx.sessions.hello("ad-agent");
    const reviewer = ctx.sessions.hello("ad-reviewer");

    // review_unblocks unchanged: B claims and submits while A is in_review
    await ops.claim(a, worker);
    await ops.submit(a, worker, { what: "task done", how: "ran the steps" });
    expect(store.idx.get(a)!.meta.status).toBe("in_review");
    expect(store.idx.get(b)!.blocked).toBe(false);
    await ops.claim(b, worker);
    await ops.submit(b, worker, { what: "task done", how: "ran the steps" });
    await ops.review(b, reviewer, "ok", undefined, "verified the work");

    // te accept B → refused, names the open dependency, changes nothing
    await expect(ops.accept(b)).rejects.toThrow(new RegExp(`dependencies not done: ${a}`));
    const refused = await api(`/api/items/${b}/accept`, { method: "POST" });
    expect(refused.status).toBe(400);
    expect(store.idx.get(b)!.meta.status).toBe("in_review");

    // te status sees the wait
    const inbox = (await (await api("/api/inbox")).json()) as {
      accept_waiting: Array<{ id: string; deps: string[] }>;
    };
    expect(inbox.accept_waiting).toContainEqual({ id: b, deps: [a] });

    // auto-accept skips B while A is open; after A is done the next sweep takes it
    wsr.ws.config.autonomy = "solo";
    wsr.ws.config.auto_accept_after = "30m";
    try {
      const future = Date.now() + 3_600_000;
      expect(await ops.autoAccept(future)).not.toContain(b);
      expect(store.idx.get(b)!.meta.status).toBe("in_review");
      await ops.accept(a);
      expect(store.idx.get(a)!.meta.status).toBe("done");
      expect(await ops.autoAccept(future)).toContain(b);
      expect(store.idx.get(b)!.meta.status).toBe("done");
    } finally {
      wsr.ws.config.autonomy = "strict";
    }

    // te accept --force accepts over an open dependency
    const { ids: more } = await store.createItems(
      [
        { type: "task", title: "Accept-order C" },
        { type: "task", title: "Accept-order D", depends_on: ["#0"] },
      ],
      human,
    );
    const [c, d] = more;
    await ops.approve(c);
    await ops.approve(d);
    await ops.claim(c, worker);
    await ops.submit(c, worker, { what: "task done", how: "ran the steps" });
    await ops.claim(d, worker);
    await ops.submit(d, worker, { what: "task done", how: "ran the steps" });
    const forced = await api(`/api/items/${d}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe(200);
    expect(store.idx.get(d)!.meta.status).toBe("done");
    expect(store.idx.get(c)!.meta.status).toBe("in_review");
  });
});

describe("per-task unblocks_on (key tasks)", () => {
  it("a key task holds its dependents until accepted, even with review_unblocks on; and the reverse", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "Key foundation" },
        { type: "task", title: "Built on the key", depends_on: ["#0"] },
      ],
      human,
    );
    const [k, dep] = ids;
    await ops.approve(k);
    await ops.approve(dep);
    const r = await api(`/api/items/${k}/unblocks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: "done" }),
    });
    expect(r.status).toBe(200);
    expect(store.idx.get(k)!.meta.unblocks_on).toBe("done");

    const s = ctx.sessions.hello("key-agent");
    await ops.claim(k, s);
    await ops.submit(k, s, { what: "task done", how: "ran the steps" });
    expect(wsr.ws.config.review_unblocks).toBe(true);
    expect(store.idx.get(dep)!.blocked).toBe(true); // key task in review still blocks
    const brief = await ops.brief(dep);
    expect(brief.deps[0]).toMatchObject({ key: true, pending: false });
    await expect(ops.claim(dep, ctx.sessions.hello("other"))).rejects.toThrow(/dependencies not done/);

    await ops.accept(k);
    expect(store.idx.get(dep)!.blocked).toBe(false);

    // the reverse: workspace strict, one task opts in to unblocking at review
    wsr.ws.config.review_unblocks = false;
    store.idx.setReviewUnblocks(false);
    try {
      const { ids: more } = await store.createItems(
        [
          { type: "task", title: "Loose one" },
          { type: "task", title: "After loose", depends_on: ["#0"] },
        ],
        human,
      );
      await ops.approve(more[0]);
      await ops.approve(more[1]);
      await ops.setUnblocksOn(more[0], "review");
      await ops.claim(more[0], s);
      await ops.submit(more[0], s, { what: "task done", how: "ran the steps" });
      expect(store.idx.get(more[1])!.blocked).toBe(false);
      // back to default → strict workspace rule applies again
      await ops.setUnblocksOn(more[0], "default");
      expect(store.idx.get(more[0])!.meta.unblocks_on).toBeUndefined();
      expect(store.idx.get(more[1])!.blocked).toBe(true);
    } finally {
      wsr.ws.config.review_unblocks = true;
      store.idx.setReviewUnblocks(true);
    }
  });
});

describe("graph search", () => {
  it("q matches like the board; linked adds one step of neighbours", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "Zebra base" },
        { type: "task", title: "Zebra top", depends_on: ["#0"], domains: ["stripes"] },
        { type: "task", title: "Lion after", depends_on: ["#1"] },
      ],
      human,
    );
    const node = (id: string) => id.replace("-", "_");
    const g = async (qs: string) => (await (await api(`/api/graph?${qs}`)).json()) as { mermaid: string; count: number };

    const r = await g("q=zebra");
    expect(r.count).toBe(2);
    expect(r.mermaid).toContain(node(ids[0]));
    expect(r.mermaid).not.toContain(node(ids[2]));

    expect((await g("q=%23stripes")).count).toBe(1);
    expect((await g("domain=stripes")).mermaid).toContain(node(ids[1]));

    const linked = await g("q=zebra%20top&linked=1");
    expect(linked.count).toBe(1);
    for (const id of ids) expect(linked.mermaid).toContain(node(id)); // dep + dependent come along
  });

  it("under=<epic> scopes the graph to the plan subtree — no ancestors or outside dependents", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "epic", title: "outer plan" },
        { type: "epic", title: "sub plan", parent: "#0" },
        { type: "task", title: "sub part", parent: "#1" },
        { type: "task", title: "outside dependent", depends_on: ["#2"] },
      ],
      human,
    );
    const node = (id: string) => id.replace("-", "_");
    const g = async (qs: string) => (await (await api(`/api/graph?${qs}`)).json()) as { mermaid: string; count: number };

    const r = await g(`under=${ids[1]}`);
    expect(r.count).toBe(2); // the sub-plan and its part — not the outer plan, not dependents
    expect(r.mermaid).toContain(node(ids[1]));
    expect(r.mermaid).toContain(node(ids[2]));
    expect(r.mermaid).not.toContain(node(ids[0]));
    expect(r.mermaid).not.toContain(node(ids[3]));
    // a bad id is a clean 404, not an empty chart
    expect((await api(`/api/graph?under=NOPE-1`)).status).toBe(404);
  });
});

describe("change_answer", () => {
  it("revises the latest answer of an in-progress item in place", async () => {
    const post = (action: string, body: unknown) =>
      api(`/api/items/WS-0009/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post("change_answer", { text: "too early" })).status).toBeGreaterThanOrEqual(400);
    expect((await post("answer", { text: "a" })).status).toBe(200);
    expect((await post("change_answer", { text: "b, after all" })).status).toBe(200);

    const brief = (await (await api("/api/items/WS-0009")).json()) as {
      item: { meta: { status: string }; sections: Array<{ heading: string; body: string }> };
      decisions: Array<{ meta: { id: string; title: string; version: number; question?: string; options?: string[] } }>;
    };
    expect(brief.item.meta.status).toBe("in_progress");
    const own = brief.decisions.filter((d) => d.meta.title.startsWith("b"));
    expect(own).toHaveLength(1);
    expect(own[0].meta.version).toBe(2);
    // the question and its options stay with the answer, also after a change
    expect(own[0].meta.question).toBe("which?");
    expect(own[0].meta.options).toEqual(["a", "b"]);
    expect(brief.decisions.some((d) => d.meta.title === "a")).toBe(false);
    const log = brief.item.sections.find((x) => x.heading === "Log")?.body ?? "";
    expect(log).toContain(`changed answer ${own[0].meta.id}: "a" → "b, after all"`);
  });
});

describe("plan tracking (epics)", () => {
  it("next skips epics, claim refuses them; approve on an epic approves its draft children", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "epic", title: "Plan P" },
        { type: "task", title: "P part 1", parent: "#0" },
        { type: "task", title: "P part 2", parent: "#0" },
        { type: "task", title: "P part 3", parent: "#0" },
        { type: "task", title: "P part 4", parent: "#0" },
      ],
      human,
    );
    const [epic, t1, t2, t3, t4] = ids;
    // one child already ready; approve on the epic approves the 3 draft
    // children too — each part's own draft status is the only gate
    await ops.approve(t4);
    await ops.approve(epic);
    for (const t of [t1, t2, t3, t4]) expect(store.idx.get(t)!.meta.status).toBe("ready");
    expect(store.idx.get(epic)!.meta.status).toBe("ready");
    expect(store.idx.planState(epic)).toBe("ready");
    // a ready part under it claims as usual — no plan gate left
    const s = ctx.sessions.hello("plan-agent");
    await ops.claim(t1, s);
    await ops.release(t1, s);
    // a ready epic is never offered to agents and can't be claimed
    expect(ops.next(50).map((i) => i.meta.id)).not.toContain(epic);
    await expect(ops.claim(epic, s)).rejects.toThrow(/epics are plans/);
    // the board JSON carries plan fields on epics
    const list = (await (await api("/api/items?type=epic")).json()) as Array<{
      id: string;
      plan_state?: string;
      plan_progress?: { done: number; total: number };
    }>;
    const row = list.find((i) => i.id === epic)!;
    expect(row.plan_state).toBe("ready"); // t1's release sent it back to ready — nothing in flight
    expect(row.plan_progress).toEqual({ done: 0, total: 4 });
    // the parts finish → the plan is done
    await ops.complete(t1);
    await ops.complete(t2);
    await ops.complete(t3);
    await ops.complete(t4);
    expect(store.idx.planState(epic)).toBe("done");
  });
});

describe("plan auto-done sweep", () => {
  it("a finished plan gets status=done — open problems and a hand-done sub-plan with open parts block", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "epic", title: "plan that finishes itself" }, // 0
        { type: "task", title: "part one", parent: "#0" }, // 1
        { type: "epic", title: "sub-plan", parent: "#0" }, // 2
        { type: "task", title: "sub part", parent: "#2" }, // 3
        { type: "bug", title: "problem on part one", found_by: ["#1"] }, // 4
      ],
      human,
    );
    const [plan, t1, sub, subT, bug] = ids;
    await ops.approve(plan);

    // part one done; the bug and the sub-plan's task are still open → not done
    await ops.complete(t1);
    await ops.complete(sub); // done by hand — its part is still open
    await ops.approve(subT);
    // no plan gate: the approved part claims straight away
    const agent = ctx.sessions.hello("pad-agent");
    await ops.claim(subT, agent);
    await ops.submit(subT, agent, { what: "part done", how: "ran the steps" }); // in_review — can bounce back
    expect(store.idx.planState(plan)).toBe("in_progress");
    expect(ops.autoCompletePlansDue()).not.toContain(plan);

    // problem resolved, review accepted → the whole tree is finished
    await ops.complete(bug);
    await ops.accept(subT);
    expect(store.idx.planState(plan)).toBe("done");
    // the hand-done sub-plan is already status=done — the parent is due
    // (other tests' finished plans may be due too — assert membership)
    expect(ops.autoCompletePlansDue()).toContain(plan);
    expect(await ops.autoCompletePlans()).toContain(plan);
    expect(store.idx.get(plan)!.meta.status).toBe("done");
    expect(store.idx.get(plan)!.meta.finished_at).toBeTruthy();

    // a stored done is a verdict — new idle work under it keeps the plan done
    const { ids: more } = await store.createItems([{ type: "task", title: "late part", parent: plan }], human);
    expect(store.idx.planState(plan)).toBe("done");
    expect(store.idx.get(plan)!.meta.status).toBe("done");

    // but a part in flight beats the verdict — the plan shows in_progress
    const late = await ctx.sessions.hello("pad-agent-late");
    await ops.approve(more[0]);
    await ops.claim(more[0], late);
    expect(store.idx.planState(plan)).toBe("in_progress");

    // plan_auto_done is daemon-only — an agent actor is refused
    await expect(
      store.perform(more[0], store.idx.get(more[0])!.meta.version, { kind: "agent", session: "x@test", machine: "test" }, {
        type: "plan_auto_done",
      }),
    ).rejects.toThrow(/daemon-only/);
  });
});

describe("plan problems list", () => {
  it("GET /api/items/:id/problems returns the chip's set — open first; non-epics get none", async () => {
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "epic", title: "plan with problems" }, // 0
        { type: "task", title: "part one", parent: "#0" }, // 1
        { type: "bug", title: "found on the part", found_by: ["#1"] }, // 2
        { type: "bug", title: "a bug part", parent: "#0" }, // 3
      ],
      human,
    );
    const [plan, part, found, bugPart] = ids;
    const res = await api(`/api/items/${plan}/problems`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.problems.map((p: { id: string }) => p.id)).toEqual([found, bugPart].sort());
    expect(body.problems.find((p: { id: string }) => p.id === found).title).toBe("found on the part");
    // non-epic → empty list; unknown id → 404
    const notPlan = await api(`/api/items/${part}/problems`);
    expect((await notPlan.json()).problems).toEqual([]);
    expect((await api(`/api/items/WS-9999/problems`)).status).toBe(404);
  });
});

describe("autonomy: solo", () => {
  it("follow-ups land ready, ok reviews auto-accept after the delay; strict is unchanged", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems([{ type: "task", title: "Base work" }], human);
    const [base] = ids;
    await ops.approve(base);
    const agent = ctx.sessions.hello("solo-agent");

    // strict (default): agent proposals stay drafts, nothing auto-accepts
    const strict = await ops.propose([{ title: "Strict fix", depends_on: [base] }], agent);
    expect(strict.ready).toEqual([]);
    expect(store.idx.get(strict.ids[0])!.meta.status).toBe("draft");

    wsr.ws.config.autonomy = "solo";
    wsr.ws.config.auto_accept_after = "30m";
    try {
      const p = await ops.propose(
        [
          { title: "Fix of base", depends_on: [base] },
          { title: "Free-standing idea", domains: ["meta"] },
          { type: "epic", title: "Big plan", depends_on: [base], domains: ["meta"] },
        ],
        agent,
      );
      const [fix, free, epic] = p.ids;
      expect(p.ready).toEqual([fix]);
      expect(store.idx.get(fix)!.meta.status).toBe("ready");
      expect(store.idx.get(free)!.meta.status).toBe("draft");
      expect(store.idx.get(epic)!.meta.status).toBe("draft");
      // a human's own proposal is never auto-approved
      const hp = await ops.propose([{ title: "Human fix", depends_on: [base] }], "human");
      expect(store.idx.get(hp.ids[0])!.meta.status).toBe("draft");

      // auto-accept: only after an ok review has aged past the delay
      await ops.claim(base, agent);
      await ops.submit(base, agent, { notes: "done", what: "task done", how: "ran the steps" });
      const reviewer = ctx.sessions.hello("solo-reviewer");
      expect(ops.autoAcceptDue()).not.toContain(base); // unreviewed
      await ops.review(base, reviewer, "issues", "broken", "goes back for fixes", undefined, undefined, undefined, { problem: "the change is not verified end to end", recommendation: "read the diff and accept or send it back", options: ["accept", "send back"] });
      expect(ops.autoAcceptDue(Date.now() + 3_600_000)).not.toContain(base);
      // the issues verdict sent it back to the holder — a resubmit returns it to review
      await ops.submit(base, agent, { what: "task done", how: "ran the steps" });
      await ops.review(base, reviewer, "ok", undefined, "verified the work");
      expect(ops.autoAcceptDue()).not.toContain(base); // too fresh
      // key tasks wait for the human
      await ops.setUnblocksOn(base, "done");
      expect(ops.autoAcceptDue(Date.now() + 3_600_000)).not.toContain(base);
      await ops.setUnblocksOn(base, "default");
      // the countdown reaches the UI: list + brief carry the deadline
      const listed = (await (await api(`/api/items?status=in_review`)).json()) as Array<{ id: string; auto_accept_at?: string }>;
      expect(listed.find((i) => i.id === base)?.auto_accept_at).toBeTruthy();
      expect((await ops.brief(base)).autoAcceptAt).toBeTruthy();
      // the human stops it for this submission
      expect((await api(`/api/items/${base}/stop-auto-accept`, { method: "POST" })).status).toBe(200);
      expect(ops.autoAcceptDue(Date.now() + 3_600_000)).not.toContain(base);
      // a resubmit re-arms it
      await ops.review(base, reviewer, "issues", "one more pass", "goes back for fixes", undefined, undefined, undefined, { problem: "the change is not verified end to end", recommendation: "read the diff and accept or send it back", options: ["accept", "send back"] });
      // the second send-back escalated the tier — a walkthrough is required now
      await ops.submit(base, agent, { what: "task done", how: "ran the steps", walkthrough: "fixed the red path end to end" });
      await ops.review(base, reviewer, "ok", undefined, "verified the work");
      expect(await ops.autoAccept(Date.now() + 3_600_000)).toContain(base);
      expect(store.idx.get(base)!.meta.status).toBe("done");

      // strict again: an aged ok review is left for the human
      wsr.ws.config.autonomy = "strict";
      expect(ops.autoAcceptDue(Date.now() + 3_600_000)).toEqual([]);
    } finally {
      wsr.ws.config.autonomy = "strict";
    }
  });

  it("needs_human ok reviews never auto-accept; the submitter's walkthrough lands in ## Walkthrough", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems([{ type: "task", title: "Borderline work" }], human);
    const [id] = ids;
    await ops.approve(id);
    const agent = ctx.sessions.hello("nh-agent");
    const reviewer = ctx.sessions.hello("nh-reviewer");
    await ops.claim(id, agent);
    await ops.submit(id, agent, {
      notes: "acceptance checked",
      walkthrough: "Changed the counter reset path — the flag is set on FC restart.",
      what: "task done", how: "ran the steps",
    });
    // the walkthrough is appended to the item's ## Walkthrough section
    const wt = store.idx.get(id)!.sections.find((s) => s.heading.toLowerCase() === "walkthrough")?.body ?? "";
    expect(wt).toContain("Changed the counter reset path");
    wsr.ws.config.autonomy = "solo";
    wsr.ws.config.auto_accept_after = "30m";
    try {
      // "ok, but the human should decide" — flagged, never auto-accepted
      await ops.review(id, reviewer, "ok", "auth-adjacent change", "looks right, wants your eyes", true, undefined, undefined, { problem: "the change is not verified end to end", recommendation: "read the diff and accept or bounce it", options: ["accept", "bounce"] });
      const it = store.idx.get(id)!;
      expect(it.meta.ai_review?.needs_human).toBe(true);
      expect(ops.autoAcceptAt(it)).toBeUndefined();
      expect(ops.autoAcceptDue(Date.now() + 3_600_000)).not.toContain(id);
      const listed = (await (await api(`/api/items?status=in_review`)).json()) as Array<{
        id: string;
        auto_accept_at?: string;
      }>;
      expect(listed.find((i) => i.id === id)?.auto_accept_at).toBeUndefined();
      expect((await ops.brief(id)).autoAcceptAt).toBeUndefined();
      // a plain ok on a later submission auto-accepts again
      await ops.review(id, reviewer, "ok", "re-checked", "all good now");
      expect(ops.autoAcceptAt(store.idx.get(id)!)).toBeTruthy();
      expect(await ops.autoAccept(Date.now() + 3_600_000)).toContain(id);
      expect(store.idx.get(id)!.meta.status).toBe("done");
    } finally {
      wsr.ws.config.autonomy = "strict";
    }
  });

  it("auto_accept_rules pick the delay per item — never and needs_human stay with the human", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "light item", tier: "light" },
        { type: "task", title: "meta item", domains: ["meta"] },
        { type: "task", title: "plain item" },
        { type: "task", title: "nh item" },
      ],
      human,
    );
    const [light, meta, plain, nh] = ids;
    const agent = ctx.sessions.hello("rules-agent");
    const reviewer = ctx.sessions.hello("rules-reviewer");
    for (const id of ids) {
      await ops.approve(id);
      await ops.claim(id, agent);
      await ops.submit(id, agent, { what: "task done", how: "ran the steps" });
    }
    await ops.review(nh, reviewer, "ok", "borderline", "looks right, wants your eyes", true, undefined, undefined, { problem: "the change is not verified end to end", recommendation: "read the diff and accept or bounce it", options: ["accept", "bounce"] });
    for (const id of [light, meta, plain]) await ops.review(id, reviewer, "ok", undefined, "verified the work");

    wsr.ws.config.autonomy = "solo";
    wsr.ws.config.auto_accept_after = "30m";
    wsr.ws.config.auto_accept_rules = [
      { tier: "light", after: "5m" },
      { domains: ["meta"], after: "never" },
    ];
    try {
      // light → its own 5m delay; the item page names the rule and the time
      const at = ops.autoAcceptAt(store.idx.get(light)!)!;
      expect(at).toBeTruthy();
      const b = await ops.brief(light);
      expect(b.autoAcceptRule).toContain("rule #1");
      expect(b.autoAcceptRule).toContain("tier: light");
      const listed = (await (await api(`/api/items?status=in_review`)).json()) as Array<{ id: string; auto_accept_rule?: string }>;
      expect(listed.find((i) => i.id === light)?.auto_accept_rule).toContain("rule #1");
      // a never rule keeps the item in_review under every clock
      expect(ops.autoAcceptAt(store.idx.get(meta)!)).toBeUndefined();
      expect(ops.autoAcceptDue(Date.now() + 30 * 86_400_000)).not.toContain(meta);
      expect((await ops.brief(meta)).autoAcceptRule).toContain("never");
      // needs_human stays under every rule
      expect(ops.autoAcceptAt(store.idx.get(nh)!)).toBeUndefined();
      expect(ops.autoAcceptDue(Date.now() + 30 * 86_400_000)).not.toContain(nh);
      // no matching rule → the default auto_accept_after
      const plainAt = Date.parse(ops.autoAcceptAt(store.idx.get(plain)!)!);
      const plainRv = Date.parse(store.idx.get(plain)!.meta.ai_review!.reviewed_at);
      expect(plainAt - plainRv).toBe(30 * 60_000);
      // the light item accepts 5 minutes after its ok review, not 30
      const lightRv = Date.parse(store.idx.get(light)!.meta.ai_review!.reviewed_at);
      expect(ops.autoAcceptDue(lightRv + 4 * 60_000)).not.toContain(light);
      expect(await ops.autoAccept(lightRv + 6 * 60_000)).toContain(light);
      expect(store.idx.get(light)!.meta.status).toBe("done");
    } finally {
      wsr.ws.config.autonomy = "strict";
      wsr.ws.config.auto_accept_rules = [];
    }
  });
});

describe("auto_archive_after", () => {
  it("archives items done/dropped past the duration — starred and open items stay", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "old done" },
        { type: "task", title: "old dropped" },
        { type: "task", title: "starred done" },
        { type: "task", title: "still ready" },
      ],
      human,
    );
    const [doneId, droppedId, starredId, readyId] = ids;
    await ops.complete(doneId);
    await ops.drop(droppedId);
    await ops.complete(starredId);
    await ops.star(starredId, "yellow");
    await ops.approve(readyId);
    // terminal transitions stamp finished_at; a reopen clears it
    expect(store.idx.get(doneId)!.meta.finished_at).toBeTruthy();
    await ops.toDraft(doneId, "reopen by mistake");
    expect(store.idx.get(doneId)!.meta.finished_at).toBeUndefined();
    await ops.complete(doneId);

    // rule unset — nothing is ever due
    expect(ops.autoArchiveDue(Date.now() + 30 * 86_400_000)).toEqual([]);

    wsr.ws.config.auto_archive_after = "7d";
    try {
      const in8d = Date.now() + 8 * 86_400_000;
      // the shared fixture has older finished items too — assert membership
      const due = ops.autoArchiveDue(in8d);
      expect(due).toEqual(expect.arrayContaining([doneId, droppedId]));
      expect(due).not.toContain(starredId);
      expect(due).not.toContain(readyId);
      const got = await ops.autoArchive(in8d);
      expect(got).toEqual(expect.arrayContaining([doneId, droppedId]));
      expect(got).not.toContain(starredId);
      expect(store.idx.get(doneId)!.meta.archived).toBe(true);
      expect(store.idx.get(droppedId)!.meta.archived).toBe(true);
      expect(store.idx.get(starredId)!.meta.archived).toBeUndefined();
      expect(store.idx.get(readyId)!.meta.archived).toBeUndefined();
      // each archive is an event with actor daemon
      const { readAllEvents } = await import("../../core/events/log.js");
      const r = await readAllEvents(join(wsr.ws.plansDir, "events"));
      const ev = r.events.find((e) => e.item === doneId && e.action === "archive");
      expect(ev?.actor).toBe("daemon");
    } finally {
      delete wsr.ws.config.auto_archive_after;
    }
  });

  it("closing a finished plan archives its parts under the rule", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "epic", title: "finished plan" },
        { type: "task", title: "part one" },
        { type: "task", title: "part two" },
        { type: "epic", title: "open plan" },
        { type: "task", title: "open part" },
      ],
      human,
    );
    const [epic, p1, p2, epic2, p3] = ids;
    await ops.setParent(p1, epic);
    await ops.setParent(p2, epic);
    await ops.setParent(p3, epic2);
    await ops.complete(p1);
    await ops.drop(p2);

    wsr.ws.config.auto_archive_after = "7d";
    try {
      // all parts finished → the auto-done sweep archives them in the same
      // step; the epic stays visible
      await ops.autoCompletePlans();
      expect(store.idx.get(epic)!.meta.status).toBe("done");
      expect(store.idx.get(p1)!.meta.archived).toBe(true);
      expect(store.idx.get(p2)!.meta.archived).toBe(true);
      expect(store.idx.get(epic)!.meta.archived).toBeUndefined();
      // a plan with an open part finishes nothing and archives nothing
      expect(store.idx.get(p3)!.meta.archived).toBeUndefined();
      expect(store.idx.get(epic2)!.meta.status).not.toBe("done");
    } finally {
      delete wsr.ws.config.auto_archive_after;
    }
  });
});

describe("auto_release_after", () => {
  it("releases dead-session claims past the duration — live, review and other-machine claims stay", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "stuck work" },
        { type: "task", title: "live work" },
        { type: "task", title: "review work" },
        { type: "task", title: "other machine work" },
      ],
      human,
    );
    const [stuck, live, reviewId, other] = ids;
    for (const id of ids) await ops.approve(id);
    const deadAgent = ctx.sessions.hello("dead-agent");
    const liveAgent = ctx.sessions.hello("live-agent");
    await ops.claim(stuck, deadAgent);
    await ops.claim(live, liveAgent);
    await ops.claim(reviewId, deadAgent);
    await ops.submit(reviewId, deadAgent, { what: "task done", how: "ran the steps" });
    // a claim held on another machine — written into the index like a pull does
    const now = new Date().toISOString();
    store.idx.setClaim({
      item: other,
      holder: "peer@otherbox#aa11",
      actor: "agent",
      machine: "otherbox",
      targets: [],
      claimed_at: now,
      last_seen: now,
    });
    ctx.sessions.disconnect(deadAgent.id);

    // TE-0207: the sweep defaults on (2h) — "0" is the disable
    wsr.ws.config.auto_release_after = "0";
    expect(ops.autoReleaseDue(Date.now() + 30 * 86_400_000)).toEqual([]);

    wsr.ws.config.auto_release_after = "24h";
    try {
      const later = Date.now() + 25 * 3_600_000;
      // TE-0207: a live holder does not protect a stale claim — keep this
      // one's last_seen fresh at the check instant so it stays
      const liveClaim = store.idx.claims.get(live)!;
      store.idx.setClaim({ ...liveClaim, last_seen: new Date(later - 3_600_000).toISOString() });
      const due = ops.autoReleaseDue(later);
      expect(due).toContain(stuck);
      expect(due).not.toContain(live); // live session and a fresh claim
      expect(due).not.toContain(reviewId); // in_review
      expect(due).not.toContain(other); // another machine's claim
      const got = await ops.autoRelease(later);
      expect(got.map((s) => s.id)).toContain(stuck);
      const st = store.idx.get(stuck)!;
      expect(st.meta.status).toBe("ready");
      expect(store.idx.claims.get(stuck)).toBeUndefined();
      // the item log and the event name the daemon
      const logSec = st.sections.find((s) => s.heading.toLowerCase() === "log")?.body ?? "";
      expect(logSec).toMatch(/daemon released/);
      const { readAllEvents } = await import("../../core/events/log.js");
      const r = await readAllEvents(join(wsr.ws.plansDir, "events"));
      expect(r.events.find((e) => e.item === stuck && e.action === "release")?.actor).toBe("daemon");
      // the live and foreign claims are untouched
      expect(store.idx.claims.get(live)?.holder).toBe(liveAgent.id);
      expect(store.idx.claims.get(other)?.machine).toBe("otherbox");
      await ops.release(live, liveAgent);
      store.idx.setClaim(null, other);
    } finally {
      delete wsr.ws.config.auto_release_after;
    }
  });
});

describe("batch actions", () => {
  it("accept all takes the ok-reviewed, approve takes a plan's drafts, archive takes finished — agents get FORBIDDEN", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "ok one" },
        { type: "task", title: "ok two" },
        { type: "task", title: "ok three" },
        { type: "task", title: "bad review" },
        { type: "task", title: "nh review" },
        { type: "epic", title: "draft plan" },
        { type: "task", title: "draft part a" },
        { type: "task", title: "draft part b" },
        { type: "task", title: "fin a" },
        { type: "task", title: "fin b" },
      ],
      human,
    );
    const [ok1, ok2, ok3, bad, nh, epic, da, db, fa, fb] = ids;
    const agent = ctx.sessions.hello("batch-agent");
    const reviewer = ctx.sessions.hello("batch-reviewer");
    for (const id of [ok1, ok2, ok3, bad, nh]) {
      await ops.approve(id);
      await ops.claim(id, agent);
      await ops.submit(id, agent, { what: "task done", how: "ran the steps" });
    }
    await ops.review(ok1, reviewer, "ok", undefined, "verified the work");
    await ops.review(ok2, reviewer, "ok", undefined, "verified the work");
    await ops.review(ok3, reviewer, "ok", undefined, "verified the work");
    await ops.review(bad, reviewer, "issues", "broken", "goes back for fixes", undefined, undefined, undefined, { problem: "the change is not verified end to end", recommendation: "read the diff and accept or bounce it", options: ["accept", "bounce"] });
    await ops.review(nh, reviewer, "ok", "risky bit", "wants your eyes", true, undefined, undefined, { problem: "the change is not verified end to end", recommendation: "read the diff and accept or bounce it", options: ["accept", "bounce"] });
    await ops.setParent(da, epic);
    await ops.setParent(db, epic);
    await ops.complete(fa);
    await ops.complete(fb);

    const call = (body: unknown, headers: Record<string, string> = {}) =>
      api("/api/batch", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }).then((r) => r.json().then((j) => ({ status: r.status, j })));

    // an agent session identity on the batch route is refused
    expect((await call({ op: "accept", ids: [ok1] }, { "x-te-session": "agent-x" })).status).toBe(403);
    // a bad op is a usage error
    expect((await call({ op: "frotz", ids: [] })).status).toBe(400);

    // accept all in view: 3 ok go done, issues + needs_human are skipped
    const accept = await call({ op: "accept", ids: [ok1, ok2, ok3, bad, nh] });
    expect(accept.j.done.sort()).toEqual([ok1, ok2, ok3].sort());
    expect(accept.j.skipped.map((s: { id: string }) => s.id).sort()).toEqual([bad, nh].sort());
    expect(store.idx.get(ok1)!.meta.status).toBe("done");
    expect(store.idx.get(nh)!.meta.status).toBe("in_review");
    // each accepted item wrote its own accept event
    const { readAllEvents } = await import("../../core/events/log.js");
    const evs = (await readAllEvents(join(wsr.ws.plansDir, "events"))).events;
    for (const id of [ok1, ok2, ok3]) {
      expect(evs.some((e) => e.item === id && e.action === "accept")).toBe(true);
    }

    // approve all parts of the plan — server computes the draft children
    const approve = await call({ op: "approve", plan: epic });
    expect(approve.j.done.sort()).toEqual([da, db].sort());
    expect(store.idx.get(da)!.meta.status).toBe("ready");
    expect(store.idx.get(db)!.meta.status).toBe("ready");

    // archive finished — an unfinished id is skipped, not archived
    const archive = await call({ op: "archive", ids: [fa, fb, da] });
    expect(archive.j.done.sort()).toEqual([fa, fb].sort());
    expect(archive.j.skipped.map((s: { id: string }) => s.id)).toEqual([da]);
    expect(store.idx.get(fa)!.meta.archived).toBe(true);
    expect(store.idx.get(da)!.meta.archived).toBeUndefined();
  });
});

describe("drop flags: agent asks, human decides", () => {
  it("flag → inbox → unflag keeps it; flag → drop drops it and clears the flag", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "stale idea" },
        { type: "task", title: "superseded work" },
      ],
      human,
    );
    const [keep, drop] = ids;
    const post = (path: string, body: unknown = {}) =>
      api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const flags = async () =>
      ((await (await api("/api/inbox")).json()) as { drop_flags: Array<{ id: string; by: string; reason?: string; status: string }> }).drop_flags;

    const agent = ctx.sessions.hello("flagger", { tier: "light" }); // any tier may flag
    await ops.flagDrop(keep, agent, "no longer needed");
    expect(store.idx.get(keep)!.meta.status).toBe("draft"); // advisory — status untouched
    expect(store.idx.get(keep)!.meta.drop_request?.by).toBe(agent.id);
    const f1 = await flags();
    expect(f1.map((f) => f.id)).toContain(keep);
    expect(f1.find((f) => f.id === keep)).toMatchObject({ reason: "no longer needed", status: "draft" });

    // humans can't flag, agents can't unflag
    await expect(ops.flagDrop(keep, "human" as never)).rejects.toThrow(/agent-only/);
    expect((await post(`/api/items/${keep}/unflag`)).status).toBe(200);
    expect(store.idx.get(keep)!.meta.drop_request).toBeUndefined();
    expect((await post(`/api/items/${keep}/unflag`)).status).toBeGreaterThanOrEqual(400); // nothing to dismiss

    // approve → ready, flag, drop: the flag is consumed by the drop
    await ops.approve(drop);
    await ops.flagDrop(drop, agent, "superseded by GL-other");
    const d = await post(`/api/items/${drop}/drop`, { reason: "superseded by GL-other" });
    expect(d.status).toBe(200);
    expect(store.idx.get(drop)!.meta).toMatchObject({ status: "dropped" });
    expect(store.idx.get(drop)!.meta.drop_request).toBeUndefined();
    expect((await flags()).map((f) => f.id)).not.toContain(drop);

    // flagging a claimed item doesn't interrupt it — the drop does the cleanup
    const { ids: cids } = await store.createItems([{ type: "task", title: "in-flight" }], human);
    await ops.approve(cids[0]);
    const worker = ctx.sessions.hello("worker");
    await ops.claim(cids[0], worker);
    await ops.flagDrop(cids[0], worker, "blocked forever");
    expect(store.idx.get(cids[0])!.meta.status).toBe("in_progress");
    expect(store.idx.claims.has(cids[0])).toBe(true);
    expect((await post(`/api/items/${cids[0]}/drop`, { reason: "blocked forever" })).status).toBe(200);
    expect(store.idx.claims.has(cids[0])).toBe(false);
  });
});

describe("deps: change depends_on after creation", () => {
  it("set, clear, and validation — missing / self / cycle refused", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "dep base" },
        { type: "task", title: "dep mid" },
        { type: "task", title: "dep leaf" },
      ],
      human,
    );
    const [base, mid, leaf] = ids;
    const post = (id: string, depends_on: string[]) =>
      api(`/api/items/${id}/deps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ depends_on }),
      });

    expect((await post(mid, [base])).status).toBe(200);
    expect(store.idx.get(mid)!.meta.depends_on).toEqual([base]);
    expect((await post(leaf, [mid])).status).toBe(200);

    // closing a cycle: base may not wait on leaf (leaf → mid → base)
    const cyc = await post(base, [leaf]);
    expect(cyc.status).toBe(400);
    expect(await cyc.text()).toMatch(/cycle/);
    // self and missing
    expect((await post(base, [base])).status).toBe(400);
    expect((await post(base, ["WS-9999"])).status).toBe(404);
    expect((await post(base, ["not an id"])).status).toBe(400);
    // empty clears; a dropped dep satisfies dependents
    expect((await post(leaf, [])).status).toBe(200);
    expect(store.idx.get(leaf)!.meta.depends_on).toEqual([]);
    expect((await api(`/api/items/${base}/drop`, { method: "POST" })).status).toBe(200);
    expect(store.idx.get(mid)!.blocked).toBe(false); // dropped counts as done
  });
});

describe("editDraft: agent rewrites a draft", () => {
  it("fields + sections land on the item; drafts only, planner tier only", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "task", title: "edit me" },
        { type: "task", title: "edit target" },
        { type: "epic", title: "edit epic" },
      ],
      human,
    );
    const [id, dep, epic] = ids;
    const light = ctx.sessions.hello("lite", { tier: "light" });
    const planner = ctx.sessions.hello("plnr", { tier: "standard" });

    await expect(ops.editDraft(id, light, { reason: "x", title: "y" })).rejects.toThrow(/standard- or heavy/);
    await expect(ops.editDraft(id, planner, { title: "y" } as never)).rejects.toThrow(/reason/);

    await ops.editDraft(id, planner, {
      reason: "fuller spec",
      title: "edited title",
      summary: "New summary body.",
      acceptance: ["a1", "a2"],
      depends_on: [dep],
      parent: epic,
      tier: "heavy",
      domains: ["infra"],
      sections: { Approach: "Do it sideways." },
    });
    const it = store.idx.get(id)!;
    expect(it.meta).toMatchObject({
      title: "edited title",
      status: "draft",
      tier: "heavy",
      depends_on: [dep],
      parent: epic,
      domains: ["infra"],
    });
    const body = (h: string) => it.sections.find((s) => s.heading === h)?.body ?? "";
    expect(body("Summary")).toContain("New summary body.");
    expect(body("Acceptance")).toContain("- [ ] a1");
    expect(body("Acceptance")).toContain("- [ ] a2");
    expect(body("Approach")).toContain("Do it sideways.");
    expect(body("Log")).toMatch(/edited the draft \(.*\): fuller spec/);
    // protected sections are refused
    await expect(
      ops.editDraft(id, planner, { reason: "r", sections: { Notes: "forged" } }),
    ).rejects.toThrow(/managed by TeamEngage/);
    await expect(
      ops.editDraft(id, planner, { reason: "r", sections: { Artifacts: "forged" } }),
    ).rejects.toThrow(/managed by TeamEngage/);

    // clears: tier "" → cleared, parent "" → cleared, deps [] → cleared
    await ops.editDraft(id, planner, { reason: "undo", parent: null, depends_on: [], tier: null });
    const cleared = store.idx.get(id)!.meta;
    expect(cleared.parent).toBeUndefined();
    expect(cleared.depends_on).toEqual([]);
    expect(cleared.tier).toBeUndefined();

    // not a draft → refused even for a human
    await ops.approve(id);
    await expect(ops.editDraft(id, "human", { reason: "late", title: "no" })).rejects.toThrow(/draft/);
    // validation: self-dep / dangling / cycle
    await expect(ops.editDraft(id, planner, { reason: "r", depends_on: [id] })).rejects.toThrow(/itself/);
    await expect(ops.editDraft(id, planner, { reason: "r", depends_on: ["WS-9999"] })).rejects.toThrow(NotFoundError);
  });
});

describe("reject --release and dead-holder takeover", () => {
  it("reject --release frees the claim → ready; the next claim resumes", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems([{ type: "task", title: "rejected for reassign" }], human);
    const [id] = ids;
    await ops.approve(id);
    const s1 = ctx.sessions.hello("coder-1");
    await ops.claim(id, s1);
    await ops.submit(id, s1, { what: "task done", how: "ran the steps" });

    const r = await api(`/api/items/${id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "reassign it", release: true }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { meta: { status: string } }).meta.status).toBe("ready");
    expect(store.idx.get(id)!.claim).toBeUndefined();
    // the submission's branch survives → the next claim reports a resume
    const s2 = ctx.sessions.hello("coder-2");
    const c = await ops.claim(id, s2);
    expect(c.claim.holder).toBe(s2.id);
  });

  it("a dead holder's in_progress claim is takeable; a live one is not; finding surfaces", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems([{ type: "task", title: "stranded work" }], human);
    const [id] = ids;
    await ops.approve(id);
    const s1 = ctx.sessions.hello("gone-agent");
    await ops.claim(id, s1);
    const s2 = ctx.sessions.hello("new-agent");
    // live holder: a second session can't steal it
    await expect(ops.claim(id, s2)).rejects.toThrow(/already claimed/);
    // the holder's session ends → dead_claim finding + takeover allowed
    ctx.sessions.disconnect(s1.id);
    expect((await ops.findings()).some((f) => f.kind === "dead_claim" && f.item === id)).toBe(true);
    const c = await ops.claim(id, s2);
    expect(c.claim.holder).toBe(s2.id);
    expect(store.idx.get(id)!.meta.status).toBe("in_progress");
    expect((await ops.findings()).some((f) => f.kind === "dead_claim" && f.item === id)).toBe(false);
  });
});

describe("idle-expired holder (TE-0165)", () => {
  it("an expired no-pid session's claim is takeable like a dead claim", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "idle holder work" }], human);
    const [id] = ids;
    await ops.approve(id);
    const s1 = ctx.sessions.hello("idle-agent");
    await ops.claim(id, s1);
    const s2 = ctx.sessions.hello("taker-agent");
    await expect(ops.claim(id, s2)).rejects.toThrow(/already claimed/);
    s1.last_seen = new Date(Date.now() - ctx.sessions.idleAfterMs - 1000).toISOString();
    const c = await ops.claim(id, s2);
    expect(c.claim.holder).toBe(s2.id);
  });
});

describe("attach/detach artifacts", () => {
  it("attach copies the file, writes the line and logs; detach removes only the line", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const agent = ctx.sessions.hello("art-agent");
    const root = join(home, "ws");
    writeFileSync(join(root, "shot.png"), Buffer.from([1, 2, 3, 4]));

    // on a ready item, no claim needed
    const r = await ops.attach("WS-0001", agent, { path: "shot.png", caption: "home" });
    expect(r).toMatchObject({ path: "_root/ws-0001-shot.png", copied: true, already: false });
    expect(existsSync(join(root, ".artifacts", "_root", "ws-0001-shot.png"))).toBe(true);
    const itemText = () => readFileSync(join(plans, store.idx.get("WS-0001")!.path), "utf8");
    expect(itemText()).toContain("- _root/ws-0001-shot.png — home");
    expect(itemText()).toContain("attached .artifacts/_root/ws-0001-shot.png");
    // second attach of the same path is a no-op
    expect((await ops.attach("WS-0001", agent, { path: "shot.png", caption: "home" })).already).toBe(true);
    // works on a draft too (WS-0003 is draft)
    await ops.attach("WS-0003", agent, { path: "shot.png", caption: "d" });
    expect(readFileSync(join(plans, store.idx.get("WS-0003")!.path), "utf8")).toContain("- _root/ws-0003-shot.png — d");

    // refusals: '..', missing file, bad type, oversized
    await expect(ops.attach("WS-0001", agent, { path: "../shot.png", caption: "x" })).rejects.toThrow(/\.\./);
    await expect(ops.attach("WS-0001", agent, { path: "nope.png", caption: "x" })).rejects.toThrow(/not found/);
    writeFileSync(join(root, "evil.exe"), "x");
    await expect(ops.attach("WS-0001", agent, { path: "evil.exe", caption: "x" })).rejects.toThrow(/not an allowed artifact type/);
    const big = join(root, "big.png");
    writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0));
    await expect(ops.attach("WS-0001", agent, { path: "big.png", caption: "x" })).rejects.toThrow(/max_mb/);
    // name clash: different content under the same dest name
    writeFileSync(join(root, "shot.png"), Buffer.from([9, 9, 9]));
    await expect(ops.attach("WS-0001", agent, { path: "shot.png", caption: "x" })).rejects.toThrow(/different content/);

    // sensitive: !sensitive tag on the line + warning in the reply
    writeFileSync(join(root, "priv.png"), Buffer.from([5]));
    const s = await ops.attach("WS-0001", agent, { path: "priv.png", caption: "private", domains: ["ui"], sensitive: true });
    expect(s.warning).toMatch(/plans git repo/);
    expect(itemText()).toContain("- _root/ws-0001-priv.png — private #ui !sensitive");

    // detach removes the line, keeps the file
    const d = await ops.detach("WS-0001", agent, "_root/ws-0001-shot.png");
    expect(d.path).toBe("_root/ws-0001-shot.png");
    expect(itemText()).not.toContain("- _root/ws-0001-shot.png — home");
    expect(itemText()).toContain("detached .artifacts/_root/ws-0001-shot.png");
    expect(existsSync(join(root, ".artifacts", "_root", "ws-0001-shot.png"))).toBe(true);
    await expect(ops.detach("WS-0001", agent, "_root/ws-0001-shot.png")).rejects.toThrow(/no artifact/);
  });

  it("domains equal to the item's write no #tags (the line inherits); specific tags stay (TE-0170)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const agent = ctx.sessions.hello("art-domains");
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [{ type: "task", title: "artifact domains", domains: ["bug", "gpio"] }],
      human,
    );
    const [id] = ids;
    const root = join(home, "ws");
    const itemText = () => readFileSync(join(plans, store.idx.get(id)!.path), "utf8");
    const domainsOf = (p: string) =>
      store.idx.get(id)!.artifacts.find((x) => x.path === p)!.domains;

    // an echo of the item's domains (any order) writes no own #tags — the
    // line inherits the live item domains in parseArtifacts
    writeFileSync(join(root, "eq.png"), Buffer.from([1]));
    const eq = await ops.attach(id, agent, {
      path: "eq.png",
      caption: "same",
      domains: ["gpio", "bug"],
    });
    expect(itemText()).toContain(`- ${eq.path} — same\n`);
    expect(domainsOf(eq.path)).toEqual(["bug", "gpio"]);

    // artifact-specific tags are written as own #tags
    writeFileSync(join(root, "spec.png"), Buffer.from([2]));
    const sp = await ops.attach(id, agent, {
      path: "spec.png",
      caption: "specific",
      domains: ["ui"],
    });
    expect(itemText()).toContain(`- ${sp.path} — specific #ui\n`);
    expect(domainsOf(sp.path)).toEqual(["ui"]);
  });
});

describe("artifact file serving and lists", () => {
  it("serves files under .artifacts, refuses escapes, lists per item and workspace", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const agent = ctx.sessions.hello("art-serve");
    const root = join(home, "ws");
    writeFileSync(join(root, "a2.png"), Buffer.from([1, 2]));
    writeFileSync(join(root, "page.html"), "<html><body>mock</body></html>");
    writeFileSync(join(root, "icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    await ops.attach("WS-0001", agent, { path: "a2.png", caption: "shot" });
    await ops.attach("WS-0001", agent, { path: "page.html", caption: "page" });
    await ops.attach("WS-0001", agent, { path: "icon.svg", caption: "icon" });
    await ops.attach("WS-0001", agent, { path: "a2.png", caption: "ui", domains: ["ui"], sensitive: false }).catch(() => {});

    const file = async (p: string) => api(`/api/artifacts/file?path=${encodeURIComponent(p)}`);
    const ok = await file("_root/ws-0001-a2.png");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("content-security-policy")).toBeNull();
    const html = await file("_root/ws-0001-page.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toBe("sandbox");
    const svg = await file("_root/ws-0001-icon.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-security-policy")).toBe("sandbox");
    // .htm is not an allowed attach type — drop it into .artifacts/ directly
    // (name carries no item id, so artifacts import files it under no_item)
    writeFileSync(join(root, ".artifacts", "_root", "page.htm"), "<html><body>htm</body></html>");
    const htm = await file("_root/page.htm");
    expect(htm.status).toBe(200);
    expect(htm.headers.get("content-security-policy")).toBe("sandbox");
    // escapes: '..' and a symlink pointing outside are refused/404
    expect((await file("../workspace.yaml")).status).toBe(403);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(plans, "workspace.yaml"), join(root, ".artifacts", "_root", "link.yaml"));
    expect((await file("_root/link.yaml")).status).toBe(403);
    expect((await file("_root/nope.png")).status).toBe(404);
    // no token → 401
    const bare = await fetch(`${daemon.url}/api/artifacts/file?path=_root/ws-0001-a2.png`);
    expect(bare.status).toBe(401);

    const list = (await (await api("/api/items/WS-0001/artifacts")).json()) as Array<{ path: string; item: string }>;
    expect(list.map((a) => a.path)).toContain("_root/ws-0001-a2.png");
    expect(list.every((a) => a.item === "WS-0001")).toBe(true);
    const all = (await (await api("/api/artifacts?domain=ui")).json()) as Array<{ path: string; domains: string[] }>;
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((a) => a.domains.includes("ui"))).toBe(true);
  });
});

describe("artifacts import", () => {
  it("dry-run plans; --apply attaches and moves; reruns are no-ops", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const root = join(home, "ws");
    mkdirSync(join(root, ".artifacts"), { recursive: true });
    writeFileSync(join(root, ".artifacts", "ws0001-pic.png"), Buffer.from([1]));
    writeFileSync(join(root, ".artifacts", "zz9999-lost.png"), Buffer.from([2]));

    // dry run: plan only, nothing changes
    const dry = await ops.artifactsImport(false);
    expect(dry.move).toEqual(["ws0001-pic.png → _root/ws0001-pic.png"]);
    expect(dry.attach).toEqual(["WS-0001 _root/ws-0001-shot.png", "WS-0001 _root/ws0001-pic.png"]);
    expect(dry.no_item).toEqual(["_root/page.htm", "zz9999-lost.png"]);
    expect(dry.already).toContain("_root/ws-0001-priv.png"); // from the earlier attach suite
    expect(existsSync(join(root, ".artifacts", "ws0001-pic.png"))).toBe(true);

    // apply: the file moves and lands in ## Artifacts
    const done = await ops.artifactsImport(true);
    expect(done.applied).toBe(true);
    expect(existsSync(join(root, ".artifacts", "_root", "ws0001-pic.png"))).toBe(true);
    const text = readFileSync(join(plans, store.idx.get("WS-0001")!.path), "utf8");
    expect(text).toContain("- _root/ws0001-pic.png — ws0001-pic.png");
    expect(existsSync(join(root, ".artifacts", "zz9999-lost.png"))).toBe(true); // never deleted

    // second run: already attached, no new move
    const again = await ops.artifactsImport(true);
    expect(again.already).toContain("_root/ws0001-pic.png");
    expect(again.attach).toEqual([]);
  });
});

describe("propose domain tags", () => {
  it("a task always lands with a domain; fixes get #bug; ideas are exempt", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const agent = ctx.sessions.hello("dom-agent");
    const domainsOf = async (id: string) => store.idx.get(id)!.meta.domains;

    // explicit domains win; a fix title still gains #bug on top
    const tagged = await ops.propose([{ title: "Fix telemetry drop", domains: ["telemetry"] }], agent);
    expect(await domainsOf(tagged.ids[0])).toEqual(["telemetry", "bug"]);

    // nothing given: the title is matched against the vocabulary (telemetry
    // was just added) and the inferred domain is applied
    const inferred = await ops.propose([{ title: "Improve telemetry charts" }], agent);
    expect(await domainsOf(inferred.ids[0])).toEqual(["telemetry"]);

    // a fix gets #bug even when inference found it nothing else
    const bare = await ops.propose([{ title: "Repair zzz wobble" }], agent);
    expect(await domainsOf(bare.ids[0])).toEqual(["bug"]);
    // type `bug` always carries the domain
    const bt = await ops.propose([{ type: "bug", title: "Zzz wobble" }], agent);
    expect(await domainsOf(bt.ids[0])).toEqual(["bug"]);

    // nothing given and nothing inferable → refused, no item created
    await expect(ops.propose([{ title: "Zzz qqq wobble" }], agent)).rejects.toThrow(/domain/);

    // ideas are exempt — an untagged source document is fine
    const idea = await ops.propose([{ type: "idea", title: "Zzz qqq wobble" }], agent);
    expect(await domainsOf(idea.ids[0])).toEqual([]);
  });
});

describe("idea fields in the item API (DE-0133)", () => {
  it("ideas return idea_state, idea_progress and idea_refs in list and item; other types do not", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems(
      [
        { type: "idea", title: "solo thought" },
        { type: "idea", title: "referenced thought" },
        { type: "task", title: "works on the referenced thought", relates: ["#1"] },
        { type: "task", title: "plain task" },
      ],
      human,
    );
    const [ideaSolo, ideaRefed, task, plain] = ids;
    const post = (path: string, body: unknown = {}) =>
      api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // GET /api/items — each idea row carries the derived fields
    const list = (await (await api("/api/items?type=idea")).json()) as Array<{
      id: string;
      idea_state?: string;
      idea_progress?: { done: number; total: number };
      idea_refs?: string[];
    }>;
    expect(list.find((i) => i.id === ideaSolo)).toMatchObject({
      idea_state: "draft",
      idea_progress: { done: 0, total: 0 },
      idea_refs: [],
    });
    // still a draft — its own status wins over the referrer
    expect(list.find((i) => i.id === ideaRefed)).toMatchObject({
      idea_state: "draft",
      idea_progress: { done: 0, total: 1 },
      idea_refs: [task],
    });

    // approve → ready; the referrer finishing flips it to done
    expect((await post(`/api/items/${ideaRefed}/approve`)).status).toBe(200);
    let row = (await (await api(`/api/items/${ideaRefed}`)).json()) as {
      item: { idea_state?: string; idea_progress?: { done: number; total: number }; idea_refs?: string[] };
    };
    expect(row.item.idea_state).toBe("ready");
    expect(row.item.idea_progress).toEqual({ done: 0, total: 1 });
    expect(row.item.idea_refs).toEqual([task]);
    expect((await post(`/api/items/${task}/complete`)).status).toBe(200);
    row = (await (await api(`/api/items/${ideaRefed}`)).json()) as typeof row;
    expect(row.item.idea_state).toBe("done");
    expect(row.item.idea_progress).toEqual({ done: 1, total: 1 });

    // items that are not ideas never carry the fields
    const tasks = (await (await api("/api/items?type=task")).json()) as Array<Record<string, unknown>>;
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.some((i) => "idea_state" in i || "idea_progress" in i || "idea_refs" in i)).toBe(false);
    const plainBrief = (await (await api(`/api/items/${plain}`)).json()) as { item: Record<string, unknown> };
    expect("idea_state" in plainBrief.item).toBe(false);
    expect("idea_progress" in plainBrief.item).toBe(false);
    expect("idea_refs" in plainBrief.item).toBe(false);
  });

  it("idea drafts stay out of the inbox", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await store.createItems([{ type: "idea", title: "inbox-free thought" }], human);
    const data = (await (await api("/api/inbox")).json()) as { drafts: string[] };
    expect(data.drafts).not.toContain(ids[0]);
  });
});
describe("session role at hello (GL-0323)", () => {
  it("/api/sessions lists live sessions with their role", async () => {
    ctx.sessions.hello("planner-1", { role: "planner" });
    ctx.sessions.hello("reviewer-1", { tier: "heavy", role: "reviewer" });
    ctx.sessions.hello("plain-1");
    const res = await api("/api/sessions");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; role?: string; tier?: string }>;
    expect(list.find((s) => s.id.startsWith("planner-1@"))?.role).toBe("planner");
    expect(list.find((s) => s.id.startsWith("reviewer-1@"))?.role).toBe("reviewer");
    expect(list.find((s) => s.id.startsWith("reviewer-1@"))?.tier).toBe("heavy");
    expect("role" in (list.find((s) => s.id.startsWith("plain-1@")) ?? {})).toBe(false);
  });

  it("role picks next's pool: reviewer sees others' submissions, no role sees ready items", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "role-check" }], human);
    const [id] = ids;
    await ops.approve(id);
    const submitter = ctx.sessions.hello("doer", { role: "reviewer" });
    const reviewer = ctx.sessions.hello("watcher", { role: "reviewer" });
    await ops.claim(id, submitter);
    await ops.submit(id, submitter, { walkthrough: "did it", what: "task done", how: "ran the steps" });

    const reviewerNext = ops.next(50, undefined, reviewer).map((i) => i.meta.id);
    expect(reviewerNext).toContain(id); // someone else's submission

    // the submitting session itself never sees its own submission
    expect(ops.next(50, undefined, submitter).map((i) => i.meta.id)).not.toContain(id);
    // DE-0161: a second window of the same agent is the same model — hidden
    const selfReviewer = ctx.sessions.hello("doer", { role: "reviewer" });
    expect(ops.next(50, undefined, selfReviewer).map((i) => i.meta.id)).not.toContain(id);

    // DE-0161: declared models decide — a same-model reviewer is hidden,
    // a different-model reviewer sees the item
    const sameModel = ctx.sessions.hello("watcher", { role: "reviewer", model: "swe-2" });
    expect(ops.next(50, undefined, sameModel).map((i) => i.meta.id)).toContain(id); // submitter declared no model
    const subM = ctx.sessions.hello("doer-m", { role: "reviewer", model: "swe-2" });
    const { ids: ids2 } = await wsr.store.createItems([{ type: "task", title: "model-check" }], human);
    await ops.approve(ids2[0]);
    await ops.claim(ids2[0], subM);
    await ops.submit(ids2[0], subM, { walkthrough: "did it", what: "task done", how: "ran the steps" });
    expect(ops.next(50, undefined, sameModel).map((i) => i.meta.id)).not.toContain(ids2[0]);
    expect(ops.next(50, undefined, reviewer).map((i) => i.meta.id)).toContain(ids2[0]);

    // no role → the ready pool, unchanged
    const plainNext = ops.next(50, undefined, ctx.sessions.hello("plain")).map((i) => i.meta.id);
    expect(plainNext).not.toContain(id);
  });
});

describe("review_models: which model may review which tier (GL-0361)", () => {
  it("gates reviews by declared model and item tier; next hides what a model may not review", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems(
      [
        { type: "task", title: "heavy work", tier: "heavy" },
        { type: "task", title: "light work", tier: "light" },
        { type: "task", title: "baseline work", tier: "heavy" },
      ],
      human,
    );
    const [heavy, light, base] = ids;
    await ops.approve(heavy);
    await ops.approve(light);
    await ops.approve(base);
    const doer = ctx.sessions.hello("rm-doer", { model: "sonnet" });
    for (const [id, w] of [[heavy, "heavy work done"], [light, "light work done"], [base, "baseline work done"]] as const) {
      await ops.claim(id, doer);
      await ops.submit(id, doer, { what: w, how: "ran the steps", walkthrough: "did the work end to end" });
    }

    const quick = ctx.sessions.hello("rm-quick", { role: "reviewer", model: "haiku" });
    const deep = ctx.sessions.hello("rm-deep", { role: "reviewer", model: "opus" });
    const noModel = ctx.sessions.hello("rm-none", { role: "reviewer" });
    const sameModel = ctx.sessions.hello("rm-same", { role: "reviewer", model: "sonnet" });

    // unset review_models: the DE-0161 different-model rule only
    await ops.review(base, quick, "ok", undefined, "verified the work");
    expect(wsr.store.idx.get(base)!.meta.ai_review?.verdict).toBe("ok");

    wsr.ws.config.review_models = { deep: "opus", quick: "haiku", deep_from_tier: "heavy" };
    try {
      // rule 1: no declared model — refused
      await expect(ops.review(heavy, noModel, "ok", undefined, "verified the work")).rejects.toThrow(/declare a model/);
      // rule 2: same model as the submitter — refused
      await expect(ops.review(heavy, sameModel, "ok", undefined, "verified the work")).rejects.toThrow(/different model/);
      // rule 3: a heavy item needs the deep model — quick is refused, error names deep_from_tier
      await expect(ops.review(heavy, quick, "ok", undefined, "verified the work")).rejects.toThrow(/deep_from_tier/);
      // a light item takes the quick or the deep model
      await ops.review(light, quick, "ok", undefined, "verified the work");
      expect(wsr.store.idx.get(light)!.meta.ai_review?.reviewer_model).toBe("haiku");
      // the deep model reviews the heavy item
      await ops.review(heavy, deep, "ok", undefined, "verified the work");
      expect(wsr.store.idx.get(heavy)!.meta.ai_review?.reviewer_model).toBe("opus");

      // next: the quick reviewer sees the light item only; no model sees nothing
      expect(ops.next(50, undefined, quick).map((i) => i.meta.id)).not.toContain(heavy);
      expect(ops.next(50, undefined, noModel)).toHaveLength(0);
      // bounce follows the same gate
      await expect(
        ops.bounce(light, noModel, "bad", "broken work", undefined, {
          problem: "the submission is broken", recommendation: "send it back",
        }),
      ).rejects.toThrow(/declare a model/);
    } finally {
      wsr.ws.config.review_models = undefined;
    }
  });
});

describe("bounce compat routes through review (TE-0187)", () => {
  it("a bounce without ask_human refuses like a review issues; with it the verdict records", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Bounce gate" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    const reviewer = ctx.sessions.hello(`r-${id}`);
    await ops.claim(id, holder);
    await ops.submit(id, holder, { notes: "done", what: "did the work", how: "ran the steps" });
    // same refusal a review issues gets: the ask_human card is required
    await expect(ops.bounce(id, reviewer, "tests are red", "broken work")).rejects.toThrow(/ask_human/);
    await expect(
      ops.review(id, reviewer, "issues", "tests are red", "broken work"),
    ).rejects.toThrow(/ask_human/);
    // with the card the bounce records the issues verdict as before
    const r = await ops.bounce(id, reviewer, "tests are red", "broken work", undefined, {
      problem: "the submission is broken",
      recommendation: "send it back",
      options: ["send it back", "I will check"],
    });
    expect(r.meta.ai_review?.verdict).toBe("issues");
    expect(wsr.store.idx.get(id)!.meta.status).toBe("in_progress");
  });
});

describe("auto-accept follows the model rule (GL-0362)", () => {
  it("a review without reviewer_model never arms auto-accept; batch accept skips it", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems(
      [
        { type: "task", title: "old-reviewed heavy", tier: "heavy" },
        { type: "task", title: "well-reviewed heavy", tier: "heavy" },
      ],
      human,
    );
    const [old, fresh] = ids;
    await ops.approve(old);
    await ops.approve(fresh);
    const doer = ctx.sessions.hello("aa-doer", { model: "sonnet" });
    for (const id of [old, fresh]) {
      await ops.claim(id, doer);
      await ops.submit(id, doer, { what: "work done", how: "ran the steps", walkthrough: "did the work end to end" });
    }

    // an ok review recorded before review_models existed — no reviewer_model
    const oldRev = ctx.sessions.hello("aa-old", { role: "reviewer" });
    await ops.review(old, oldRev, "ok", undefined, "verified the work");
    expect(wsr.store.idx.get(old)!.meta.ai_review?.reviewer_model).toBeUndefined();

    wsr.ws.config.autonomy = "solo";
    wsr.ws.config.review_models = { deep: "opus", quick: "haiku", deep_from_tier: "heavy" };
    try {
      const itOld = ops.index.get(old)!;
      expect(ops.autoAcceptAt(itOld)).toBeUndefined();
      expect(ops.autoAcceptRuleLabel(itOld)).toContain("waits for you");
      expect(ops.autoAcceptDue(Date.now() + 3_600_000)).not.toContain(old);

      // a compliant deep-model review arms the delay
      const deep = ctx.sessions.hello("aa-deep", { role: "reviewer", model: "opus" });
      await ops.review(fresh, deep, "ok", undefined, "verified the work");
      const itFresh = ops.index.get(fresh)!;
      expect(ops.autoAcceptAt(itFresh)).toBeTruthy();
      expect(ops.autoAcceptDue(Date.now() + 3_600_000)).toContain(fresh);

      // batch accept applies the same test and reports the skip
      const res = await ops.batch("accept", { ids: [old, fresh] });
      expect(res.done).toEqual([fresh]);
      expect(res.skipped).toEqual([{ id: old, reason: "no review by a different model" }]);
      expect(wsr.store.idx.get(fresh)!.meta.status).toBe("done");
    } finally {
      wsr.ws.config.review_models = undefined;
      wsr.ws.config.autonomy = "strict";
    }
  });
});


describe("shared lessons per domain (GL-0322)", () => {
  it("GET /api/lessons lists lines per domain; delete removes one — agents get FORBIDDEN", async () => {
    mkdirSync(join(plans, "lessons"), { recursive: true });
    writeFileSync(
      join(plans, "lessons", "simulation.md"),
      "# lessons — #simulation\n\n- 2026-11-14 a@x#1 — first lesson\n- 2026-11-15 b@x#2 — second lesson\n",
    );

    const res = await api("/api/lessons");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Record<string, string[]>;
    expect(list["simulation"]).toHaveLength(2);

    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      api(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    // an agent session may not delete a lesson
    expect(
      (await post("/api/lessons/delete", { domain: "simulation", line: 1 }, { "x-te-session": "t" }))
        .status,
    ).toBe(403);

    // the human deletes one line; the rest stays
    expect((await post("/api/lessons/delete", { domain: "simulation", line: 1 })).status).toBe(200);
    const after = (await (await api("/api/lessons")).json()) as Record<string, string[]>;
    expect(after["simulation"]).toEqual(["2026-11-15 b@x#2 — second lesson"]);
    expect((await post("/api/lessons/delete", { domain: "simulation", line: 9 })).status).toBe(404);
  });

  it("dispatch: status is open, on/off/max_issues/filter are human-only and validated (GL-0328, TE-0203)", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      api("/api/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect((await post({ enabled: true }, { "x-te-session": "agent-x" })).status).toBe(403);
    expect((await post({ max_issues: 0 })).status).toBe(400);
    expect((await post({ filter: "SE-01*:done" })).status).toBe(400);

    const on = (await (await post({ enabled: true, max_issues: 4, filter: "se-01xx:inreview" })).json()) as {
      enabled: boolean;
      max_issues: number;
      filter: string;
      online_issues: number;
      matched: unknown[];
      running: unknown[];
    };
    expect(on.enabled).toBe(true);
    expect(on.max_issues).toBe(4);
    expect(on.filter).toBe("se-01xx:inreview");
    expect(typeof on.online_issues).toBe("number");
    expect(Array.isArray(on.matched)).toBe(true);
    expect(Array.isArray(on.running)).toBe(true);

    const off = (await (await post({ enabled: false, filter: "" })).json()) as { enabled: boolean; filter: string };
    expect(off.enabled).toBe(false);
    expect(off.filter).toBe("");
    const status = (await (await api("/api/dispatch")).json()) as {
      enabled: boolean;
      agents: unknown[];
      events: unknown[];
    };
    expect(status.enabled).toBe(false); // fixture workspace.yaml has no dispatch:
    expect(status.events).toEqual([]);
  });

  it("dispatch matched preview shows per-candidate admission reasons (TE-0208)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions, undefined, home);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems(
      [
        { type: "task", title: "admit-ok" },
        { type: "task", title: "admit-blocked" },
      ],
      human,
    );
    const [okId, blockedId] = ids;
    await ops.approve(okId);
    await ops.approve(blockedId);
    const it = wsr.store.idx.get(blockedId)!;
    await wsr.store.perform(
      blockedId,
      it.meta.version,
      { kind: "daemon", session: "daemon", machine: "test" },
      { type: "dispatch_block", reason: "two failed dispatch runs" },
    );
    const prev = wsr.ws.config.dispatch;
    wsr.ws.config.dispatch = {
      enabled: true,
      agents: [{ role: "coder", command: "sleep 30" }],
    } as typeof prev;
    try {
      const status = (await (await api("/api/dispatch")).json()) as {
        matched: Array<{ id: string; mode: string; admission?: { ok: boolean; reasons: string[] } }>;
      };
      const ok = status.matched.find((c) => c.id === okId);
      const blocked = status.matched.find((c) => c.id === blockedId);
      expect(ok?.admission?.ok).toBe(true);
      expect(ok?.admission?.reasons.length).toBeGreaterThan(0);
      expect(blocked?.admission?.ok).toBe(false);
      expect(blocked?.admission?.reasons.join(" ")).toContain("dispatch_blocked");
    } finally {
      wsr.ws.config.dispatch = prev;
    }
  });

  it("sessions list each live session's held items (GL-0329)", async () => {
    const sessions = (await (await api("/api/sessions")).json()) as Array<{
      id: string;
      holding: string[];
    }>;
    expect(Array.isArray(sessions)).toBe(true);
    // a live session holding a claim reports it; none in this fixture → []
    for (const s of sessions) expect(Array.isArray(s.holding)).toBe(true);
  });

  it("/api/sessions holding lists in_progress claims only — an in_review claim stays parked", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions, undefined, home);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems(
      [
        { type: "task", title: "hold-work" },
        { type: "task", title: "hold-review" },
      ],
      human,
    );
    const [workId, reviewId] = ids;
    await ops.approve(workId);
    await ops.approve(reviewId);
    const worker = ctx.sessions.hello("hold-worker");
    const submitter = ctx.sessions.hello("hold-submitter");
    await ops.claim(workId, worker);
    await ops.claim(reviewId, submitter);
    await ops.submit(reviewId, submitter, {
      summary: "submitted",
      what: "task done",
      how: "ran the steps",
    });
    try {
      const sessions = (await (await api("/api/sessions")).json()) as Array<{
        id: string;
        holding: string[];
      }>;
      expect(sessions.find((s) => s.id === worker.id)?.holding).toEqual([workId]);
      expect(sessions.find((s) => s.id === submitter.id)?.holding).toEqual([]);
    } finally {
      await ops.release(workId, worker, "test done");
      await ops.withdraw(reviewId, submitter);
      await ops.release(reviewId, submitter, "test done");
      ctx.sessions.disconnect(worker.id);
      ctx.sessions.disconnect(submitter.id);
    }
  });

  it("ops.lessonsFor merges the item's domains newest-first, capped at 10", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    writeFileSync(
      join(plans, "lessons", "mavlink.md"),
      "# lessons — #mavlink\n\n- 2026-11-16 c@x#3 — newest of all\n- 2026-11-10 d@x#4 — older\n",
    );
    const ls = await ops.lessonsFor(["simulation", "mavlink"]);
    expect(ls[0]).toContain("[#mavlink] 2026-11-16");
    expect(ls.length).toBe(3);
  });
});

describe("feature item and feature page (GL-0331)", () => {
  it("propose makes a feature, a plan names it, claim refuses it, the view rolls up", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const store = wsr.store;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };

    // a feature plus a plan naming it plus two parts, one batch (#-refs)
    const { ids } = await store.createItems(
      [
        { type: "feature", title: "Mesh failover", domains: ["teamengage"] },
        { type: "epic", title: "Failover plan", feature: "#0", domains: ["teamengage"] },
        { type: "task", title: "part one", parent: "#1", domains: ["teamengage"] },
        { type: "task", title: "part two", parent: "#1", domains: ["teamengage"] },
      ],
      human,
    );
    const [feat, plan, p1] = ids;
    const f = store.idx.get(feat)!;
    expect(f.meta.type).toBe("feature");
    expect(f.feature_plans).toEqual([plan]);
    expect(f.feature_progress).toEqual({ done: 0, total: 2 });
    expect(await ops.featureStatus(f)).toBe("planned");

    // never claimed — approve it first so the type check (not the draft
    // gate) is what refuses, same as an approved idea
    await ops.approve(feat);
    const s = ctx.sessions.hello("coder-x");
    await expect(ops.claim(feat, s)).rejects.toThrow(/features are deliveries/);

    // finish one part → in_progress; the plan's progress lands on the view
    await ops.approve(p1);
    await ops.claim(p1, s);
    await ops.submit(p1, s, { walkthrough: "did it", what: "task done", how: "ran the steps" });
    await ops.accept(p1, human);
    const view = await ops.featureView(store.idx.get(feat)!);
    expect(view.status).toBe("in_progress");
    expect(view.progress).toEqual({ done: 1, total: 2 });
    expect(view.plans[0]).toMatchObject({ id: plan, done: 1, total: 2 });

    // the board's feature filter sees it through /api/items
    const res = await api("/api/items?type=feature&ws=ws");
    const rows = (await res.json()) as Array<{ id: string; feature_status: string }>;
    expect(rows.find((r) => r.id === feat)?.feature_status).toBe("in_progress");
  });

  it("refuses a feature on a non-plan and a parent on a feature", async () => {
    const wsr = ctx.workspaces.get("ws")!;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems(
      [
        { type: "feature", title: "F2", domains: ["teamengage"] },
        { type: "task", title: "p", domains: ["teamengage"] },
      ],
      human,
    );
    const [feat, task] = ids;
    // a task may not name a feature — only a plan does
    await expect(
      wsr.store.createItems([{ type: "task", title: "x", feature: feat, domains: ["teamengage"] }], human),
    ).rejects.toThrow(/only a plan/);
    // a task may not be named as a feature either
    await expect(
      wsr.store.createItems([{ type: "epic", title: "e", feature: task, domains: ["teamengage"] }], human),
    ).rejects.toThrow(/does not name a feature/);
    // a feature is flat — never inside a plan
    await expect(
      wsr.store.createItems([{ type: "feature", title: "x", parent: task, domains: ["teamengage"] }], human),
    ).rejects.toThrow(/may not have a parent/);
  });
});

describe("## Checks (GL-0348)", () => {
  it("propose writes the section, brief lists the checks, validate reports bad ones", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await ops.propose(
      [
        {
          type: "task",
          title: "Checks feature",
          domains: ["teamengage"],
          touches: ["self: src/a.ts"],
          checks: [
            { name: "good", repo: "self", run: "npm test", timeout: 60, expect_exit: 0 },
            { name: "no-run", repo: "self" },
            { name: "far-repo", repo: "elsewhere", run: "true" },
            { name: "good", repo: "self", run: "npm run typecheck" },
          ],
        },
      ],
      "human",
    );
    const [id] = ids;

    // 1. the item file carries the ## Checks section
    const path = join(plans, "items", "WS", `${id}.md`);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("## Checks");
    expect(text).toContain("- name: good");

    // 2. the item API (brief) returns the list
    const b = await ops.brief(id);
    expect(b.checks).toHaveLength(4);
    expect(b.checks[0]).toEqual({ name: "good", repo: "self", run: "npm test", timeout: 60, expect_exit: 0 });

    // 3. findings: no run, repo outside Touches (this item has no Touches line), duplicate
    const findings = await ops.findings();
    const mine = findings.filter((f) => f.item === id && f.kind === "check");
    expect(mine.some((f) => f.message.includes("check 'no-run' has no run"))).toBe(true);
    expect(mine.some((f) => f.message.includes("names repo 'elsewhere' outside Touches"))).toBe(true);
    expect(mine.some((f) => f.message.includes("duplicate check name 'good'"))).toBe(true);

    // 4. a task with no ## Checks loads as before and adds no findings
    const clean = await ops.propose([{ type: "task", title: "No checks here", domains: ["teamengage"] }], human);
    const cleanFindings = (await ops.findings()).filter((f) => f.item === clean.ids[0] && f.kind === "check");
    expect(cleanFindings).toHaveLength(0);
  });
});

describe("ask_human decision card (GL-0344)", () => {
  const AH = { problem: "the change is not verified end to end", recommendation: "read the diff and accept or bounce it", options: ["accept", "bounce"] };

  const submitted = async (ops: InstanceType<typeof WorkspaceOps>, title: string) => {
    const wsr = ctx.workspaces.get("ws")!;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`holder-${id}`);
    await ops.claim(id, holder);
    // what/how via spread: required where the GL-0343 gate is active, ignored otherwise
    await ops.submit(id, holder, { notes: "done", ...({ what: "task done", how: "ran the steps" } as Record<string, string>) });
    return id;
  };

  it("a needs_human or issues review without ask_human is refused with USAGE", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const ops = new WorkspaceOps(ctx.workspaces.get("ws")!, ctx.sessions);
    const reviewer = ctx.sessions.hello("r-344");
    const a = await submitted(ops, "Card check A");
    const b = await submitted(ops, "Card check B");
    await expect(ops.review(a, reviewer, "ok", "n", "s", true)).rejects.toMatchObject({ code: "USAGE" });
    await expect(ops.review(b, reviewer, "issues", "n", "goes back for fixes")).rejects.toMatchObject({ code: "USAGE" });
    // with the card both go through
    await ops.review(a, reviewer, "ok", "n", "s", true, undefined, undefined, AH);
    await ops.review(b, reviewer, "issues", "n", "goes back for fixes", undefined, undefined, undefined, AH);
  });

  it("an ok review summary warns only past the limit + 30% slack (TE-0177)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const ops = new WorkspaceOps(ctx.workspaces.get("ws")!, ctx.sessions);
    const reviewer = ctx.sessions.hello("r-344b");
    const a = await submitted(ops, "Summary inside slack");
    const inside = Array.from({ length: 32 }, (_, i) => `w${i}`).join(" ");
    const ok = await ops.review(a, reviewer, "ok", undefined, inside);
    expect(ok.warnings).toEqual([]);
    const b = await submitted(ops, "Summary over slack");
    const long = Array.from({ length: 33 }, (_, i) => `w${i}`).join(" ");
    const r = await ops.review(b, reviewer, "ok", undefined, long);
    expect(r.warnings).toEqual(["summary is 33 words — max 25 (+30% slack: 32)"]);
    expect(r.meta.ai_review?.summary).toBe(long);
  });

  it("ask_human lands on ai_review and the item API returns it", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const ops = new WorkspaceOps(ctx.workspaces.get("ws")!, ctx.sessions);
    const reviewer = ctx.sessions.hello("r-344c");
    const id = await submitted(ops, "Card stored");
    await ops.review(id, reviewer, "issues", "broken bit", "goes back for fixes", undefined, undefined, undefined, AH);
    const stored = ctx.workspaces.get("ws")!.store.idx.get(id)!.meta.ai_review;
    expect(stored?.ask_human).toEqual(AH);
    const body = (await (await api(`/api/items/${id}`)).json()) as { item: { meta: { ai_review?: { ask_human?: unknown } } } };
    expect(body.item.meta.ai_review?.ask_human).toEqual(AH);
  });

  it("ask with context stores it apart from the question", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const ops = new WorkspaceOps(ctx.workspaces.get("ws")!, ctx.sessions);
    const wsr = ctx.workspaces.get("ws")!;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Ask context" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`holder-${id}`);
    await ops.claim(id, holder);
    await ops.ask(id, holder, "keep the old path or take the new one?", undefined, undefined, "long detail: the new path drops the lock but changes the retry shape, see src/x.ts");
    const q = wsr.store.idx.get(id)!.meta.question!;
    expect(q.text).toBe("keep the old path or take the new one?");
    expect(q.context).toContain("long detail");
    // a 53-word question stands and warns (TE-0177, past the 30% slack) —
    // fresh item, the first one's question is still open
    const { ids: ids2 } = await wsr.store.createItems([{ type: "task", title: "Long question" }], human);
    await ops.approve(ids2[0]);
    await ops.claim(ids2[0], holder);
    const long = await ops.ask(ids2[0], holder, Array.from({ length: 53 }, (_, i) => `w${i}`).join(" "));
    expect(long.warnings).toEqual(["question is 53 words — max 40 (+30% slack: 52)"]);
  });

  it("a review record made before ask_human loads with no error", async () => {
    const { AiReview } = await import("../../core/model/item.js");
    const old = {
      verdict: "ok",
      reviewed_by: "agent@m#abcd",
      reviewed_at: "2026-01-01T00:00:00Z",
      summary: "looked fine",
    };
    expect(AiReview.parse(old).verdict).toBe("ok");
    expect(AiReview.parse(old).ask_human).toBeUndefined();
  });
});

describe("For the human — what/how on submit (GL-0343)", () => {
  it("submit writes the summary under ## For the human; no walkthrough is fine on a standard task (TE-0178)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Two short lines" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    await ops.claim(id, holder);
    // no walkthrough at all — accepted on a standard task
    await ops.submit(id, holder, {
      commits: ["repo@abc1234"],
      summary: "the counter now resets on FC restart — the reset call moved into the restart path",
    });
    const it = wsr.store.idx.get(id)!;
    const sec = it.sections.find((s) => s.heading.toLowerCase() === "for the human");
    expect(sec?.body).toContain("- summary: the counter now resets on FC restart — the reset call moved into the restart path");
    expect(it.meta.status).toBe("in_review");
  });

  it("an old-style submit (what/how/notes) folds into the summary line for one release", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Old style" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    await ops.claim(id, holder);
    await ops.submit(id, holder, {
      notes: "done",
      what: "the counter now resets on FC restart",
      how: "moved the reset call into the restart path and ran the tests",
    });
    const it = wsr.store.idx.get(id)!;
    const sec = it.sections.find((s) => s.heading.toLowerCase() === "for the human");
    expect(sec?.body).toContain("- summary: the counter now resets on FC restart; moved the reset call into the restart path and ran the tests; done");
    expect(it.meta.status).toBe("in_review");
  });

  it("a what of 53 words submits and warns past the 30% slack (TE-0177)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Long what" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    await ops.claim(id, holder);
    const long = Array.from({ length: 53 }, (_, i) => `w${i}`).join(" ");
    const r = await ops.submit(id, holder, { what: long, how: "ran the steps" });
    expect(r.meta.status).toBe("in_review");
    expect(r.warnings).toEqual([
      "summary is 56 words — max 25 (+30% slack: 32)",
      "what is 53 words — max 40 (+30% slack: 52)",
      "no commits listed — name the commit(s) the work made",
    ]);
  });

  it("a submit with no summary text at all still fails (TE-0178)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "No what" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    await ops.claim(id, holder);
    await expect(
      ops.submit(id, holder, {}),
    ).rejects.toThrow(/summary is required/);
  });

  it("tests auto-fill from te verify results when the submit leaves them out (TE-0178)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems(
      [{ type: "task", title: "Verify fill", checks: [{ name: "unit tests", run: "true" }] }],
      human,
    );
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    await ops.claim(id, holder);
    await ops.verifyResult(id, { check: "unit tests", exit_code: 0, passed: true, commit: "abc123def456" }, holder);
    const r = await ops.submit(id, holder, {
      commits: ["repo@abc1234"],
      summary: "the counter now resets on FC restart",
    });
    expect(r.meta.status).toBe("in_review");
    const it = wsr.store.idx.get(id)!;
    const ev = it.sections.find((s) => s.heading.toLowerCase() === "evidence")?.body ?? "";
    expect(ev).toContain("unit tests passed @abc123def4");
  });

  it("a heavy-tier submit without a walkthrough fails with a clear message (TE-0178)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Heavy work", tier: "heavy" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    await ops.claim(id, holder);
    await expect(
      ops.submit(id, holder, { commits: ["repo@abc1234"], summary: "deep change done" }),
    ).rejects.toThrow(/walkthrough is required on heavy tasks/);
    // with the walkthrough it submits
    const r = await ops.submit(id, holder, {
      commits: ["repo@abc1234"],
      summary: "deep change done",
      walkthrough: "the retry path now owns the timer — start there",
    });
    expect(r.meta.status).toBe("in_review");
  });

  it("a review needs only verdict and summary; findings render a numbered list (TE-0178)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Review shape" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    const reviewer = ctx.sessions.hello(`r-${id}`);
    await ops.claim(id, holder);
    await ops.submit(id, holder, { commits: ["repo@abc1234"], summary: "work done" });
    await ops.review(id, reviewer, "ok", undefined, "verified the work");
    expect(wsr.store.idx.get(id)!.meta.ai_review?.verdict).toBe("ok");
    // a findings review writes the numbered list into ## Review
    await ops.withdraw(id, holder);
    await ops.submit(id, holder, { commits: ["repo@abc1234"], summary: "work done again" });
    const reviewer2 = ctx.sessions.hello(`r2-${id}`);
    await ops.review(
      id,
      reviewer2,
      "issues",
      undefined,
      "two problems stay open",
      undefined,
      undefined,
      [
        { text: "the retry timer is not stopped", where: "src/retry.ts:41", severity: "must" },
        { text: "naming is off", severity: "should" },
      ],
      { problem: "two problems stay open", recommendation: "send it back" },
    );
    const review = wsr.store.idx.get(id)!.sections.find((s) => s.heading.toLowerCase() === "review")?.body ?? "";
    expect(review).toContain("two problems stay open");
    expect(review).toContain("1. [must] the retry timer is not stopped (src/retry.ts:41)");
    expect(review).toContain("2. [should] naming is off");
  });

  it("an old-style review (report + note) still succeeds and renders (TE-0178)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Old review" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    const reviewer = ctx.sessions.hello(`r-${id}`);
    await ops.claim(id, holder);
    await ops.submit(id, holder, { commits: ["repo@abc1234"], summary: "work done" });
    await ops.review(
      id,
      reviewer,
      "ok",
      "traced acceptance 1 to code",
      "the work holds up",
      undefined,
      "Verdict: OK.\n\nBottom line: You can accept it.",
    );
    const review = wsr.store.idx.get(id)!.sections.find((s) => s.heading.toLowerCase() === "review")?.body ?? "";
    // DE-0252: the report's lines become numbered findings, not the old block
    expect(review).toContain("1. [report] Verdict: OK.");
    expect(review).toContain("2. [report] Bottom line: You can accept it.");
    expect(review).not.toContain("Technical note:");
    // and the note shows exactly once — as a findings item
    expect(review).toContain("3. [note] traced acceptance 1 to code");
    expect(review.split("traced acceptance 1 to code").length - 1).toBe(1);
  });

  it("an old item with only a walkthrough loads with no error", async () => {
    const wsr = ctx.workspaces.get("ws")!;
    // an item written before what/how existed — the sections just carry ## Walkthrough
    const p = join(plans, "items", "WS", "WS-0099.md");
    writeFileSync(
      p,
      item("WS-0099", "done", "", "## Walkthrough\ndid it the old way\n"),
    );
    await wsr.store.init();
    const it = wsr.store.idx.get("WS-0099")!;
    expect(it.meta.status).toBe("done");
    expect(it.sections.find((s) => s.heading.toLowerCase() === "walkthrough")?.body).toContain("old way");
  });
});

describe("review card actions are real (TE-0176)", () => {
  const submitted = async (ops: InstanceType<typeof WorkspaceOps>, title: string) => {
    const wsr = ctx.workspaces.get("ws")!;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    await ops.claim(id, holder);
    await ops.submit(id, holder, { notes: "done", what: "did the work", how: "ran the steps" });
    return { id, holder };
  };

  it("the decide route is gone; send_back moves the item, writes no D-record", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const { id } = await submitted(ops, "Real buttons");

    const gone = await api(`/api/items/${id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "accept it" }),
    });
    expect(gone.status).toBe(404);

    // send back on a live holder: in_progress, claim kept, no decision file
    const { readdirSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const decisionDir = join(wsr.ws.plansDir, "decisions");
    const decisionFiles = () =>
      existsSync(decisionDir) ? readdirSync(decisionDir).filter((f) => f.startsWith("D-")) : [];
    const beforeSendBack = decisionFiles();
    const res = await api(`/api/items/${id}/send_back`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "tests are red" }),
    });
    expect(res.status).toBe(200);
    expect(wsr.store.idx.get(id)!.meta.status).toBe("in_progress");
    expect(wsr.store.idx.claims.get(id)).toBeTruthy();
    expect(wsr.store.idx.get(id)!.meta.ai_review?.verdict).toBe("issues");
    expect(wsr.store.idx.get(id)!.meta.ai_review?.needs_human).toBeUndefined();
    expect(decisionFiles()).toEqual(beforeSendBack);

    // the human's send-back resets the AI cap: an agent issues verdict still sends back
    const holder2 = wsr.store.idx.claims.get(id)!.holder;
    await ops.submit(id, { ...ctx.sessions.get(holder2)! }, { what: "fixed", how: "patched" });
    const reviewer = ctx.sessions.hello("r-176");
    const r = await ops.review(id, reviewer, "issues", "still red", "goes back for fixes", undefined, undefined, undefined, { problem: "tests are red", recommendation: "send it back", options: ["send back", "keep"] });
    expect(r.meta.status).toBe("in_progress");
  });

  it("send_back on a dead holder releases the claim to ready", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const { id, holder } = await submitted(ops, "Dead holder card");
    ctx.sessions.disconnect(holder.id);
    const res = await api(`/api/items/${id}/send_back`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "holder gone" }),
    });
    expect(res.status).toBe(200);
    expect(wsr.store.idx.get(id)!.meta.status).toBe("ready");
    expect(wsr.store.idx.claims.get(id)).toBeUndefined();
  });

  it("hold parks a claimed review: claim released, item held", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const { id } = await submitted(ops, "Park the card");
    const res = await api(`/api/items/${id}/hold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "next week" }),
    });
    expect(res.status).toBe(200);
    expect(wsr.store.idx.get(id)!.meta.status).toBe("hold");
    expect(wsr.store.idx.claims.get(id)).toBeUndefined();
  });

  it("the Accept button moves an in_review item to done and writes no D-record (DE-0249)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const { id } = await submitted(ops, "Accept through the card");
    const decisionDir = join(wsr.ws.plansDir, "decisions");
    const { readdirSync, existsSync } = await import("node:fs");
    const decisionFiles = () =>
      existsSync(decisionDir) ? readdirSync(decisionDir).filter((f) => f.startsWith("D-")) : [];
    const before = decisionFiles();
    const res = await api(`/api/items/${id}/accept`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(wsr.store.idx.get(id)!.meta.status).toBe("done");
    expect(decisionFiles()).toEqual(before);
  });

  it("Create follow-up: POST /api/propose with found_by lands a draft that names the item (DE-0249)", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const { id } = await submitted(ops, "Follow-up source");
    const res = await api("/api/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            title: "Fix the red tests the review found",
            found_by: [id],
            domains: ["teamengage"],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { ids: string[] };
    expect(created.ids).toHaveLength(1);
    const followUp = wsr.store.idx.get(created.ids[0])!;
    expect(followUp.meta.status).toBe("draft");
    expect(followUp.meta.found_by).toContain(id);
  });

  it("review-card-picks lists legacy card decisions; domain_decisions excludes them", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems(
      [
        { type: "task", title: "Card pick source", domains: ["teamengage"] },
        { type: "task", title: "Sibling same domain", domains: ["teamengage"] },
      ],
      human,
    );
    const [src, sib] = ids;
    // the legacy shape: a decide-route pick wrote `picked "…" → D-N` on the item
    await ops.recordDecision(src, "accept it", { text: "tests are red" } as never);
    const picks = (await (await api("/api/decisions/review-card-picks")).json()) as Array<{ id: string; item: string; title: string }>;
    const pick = picks.find((p) => p.title === "accept it");
    expect(pick).toBeTruthy();
    expect(pick!.item).toBe(src);
    // the same-domain sibling's brief must not carry it as a domain rule
    const brief = await ops.brief(sib);
    expect(brief.domain_decisions.some((d) => d.id === pick!.id)).toBe(false);
    // but the source item keeps the record on its own decisions list
    const own = (await (await api(`/api/items/${src}`)).json()) as { decisions: Array<{ meta: { id: string } }> };
    expect(own.decisions.some((d) => d.meta.id === pick!.id)).toBe(true);
  });
});

describe("unprocessed decisions in the inbox (TE-0164)", () => {
  it("a pick lists under decisions; an agent cannot process; a human's process removes it", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Needs follow-up" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    await ops.claim(id, holder);
    await ops.submit(id, holder, { notes: "done", what: "fixed it", how: "ran the steps" });
    // a pick decision — the promote path still creates these (record_decision)
    await ops.recordDecision(id, "create follow-up task", { text: "two checks open" } as never);

    const inbox = (await (await api("/api/inbox")).json()) as {
      decisions: Array<{ id: string; item: string; title: string }>;
    };
    const d = inbox.decisions.find((x) => x.item === id && x.title === "create follow-up task");
    expect(d).toBeTruthy();

    const refused = await api(`/api/decisions/${d!.id}/process`, {
      method: "POST",
      headers: { "x-te-session": "some-agent" },
    });
    expect(refused.status).toBe(403);

    const ok = await api(`/api/decisions/${d!.id}/process`, { method: "POST" });
    expect(ok.status).toBe(200);
    const inbox2 = (await (await api("/api/inbox")).json()) as {
      decisions: Array<{ id: string }>;
    };
    expect(inbox2.decisions.some((x) => x.id === d!.id)).toBe(false);
  });

  it("accepting the item does not settle the decision — it lists until processed", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "Close me" }], human);
    const [id] = ids;
    await ops.approve(id);
    const holder = ctx.sessions.hello(`h-${id}`);
    await ops.claim(id, holder);
    await ops.submit(id, holder, { notes: "done", what: "fixed it", how: "ran the steps" });
    await ops.recordDecision(id, "create follow-up task");
    const before = (await (await api("/api/inbox")).json()) as {
      decisions: Array<{ id: string; item: string }>;
    };
    const d = before.decisions.find((x) => x.item === id);
    expect(d).toBeTruthy();
    await api(`/api/items/${id}/accept`, { method: "POST" });
    // item done — the unprocessed decision still lists
    const after = (await (await api("/api/inbox")).json()) as {
      decisions: Array<{ id: string; item: string }>;
    };
    expect(after.decisions.some((x) => x.id === d!.id)).toBe(true);
    // only the human's mark clears it
    await api(`/api/decisions/${d!.id}/process`, { method: "POST" });
    const cleared = (await (await api("/api/inbox")).json()) as {
      decisions: Array<{ id: string }>;
    };
    expect(cleared.decisions.some((x) => x.id === d!.id)).toBe(false);
  });

  it("orphans: an outside-work pick clears when an item references it; a work pick clears on later action", async () => {
    const { WorkspaceOps } = await import("./ops.js");
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions);
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems(
      [
        { type: "task", title: "Ext pick" },
        { type: "task", title: "Work pick" },
      ],
      human,
    );
    const [extId, workId] = ids;
    await ops.approve(extId);
    await ops.approve(workId);
    const h1 = ctx.sessions.hello(`h-${extId}`);
    const h2 = ctx.sessions.hello(`h-${workId}`);
    await ops.claim(extId, h1);
    await ops.claim(workId, h2);
    for (const [id, text] of [
      [extId, "create follow-up task"],
      [workId, "widen Touches, fix now"],
    ] as const) {
      await ops.recordDecision(id, text);
    }
    const inbox1 = (await (await api("/api/inbox")).json()) as {
      decisions: Array<{ id: string; item: string }>;
    };
    expect(inbox1.decisions.some((x) => x.item === extId)).toBe(true);
    expect(inbox1.decisions.some((x) => x.item === workId)).toBe(true);

    // inside-work pick: the holder submits → executed
    await ops.submit(workId, h2, { notes: "x", what: "did it", how: "steps" });
    // outside-work pick: a new item references the decision's item → executed
    await wsr.store.createItems(
      [{ type: "task", title: "the follow-up", relates: [extId] }],
      human,
    );
    const inbox2 = (await (await api("/api/inbox")).json()) as {
      decisions: Array<{ id: string; item: string }>;
    };
    expect(inbox2.decisions.some((x) => x.item === extId)).toBe(false);
    expect(inbox2.decisions.some((x) => x.item === workId)).toBe(false);
  });
});
