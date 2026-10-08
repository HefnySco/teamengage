import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
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
  daemon = await startDaemon({ home, register: (app) => registerApiRoutes(app, ctx) });
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
