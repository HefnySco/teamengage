import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  git,
  isRepo,
  isDirty,
  currentBranch,
  revParse,
  remotes,
  worktreeAdd,
  worktreeList,
  worktreeRemove,
  mergeNoFF,
  mergeAbort,
  commit,
  fetch,
  remoteBranchesContaining,
  aheadBehind,
  showFile,
  GitError,
} from "./git.js";

let dir: string;
let repo: string;

function initRepo(path: string) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: path });
  execFileSync("git", ["config", "user.name", "t"], { cwd: path });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "te-git-"));
  repo = join(dir, "repo");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("git helper", () => {
  it("isRepo / commit / isDirty / currentBranch / revParse", async () => {
    expect(await isRepo(repo)).toBe(true);
    expect(await isDirty(repo)).toBe(true);
    const sha = await commit(repo, "initial");
    expect(await isDirty(repo)).toBe(false);
    expect(await currentBranch(repo)).toBe("main");
    expect(await revParse(repo, "HEAD")).toBe(sha);
  });

  it("refuses push", async () => {
    await expect(git(repo, ["push", "origin", "main"])).rejects.toThrow(/forbidden/);
    await expect(git(repo, ["push"])).rejects.toBeInstanceOf(GitError);
  });

  it("worktree add/list/remove", async () => {
    const wt = join(dir, "wt1");
    await worktreeAdd(repo, wt, "te/GL-0001-test", "main");
    const list = await worktreeList(repo);
    expect(list.some((w) => w.path === wt && w.branch === "te/GL-0001-test")).toBe(true);
    writeFileSync(join(wt, "b.txt"), "work\n");
    await commit(wt, "branch work");
    await worktreeRemove(repo, wt);
    expect((await worktreeList(repo)).some((w) => w.path === wt)).toBe(false);
  });

  it("merge --no-ff clean + conflict paths", async () => {
    // clean merge
    const wt = join(dir, "wt2");
    await worktreeAdd(repo, wt, "te/GL-0002-a", "main");
    writeFileSync(join(wt, "c.txt"), "clean\n");
    await commit(wt, "add c");
    const m1 = await mergeNoFF(repo, "te/GL-0002-a");
    expect(m1.ok).toBe(true);
    expect(m1.mergeCommit).toBeTruthy();

    // conflicting merge
    writeFileSync(join(repo, "a.txt"), "main change\n");
    await commit(repo, "main edits a");
    const wt2 = join(dir, "wt3");
    await worktreeAdd(repo, wt2, "te/GL-0003-b", "HEAD~1");
    writeFileSync(join(wt2, "a.txt"), "branch change\n");
    await commit(wt2, "branch edits a");
    const m2 = await mergeNoFF(repo, "te/GL-0003-b");
    expect(m2.ok).toBe(false);
    expect(m2.conflicts).toContain("a.txt");
    await mergeAbort(repo);
    expect(await isDirty(repo)).toBe(false);
  });

  it("fetch + remoteBranchesContaining + aheadBehind + showFile", async () => {
    // bare "remote" and a clone
    const bare = join(dir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
    // push the remote by hand — the helper's ban applies to the module, not the test
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    await fetch(repo, "origin");
    const head = await revParse(repo, "main");
    expect(await remoteBranchesContaining(repo, head)).toContain("origin/main");
    const ab = await aheadBehind(repo, "origin/main", "main");
    expect(ab).toEqual({ ahead: 0, behind: 0 });
    expect(await remotes(repo)).toContain("origin");
    expect(await showFile(repo, "origin/main", "a.txt")).toBe("main change\n");
  });

  it("times out instead of hanging", async () => {
    // cat-file --batch-check blocks on stdin forever; the timeout must kill it
    await expect(git(repo, ["cat-file", "--batch-check"], { timeoutMs: 200 })).rejects.toThrow(
      /timed out/,
    );
  });
});
