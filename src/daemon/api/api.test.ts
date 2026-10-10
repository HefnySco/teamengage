import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
    await ops.submit(a, s1, { notes: "done" });
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
    expect(ops.findings().some((f) => f.kind === "started_on_open_dep" && f.item === b)).toBe(true);

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
    await ops.submit(c, s1, {});
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
    await ops.submit(k, s, {});
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
      await ops.submit(more[0], s, {});
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
      decisions: Array<{ meta: { id: string; title: string; version: number } }>;
    };
    expect(brief.item.meta.status).toBe("in_progress");
    const own = brief.decisions.filter((d) => d.meta.title.startsWith("b"));
    expect(own).toHaveLength(1);
    expect(own[0].meta.version).toBe(2);
    expect(brief.decisions.some((d) => d.meta.title === "a")).toBe(false);
    const log = brief.item.sections.find((x) => x.heading === "Log")?.body ?? "";
    expect(log).toContain(`changed answer ${own[0].meta.id}: "a" → "b, after all"`);
  });
});
