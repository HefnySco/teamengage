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
import { makeSnippet, searchDocs, type SearchDoc } from "../../core/index/search.js";

/**
 * GL-0354: search {text, domain?, limit?} over finished items, decisions
 * and lessons. Every word must hit; ranked by match; ≤30-word snippet.
 */

let home: string;
let plans: string;
let ops: WorkspaceOps;

const writeItem = (id: string, status: string, body: string) => {
  const prefix = id.split("-")[0];
  mkdirSync(join(plans, "items", prefix), { recursive: true });
  writeFileSync(
    join(plans, "items", prefix, `${id}.md`),
    `---\nid: ${id}\ntype: task\ntitle: "${id} title"\nstatus: ${status}\npriority: 2\nversion: 1\ncreated: 2026-10-01\ndomains: [teamengage]\n---\n\n${body}`,
  );
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-search-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  mkdirSync(join(plans, "decisions"), { recursive: true });
  mkdirSync(join(plans, "lessons"), { recursive: true });
  writeFileSync(join(plans, "workspace.yaml"), `name: ws\nprefix: WS\n`);
  for (const a of [["init", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    execFileSync("git", a, { cwd: plans });
  }

  writeItem(
    "WS-0001",
    "done",
    `## Summary\nrestart the daemon cleanly\n\n## For the human\n- what: te restart restarts teamengaged\n- how: it kills the pid and spawns\n`,
  );
  writeItem("WS-0002", "done", `## Summary\nsearch finished work and decisions\n`);
  writeItem("WS-0003", "ready", `## Summary\nrestart the daemon cleanly\n`);
  writeFileSync(
    join(plans, "decisions", "D-0007.md"),
    `---\nid: D-0007\ntitle: "restart through the unit file when systemd exists"\nitem: WS-0001\ndecided_by: human\n---\n\n## Decision\nUse systemctl --user restart when the unit is installed.\n`,
  );
  writeFileSync(
    join(plans, "lessons", "teamengage.md"),
    `# lessons — #teamengage\n\n- 2026-11-13 a@b — a stale spawned daemon keeps port 4747 after a build — restart it\n`,
  );

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  ops = new WorkspaceOps({ ws, store } as WorkspaceRuntime, new SessionRegistry("test"));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("searchDocs helpers", () => {
  it("every word must occur; ranked by match count, title hits weigh more", () => {
    const doc = (id: string, title: string, text: string): SearchDoc => ({
      kind: "item",
      id,
      title,
      domains: [],
      date: "",
      text,
    });
    const hits = searchDocs(
      [
        doc("A", "daemon restart", "restart the daemon"),
        doc("B", "other", "restart restart restart the daemon daemon"),
        doc("C", "restart only", "restart alone"),
      ],
      "restart daemon",
    );
    expect(hits.map((h) => h.id)).not.toContain("C");
    expect(hits.map((h) => h.id).sort()).toEqual(["A", "B"]);
  });

  it("snippets stay under 31 words and mark trimmed edges", () => {
    const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const s = makeSnippet(`prefix ${words} needle tail`, ["needle"]);
    expect(s.split(/\s+/).filter((t) => t !== "…").length).toBeLessThanOrEqual(30);
    expect(s).toContain("…");
    expect(s).toContain("needle");
  });
});

describe("WorkspaceOps.search", () => {
  it("two words return the done items that hold both, with a snippet; open items excluded", async () => {
    const hits = await ops.search({ text: "restart daemon" });
    const ids = hits.filter((h) => h.kind === "item").map((h) => h.id);
    expect(ids).toContain("WS-0001");
    expect(ids).not.toContain("WS-0003");
    expect(hits[0].snippet.length).toBeGreaterThan(0);
  });

  it("a decision that holds the words is in the result with its id", async () => {
    const hits = await ops.search({ text: "systemd" });
    expect(hits.some((h) => h.kind === "decision" && h.id === "D-0007")).toBe(true);
  });

  it("lessons are searched too", async () => {
    const hits = await ops.search({ text: "stale spawned" });
    expect(hits.some((h) => h.kind === "lesson" && h.id === "#teamengage")).toBe(true);
  });

  it("the domain filter narrows results", async () => {
    const hits = await ops.search({ text: "restart daemon", domain: "other" });
    expect(hits.filter((h) => h.kind === "item")).toEqual([]);
    const hits2 = await ops.search({ text: "restart daemon", domain: "teamengage" });
    expect(hits2.some((h) => h.kind === "item")).toBe(true);
  });
});
