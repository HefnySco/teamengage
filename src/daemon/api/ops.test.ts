import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
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

function item(id: string, status: string, type = "task", extra = "", body = "## Summary\nx\n") {
  const prefix = id.split("-")[0];
  mkdirSync(join(plans, "items", prefix), { recursive: true });
  writeFileSync(
    join(plans, "items", prefix, `${id}.md`),
    `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\nstatus: ${status}\nversion: 1\n${extra}---\n\n${body}`,
  );
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-ops-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "claims"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nauto_archive_after: 30d\ndomains:\n  teamengage: { keywords: [teamengage, daemon] }\nresources:\n  self: { kind: git, path: ., worktree: false }\n",
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

  // feature fixtures (TE-0174): FE-0001's parts are all done; FE-0002's are
  // done but a bug found under its plan stays open
  item("FE-0001", "ready", "feature");
  item("EP-0001", "ready", "epic", "feature: FE-0001\n");
  item("TS-0001", "done", "task", "parent: EP-0001\n");
  item("TS-0002", "done", "task", "parent: EP-0001\n");
  item("FE-0002", "ready", "feature");
  item("EP-0002", "ready", "epic", "feature: FE-0002\n");
  item("TS-0003", "done", "task", "parent: EP-0002\n");
  item("TS-0004", "dropped", "task", "parent: EP-0002\n");
  item("BG-0001", "ready", "bug", 'found_by: ["EP-0002"]\n');
  item("FE-0003", "ready", "feature");
  item("EP-0003", "ready", "epic", "feature: FE-0003\n");
  item("TS-0005", "done", "task", "parent: EP-0003\n");
  item("TS-0006", "in_progress", "task", "parent: EP-0003\n");

  // brief fixtures (TE-0179): parent-epic context, a relates source's
  // digest, the item's own submission record, and the inherit line cap
  mkdirSync(join(plans, "decisions"), { recursive: true });
  item(
    "EP-0400",
    "ready",
    "epic",
    "",
    "## Summary\nFirst goal line.\nSecond goal line.\n\n## Architecture\nlayer one\nlayer two\n",
  );
  writeFileSync(
    join(plans, "decisions", "D-0400.md"),
    `---\nid: D-0400\ntitle: "epic call"\nitem: EP-0400\ndecided_by: human\n---\n\n## Decision\nx\n`,
  );
  item(
    "DC-0400",
    "ready",
    "discussion",
    "",
    "## Summary\ntalked about cache keys\n\n## Key points\n- keys derive from the session\n\n## Decisions reached\n- keep the two-line format\n",
  );
  item("WS-0040", "ready", "task", 'parent: EP-0400\nrelates: ["DC-0400"]\n');
  item(
    "WS-0041",
    "in_review",
    "task",
    "",
    "## Summary\nsubmitted work\n\n## Evidence\n- commit abc123\n- tests: pass\n\n## For the human\n- summary: did the thing\n\n## Walkthrough\n### 2026-11-20 devin@x\n\nhow it works\n\n## Review\n- 2026-11-20T10:00:00Z rev@y issues — first pass\n  findings:\n  1. [must] fix the loop\n- 2026-11-21T10:00:00Z rev@y ok — second pass looks right\n",
  );
  item(
    "ID-0400",
    "ready",
    "idea",
    "",
    `## Summary\n${Array.from({ length: 70 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
  );
  item("WS-0042", "ready", "task", 'relates: ["ID-0400"]\n');

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

describe("featureStatus (TE-0174)", () => {
  it("a feature with all parts done and 0 open problems is done", async () => {
    expect(await ops.featureStatus(ops.index.get("FE-0001")!)).toBe("done");
  });

  it("a feature with all parts finished but an open problem stays in_progress", async () => {
    expect(await ops.featureStatus(ops.index.get("FE-0002")!)).toBe("in_progress");
  });

  it("a feature with open parts stays in_progress, and none at all stays planned", async () => {
    expect(await ops.featureStatus(ops.index.get("FE-0003")!)).toBe("in_progress");
  });
});

describe("brief: own record and inherited context (TE-0179)", () => {
  it("an in_review item's brief carries its Evidence and its latest Review", async () => {
    const b = await ops.brief("WS-0041");
    expect(b.submission?.evidence).toContain("commit abc123");
    expect(b.submission?.for_human).toContain("did the thing");
    expect(b.submission?.walkthrough).toContain("how it works");
    expect(b.submission?.latest_review).toContain("second pass looks right");
    expect(b.submission?.latest_review).not.toContain("first pass");
  });

  it("a task under an epic gets the full Summary, Architecture and the epic's decisions", async () => {
    const b = await ops.brief("WS-0040");
    expect(b.plan?.id).toBe("EP-0400");
    expect(b.plan?.summary).toContain("First goal line.");
    expect(b.plan?.summary).toContain("Second goal line.");
    expect(b.plan?.architecture).toContain("layer two");
    expect(b.plan?.decisions.map((d) => d.id)).toContain("D-0400");
  });

  it("a relates discussion gives its summary, key points and decisions reached", async () => {
    const b = await ops.brief("WS-0040");
    const r = b.relates.find((x) => x.ref === "DC-0400");
    expect(r?.digest).toContain("talked about cache keys");
    expect(r?.digest).toContain("keys derive from the session");
    expect(r?.digest).toContain("keep the two-line format");
  });

  it("inherited text stops at brief_inherit_lines and shows a more hint", async () => {
    const b = await ops.brief("WS-0042");
    const r = b.relates.find((x) => x.ref === "ID-0400");
    expect(r?.digest).toContain("line 60");
    expect(r?.digest).not.toContain("line 61");
    expect(r?.digest).toContain("10 more lines — brief ID-0400");
  });
});

describe("capture: the caller owns the ready transition (TE-0180)", () => {
  const eventLines = () =>
    readdirSync(join(plans, "events", "test")).flatMap((f) =>
      readFileSync(join(plans, "events", "test", f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { item?: string; action: string; actor: string }),
    );

  it("an agent capture writes no event with the human as actor", async () => {
    const s = sessions.hello("capturer");
    const r = await ops.capture(s, {
      title: "chat about ops",
      transcript_text: "## user\n\nhi\n\n## assistant\n\nhello\n",
    });
    const mine = eventLines().filter((e) => e.item === r.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.actor !== "human")).toBe(true);
    expect(mine.find((e) => e.action === "source_ready")?.actor).toBe(s.id);
    // and the record still lands ready
    expect(ops.index.get(r.id)!.meta.status).toBe("ready");
  });

  it("a captured discussion whose summary names a known domain gets that #domain", async () => {
    const s = sessions.hello("capturer2");
    const r = await ops.capture(s, {
      title: "a chat",
      summary: "how the teamengage daemon indexes the items",
      transcript_text: "x",
    });
    expect(ops.index.get(r.id)!.meta.domains).toContain("teamengage");
  });
});
