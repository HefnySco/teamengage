import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../server/server.js";
import type { DaemonCtx } from "../server/context.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { EventBus } from "./events.js";
import { registerApiRoutes } from "./api.js";
import { OverlayTracker } from "../overlay/tracker.js";
import { registerAgentRoutes, SESSION_HEADER } from "../../agent/http.js";

/**
 * Overlay mode: an existing Markdown task folder tracked in place. Item files
 * hold state only, task files get a `te:` tag, and with `commit: false` the
 * daemon never commits — the human does.
 */

let home: string;
let root: string;
let plans: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let api: (path: string, init?: RequestInit) => Promise<Response>;

const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const post = (path: string, body: unknown) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-overlay-"));
  root = join(home, "Tasks");
  plans = join(root, ".teamengage");
  mkdirSync(join(root, "global", "done"), { recursive: true });
  mkdirSync(join(plans, "items"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: tasks\nprefix: TK\nmode: overlay\ncommit: false\nprojects:\n  global: { prefix: GL }\n",
  );
  writeFileSync(join(root, "global", "TASK-12-gate.md"), "# TASK-12: Wait gate\n\nGate body.\n");
  writeFileSync(
    join(root, "global", "TASK-13-rerun.md"),
    "# TASK-13: Mission re-run\n\n**Order:** after TASK-12.\n\nRerun body.\n",
  );
  writeFileSync(join(root, "global", "TASK-13-rerun.simple.md"), "Plain words.\n");
  writeFileSync(join(root, "global", "done", "TASK-01-view.md"), "# TASK-01: View mode\n\nDone.\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-m", "human tasks");

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  ctx = {
    home,
    machine: "test",
    workspaces: new Map([["tasks", { ws, store }]]),
    sessions: new SessionRegistry("test"),
    bus: new EventBus(),
  };
  daemon = await startDaemon({
    home,
    register: (app) => {
      registerApiRoutes(app, ctx);
      registerAgentRoutes(app, ctx);
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

const store = () => ctx.workspaces.get("tasks")!.store;
const byLegacy = (l: string) =>
  [...store().idx.items.values()].find((i) => i.meta.legacy_id === l)!;

describe("overlay import", () => {
  it("records relative sources, copies no content, tags task files, never commits", async () => {
    const head = git("rev-parse", "HEAD");
    const r = await post("/api/import", { folder: join(root, "global"), project: "global", apply: true });
    expect(r.created).toHaveLength(3);

    const t13 = byLegacy("TASK-13-rerun");
    expect(t13.meta.source).toBe("global/TASK-13-rerun.md");
    expect(t13.meta.simple_source).toBe("global/TASK-13-rerun.simple.md");
    expect(t13.meta.imported_from).toBeUndefined();
    expect(t13.meta.depends_on).toEqual([byLegacy("TASK-12-gate").meta.id]);
    expect(byLegacy("TASK-01-view").meta.status).toBe("done");
    expect(t13.sections.find((s) => s.heading === "Summary")).toBeUndefined();
    const itemText = readFileSync(join(plans, t13.path), "utf8");
    expect(itemText).not.toContain("Rerun body");

    const id = t13.meta.id;
    expect(readFileSync(join(root, "global", "TASK-13-rerun.md"), "utf8")).toBe(
      `---\nte: ${id}\n---\n# TASK-13: Mission re-run\n\n**Order:** after TASK-12.\n\nRerun body.\n`,
    );
    expect(readFileSync(join(root, "global", "TASK-13-rerun.simple.md"), "utf8")).toBe(
      `---\nte: ${id}\n---\nPlain words.\n`,
    );

    await post(`/api/items/${id}/approve`, {});
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toContain(".teamengage/");
  });

  it("brief returns the live task file; a moved file is found by its tag", async () => {
    const id = byLegacy("TASK-13-rerun").meta.id;
    const get = async () =>
      (await (await api(`/api/items/${id}`)).json()) as {
        source: { path: string; text: string; moved: boolean; simple?: { text: string } };
      };
    let b = await get();
    expect(b.source.path).toBe("global/TASK-13-rerun.md");
    expect(b.source.text).toContain("Rerun body.");
    expect(b.source.text).not.toContain("te:");
    expect(b.source.simple?.text).toBe("Plain words.\n");

    // the human edits and moves the file — content is read live
    writeFileSync(
      join(root, "global", "TASK-13-rerun.md"),
      `---\nte: ${id}\n---\n# TASK-13: Mission re-run\n\nEdited.\n`,
    );
    renameSync(join(root, "global", "TASK-13-rerun.md"), join(root, "global", "done", "TASK-13-rerun.md"));
    b = await get();
    expect(b.source).toMatchObject({ path: "global/done/TASK-13-rerun.md", moved: true });
    expect(b.source.text).toContain("Edited.");
  });

  it("re-import skips tagged files and flags tags from elsewhere", async () => {
    writeFileSync(join(root, "global", "TASK-14-new.md"), "# TASK-14: New\n\nNew.\n");
    writeFileSync(join(root, "global", "TASK-15-foreign.md"), "---\nte: GL-0999\n---\n# TASK-15\n");
    const r = await post("/api/import", { folder: join(root, "global"), project: "global", apply: true });
    expect(r.created).toHaveLength(1);
    expect(byLegacy("TASK-14-new").meta.source).toBe("global/TASK-14-new.md");
    const amb = r.ambiguities as Array<{ kind: string; file: string }>;
    expect(amb).toContainEqual(expect.objectContaining({ kind: "unknown_tag", file: "TASK-15-foreign.md" }));
  });

  it("refuses an overlay import from outside the workspace root", async () => {
    const outside = join(home, "elsewhere");
    mkdirSync(outside, { recursive: true });
    const res = await api("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: outside, apply: false }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("overlay tracker (task-folder watcher)", () => {
  const until = async (cond: () => boolean, ms = 5000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("records moves, reports untracked/foreign files, adopts one file", async () => {
    const tracker = new OverlayTracker(store(), { debounceMs: 50 });
    ctx.workspaces.get("tasks")!.overlay = tracker;
    try {
      await tracker.start();
      // TASK-13 was moved into done/ by the previous test — the start scan records it
      const t13 = byLegacy("TASK-13-rerun");
      expect(t13.meta.source).toBe("global/done/TASK-13-rerun.md");
      expect(readFileSync(join(plans, t13.path), "utf8")).toContain("human moved source → global/done/TASK-13-rerun.md");
      const kinds = () => tracker.findings().map((f) => `${f.kind} ${f.path}`);
      expect(kinds()).toContain("unknown_tag global/TASK-15-foreign.md");
      // surfaced through the regular findings endpoint
      const viaApi = (await (await api("/api/findings")).json()) as Array<{ kind: string }>;
      expect(viaApi.map((f) => f.kind)).toContain("unknown_tag");

      // a new task file appears → untracked finding
      writeFileSync(join(root, "global", "TASK-16-later.md"), "# TASK-16: Later\n\nLater.\n");
      await until(() => kinds().includes("untracked_task_file global/TASK-16-later.md"));

      // adopt just that file
      const r = await post("/api/import", {
        folder: join(root, "global", "TASK-16-later.md"),
        project: "global",
        apply: true,
      });
      expect(r.created).toHaveLength(1);
      const t16 = byLegacy("TASK-16-later");
      expect(t16.meta).toMatchObject({ status: "draft", source: "global/TASK-16-later.md" });
      await until(() => !kinds().some((k) => k.includes("TASK-16")));

      // a file deleted outright → missing_source, item kept
      rmSync(join(root, "global", "TASK-16-later.md"));
      await until(() => kinds().includes("missing_source global/TASK-16-later.md"));
      expect(byLegacy("TASK-16-later")).toBeDefined();
    } finally {
      await tracker.close();
      ctx.workspaces.get("tasks")!.overlay = undefined;
    }
  });
});

describe("overlay propose writes real task files", () => {
  const agent = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(`${daemon.url}${path}`, {
      method: "POST",
      headers: token ? { [SESSION_HEADER]: token } : {},
      body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  };

  it("renders TASK-NN / PHASE-NN files from the template, tagged and tracked", async () => {
    const token = /^token (\S+)/.exec((await agent("/agent/hello", { agent: "planner" })).text)![1];
    const t13 = byLegacy("TASK-13-rerun").meta.id;
    const r = await agent(
      "/agent/propose",
      {
        items: [
          {
            title: "Clear latched events on restart",
            project: "global",
            depends_on: [t13],
            touches: ["droneengage_mavlink: src/mission/**"],
            acceptance: ["second AUTO run fires module events", "ctest -R mission_restart passes"],
            summary: "Reset latched events when a restart is detected.",
            simple: "Events fire again on a second flight.",
          },
          { title: "Follow-up cleanup", project: "global" },
          { type: "epic", title: "Protocol v3", project: "global" },
        ],
      },
      token,
    );
    expect(r.status).toBe(200);
    // global/ holds TASK-12, 14, 15 and done/TASK-01, 13; GL item TASK-16's
    // file was deleted but the item still records it → 16 is not reused
    const lines = r.text.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^proposed GL-\d{4} → global\/TASK-17-clear-latched-events-on-restart\.md$/);
    expect(lines[1]).toMatch(/→ global\/TASK-18-follow-up-cleanup\.md$/);
    expect(lines[2]).toMatch(/→ global\/PHASE-01-protocol-v3\.md$/);

    const id = /^proposed (\S+)/.exec(lines[0])![1];
    const it = store().idx.get(id)!;
    expect(it.meta).toMatchObject({
      status: "draft",
      source: "global/TASK-17-clear-latched-events-on-restart.md",
      simple_source: "global/TASK-17-clear-latched-events-on-restart.simple.md",
      depends_on: [t13],
    });
    // the tracking file holds state only — the content is in the task file
    expect(it.sections.find((s) => s.heading === "Summary")).toBeUndefined();
    expect(readFileSync(join(plans, it.path), "utf8")).not.toContain("Reset latched events");

    const task = readFileSync(join(root, "global", "TASK-17-clear-latched-events-on-restart.md"), "utf8");
    expect(task).toBe(
      [
        "---",
        `te: ${id}`,
        "---",
        "# Clear latched events on restart",
        "",
        `**Depends on:** ${t13}`,
        "**Touches:** droneengage_mavlink: src/mission/**",
        "",
        "## Summary",
        "Reset latched events when a restart is detected.",
        "",
        "## Acceptance",
        "- [ ] second AUTO run fires module events",
        "- [ ] ctest -R mission_restart passes",
        "",
        "## Notes",
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(root, "global", "TASK-17-clear-latched-events-on-restart.simple.md"), "utf8")).toBe(
      `---\nte: ${id}\n---\n# Clear latched events on restart (simple)\n\nEvents fire again on a second flight.\n`,
    );

    // brief serves the new file; the epic is an epic
    const b = (await (await api(`/api/items/${id}`)).json()) as { source: { text: string } };
    expect(b.source.text).toContain("## Acceptance");
    const epicId = /^proposed (\S+)/.exec(lines[2])![1];
    expect(store().idx.get(epicId)!.meta.type).toBe("epic");

    // the tracker sees the new files as tracked, not untracked
    const tracker = new OverlayTracker(store(), { debounceMs: 50 });
    await tracker.rescan();
    expect(tracker.findings().filter((f) => f.path?.includes("TASK-17") || f.path?.includes("PHASE-01"))).toEqual([]);
  });

  it("refuses a project folder outside the workspace root", async () => {
    const ws = ctx.workspaces.get("tasks")!.ws;
    ws.config.projects.escape = { prefix: "ES", path: "../outside" };
    try {
      await expect(
        store().createItems([{ type: "task", title: "x", project: "escape" }], {
          kind: "human",
          session: "human",
          machine: "test",
        }),
      ).rejects.toThrow(/outside the workspace root/);
    } finally {
      delete ws.config.projects.escape;
    }
  });
});

describe("propose: #N batch-local refs", () => {
  const human = { kind: "human" as const, session: "human", machine: "test" };

  it("resolves #N to earlier items of the same call, in the file and the item", async () => {
    const { ids, files } = await store().createItems(
      [
        { type: "epic", title: "Batch epic", project: "global" },
        { type: "task", title: "Batch first", project: "global", parent: "#0" },
        { type: "task", title: "Batch second", project: "global", parent: "#0", depends_on: ["#1"] },
      ],
      human,
    );
    const second = store().idx.get(ids[2])!.meta;
    expect(second).toMatchObject({ parent: ids[0], depends_on: [ids[1]] });
    const text = readFileSync(join(root, files[2]), "utf8");
    expect(text).toContain(`**Depends on:** ${ids[1]}\n**Parent:** ${ids[0]}\n`);
  });

  it("refuses forward or self references", async () => {
    await expect(
      store().createItems(
        [{ type: "task", title: "Points ahead", project: "global", depends_on: ["#1"] }, { type: "task", title: "Later", project: "global" }],
        human,
      ),
    ).rejects.toThrow(/earlier item/);
  });
});

describe("overlay import honours ignore globs", () => {
  it("skips root-relative ignored files, imports the rest", async () => {
    const ws = ctx.workspaces.get("tasks")!.ws;
    writeFileSync(join(root, "AGENTS.md"), "# TeamEngage agent protocol\n");
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "README.md"), "# notes index\n");
    writeFileSync(join(root, "notes", "TASK-01-real.md"), "# TASK-01: real\n");
    ws.config.ignore = ["AGENTS.md", "**/README.md"];
    try {
      const dry = await post("/api/import", { folder: root, apply: false });
      const preview = String(dry.preview);
      expect(preview).toContain("notes/TASK-01-real.md");
      expect(preview).not.toContain("AGENTS.md");
      expect(preview).not.toContain("README.md");
      // ignore is root-relative even when importing a subfolder
      const sub = await post("/api/import", { folder: join(root, "notes"), apply: false });
      expect(String(sub.preview)).not.toContain("README.md");
      expect(sub.count).toBe(1);
    } finally {
      ws.config.ignore = [];
    }
  });
});

describe("delete", () => {
  const human = { kind: "human" as const, session: "human", machine: "test" };
  const post = (path: string, body: unknown = {}) =>
    api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("removes tracking, untags the task file, ignores its path; refusals name the reason", async () => {
    const { ids, files } = await store().createItems(
      [
        { type: "task", title: "Delete me", project: "global", simple: "plain" },
        { type: "task", title: "Depends on it", project: "global", depends_on: ["#0"] },
      ],
      human,
    );
    const [victim, user] = ids;

    // still depended on → refused, nothing touched
    const r1 = await post(`/api/items/${victim}/delete`);
    expect(r1.status).toBeGreaterThanOrEqual(400);
    expect(await r1.text()).toContain(user);
    expect(store().idx.get(victim)).toBeDefined();

    expect((await post(`/api/items/${user}/delete`, { reason: "duplicate" })).status).toBe(200);
    // claimed → refused
    expect((await post(`/api/items/${victim}/approve`)).status).toBe(200);
    expect((await post(`/api/items/${victim}/claim`)).status).toBe(200);
    expect((await post(`/api/items/${victim}/delete`)).status).toBeGreaterThanOrEqual(400);
    expect((await post(`/api/items/${victim}/release`)).status).toBe(200);

    const itemPath = join(plans, store().idx.get(victim)!.path);
    const r = await post(`/api/items/${victim}/delete`, { reason: "mistake" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { untagged: string[]; ignored: string[] };
    const simple = files[0].replace(/\.md$/, ".simple.md");
    expect(body.untagged.sort()).toEqual([files[0], simple].sort());

    expect(store().idx.get(victim)).toBeUndefined();
    expect(existsSync(itemPath)).toBe(false);
    // the task file is still there, as plain markdown
    const text = readFileSync(join(root, files[0]), "utf8");
    expect(text.startsWith("# Delete me\n")).toBe(true);
    // ignored in config (memory + file), so the tracker doesn't flag it
    const ws = ctx.workspaces.get("tasks")!.ws;
    expect(ws.config.ignore).toEqual(expect.arrayContaining([files[0], simple]));
    expect(readFileSync(join(plans, "workspace.yaml"), "utf8")).toContain(files[0]);
    const tracker = new OverlayTracker(store(), { debounceMs: 50 });
    await tracker.rescan();
    expect(tracker.findings().filter((f) => f.path?.includes("delete-me"))).toEqual([]);
    // the event log keeps the record
    const events = readFileSync(join(plans, "events", "test", `${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8");
    expect(events).toMatch(new RegExp(`"item":"${victim}","action":"delete".*Delete me — mistake`));
    ws.config.ignore = [];
  });
});

describe("simple tool", () => {
  it("an agent writes the plain-English version: created, tagged, linked; replaced on a second call", async () => {
    const hello = await fetch(`${daemon.url}/agent/hello`, { method: "POST", body: JSON.stringify({ agent: "writer" }) });
    const token = /^token (\S+)/.exec(await hello.text())![1];
    const call = (path: string, body: unknown) =>
      fetch(`${daemon.url}${path}`, { method: "POST", headers: { [SESSION_HEADER]: token }, body: JSON.stringify(body) }).then(
        async (r) => ({ status: r.status, text: await r.text() }),
      );
    const id = byLegacy("TASK-12-gate").meta.id;
    expect(store().idx.get(id)!.meta.simple_source).toBeUndefined();

    const r = await call(`/agent/simple/${id}`, { text: "The drone waits at a gate until told to go." });
    expect(r.status).toBe(200);
    expect(r.text.trim()).toBe(`simple ${id} → global/TASK-12-gate.simple.md`);
    const meta = store().idx.get(id)!.meta;
    expect(meta.simple_source).toBe("global/TASK-12-gate.simple.md");
    const file = join(root, "global", "TASK-12-gate.simple.md");
    expect(readFileSync(file, "utf8")).toBe(
      `---\nte: ${id}\n---\n# TASK-12: Wait gate (simple)\n\nThe drone waits at a gate until told to go.\n`,
    );

    await call(`/agent/simple/${id}`, { text: "Version two." });
    expect(readFileSync(file, "utf8")).toContain("Version two.");
    expect(readFileSync(file, "utf8")).not.toContain("waits at a gate");
    const b = (await (await api(`/api/items/${id}`)).json()) as { source: { simple: { text: string } } };
    expect(b.source.simple.text).toContain("Version two.");
    expect(store().idx.get(id)!.sections.find((s) => s.heading === "Log")!.body).toMatch(/writer@test#\w+ wrote the simple version/);

    // the tracker sees a linked, tagged companion — nothing to report or merge
    const tracker = new OverlayTracker(store(), { debounceMs: 50 });
    await tracker.rescan();
    expect(tracker.findings().filter((f) => f.path?.includes("TASK-12-gate"))).toEqual([]);
  });
});

describe("notes", () => {
  it("a multi-line note lands in the task file's ## Notes; History gets a short line", async () => {
    const { ids, files } = await store().createItems([{ type: "task", title: "Noted task", project: "global" }], {
      kind: "human",
      session: "human",
      machine: "test",
    });
    const id = ids[0];
    const post = (body: unknown) =>
      api(`/api/items/${id}/note`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    expect((await post({ text: "first line with `code`\nsecond line\n\n- a list" })).status).toBe(200);
    expect((await post({ text: "another one" })).status).toBe(200);
    expect((await post({ text: "   " })).status).toBeGreaterThanOrEqual(400);

    const file = readFileSync(join(root, files[0]), "utf8");
    const notes = file.slice(file.indexOf("## Notes"));
    expect(notes).toMatch(/## Notes\n\n\*\*\d{4}-\d\d-\d\d \d\d:\d\d · human\*\*\n\nfirst line with `code`\nsecond line\n\n- a list\n\n\*\*.* · human\*\*\n\nanother one\n$/);
    // everything above Notes is untouched (template body)
    expect(file.startsWith(`---\nte: ${id}\n---\n# Noted task\n`)).toBe(true);
    const log = store().idx.get(id)!.sections.find((s) => s.heading === "Log")!.body;
    expect(log).toMatch(/human added a note: first line with `code`\n.*human added a note: another one/);
  });
});

describe("domains", () => {
  const human = { kind: "human" as const, session: "human", machine: "test" };
  const json = async (path: string, body?: unknown) => {
    const r = await api(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as never };
  };
  const yaml = () => readFileSync(join(plans, "workspace.yaml"), "utf8");

  it("tagging auto-adds to the vocabulary; filters work for board, next and query", async () => {
    const { ids } = await store().createItems(
      [
        { type: "task", title: "Mavlink restart", project: "global", domains: ["MAVLink", "missions"] },
        { type: "task", title: "Webclient panel", project: "global" },
      ],
      human,
    );
    const [a, b] = ids;
    expect(store().idx.get(a)!.meta.domains).toEqual(["mavlink", "missions"]);
    expect(yaml()).toMatch(/domains:[\s\S]*mavlink: \{\}[\s\S]*missions: \{\}/);

    const r = await json(`/api/items/${b}/domains`, { domains: ["Web Client", "missions"] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ domains: ["web-client", "missions"], added: ["web-client"] });
    expect(store().idx.get(b)!.sections.find((s) => s.heading === "Log")!.body).toMatch(/domains: \+web-client \+missions/);

    const byDomain = async (d: string) =>
      ((await json(`/api/items?domain=${d}`)).body as Array<{ id: string }>).map((i) => i.id).filter((id) => ids.includes(id));
    expect(await byDomain("missions")).toEqual([a, b]);
    expect(await byDomain("mavlink")).toEqual([a]);

    for (const id of ids) await json(`/api/items/${id}/approve`, {});
    const next = ((await json("/api/next?limit=50&domain=web-client")).body as Array<{ meta: { id: string } }>).map((i) => i.meta.id);
    expect(next).toEqual([b]);

    const list = (await json("/api/domains")).body as Array<{ name: string; count: number; open: number }>;
    expect(list.find((d) => d.name === "missions")).toMatchObject({ count: 2, open: 2 });
  });

  it("describe, rename, merge (keywords unioned), delete — every item follows", async () => {
    expect((await json("/api/domains", { name: "comm", description: "de_comm module", keywords: ["de_comm"] })).status).toBe(200);
    expect(yaml()).toMatch(/comm:\s*\n\s*description: de_comm module\s*\n\s*keywords:/);

    const { ids } = await store().createItems([{ type: "task", title: "Typo tagged", project: "global", domains: ["mavlnk"] }], human);
    // rename onto an existing domain = merge
    const m = await json("/api/domains/mavlnk/rename", { to: "mavlink" });
    expect(m.body).toMatchObject({ merged: true, items: ids });
    expect(store().idx.get(ids[0])!.meta.domains).toEqual(["mavlink"]);
    expect(yaml()).not.toMatch(/mavlnk: \{\}/);
    expect(yaml()).toMatch(/mavlink:[\s\S]*keywords:[\s\S]*mavlnk/); // the old spelling keeps suggesting it

    // plain rename keeps the definition
    const rn = await json("/api/domains/comm/rename", { to: "communication" });
    expect(rn.body).toMatchObject({ merged: false });
    expect(yaml()).toMatch(/communication:\s*\n\s*description: de_comm module/);

    const del = await json("/api/domains/missions/delete", {});
    expect((del.body as { items: string[] }).items.length).toBeGreaterThan(0);
    expect([...store().idx.items.values()].some((i) => i.meta.domains.includes("missions"))).toBe(false);
    expect(yaml()).not.toMatch(/missions:/);
  });

  it("suggestions come from keywords; apply only adds", async () => {
    await json("/api/domains", { name: "gate", keywords: ["wait gate"] });
    const s = (await json("/api/domains/suggest")).body as Array<{ id: string; add: string[] }>;
    const t12 = byLegacy("TASK-12-gate").meta.id;
    expect(s.find((x) => x.id === t12)?.add).toContain("gate");
    const ap = await json("/api/domains/suggest/apply", { ids: [t12] });
    expect(ap.body).toMatchObject({ items: 1 });
    expect(store().idx.get(t12)!.meta.domains).toContain("gate");
    expect(((await json("/api/domains/suggest")).body as Array<{ id: string }>).some((x) => x.id === t12)).toBe(false);
  });
});
