import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "./ops.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { evidenceCommits, fileMatches, historyRow, touchMatches } from "../../core/index/history.js";
import { covers, type Touch } from "../../core/index/overlap.js";

/**
 * GL-0353: history {path, repo?, limit?} returns the finished items that
 * changed a path — Touches glob match, plus the files of Evidence commits
 * when the repo resolves on this machine.
 */

let home: string;
let plans: string;
let repo: string;
let ops: WorkspaceOps;
let shaA: string;

const writeItem = (id: string, status: string, touches: string, commitRepo = "code") => {
  const prefix = id.split("-")[0];
  mkdirSync(join(plans, "items", prefix), { recursive: true });
  writeFileSync(
    join(plans, "items", prefix, `${id}.md`),
    `---\nid: ${id}\ntype: task\ntitle: "${id} title"\nstatus: ${status}\npriority: 2\nversion: 1\ncreated: 2026-10-01\n---\n\n**Touches:** ${touches}\n\n## Summary\n${id}\n\n## Log\n- 2026-11-14T10:00:00.000Z human accepted\n\n## Evidence\n- commit ${commitRepo}@${shaA}\n\n## For the human\n- what: ${id} changed the path\n- how: ${id} way\n`,
  );
};

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd }).toString().trim();

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-hist-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  repo = join(home, "code");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    `name: ws\nprefix: WS\nresources:\n  code: { kind: git, path: ${JSON.stringify(repo)} }\n`,
  );
  for (const cwd of [plans, repo]) {
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.email", "t@t"]);
    git(cwd, ["config", "user.name", "t"]);
  }
  writeFileSync(join(repo, "src", "a.ts"), "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "a"]);
  shaA = git(repo, ["rev-parse", "HEAD"]);
  appendFileSync(join(repo, "src", "b.ts"), "two\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "b"]);

  // WS-0001 hits src/a.ts by Touches; WS-0002 hits src/a.ts only through its
  // Evidence commit (its Touches cover docs/, not src/); WS-0003 is not done.
  writeItem("WS-0001", "done", "code: src/a.ts");
  writeItem("WS-0002", "done", "code: docs/**");
  writeItem("WS-0003", "ready", "code: src/a.ts");
  // `missing` does not resolve on this machine — these match by Touches only
  for (let i = 10; i < 17; i++) writeItem(`WS-00${i}`, "done", "code: shared.ts", "missing");

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  ops = new WorkspaceOps({ ws, store } as WorkspaceRuntime, new SessionRegistry("test"));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("history helpers", () => {
  it("evidenceCommits parses repo@sha plus `+ sha` extras, skips bare shas", () => {
    const it_ = {
      meta: {},
      sections: [
        {
          heading: "Evidence",
          body: "- commit code@b6207e7 + 33e6a80\n- commit fef75bee no-repo\n- tests: ok\n",
        },
      ],
    } as never;
    expect(evidenceCommits(it_)).toEqual([{ repo: "code", shas: ["b6207e7", "33e6a80"] }]);
  });

  it("touchMatches: glob covers the path, repo filter applies", () => {
    const t: Touch = { repo: "code", path: "src/**" };
    expect(touchMatches(t, { path: "src/a.ts" })).toBe(true);
    expect(touchMatches(t, { path: "src/a.ts", repo: "code" })).toBe(true);
    expect(touchMatches(t, { path: "src/a.ts", repo: "other" })).toBe(false);
    expect(touchMatches({ repo: "code", path: "docs/x.md" }, { path: "src/a.ts" })).toBe(false);
    expect(covers("src/**", "src/cli/main.ts")).toBe(true);
  });

  it("fileMatches: exact file, dir prefix, glob", () => {
    expect(fileMatches(["src/a.ts", "README.md"], "src/a.ts")).toBe(true);
    expect(fileMatches(["src/a.ts"], "src/")).toBe(true);
    expect(fileMatches(["src/cli/a.ts"], "src/**")).toBe(true);
    expect(fileMatches(["src/a.ts"], "src/b.ts")).toBe(false);
  });

  it("historyRow prefers the what line, falls back to the walkthrough", () => {
    const mk = (sections: { heading: string; body: string }[]) =>
      ({ meta: { id: "WS-0099", title: "t" }, sections, found_here: [] }) as never;
    const withWhat = mk([
      { heading: "For the human", body: "- what: added te restart\n- how: x\n" },
      { heading: "Walkthrough", body: "### 2026-11-14 a@b\n\nLong text. Second sentence.\n" },
    ]);
    expect(historyRow(withWhat).what).toBe("added te restart");
    const old = mk([{ heading: "Walkthrough", body: "### 2026-11-14 a@b\n\nLong text. Second sentence.\n" }]);
    expect(historyRow(old).what).toBe("Long text.");
  });
});

describe("WorkspaceOps.history", () => {
  it("returns done items that touched the path, with the what line; open items excluded", async () => {
    const rows = await ops.history({ path: "src/a.ts" });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("WS-0001");
    expect(ids).toContain("WS-0002"); // commit files only
    expect(ids).not.toContain("WS-0003");
    expect(rows.find((r) => r.id === "WS-0001")!.what).toBe("WS-0001 changed the path");
  });

  it("a path nothing touched comes back empty", async () => {
    expect(await ops.history({ path: "nope/deep.txt" })).toEqual([]);
  });

  it("the default limit is 5 rows", async () => {
    const rows = await ops.history({ path: "shared.ts" });
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.id.startsWith("WS-00"))).toBe(true);
  });

  it("the repo filter narrows matching", async () => {
    expect(await ops.history({ path: "src/a.ts", repo: "other" })).toEqual([]);
    const rows = await ops.history({ path: "src/a.ts", repo: "code" });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
