import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { expandTilde } from "../../core/config/config.js";
import { git, isRepo, isDirty, remotes, aheadBehind, worktreeList } from "../../resources/git/git.js";
import { parseTargetRef } from "../../core/address/refs.js";
import type { Claim } from "../../core/model/claim.js";
import { repoForResource, worktreePath } from "../effects/effects.js";
import type { WorkspaceRuntime } from "../server/context.js";

/**
 * Code sync between the human's machines (home ↔ work). The plans repo
 * carries claims and status; this carries the code those claims produced:
 * every git resource's base branch (accepted merges land there) and its
 * `te/<ID>-*` work branches (in-progress and in-review work), so a task
 * released on one machine resumes on the other from the same commits.
 *
 * Human-triggered only (`te sync`, the UI's Sync) — agents never push.
 * Fast-forward only: a diverged branch or a dirty checkout is reported,
 * never merged or overwritten.
 */

export interface CodeSyncReport {
  resource: string;
  repo?: string;
  remote?: string;
  /** what happened: "pushed te/GL-0012-swift", "pulled main (+3)" */
  done: string[];
  /** what needs the human: diverged branches, dirty checkouts, offline */
  problems: string[];
}

const ITEM_OF = /^te\/([A-Za-z][A-Za-z0-9]*-\d+)(?:-|$)/;

/** The item a `te/<ID>-…` branch belongs to. */
export function itemOfBranch(branch: string): string | undefined {
  return ITEM_OF.exec(branch)?.[1];
}

async function refs(repo: string, prefix: string): Promise<string[]> {
  return (await git(repo, ["for-each-ref", "--format=%(refname)", prefix]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function hasRef(repo: string, ref: string): Promise<boolean> {
  return git(repo, ["rev-parse", "--verify", "-q", ref]).then(
    () => true,
    () => false,
  );
}

/**
 * The remote a repo syncs through. `allowed` (workspace `sync_remotes`) is a
 * strict allow-list in preference order — a repo with none of them is not
 * synced at all, so a public `upstream` is never pushed by accident. Without
 * it: base's upstream, else origin, else the only remote.
 */
async function pickRemote(repo: string, base: string, allowed: string[]): Promise<string | undefined> {
  const all = await remotes(repo);
  if (allowed.length) return allowed.find((r) => all.includes(r));
  const up = (await git(repo, ["rev-parse", "--abbrev-ref", `${base}@{upstream}`]).catch(() => "")).trim();
  if (up.includes("/")) return up.slice(0, up.indexOf("/"));
  if (all.includes("origin")) return "origin";
  return all.length === 1 ? all[0] : undefined;
}

/**
 * Submodules whose checked-out commit no remote branch has: pushing the
 * parent would publish a gitlink the other machine can't fetch.
 */
async function unpushedSubmodules(repo: string): Promise<string[]> {
  if (!existsSync(join(repo, ".gitmodules"))) return [];
  const out: string[] = [];
  const status = await git(repo, ["submodule", "status", "--recursive"], { timeoutMs: 30_000 }).catch(() => "");
  for (const line of status.split("\n")) {
    const m = /^([ +U-])([0-9a-f]+) (\S+)/.exec(line);
    if (!m || m[1] === "-") continue; // not initialized here
    const sub = join(repo, m[3]);
    const on = await git(sub, ["branch", "-r", "--contains", "HEAD"]).catch(() => "");
    if (!on.trim()) out.push(m[3]);
  }
  return out;
}

/**
 * Fast-forward local `branch` to `target`. A branch checked out somewhere
 * (the main checkout or a worktree) moves only when that checkout is clean.
 */
async function fastForward(
  repo: string,
  branch: string,
  target: string,
  checkedOut: Map<string, string>,
): Promise<string | undefined> {
  const at = checkedOut.get(branch);
  if (at) {
    if (await isDirty(at, false)) return `${branch}: behind, but its checkout ${at} has uncommitted changes — commit or stash, then sync again`;
    await git(at, ["merge", "--ff-only", "-q", target], { timeoutMs: 60_000 });
    return undefined;
  }
  await git(repo, ["update-ref", `refs/heads/${branch}`, target]);
  return undefined;
}

interface SyncTarget {
  name: string;
  repo?: string;
  /** branch accepted work lands on; undefined = the checked-out branch */
  base?: string;
}

/** Git resources, then the `repos:` list (paths / `dir/*` globs from the root). */
async function syncTargets(wsr: WorkspaceRuntime, home?: string): Promise<SyncTarget[]> {
  const ws = wsr.ws;
  const out: SyncTarget[] = [];
  const seen = new Set<string>();
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  for (const [name, r] of ws.resources) {
    if (r.config.kind !== "git") continue;
    const repo = await repoForResource(ws, name, home || undefined).catch(() => undefined);
    if (repo) seen.add(real(repo));
    out.push({ name, repo, base: r.config.base ?? "main" });
  }
  // the plans repo syncs on its own (it may be the task folder's repo)
  const plansTop = (await git(ws.plansDir, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (plansTop) seen.add(real(plansTop));
  for (const pat of ws.config.repos ?? []) {
    const abs = resolve(ws.root, expandTilde(pat, home || undefined));
    const dirs = abs.endsWith(`${sep}*`)
      ? readdirSync(dirname(abs), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(dirname(abs), d.name))
          .filter((d) => existsSync(join(d, ".git")))
      : [abs];
    for (const d of dirs.sort()) {
      if (seen.has(real(d))) continue;
      seen.add(real(d));
      out.push({ name: basename(d), repo: d });
    }
  }
  return out;
}

export interface CodeSyncOpts {
  pull?: boolean;
  push?: boolean;
  home?: string;
  fetchTimeoutMs?: number;
  /** fetch and report only: no pull, push or prune */
  dryRun?: boolean;
}

/** Sync every git resource of the workspace; one report per resource. */
export async function syncCode(wsr: WorkspaceRuntime, opts: CodeSyncOpts = {}): Promise<CodeSyncReport[]> {
  const pull = opts.pull ?? true;
  const pushWanted = opts.push ?? true;
  const dry = opts.dryRun ?? false;
  const w = dry ? "[dry run] " : "";
  const statusOf = (id: string) => wsr.store.idx.items.get(id)?.meta.status;
  /** work still open: its branch must travel. Done/dropped/untracked work stays put. */
  const open = (b: string) => {
    const id = itemOfBranch(b);
    const s = id ? statusOf(id) : undefined;
    return s !== undefined && s !== "done" && s !== "dropped";
  };
  const out: CodeSyncReport[] = [];

  for (const t of await syncTargets(wsr, opts.home)) {
    const rep: CodeSyncReport = { resource: t.name, done: [], problems: [] };
    out.push(rep);
    const repo = t.repo;
    if (!repo || !(await isRepo(repo))) {
      rep.problems.push("repository not found on this machine (check the resource path or its per-machine override)");
      continue;
    }
    rep.repo = repo;
    // a plain repo syncs whatever branch is checked out
    const base = t.base ?? (await git(repo, ["branch", "--show-current"]).catch(() => "")).trim();
    if (!base) {
      rep.problems.push("detached HEAD — check out a branch to sync it");
      continue;
    }
    const allowed = wsr.ws.config.sync_remotes ?? [];
    const remote = await pickRemote(repo, base, allowed);
    if (!remote) {
      rep.problems.push(
        allowed.length
          ? `none of sync_remotes (${allowed.join(", ")}) on this repo — not synced`
          : "no git remote — this code stays on this machine (add one: git remote add origin <url>)",
      );
      continue;
    }
    rep.remote = remote;
    try {
      const fetchRefs = (refspecs: string[]) =>
        git(repo, ["fetch", "-q", "--prune", remote, ...refspecs], { timeoutMs: opts.fetchTimeoutMs ?? 60_000 });
      const teRefs = `+refs/heads/te/*:refs/remotes/${remote}/te/*`;
      await fetchRefs([`+refs/heads/${base}:refs/remotes/${remote}/${base}`, teRefs]).catch(async (e: Error) => {
        // a fresh (empty) remote has no base branch yet — the first push creates it
        if (!/couldn't find remote ref/i.test(e.message)) throw e;
        await fetchRefs([teRefs]);
      });
    } catch (e) {
      rep.problems.push(`could not fetch from ${remote} — offline? (${(e as Error).message.split("\n")[0]})`);
      continue;
    }

    /** run a git step and report it — or, dry, only report it */
    const act = async (desc: string, gitArgs: string[]) => {
      if (!dry) await git(repo, gitArgs, { timeoutMs: 90_000, humanPush: gitArgs[0] === "push" });
      rep.done.push(`${w}${desc}`);
    };
    let push = pushWanted;
    if (push) {
      const subs = await unpushedSubmodules(repo);
      if (subs.length) {
        push = false;
        rep.problems.push(`not pushed: submodule ${subs.join(", ")} has commits no remote has — push the submodule first, then sync again`);
      }
    }
    const checkedOut = new Map<string, string>();
    for (const w of await worktreeList(repo)) if (w.branch) checkedOut.set(w.branch, w.path);
    const rBase = `refs/remotes/${remote}/${base}`;
    const remoteBase = await hasRef(repo, rBase);
    const localBase = await hasRef(repo, `refs/heads/${base}`);

    // ---- base branch: accepted work ----
    if (remoteBase && localBase) {
      const ab = await aheadBehind(repo, rBase, `refs/heads/${base}`);
      if (ab.ahead > 0 && ab.behind > 0) {
        rep.problems.push(`${base}: diverged from ${remote} (${ab.ahead} local, ${ab.behind} remote) — merge or rebase it yourself`);
      } else if (ab.behind > 0 && pull) {
        const p = dry ? undefined : await fastForward(repo, base, rBase, checkedOut);
        if (p) rep.problems.push(p);
        else rep.done.push(`${w}pulled ${base} (+${ab.behind})`);
      } else if (ab.ahead > 0 && push) {
        await act(`pushed ${base} (+${ab.ahead})`, ["push", "-q", remote, `refs/heads/${base}:refs/heads/${base}`]);
      }
    } else if (localBase && push) {
      await act(`pushed ${base} (new on ${remote})`, ["push", "-q", remote, `refs/heads/${base}:refs/heads/${base}`]);
    } else if (remoteBase && pull) {
      await act(`pulled ${base} (new here)`, ["branch", "-q", base, rBase]);
    }

    // a plain repo is worked in place — say what can't travel
    if (!t.base && (await isDirty(repo, false))) {
      rep.problems.push(`uncommitted changes on ${base} stay on this machine — commit them, then sync again`);
    }

    // ---- te/* work branches: open work travels, finished work is pruned ----
    const local = new Set((await refs(repo, "refs/heads/te/")).map((s) => s.slice("refs/heads/".length)));
    const remotePrefix = `refs/remotes/${remote}/`;
    const theirs = new Set((await refs(repo, `${remotePrefix}te/`)).map((s) => s.slice(remotePrefix.length)));

    for (const b of [...new Set([...local, ...theirs])].sort()) {
      const rRef = `${remotePrefix}${b}`;
      if (!open(b)) {
        // finished work: drop the remote copy once the base holds it
        if (push && theirs.has(b) && remoteBase && (await git(repo, ["merge-base", "--is-ancestor", rRef, rBase]).then(() => true, () => false))) {
          await act(`pruned ${b} on ${remote} (merged)`, ["push", "-q", remote, "--delete", b]).catch(() => {});
        }
        continue;
      }
      if (local.has(b) && theirs.has(b)) {
        const ab = await aheadBehind(repo, rRef, `refs/heads/${b}`);
        if (ab.ahead > 0 && ab.behind > 0) {
          rep.problems.push(`${b}: diverged from ${remote} (${ab.ahead} local, ${ab.behind} remote) — the task was worked on both machines; merge it yourself`);
        } else if (ab.behind > 0 && pull) {
          const p = dry ? undefined : await fastForward(repo, b, rRef, checkedOut);
          if (p) rep.problems.push(p);
          else rep.done.push(`${w}pulled ${b} (+${ab.behind})`);
        } else if (ab.ahead > 0 && push) {
          await act(`pushed ${b} (+${ab.ahead})`, ["push", "-q", remote, `refs/heads/${b}:refs/heads/${b}`]);
        }
      } else if (local.has(b) && push) {
        await act(`pushed ${b} (new on ${remote})`, ["push", "-q", remote, `refs/heads/${b}:refs/heads/${b}`]);
      } else if (theirs.has(b) && pull) {
        await act(`pulled ${b} (new here)`, ["branch", "-q", b, rRef]);
      }
      // uncommitted work in a live worktree can't travel — say so
      const at = checkedOut.get(b);
      if (at && (await isDirty(at))) {
        rep.problems.push(`${b}: uncommitted changes in ${at} stay on this machine — use te sync --leave to commit them before you go`);
      }
    }
  }
  return out;
}

/**
 * Commit whatever is uncommitted in a claim's worktrees onto its branch, so
 * the branch can travel. Returns the branches that got a WIP commit.
 */
export async function commitWip(wsr: WorkspaceRuntime, claim: Claim): Promise<string[]> {
  const out: string[] = [];
  for (const t of claim.targets) {
    const { resource } = parseTargetRef(t);
    const r = wsr.ws.resources.get(resource);
    if (!r || r.config.kind !== "git" || r.config.worktree === false) continue;
    const wt = worktreePath(wsr.ws, claim.item, resource);
    if (!existsSync(wt) || !(await isDirty(wt))) continue;
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "--no-verify", "-m", `te: WIP ${claim.item} (te sync --leave)`]);
    out.push(`${claim.item}:${resource}`);
  }
  return out;
}
