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
import { briefBudget, BRIEF_BUDGET } from "../../mcp/format.js";

/**
 * GL-0356: brief gains the parent plan's goal line, titles of decisions
 * in the item's domains, and the newest done items on the same Touches.
 */

let home: string;
let plans: string;
let ops: WorkspaceOps;

const writeItem = (id: string, status: string, body: string, meta = "") => {
  const prefix = id.split("-")[0];
  mkdirSync(join(plans, "items", prefix), { recursive: true });
  writeFileSync(
    join(plans, "items", prefix, `${id}.md`),
    `---\nid: ${id}\ntype: task\ntitle: "${id} title"\nstatus: ${status}\npriority: 2\nversion: 1\ncreated: 2026-10-01\ndomains: [teamengage]\n${meta}---\n\n${body}`,
  );
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-briefctx-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  mkdirSync(join(plans, "decisions"), { recursive: true });
  writeFileSync(join(plans, "workspace.yaml"), `name: ws\nprefix: WS\n`);
  for (const a of [["init", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    execFileSync("git", a, { cwd: plans });
  }

  writeItem(
    "WS-0001",
    "ready",
    `## Summary\ngive agents context from past work\n\n## Acceptance\n`,
  );
  writeItem(
    "WS-0002",
    "ready",
    `## Summary\na task\n\n**Touches:** teamengage: src/daemon/**\n`,
    `parent: WS-0001\n`,
  );
  // done items on the same paths — newest (by ## Log date) first
  for (const [id, day] of [
    ["WS-0101", "2026-11-10"],
    ["WS-0102", "2026-11-11"],
    ["WS-0103", "2026-11-12"],
    ["WS-0104", "2026-11-13"],
  ] as const) {
    writeItem(
      id,
      "done",
      `## Summary\nold work\n\n**Touches:** teamengage: src/daemon/**\n\n## For the human\n- what: did ${id}\n\n## Log\n- ${day} done\n`,
    );
  }
  // a done item on other paths — must not appear
  writeItem("WS-0199", "done", `## Summary\nelsewhere\n\n**Touches:** teamengage: web/**\n`);
  // decision on the item itself → in `decisions`, not domain_decisions
  writeFileSync(
    join(plans, "decisions", "D-0007.md"),
    `---\nid: D-0007\ntitle: "own decision"\nitem: WS-0002\ndecided_by: human\n---\n\n## Decision\nx\n`,
  );
  // decision on a same-domain item → domain_decisions
  writeItem("WS-0050", "done", `## Summary\nsibling\n\n**Touches:** teamengage: web/**\n`);
  writeFileSync(
    join(plans, "decisions", "D-0008.md"),
    `---\nid: D-0008\ntitle: "same-domain call"\nitem: WS-0050\ndecided_by: human\n---\n\n## Decision\ny\n`,
  );

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  ops = new WorkspaceOps({ ws, store } as WorkspaceRuntime, new SessionRegistry("test"));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("brief: context from past work (GL-0356)", () => {
  it("shows the parent plan's goal line", async () => {
    const b = await ops.brief("WS-0002");
    expect(b.plan_goal).toBe("give agents context from past work");
  });

  it("adds domain decisions, excluding ones already listed", async () => {
    const b = await ops.brief("WS-0002");
    expect(b.decisions.map((d) => d.meta.id)).toContain("D-0007");
    expect(b.domain_decisions.map((d) => d.id)).toEqual(["D-0008"]);
    expect(b.domain_decisions[0].title).toBe("same-domain call");
  });

  it("top-3 history rows for the item's Touches, newest first + total", async () => {
    const b = await ops.brief("WS-0002");
    expect(b.history_total).toBe(4);
    expect(b.history.map((r) => r.id)).toEqual(["WS-0104", "WS-0103", "WS-0102"]);
    expect(b.history[0].what).toContain("did WS-0104");
  });
});

describe("briefBudget — the 120-line limit", () => {
  const base = Array.from({ length: 90 }, (_, i) => `fixed ${i}`);
  const decisions = {
    name: "decisions",
    count: 30,
    lines: Array.from({ length: 30 }, (_, i) => `domain decision D-${i}`),
  };

  it("a 30-decision brief stays under 120 lines and names the more call", () => {
    const out = briefBudget(base, [decisions], undefined, "WS-0002");
    expect(out.length).toBeLessThanOrEqual(BRIEF_BUDGET);
    expect(out.at(-1)).toBe("  (30 decisions — brief WS-0002 more=decisions)");
  });

  it("more=decisions prints all of them", () => {
    const out = briefBudget(base, [decisions], "decisions", "WS-0002");
    expect(out.filter((l) => l.startsWith("domain decision")).length).toBe(30);
  });

  it("blocks that fit still print", () => {
    const out = briefBudget(
      base,
      [{ name: "history", count: 4, lines: ["h1", "h2", "h3"] }, decisions],
      undefined,
      "WS-0002",
    );
    expect(out).toContain("h3");
    expect(out.at(-1)).toBe("  (30 decisions — brief WS-0002 more=decisions)");
  });
});
