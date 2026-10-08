import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseTargetRef } from "../../core/address/refs.js";
import { staticBase, normPath } from "../../core/claims/claims.js";
import type { Claim } from "../../core/model/claim.js";
import type { LoadedWorkspace } from "../../core/config/config.js";
import { TeError } from "../../core/model/errors.js";
import {
  git,
  GitError,
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
): Promise<{ resumed: Array<{ resource: string; branch: string }> }> {
  const resumed: Array<{ resource: string; branch: string }> = [];
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
      const branch = claimBranch(itemId, claim.holder);
      // a branch may survive from a released claim — resume on it. Any
      // holder's branch counts: work released by one agent is continued by
      // the next, not restarted from base.
      let resume = (await git(repo, ["branch", "--list", branch])).trim() ? branch : "";
      if (!resume) {
        resume = (
          await git(repo, [
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            `refs/heads/te/${itemId}-*`,
          ])
        )
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)[0] ?? "";
      }
      if (resume) {
        await git(repo, ["worktree", "add", wt, resume]);
        resumed.push({ resource, branch: resume });
      } else {
        await worktreeAdd(repo, wt, branch, r.config.base ?? "main");
      }
    } else if (r.config.kind === "ssh" && r.config.snapshot !== false) {
      const root = join(snapshotsRoot(home), ws.name, itemId);
      const bases = snapshotBases(claim.targets, resource, r.config.path);
      for (const e of bases) {
        if (e.b) e.missing = !(await existsOn(ws, resource, e.b));
      }
      await writeBases(root, resource, bases);
      for (const e of bases) {
        if (e.missing) continue;
        if (e.file) {
          const dest = join(root, resource, dirname(e.b));
          mkdirSync(dest, { recursive: true });
          await rsyncSnapshot(
            `${r.config.host}:${join(r.config.path, e.b)}`,
            `${dest}/`,
            r.config.exclude,
            r.config.ssh_opts,
            false,
          );
        } else {
          const dest = join(root, resource, e.b);
          mkdirSync(dest, { recursive: true });
          await rsyncSnapshot(
            `${r.config.host}:${join(r.config.path, e.b)}/`,
            dest,
            r.config.exclude,
            r.config.ssh_opts,
          );
        }
      }
    } else if (r.config.kind === "folder" && r.config.snapshot && r.path) {
      const root = join(snapshotsRoot(home), ws.name, itemId);
      const bases = snapshotBases(claim.targets, resource, r.path);
      for (const e of bases) {
        if (e.b) e.missing = !(await existsOn(ws, resource, e.b));
      }
      await writeBases(root, resource, bases);
      for (const e of bases) {
        if (e.missing) continue;
        if (e.file) {
          const dest = join(root, resource, dirname(e.b));
          mkdirSync(dest, { recursive: true });
          await rsyncSnapshot(join(r.path, e.b), `${dest}/`, undefined, undefined, false);
        } else {
          const dest = join(root, resource, e.b);
          mkdirSync(dest, { recursive: true });
          await rsyncSnapshot(`${join(r.path, e.b)}/`, dest);
        }
      }
    }
  }
  return { resumed };
}

/**
 * `cleanup_work`: remove worktrees; delete claim branches unless keepBranches.
 * A dirty worktree is never destroyed — uncommitted work is WIP-committed
 * onto the claim branch first, and that branch is kept regardless.
 */
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
    let keepBranch = opts.keepBranches ?? false;
    if (existsSync(wt) && (await isDirty(wt))) {
      await git(wt, ["add", "-A"]).catch(() => {});
      await git(wt, ["commit", "-q", "-m", `wip: uncommitted work on ${itemId}`]).catch(() => {});
      keepBranch = true;
    }
    try {
      if (existsSync(wt)) await worktreeRemove(repo, wt, true);
    } catch {
      await rm(wt, { recursive: true, force: true });
      await git(repo, ["worktree", "prune"]).catch(() => {});
    }
    if (!keepBranch) {
      await git(repo, ["branch", "-D", branch]).catch(() => {});
    }
  }
}

export interface MergeOutcome {
  merged: Array<{ resource: string; repo: string; mergeCommit: string; branch: string }>;
  conflicts: Array<{ resource: string; files: string[] }>;
  dirty: string[];
}

/** Dry-run merge check via `git merge-tree` — no working-tree changes. */
async function mergeTreeCheck(
  repo: string,
  base: string,
  branch: string,
): Promise<{ ok: boolean; files: string[] }> {
  try {
    await git(repo, ["merge-tree", "--write-tree", "--name-only", base, branch]);
    return { ok: true, files: [] };
  } catch (e) {
    // a conflict exits 1 with the merged tree OID on stdout line 1 and the
    // conflicted paths after it. Other failures (missing ref, corrupt repo)
    // have no OID — those are real errors, not conflicts.
    if (!(e instanceof GitError) || e.exitCode !== 1) throw e;
    const lines = (e.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!/^[0-9a-f]{40,64}$/.test(lines[0] ?? "")) throw e;
    const files = lines.slice(1);
    return { ok: false, files: files.length ? files : ["(conflicted — no file list)"] };
  }
}

/**
 * `merge_required` (RS-0003): merge each claim branch into its resource's
 * `base` with --no-ff — all-or-nothing. Every repo is preflighted with
 * `git merge-tree` first; a conflict or dirty checkout anywhere merges
 * nothing. The user's current branch is restored after each merge.
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
  const jobs: Array<{ resource: string; repo: string; base: string; prev: string }> = [];
  for (const t of claim.targets) {
    const { resource } = parseTargetRef(t);
    if (seen.has(resource)) continue;
    seen.add(resource);
    const r = ws.resources.get(resource);
    if (!r || r.config.kind !== "git" || r.config.worktree === false) continue;
    const repo = await repoForResource(ws, resource, home);
    if (!repo || !(await isRepo(repo))) continue;
    const base = r.config.base ?? "main";
    if (await isDirty(repo, false)) {
      out.dirty.push(resource);
      continue;
    }
    const pre = await mergeTreeCheck(repo, base, branch);
    if (!pre.ok) {
      out.conflicts.push({ resource, files: pre.files });
      continue;
    }
    jobs.push({ resource, repo, base, prev: (await git(repo, ["branch", "--show-current"])).trim() });
  }
  if (out.conflicts.length || out.dirty.length) return out; // atomic: nothing merged
  for (const j of jobs) {
    try {
      if (j.prev !== j.base) await git(j.repo, ["checkout", j.base]);
      const m = await mergeNoFF(j.repo, branch, `te: ${itemId} merge ${branch}`);
      if (!m.ok) {
        await mergeAbort(j.repo).catch(() => {});
        out.conflicts.push({ resource: j.resource, files: m.conflicts });
        continue;
      }
      out.merged.push({ resource: j.resource, repo: j.repo, mergeCommit: m.mergeCommit!, branch });
    } finally {
      if (j.prev && j.prev !== j.base) {
        await git(j.repo, ["checkout", j.prev]).catch(() => {});
      }
    }
  }
  return out;
}

interface SnapshotBase {
  /** path under the resource root ("" = whole resource) */
  b: string;
  /** target was an exact file path, not a subtree */
  file?: boolean;
  /** path didn't exist at claim time — rollback deletes it */
  missing?: boolean;
}

/** Static path prefixes a claim covers for one resource — scopes snapshots/rollback. */
function snapshotBases(targets: string[] | undefined, resource: string, root: string): SnapshotBase[] {
  const bases = new Map<string, SnapshotBase>();
  for (const raw of targets ?? []) {
    const t = parseTargetRef(raw);
    if (t.resource !== resource) continue;
    if (t.pattern === undefined) return [{ b: "" }];
    let pat = t.pattern;
    if (t.absolute) {
      // absolute targets are resolved against the resource root — the same
      // normalization the overlap check uses
      const rr = normPath(root.replace(/\/+$/, ""));
      const abs = normPath(pat);
      if (abs === rr) return [{ b: "" }];
      if (!abs.startsWith(`${rr}/`)) return [{ b: "" }]; // outside root: conservative
      pat = abs.slice(rr.length + 1);
    }
    const base = staticBase({ ...t, pattern: pat });
    if (base === "") return [{ b: "" }];
    bases.set(base, { b: base, file: !/[*?[\]{}]/.test(pat) });
  }
  return bases.size ? [...bases.values()] : [{ b: "" }];
}

/** Record which subtrees were snapshotted — sibling marker so it never restores. */
async function writeBases(dir: string, res: string, bases: SnapshotBase[]): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, `${res}.bases`), JSON.stringify(bases));
}

async function readBases(dir: string, res: string): Promise<SnapshotBase[]> {
  try {
    const raw = JSON.parse(await readFile(join(dir, `${res}.bases`), "utf8")) as unknown[];
    return raw.map((e) => (typeof e === "string" ? { b: e } : (e as SnapshotBase)));
  } catch {
    return [{ b: "" }]; // legacy whole-resource snapshot
  }
}

/** Does `base` exist on a snapshot-able resource? */
async function existsOn(ws: LoadedWorkspace, res: string, base: string): Promise<boolean> {
  const r = ws.resources.get(res);
  if (!r) return false;
  if (r.config.kind === "folder" && r.path) return existsSync(join(r.path, base));
  if (r.config.kind === "ssh") {
    try {
      const p = join(r.config.path, base).replace(/"/g, '\\"');
      await execFileP("ssh", [...(r.config.ssh_opts ?? []), r.config.host, `test -e "${p}"`], {
        timeout: 30_000,
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Delete `base` on the resource — rollback of a path that didn't exist at claim. */
async function deleteOn(ws: LoadedWorkspace, res: string, base: string): Promise<void> {
  const r = ws.resources.get(res);
  if (!r) return;
  if (r.config.kind === "folder" && r.path) {
    await rm(join(r.path, base), { recursive: true, force: true });
  } else if (r.config.kind === "ssh") {
    const p = join(r.config.path, base).replace(/"/g, '\\"');
    await execFileP("ssh", [...(r.config.ssh_opts ?? []), r.config.host, `rm -rf -- "${p}"`], {
      timeout: 60_000,
    });
  }
}

/** Ensure the parent directory of `base` exists on the resource (file restores). */
async function ensureParentOn(ws: LoadedWorkspace, res: string, base: string): Promise<void> {
  const parent = dirname(base);
  if (parent === "." || parent === "") return;
  const r = ws.resources.get(res);
  if (!r) return;
  if (r.config.kind === "folder" && r.path) {
    mkdirSync(join(r.path, parent), { recursive: true });
  } else if (r.config.kind === "ssh") {
    const p = join(r.config.path, parent).replace(/"/g, '\\"');
    await execFileP("ssh", [...(r.config.ssh_opts ?? []), r.config.host, `mkdir -p "${p}"`], {
      timeout: 30_000,
    }).catch(() => {});
  }
}

/** rsync a target into a local snapshot dir (RS-0006/7). */
async function rsyncSnapshot(
  src: string,
  dest: string,
  exclude?: string[],
  sshOpts?: string[],
  /** --delete mirrors a dir; file copies must not delete siblings */
  del = true,
): Promise<void> {
  const args = [
    "-a",
    "--checksum", // quick-check misses same-size same-mtime edits → wrong bytes restored
    ...(del ? ["--delete"] : []),
    ...(exclude ?? []).flatMap((e) => ["--exclude", e]),
    ...(sshOpts?.length ? ["-e", `ssh ${sshOpts.join(" ")}`] : []),
    src,
    dest,
  ];
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
  const root = join(snapshotsRoot(home), ws.name, itemId);
  const dest = join(root, resource);
  const src = liveSource(ws, resource);
  if (!src || !existsSync(dest)) return "";
  const parts: string[] = [];
  const resCfg = ws.resources.get(resource)?.config;
  const sshOpts = resCfg?.kind === "ssh" ? resCfg.ssh_opts : undefined;
  const srcRoot = src.replace(/\/+$/, "");
  for (const e of await readBases(root, resource)) {
    if (e.missing) {
      // didn't exist at claim — noteworthy only if it exists now
      if (await existsOn(ws, resource, e.b)) parts.push(`# ${e.b}\n+ created since claim`);
      continue;
    }
    const src = e.file ? join(srcRoot, e.b) : `${join(srcRoot, e.b)}/`;
    const dst = e.file ? `${join(dest, dirname(e.b))}/` : `${join(dest, e.b)}/`;
    const d = await rsyncDryDiff(src, dst, sshOpts);
    if (d) parts.push(e.b ? `# ${e.b}\n${d}` : d);
  }
  return formatDiff(parts);
}

/** rsync dry-run diff of one subtree; "" when identical or failed silently. */
async function rsyncDryDiff(src: string, dest: string, sshOpts?: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(
      "rsync",
      [
        "-arcn",
        "--out-format=%n %l",
        ...(sshOpts?.length ? ["-e", `ssh ${sshOpts.join(" ")}`] : []),
        src,
        dest,
      ],
      { timeout: 60_000 },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("./") && !l.startsWith("sending"))
      .join("\n");
  } catch (e) {
    const err = e as { stderr?: string };
    return `diff failed: ${err.stderr?.trim() ?? (e as Error).message}`;
  }
}

function formatDiff(parts: string[]): string {
  const body = parts.join("\n").split("\n");
  return parts.length
    ? `changed vs snapshot:\n${body.slice(0, 100).join("\n")}${body.length > 100 ? `\n… ${body.length - 100} more` : ""}`
    : "no changes vs snapshot";
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
  const root = join(snapshotsRoot(home), ws.name, itemId);
  for (const res of resources) {
    const snap = join(root, res);
    const dest = liveSource(ws, res);
    if (!dest) continue;
    const bases = await readBases(root, res);
    // a snap dir that was never written (all targets missing at claim) still
    // has a .bases marker — deletions count as restoration
    if (!existsSync(snap) && !bases.some((b) => b.missing)) continue;
    const rc = ws.resources.get(res)?.config;
    const sshOpts = rc?.kind === "ssh" ? rc.ssh_opts : undefined;
    const destRoot = dest.replace(/\/+$/, "");
    let touched = false;
    for (const e of bases) {
      if (e.missing) {
        await deleteOn(ws, res, e.b);
        touched = true;
        continue;
      }
      if (e.file) {
        await ensureParentOn(ws, res, e.b);
        await rsyncSnapshot(join(snap, e.b), `${join(destRoot, dirname(e.b))}/`, undefined, sshOpts, false);
      } else {
        await rsyncSnapshot(
          `${join(snap, e.b)}/`,
          `${join(destRoot, e.b)}/`,
          rc?.kind === "ssh" ? rc.exclude : undefined,
          sshOpts,
        );
      }
      touched = true;
    }
    if (touched) restored.push(res);
  }
  return restored;
}

/** Delete an item's snapshots — called after a successful accept. */
export async function cleanupSnapshots(
  ws: LoadedWorkspace,
  itemId: string,
  home?: string,
): Promise<void> {
  await rm(join(snapshotsRoot(home), ws.name, itemId), { recursive: true, force: true });
}

/** Snapshot dirs that exist for an item — used to offer rollback. */
export async function itemSnapshots(
  ws: LoadedWorkspace,
  itemId: string,
  home?: string,
): Promise<string[]> {
  const dir = join(snapshotsRoot(home), ws.name, itemId);
  const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return names.filter((e) => e.isDirectory()).map((e) => e.name);
}
