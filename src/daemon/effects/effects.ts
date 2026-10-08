import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, readdir } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseTargetRef } from "../../core/address/refs.js";
import type { Claim } from "../../core/model/claim.js";
import type { LoadedWorkspace } from "../../core/config/config.js";
import { TeError } from "../../core/model/errors.js";
import {
  git,
  isRepo,
  isDirty,
  worktreeAdd,
  worktreeRemove,
  mergeNoFF,
  mergeAbort,
} from "../../resources/git/git.js";

const execFileP = promisify(execFile);

/**
 * Resource effects executor (RS-0002/3/5/6/7): runs the external effects the
 * state machine emits — worktrees on claim, snapshots for ssh/folder targets,
 * auto-merge + worktree cleanup on accept/release. Everything is local git /
 * rsync subprocesses; nothing ever pushes (principle 7).
 */

/** `te/WS-0001-claude-test-aa01` — branch-safe claim branch name. */
export function claimBranch(itemId: string, holder: string): string {
  const slug = holder.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 40);
  return `te/${itemId}-${slug}`;
}

/** Deterministic worktree path — machine-local, gitignored. */
export function worktreePath(ws: LoadedWorkspace, itemId: string, res: string): string {
  return join(ws.plansDir, "worktrees", itemId, res);
}

function snapshotsRoot(home?: string): string {
  const base = home ?? process.env.HOME ?? "";
  return join(base, ".teamengage", "snapshots");
}

function clonesRoot(home?: string): string {
  const base = home ?? process.env.HOME ?? "";
  return join(base, ".teamengage", "clones");
}

/** Local repo path backing a git resource (local path, or managed clone of a url). */
export async function repoForResource(
  ws: LoadedWorkspace,
  res: string,
  home?: string,
): Promise<string | undefined> {
  const r = ws.resources.get(res);
  if (!r || r.config.kind !== "git") return undefined;
  if (r.config.url) {
    // managed clone (RS-0005): ~/.teamengage/clones/<ws>/<res>
    const dir = join(clonesRoot(home), ws.name, res);
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(dir, { recursive: true });
      await git(dir, ["clone", r.config.url, "."], { timeoutMs: 120_000 });
    }
    return dir;
  }
  return r.path;
}

/**
 * Compute the working path each target resource resolves to BEFORE the claim
 * file is written (RS-0002): worktree path for git, remote path for ssh,
 * snapshot dir for folder/url nothing.
 */
export async function plannedPaths(
  ws: LoadedWorkspace,
  itemId: string,
  targets: string[],
): Promise<Record<string, string>> {
  const paths: Record<string, string> = {};
  for (const t of targets) {
    const { resource } = parseTargetRef(t);
    if (paths[resource]) continue;
    const r = ws.resources.get(resource);
    if (!r) continue;
    switch (r.config.kind) {
      case "git":
        paths[resource] = r.config.worktree === false ? (r.path ?? "") : worktreePath(ws, itemId, resource);
        break;
      case "ssh":
        paths[resource] = `${r.config.host}:${r.config.path}`;
        break;
      case "folder":
        paths[resource] = r.path ?? "";
        break;
      default:
        break; // url: reference only
    }
  }
  return paths;
}

/**
 * Execute `setup_work` after the claim is committed: create worktrees and
 * snapshots at the paths already recorded in the claim.
 */
export async function setupWork(
  ws: LoadedWorkspace,
  itemId: string,
  claim: Claim,
  home?: string,
): Promise<void> {
  for (const t of claim.targets) {
    const { resource } = parseTargetRef(t);
    const r = ws.resources.get(resource);
    if (!r) continue;
    if (r.config.kind === "git" && r.config.worktree !== false) {
      const repo = await repoForResource(ws, resource, home);
      if (!repo || !(await isRepo(repo))) continue;
      const wt = worktreePath(ws, itemId, resource);
      if (existsSync(wt)) continue; // resume after restart
      mkdirSync(join(ws.plansDir, "worktrees", itemId), { recursive: true });
      await worktreeAdd(repo, wt, claimBranch(itemId, claim.holder), r.config.base ?? "main");
    } else if (r.config.kind === "ssh" && r.config.snapshot !== false) {
      const dest = join(snapshotsRoot(home), ws.name, itemId, resource);
      mkdirSync(dest, { recursive: true });
      await rsyncSnapshot(`${r.config.host}:${r.config.path}/`, dest, r.config.exclude);
    } else if (r.config.kind === "folder" && r.config.snapshot && r.path) {
      const dest = join(snapshotsRoot(home), ws.name, itemId, resource);
      mkdirSync(dest, { recursive: true });
      await rsyncSnapshot(`${r.path}/`, dest);
    }
  }
}

/** `cleanup_work`: remove worktrees; delete claim branches unless keepBranches. */
export async function cleanupWork(
  ws: LoadedWorkspace,
  itemId: string,
  claim: Claim,
  opts: { keepBranches?: boolean; home?: string } = {},
): Promise<void> {
  const branch = claimBranch(itemId, claim.holder);
  const seen = new Set<string>();
  for (const t of claim.targets) {
    const { resource } = parseTargetRef(t);
    if (seen.has(resource)) continue;
    seen.add(resource);
    const r = ws.resources.get(resource);
    if (!r || r.config.kind !== "git" || r.config.worktree === false) continue;
    const repo = await repoForResource(ws, resource, opts.home);
    if (!repo || !(await isRepo(repo))) continue;
    const wt = worktreePath(ws, itemId, resource);
    try {
      if (existsSync(wt)) await worktreeRemove(repo, wt, true);
    } catch {
      await rm(wt, { recursive: true, force: true });
      await git(repo, ["worktree", "prune"]).catch(() => {});
    }
    if (!opts.keepBranches) {
      await git(repo, ["branch", "-D", branch]).catch(() => {});
    }
  }
}

export interface MergeOutcome {
  merged: Array<{ resource: string; repo: string; mergeCommit: string; branch: string }>;
  conflicts: Array<{ resource: string; files: string[] }>;
  dirty: string[];
}

/**
 * `merge_required` (RS-0003): merge each claim branch into its resource's
 * `base` with --no-ff. Refuses on a dirty main checkout; conflict → abort,
 * keep the worktree so the agent can rebase and resubmit.
 */
export async function mergeWork(
  ws: LoadedWorkspace,
  itemId: string,
  claim: Claim,
  home?: string,
): Promise<MergeOutcome> {
  const out: MergeOutcome = { merged: [], conflicts: [], dirty: [] };
  const branch = claimBranch(itemId, claim.holder);
  const seen = new Set<string>();
  for (const t of claim.targets) {
    const { resource } = parseTargetRef(t);
    if (seen.has(resource)) continue;
    seen.add(resource);
    const r = ws.resources.get(resource);
    if (!r || r.config.kind !== "git" || r.config.worktree === false) continue;
    const repo = await repoForResource(ws, resource, home);
    if (!repo || !(await isRepo(repo))) continue;
    const base = r.config.base ?? "main";
    // merge happens on the main checkout — refuse a dirty tree (no stashing)
    if (await isDirty(repo, false)) {
      out.dirty.push(resource);
      continue;
    }
    const cur = (await git(repo, ["branch", "--show-current"])).trim();
    if (cur !== base) {
      // checkout base if needed
      await git(repo, ["checkout", base]);
    }
    const m = await mergeNoFF(repo, branch, `te: ${itemId} merge ${branch}`);
    if (!m.ok) {
      await mergeAbort(repo).catch(() => {});
      out.conflicts.push({ resource, files: m.conflicts });
      continue;
    }
    out.merged.push({ resource, repo, mergeCommit: m.mergeCommit!, branch });
  }
  return out;
}

/** rsync a target into a local snapshot dir (RS-0006/7). */
async function rsyncSnapshot(src: string, dest: string, exclude?: string[]): Promise<void> {
  const args = ["-a", "--delete", ...(exclude ?? []).flatMap((e) => ["--exclude", e]), src, dest];
  try {
    await execFileP("rsync", args, { timeout: 120_000 });
  } catch (e) {
    const err = e as { stderr?: string };
    throw new TeError("INTERNAL", `snapshot failed: ${err.stderr ?? (e as Error).message}`);
  }
}

/** Live path a snapshot-able resource points at (`host:path/` or local dir). */
function liveSource(ws: LoadedWorkspace, res: string): string | undefined {
  const r = ws.resources.get(res);
  if (!r) return undefined;
  if (r.config.kind === "ssh") return `${r.config.host}:${r.config.path}/`;
  if (r.config.kind === "folder" && r.path) return `${r.path}/`;
  return undefined;
}

/**
 * Diff of the live target vs its claim snapshot — evidence for ssh/folder
 * claims (RS-0006/7). rsync dry-run lists files that differ.
 */
export async function snapshotDiff(
  ws: LoadedWorkspace,
  itemId: string,
  resource: string,
  home?: string,
): Promise<string> {
  const dest = join(snapshotsRoot(home), ws.name, itemId, resource);
  const src = liveSource(ws, resource);
  if (!src || !existsSync(dest)) return "";
  try {
    const { stdout } = await execFileP(
      "rsync",
      ["-arn", "--out-format=%n %l", src, dest + "/"],
      { timeout: 60_000 },
    );
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("./") && !l.startsWith("sending"));
    return lines.length
      ? `changed vs snapshot:\n${lines.slice(0, 100).join("\n")}${lines.length > 100 ? `\n… ${lines.length - 100} more` : ""}`
      : "no changes vs snapshot";
  } catch (e) {
    const err = e as { stderr?: string };
    return `diff failed: ${err.stderr?.trim() ?? (e as Error).message}`;
  }
}

/**
 * `te rollback` (RS-0006/7): restore a claim's snapshots back onto the live
 * targets, byte-for-byte (`rsync -a --delete` preserves modes). Returns the
 * resources restored.
 */
export async function rollbackWork(
  ws: LoadedWorkspace,
  itemId: string,
  resources: string[],
  home?: string,
): Promise<string[]> {
  const restored: string[] = [];
  for (const res of resources) {
    const snap = join(snapshotsRoot(home), ws.name, itemId, res);
    const dest = liveSource(ws, res);
    if (!dest || !existsSync(snap)) continue;
    await rsyncSnapshot(`${snap}/`, dest.endsWith("/") ? dest : `${dest}/`);
    restored.push(res);
  }
  return restored;
}

/** Snapshot dirs that exist for an item — used to offer rollback. */
export async function itemSnapshots(
  ws: LoadedWorkspace,
  itemId: string,
  home?: string,
): Promise<string[]> {
  const dir = join(snapshotsRoot(home), ws.name, itemId);
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => existsSync(join(dir, n)));
}
