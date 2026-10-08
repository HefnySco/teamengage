import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TeError } from "../../core/model/errors.js";

const execFileP = promisify(execFile);

export class GitError extends TeError {
  constructor(
    message: string,
    readonly repo: string,
    readonly args: string[],
    readonly stderr?: string,
    readonly stdout?: string,
    /** process exit code — e.g. 1 for merge-tree conflicts, 128 for fatal */
    readonly exitCode?: number,
  ) {
    super("GIT", `${message}: ${stderr?.trim() ?? ""}`.trim(), { repo, args, stderr });
  }
}

export interface RunOpts {
  /** Per-call timeout in ms (default 10s; use more for fetch). */
  timeoutMs?: number;
  /** Extra environment. */
  env?: NodeJS.ProcessEnv;
}

const FORBIDDEN = new Set(["push"]);

/**
 * Run `git <args>` in `repo`. Every call has a timeout. `push` is hard-forbidden
 * — TeamEngage never pushes for the human (DESIGN principle 7, decision 6).
 */
export async function git(repo: string, args: string[], opts: RunOpts = {}): Promise<string> {
  if (args.length > 0 && FORBIDDEN.has(args[0])) {
    throw new GitError("git push is forbidden in TeamEngage", repo, args);
  }
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: repo,
      timeout: opts.timeoutMs ?? 10_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    });
    return stdout;
  } catch (e) {
    const err = e as {
      stderr?: string;
      stdout?: string;
      message?: string;
      killed?: boolean;
      code?: number;
    };
    if (err.killed) throw new GitError("git timed out", repo, args);
    throw new GitError(err.message ?? "git failed", repo, args, err.stderr, err.stdout, err.code);
  }
}

export async function isRepo(path: string): Promise<boolean> {
  try {
    const out = await git(path, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** True when the worktree has staged or unstaged changes (untracked counts). */
export async function isDirty(repo: string, includeUntracked = true): Promise<boolean> {
  const args = ["status", "--porcelain"];
  if (!includeUntracked) args.push("--untracked-files=no");
  return (await git(repo, args)).trim().length > 0;
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ["branch", "--show-current"])).trim();
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", ref])).trim();
}

export async function remotes(repo: string): Promise<string[]> {
  const out = (await git(repo, ["remote"])).trim();
  return out === "" ? [] : out.split("\n");
}

/** True when a merge is in progress (MERGE_HEAD exists). */
export async function mergeInProgress(repo: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string;
}

export async function worktreeList(repo: string): Promise<WorktreeEntry[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9) };
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "" && cur.path) {
      entries.push(cur as WorktreeEntry);
      cur = {};
    }
  }
  if (cur.path) entries.push(cur as WorktreeEntry);
  return entries;
}

/** Create `branch` starting at `base` in a new worktree at `path`. */
export async function worktreeAdd(
  repo: string,
  path: string,
  branch: string,
  base: string,
): Promise<void> {
  await git(repo, ["worktree", "add", "-b", branch, path, base]);
}

export async function worktreeRemove(repo: string, path: string, force = false): Promise<void> {
  await git(repo, ["worktree", "remove", path, ...(force ? ["--force"] : [])]);
}

export interface MergeResult {
  ok: boolean;
  /** Conflict file list when ok=false due to conflicts. */
  conflicts: string[];
  mergeCommit?: string;
}

/** `git merge --no-ff <branch>` into the current branch. Detects conflicts. */
export async function mergeNoFF(repo: string, branch: string, message?: string): Promise<MergeResult> {
  const args = ["merge", "--no-ff", "--no-edit"];
  if (message) args.push("-m", message);
  args.push(branch);
  try {
    await git(repo, args);
    return { ok: true, conflicts: [], mergeCommit: await revParse(repo, "HEAD") };
  } catch (e) {
    const conflicts = (await git(repo, ["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .filter(Boolean);
    if (conflicts.length > 0 || (await mergeInProgress(repo))) {
      return { ok: false, conflicts };
    }
    throw e;
  }
}

export async function mergeAbort(repo: string): Promise<void> {
  await git(repo, ["merge", "--abort"]);
}

/** Stage `paths` (or all tracked changes when omitted) and commit. */
export async function commit(repo: string, message: string, paths?: string[]): Promise<string> {
  if (paths && paths.length > 0) {
    await git(repo, ["add", "--", ...paths]);
  } else {
    await git(repo, ["add", "-A"]);
  }
  await git(repo, ["commit", "-m", message]);
  return revParse(repo, "HEAD");
}

/** Read-only fetch. Never changes the working tree or local branches. */
export async function fetch(repo: string, remote?: string, timeoutMs = 30_000): Promise<void> {
  await git(repo, ["fetch", ...(remote ? [remote] : ["--all"])], { timeoutMs });
}

/** Remote-tracking branches containing `commit` (`git branch -r --contains`). */
export async function remoteBranchesContaining(repo: string, commitSha: string): Promise<string[]> {
  try {
    const out = await git(repo, ["branch", "-r", "--contains", commitSha]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.includes("->"));
  } catch {
    return [];
  }
}

/** `git show <ref>:<path>` — read a file from a ref without touching the tree. */
export async function showFile(repo: string, ref: string, path: string): Promise<string> {
  return git(repo, ["show", `${ref}:${path}`]);
}

/** ahead/behind counts vs an upstream ref. */
export async function aheadBehind(
  repo: string,
  upstream: string,
  local = "HEAD",
): Promise<{ ahead: number; behind: number }> {
  const out = await git(repo, ["rev-list", "--left-right", "--count", `${local}...${upstream}`]);
  const [ahead, behind] = out.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}
