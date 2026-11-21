import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "./ops.js";
import type { WorkspaceRuntime } from "../server/context.js";

/**
 * TE-0173: sources (idea/discussion) finish themselves — the daemon sweep
 * sets status done once every live referrer is done, the planner pool
 * offers only ready unreferenced sources, and a finished source archives
 * under auto_archive_after like any item.
 */

let home: string;
let plans: string;
let wsr: WorkspaceRuntime;
let ops: WorkspaceOps;
let sessions: SessionRegistry;

function item(id: string, status: string, type = "task", extra = "") {
  const prefix = id.split("-")[0];
  mkdirSync(join(plans, "items", prefix), { recursive: true });
  writeFileSync(
    join(plans, "items", prefix, `${id}.md`),
    `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\nstatus: ${status}\nversion: 1\n${extra}---\n\n## Summary\nx\n`,
  );
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-ops-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "claims"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nauto_archive_after: 30d\nresources:\n  self: { kind: git, path: ., worktree: false }\n",
  );

  // planner pool fixtures
  item("ID-0100", "draft", "idea");
  item("ID-0101", "ready", "idea");
  item("ID-0102", "ready", "idea");
  item("WS-0002", "ready", "task", 'relates: ["ID-0102"]\n');
  item("ID-0103", "ready", "idea");
  item("WS-0003", "dropped", "task", 'relates: ["ID-0103"]\n');
  item("DC-0100", "draft", "discussion");
  item("WS-0010", "draft", "task", "authored_tier: light\n");
  item("WS-0011", "draft", "task", "authored_tier: light\nvetted_by: human\n");

  // auto-complete fixtures
  item("ID-0200", "draft", "idea");
  item("WS-0020", "done", "task", 'relates: ["ID-0200"]\n');
  item("WS-0021", "done", "task", 'relates: ["ID-0200"]\n');
  item("WS-0022", "dropped", "task", 'relates: ["ID-0200"]\n');
  item("ID-0201", "ready", "idea");
  item("WS-0023", "done", "task", 'relates: ["ID-0201"]\n');
  item("WS-0024", "ready", "task", 'relates: ["ID-0201"]\n');
  item("ID-0202", "ready", "idea");
  item("DC-0200", "draft", "discussion");
  item("WS-0025", "done", "task", 'relates: ["DC-0200"]\n');
  item("ID-0203", "ready", "idea");
  item("EP-0200", "ready", "epic", 'relates: ["ID-0203"]\n');
  item("EP-0201", "done", "task", "parent: EP-0200\n");
  item("EP-0202", "dropped", "task", "parent: EP-0200\n");

  // archive fixture — a source already done for longer than auto_archive_after
  item("ID-0300", "done", "idea", "finished_at: 2020-01-01T00:00:00Z\n");

  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  wsr = { ws, store };
  sessions = new SessionRegistry("test");
  ops = new WorkspaceOps(wsr, sessions, undefined, home);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("planner pool (next with role=planner)", () => {
  it("offers only ready unreferenced sources plus unvetted light drafts", () => {
    const planner = sessions.hello("planner", { role: "planner" });
    const ids = ops.next(50, undefined, planner).map((i) => i.meta.id);
    expect(ids).toContain("ID-0101"); // ready, no referrers
    expect(ids).toContain("ID-0103"); // its only referrer is dropped
    expect(ids).toContain("ID-0202"); // ready, no referrers
    expect(ids).not.toContain("ID-0100"); // draft — needs the human's approve first
    expect(ids).not.toContain("DC-0100"); // draft discussion
    expect(ids).not.toContain("ID-0102"); // live work references it
    expect(ids).not.toContain("ID-0200"); // draft, even with done referrers
    expect(ids).not.toContain("ID-0201"); // a referrer is still open
    expect(ids).toContain("WS-0010"); // unvetted light draft
    expect(ids).not.toContain("WS-0011"); // already vetted
  });

  it("approve on a draft source queues it for the planner", async () => {
    const planner = sessions.hello("planner2", { role: "planner" });
    await ops.approve("ID-0100");
    expect(ops.index.get("ID-0100")!.meta.status).toBe("ready");
    const ids = ops.next(50, undefined, planner).map((i) => i.meta.id);
    expect(ids).toContain("ID-0100");
  });
});

describe("autoCompleteSources", () => {
  it("marks a source done once every live referrer is done", async () => {
    const due = ops.autoCompleteSourcesDue();
    expect(due).toContain("ID-0200"); // draft, two done referrers
    expect(due).toContain("DC-0200"); // draft discussion, done referrer
    expect(due).toContain("ID-0203"); // epic referrer whose leaves are finished
    expect(due).not.toContain("ID-0201"); // a referrer is still open
    expect(due).not.toContain("ID-0202"); // no referrers — left for the planner
    expect(due).not.toContain("ID-0101"); // no referrers either

    const done = await ops.autoCompleteSources();
    expect(done).toEqual(expect.arrayContaining(["ID-0200", "DC-0200", "ID-0203"]));
    for (const id of ["ID-0200", "DC-0200", "ID-0203"]) {
      expect(ops.index.get(id)!.meta.status).toBe("done");
    }
    expect(ops.index.get("ID-0201")!.meta.status).toBe("ready");
    expect(ops.index.get("ID-0202")!.meta.status).toBe("ready");
  });
});

describe("auto_archive on a finished source", () => {
  it("a done source older than auto_archive_after is archived like any item", async () => {
    expect(ops.autoArchiveDue()).toContain("ID-0300");
    await ops.autoArchive();
    expect(ops.index.get("ID-0300")!.meta.archived).toBe(true);
  });
});
