import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { plansGitStatus, pullPlans, commitAndPushPlans } from "./sync.js";

/**
 * Human-pressed Pull / Commit & Push of the task folder: two clones of one
 * repo whose task folder (Tasks/) sits below the repo root, next to files
 * that must never be swept into a plans commit.
 */

let home: string;
let a: string;
let b: string;
let wsA: WorkspaceRuntime;
let wsB: WorkspaceRuntime;
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function runtime(repo: string, machine: string): Promise<WorkspaceRuntime> {
  const ws = resolveWorkspace(join(repo, "Tasks"), { home });
  const store = new PlansStore(ws, machine);
  await store.init();
  return { ws, store };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-plansgit-"));
  const remote = join(home, "remote.git");
  a = join(home, "desktop");
  b = join(home, "laptop");
  g(home, "init", "-q", "--bare", "-b", "main", remote);
  mkdirSync(join(a, "Tasks", ".teamengage", "items"), { recursive: true });
  writeFileSync(join(a, "Tasks", ".teamengage", "workspace.yaml"), "name: t\nprefix: TK\nmode: overlay\ncommit: false\n");
  writeFileSync(join(a, "Tasks", "TASK-01-x.md"), "# one\n");
  writeFileSync(join(a, "outside.txt"), "not plans\n");
  g(a, "init", "-q", "-b", "main");
  for (const r of [a]) {
    g(r, "config", "user.email", "t@t");
    g(r, "config", "user.name", "t");
  }
  g(a, "add", "-A");
  g(a, "commit", "-qm", "init");
  g(a, "remote", "add", "origin", remote);
  g(a, "push", "-q", "-u", "origin", "main");
  g(home, "clone", "-q", remote, b);
  g(b, "config", "user.email", "t@t");
  g(b, "config", "user.name", "t");
  wsA = await runtime(a, "desktop");
  wsB = await runtime(b, "laptop");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("task folder git from the web", () => {
  it("Commit & Push commits only the task folder; the other machine pulls it", async () => {
    writeFileSync(join(a, "Tasks", "TASK-02-y.md"), "# two\n");
    writeFileSync(join(a, "outside.txt"), "changed outside\n");
    g(a, "add", "outside.txt"); // even pre-staged outside changes stay out

    const s = await plansGitStatus(wsA);
    expect(s.scope).toBe("Tasks");
    expect(s.changes.map((c) => c.path)).toEqual(["Tasks/TASK-02-y.md"]);

    const r = await commitAndPushPlans(wsA, "Tasks: add two");
    expect(r).toMatchObject({ committed: 1, pushed: true });
    expect(g(a, "log", "-1", "--format=%s")).toBe("Tasks: add two");
    expect(g(a, "show", "--name-only", "--format=", "HEAD")).toBe("Tasks/TASK-02-y.md");
    expect(g(a, "status", "--porcelain")).toContain("outside.txt"); // still uncommitted, untouched

    const behind = await plansGitStatus(wsB, { fetch: true });
    expect(behind.behind).toBe(1);
    const p = await pullPlans(wsB);
    expect(p.pulled).toBe(1);
    expect(readFileSync(join(b, "Tasks", "TASK-02-y.md"), "utf8")).toBe("# two\n");
    expect((await pullPlans(wsB)).pulled).toBe(0); // up to date
  });

  it("refuses to push while behind, and refuses to pull a diverged history", async () => {
    writeFileSync(join(b, "Tasks", "TASK-03-z.md"), "# three\n");
    await commitAndPushPlans(wsB, "Tasks: three from laptop");

    writeFileSync(join(a, "Tasks", "TASK-04-w.md"), "# four\n");
    await expect(commitAndPushPlans(wsA, "x")).rejects.toThrow(/behind origin by 1 commit\(s\) — pull from origin first/);

    g(a, "add", "Tasks/TASK-04-w.md");
    g(a, "commit", "-qm", "local four", "--", "Tasks");
    await expect(pullPlans(wsA)).rejects.toThrow(/diverged from origin: 1 local and 1 remote/);
    expect(existsSync(join(a, "Tasks", "TASK-03-z.md"))).toBe(false); // nothing merged
  });
});

describe("choosing the remote", () => {
  it("lists every remote; push and pull go only where chosen", async () => {
    const backup = join(home, "backup.git");
    g(home, "init", "-q", "--bare", "-b", "main", backup);
    // laptop: get in sync with origin first, then add a second remote
    g(b, "remote", "add", "backupDT", backup);
    const st = await plansGitStatus(wsB, { fetch: true });
    expect(st.remotes.map((r) => [r.name, r.fetchUrl])).toEqual([
      ["backupDT", backup],
      ["origin", join(home, "remote.git")],
    ]);
    expect(st.defaultRemote).toBe("origin");
    expect(st.remotes.find((r) => r.name === "backupDT")!.ref).toBeUndefined(); // empty remote, no branch yet

    writeFileSync(join(b, "Tasks", "TASK-05-v.md"), "# five\n");
    const r = await commitAndPushPlans(wsB, "Tasks: five to backup", "backupDT");
    expect(r).toMatchObject({ remote: "backupDT", committed: 1, pushed: true });
    expect(g(home, "--git-dir", backup, "log", "-1", "--format=%s", "main")).toBe("Tasks: five to backup");
    // origin did not get it
    const after = await plansGitStatus(wsB, { fetch: true });
    expect(after.remotes.find((x) => x.name === "origin")).toMatchObject({ ahead: 1 });
    expect(after.remotes.find((x) => x.name === "backupDT")).toMatchObject({ ahead: 0, behind: 0 });

    await expect(pullPlans(wsB, "nope")).rejects.toThrow(/no remote named 'nope'/);
    expect((await pullPlans(wsB, "backupDT")).pulled).toBe(0);
  });
});
