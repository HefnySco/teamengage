import { join, relative } from "node:path";
import { writeFileAtomic } from "../store/atomic.js";
import {
  git,
  isRepo,
  remotes,
  fetch as gitFetch,
  showFile,
  aheadBehind,
  remoteBranchesContaining,
  revParse,
} from "../../resources/git/git.js";
import { parseClaimFile, claimToYaml, targetsOverlap, resolveDoubleClaim } from "../../core/claims/claims.js";
import { resourceRoots } from "../../core/config/config.js";
import { ClaimRefusedError } from "../../core/model/errors.js";
import type { Claim } from "../../core/model/claim.js";
import type { WorkspaceRuntime } from "../server/context.js";

/**
 * Plans-repo sync (SY-0001/2, RS-0004). TeamEngage pushes nothing (principle
 * 7) — but in `manual` mode a read-only fetch before claim shrinks the
 * double-claim race window, and post-pull reconciliation marks loser claims
 * conflicted rather than letting two agents collide.
 */

/** Current upstream tracking ref (`origin/main`), undefined when unset. */
async function upstreamRef(plansDir: string): Promise<string | undefined> {
  try {
    const u = (
      await git(plansDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    ).trim();
    return u || undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort fetch of the plans repo. Returns true when a fetch happened. */
export async function fetchPlansRepo(plansDir: string, timeoutMs = 10_000): Promise<boolean> {
  if (!(await isRepo(plansDir))) return false;
  if ((await remotes(plansDir)).length === 0) return false;
  try {
    // fetch the upstream branch explicitly so the tracking ref we read next
    // is the branch this machine actually syncs, not whatever FETCH_HEAD
    // happens to point at
    const upstream = await upstreamRef(plansDir);
    if (upstream) {
      const i = upstream.indexOf("/");
      await git(plansDir, ["fetch", upstream.slice(0, i), upstream.slice(i + 1)], { timeoutMs });
    } else {
      await gitFetch(plansDir, undefined, timeoutMs);
    }
    return true;
  } catch {
    return false; // offline — proceed, mark unsynced
  }
}

/** claims/ files at a ref (upstream tracking ref by default, not FETCH_HEAD). */
export async function remoteClaims(plansDir: string, ref?: string): Promise<Claim[]> {
  const at = ref ?? (await upstreamRef(plansDir)) ?? "FETCH_HEAD";
  let listing: string;
  try {
    listing = await git(plansDir, ["ls-tree", "-r", "--name-only", at, "claims/"]);
  } catch {
    return [];
  }
  const out: Claim[] = [];
  for (const path of listing.split("\n").filter((p) => p.endsWith(".yaml"))) {
    try {
      // `./` = relative to the plans dir, which may sit below the repo root
      // (overlay: drone_engage/Tasks/.teamengage); ls-tree printed it that way
      out.push(parseClaimFile(await showFile(plansDir, at, `./${path}`), `${at}:${path}`));
    } catch {
      /* unparseable remote claim — ignore */
    }
  }
  return out;
}

/**
 * fetch-before-claim hook (SY-0001, manual mode). When the plans repo has a
 * reachable remote, fetched claims/ are checked for the same item or
 * overlapping targets; a hit refuses the claim with "pull first" — the local
 * copy is stale by definition. Offline → claim proceeds, marked unsynced.
 * In `auto` mode the pull/push policy replaces this hook entirely.
 */
export async function checkRemoteClaims(wsr: WorkspaceRuntime, claim: Claim): Promise<void> {
  if (wsr.ws.config.sync !== "manual") return;
  const fetched = await fetchPlansRepo(wsr.ws.plansDir);
  if (!fetched) {
    claim.unsynced = true;
    return;
  }
  const remote = await remoteClaims(wsr.ws.plansDir);
  const roots = resourceRoots(wsr.ws);
  for (const rc of remote) {
    if (rc.conflicted) continue;
    // our own released-but-unpushed claim: deleted locally, still on remote —
    // it must not refuse a fresh claim (the deletion just isn't pushed yet)
    if (rc.machine === wsr.store.machine && !wsr.store.idx.claims.has(rc.item)) continue;
    if (rc.item === claim.item) {
      throw new ClaimRefusedError(
        `claimed on ${rc.machine} by ${rc.holder} — pull first`,
        rc.holder,
        rc.machine,
      );
    }
    const o = targetsOverlap(claim.targets, rc.targets, roots);
    if (o.overlap) {
      throw new ClaimRefusedError(
        `target ${o.via?.[0]} claimed on ${rc.machine} by ${rc.holder} — pull first`,
        rc.holder,
        rc.machine,
        o.via?.[0],
      );
    }
  }
}

/**
 * What an agent (or the human) must know before working on this machine
 * (`hello`): is the plans repo behind its upstream, are there plan changes
 * nobody committed yet (`commit: false`), and which items are held on other
 * machines — locally known claims plus, after a best-effort fetch, claims
 * already on the upstream that were not pulled yet.
 */
export interface Handoff {
  /** false when there is no remote or the fetch failed (counts are last-known) */
  fetched: boolean;
  ahead: number;
  behind: number;
  upstream?: string;
  /** uncommitted files under the plans dir */
  uncommitted: number;
  /** claims held by other machines (deduped by item) */
  foreign: Claim[];
}

export async function handoffStatus(wsr: WorkspaceRuntime, opts: { fetchTimeoutMs?: number } = {}): Promise<Handoff> {
  const plansDir = wsr.ws.plansDir;
  const machine = wsr.store.machine;
  const out: Handoff = { fetched: false, ahead: 0, behind: 0, uncommitted: 0, foreign: [] };
  const byItem = new Map<string, Claim>();
  for (const c of wsr.store.idx.claims.values()) if (c.machine !== machine) byItem.set(c.item, c);
  if (await isRepo(plansDir)) {
    out.uncommitted = (await git(plansDir, ["status", "--porcelain", "--untracked-files=all", "--", "."]))
      .split("\n")
      .filter(Boolean).length;
    out.fetched = await fetchPlansRepo(plansDir, opts.fetchTimeoutMs ?? 5_000);
    out.upstream = await upstreamRef(plansDir);
    if (out.upstream) {
      const ab = await aheadBehind(plansDir, out.upstream).catch(() => ({ ahead: 0, behind: 0 }));
      out.ahead = ab.ahead;
      out.behind = ab.behind;
      if (out.behind > 0) {
        for (const c of await remoteClaims(plansDir, out.upstream)) {
          if (c.machine !== machine && !byItem.has(c.item)) byItem.set(c.item, c);
        }
      }
    }
  }
  out.foreign = [...byItem.values()].sort((a, b) => a.item.localeCompare(b.item));
  return out;
}

/** hello's machine-handoff report: only lines that need attention. */
export function handoffLines(h: Handoff): string[] {
  const lines: string[] = [];
  if (h.behind > 0) {
    lines.push(`plans behind ${h.upstream} by ${h.behind} — STOP: ask the human to pull before claiming`);
  }
  if (h.ahead > 0) lines.push(`plans ahead of ${h.upstream} by ${h.ahead} (not pushed)`);
  if (h.uncommitted > 0) {
    lines.push(`plans: ${h.uncommitted} uncommitted file(s) — other machines can't see them until the human commits+pushes`);
  }
  if (h.upstream && !h.fetched) lines.push("plans remote unreachable — sync state is last-known");
  for (const c of h.foreign) {
    lines.push(`held on ${c.machine}: ${c.item} by ${c.holder} since ${c.claimed_at}${c.conflicted ? " (conflicted)" : ""}`);
  }
  return lines;
}

export interface SyncStatus {
  repo: { remote: boolean; ahead: number; behind: number; upstream?: string };
  /** claims made locally since the last plans-repo push. */
  unsyncedClaims: string[];
  /** merges recorded on items that no remote branch contains yet (RS-0004). */
  notPushed: Array<{ item: string; resource: string; merge_commit: string; branch?: string }>;
  /** merges that a remote branch now contains (push detected on fetch). */
  pushed: Array<{ item: string; resource: string; merge_commit: string; remotes: string[] }>;
}

interface Delivery {
  resource: string;
  repo?: string;
  branch?: string;
  merge_commit: string;
  at?: string;
}

export async function syncStatus(wsr: WorkspaceRuntime): Promise<SyncStatus> {
  const plansDir = wsr.ws.plansDir;
  const hasRemote = (await isRepo(plansDir)) && (await remotes(plansDir)).length > 0;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  if (hasRemote) {
    try {
      upstream = (
        await git(plansDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
      ).trim();
      const ab = await aheadBehind(plansDir, upstream);
      ahead = ab.ahead;
      behind = ab.behind;
    } catch {
      upstream = undefined;
    }
  }
  const head = await revParse(plansDir, "HEAD").catch(() => "");
  const unsyncedClaims = [...wsr.store.idx.claims.values()]
    .filter((c) => c.unsynced)
    .map((c) => c.item);

  const notPushed: SyncStatus["notPushed"] = [];
  const pushed: SyncStatus["pushed"] = [];
  for (const it of wsr.store.idx.items.values()) {
    const deliveries = (it.meta as unknown as { deliveries?: Delivery[] }).deliveries;
    for (const d of deliveries ?? []) {
      const repo = d.repo;
      if (!repo || !(await isRepo(repo))) continue;
      const containing = await remoteBranchesContaining(repo, d.merge_commit);
      if (containing.length === 0) {
        notPushed.push({ item: it.meta.id, resource: d.resource, merge_commit: d.merge_commit, branch: d.branch });
      } else {
        pushed.push({ item: it.meta.id, resource: d.resource, merge_commit: d.merge_commit, remotes: containing });
      }
    }
  }
  void head;
  return { repo: { remote: hasRemote, ahead, behind, upstream }, unsyncedClaims, notPushed, pushed };
}

/**
 * Post-pull reconciliation (SY-0002): two machines can claim overlapping
 * targets between syncs. Keep the earlier claimed_at, mark the loser
 * `conflicted` in its claim file (agent told to stop+release on next call,
 * item lands in the human inbox). The loser's worktree is kept.
 * Returns ids newly marked conflicted.
 */
export async function reconcile(
  wsr: WorkspaceRuntime,
  notify?: (msg: string) => void,
): Promise<string[]> {
  // claim-file writes + commit run inside the store's write queue —
  // reconciling outside it can collide with a mutation's git commands
  // (index.lock) or interleave with a release
  return wsr.store.enqueue(async () => {
    const claims = [...wsr.store.idx.claims.values()].filter((c) => !c.conflicted);
    const roots = resourceRoots(wsr.ws);
    const marked = new Set<string>();
    const touched: string[] = [];
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i];
        const b = claims[j];
        const o = targetsOverlap(a.targets, b.targets, roots);
        if (!o.overlap) continue;
        // deterministic on every machine: same rule as resolveDoubleClaim
        const { winner: keep, losers } = resolveDoubleClaim([a, b]);
        const lose = losers[0];
        if (marked.has(lose.item)) continue;
        marked.add(lose.item);
        const rel = join("claims", `${lose.item}.yaml`);
        const path = join(wsr.ws.plansDir, rel);
        const yaml = claimToYaml({ ...lose, conflicted: true });
        await writeFileAtomic(path, yaml);
        wsr.store.onFileWrite?.(path, yaml);
        wsr.store.idx.setClaim({ ...lose, conflicted: true });
        touched.push(rel);
        notify?.(
          `claim conflict: ${lose.item} held by ${lose.holder}@${lose.machine} loses to ${keep.holder}@${keep.machine} (earlier claim) — worktree kept`,
        );
      }
    }
    // claim-file writes are plans mutations too — commit them so they sync
    // (or only stage them when the workspace leaves committing to the human)
    if (touched.length && (await isRepo(wsr.ws.plansDir))) {
      await git(wsr.ws.plansDir, ["add", "--", ...touched]).catch(() => {});
      if (wsr.ws.config.commit) {
        await git(wsr.ws.plansDir, ["commit", "-m", `te: reconcile marked ${marked.size} conflicted`, "--", ...touched]).catch(() => {});
      }
    }
    return [...marked];
  });
}

// ---- human-triggered sync of the plans (task folder) repo -----------------

export interface PlansRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  /** `<remote>/<branch>` tracking ref, when this remote has the branch */
  ref?: string;
  ahead: number;
  behind: number;
  /** fetched in this call (false: not asked, offline, or failed) */
  fetched: boolean;
}

export interface PlansGitStatus {
  repo: string;
  /** the workspace root inside the repo — the only path pull/commit touch */
  scope: string;
  branch?: string;
  /** the branch's configured upstream (`origin/master`), the default choice */
  upstream?: string;
  /** remote of the upstream — what the UI preselects */
  defaultRemote?: string;
  /** every remote (`git remote -v`) with ahead/behind against its copy of the branch */
  remotes: PlansRemote[];
  /** ahead/behind against the upstream (nav badge) */
  ahead: number;
  behind: number;
  /** uncommitted changes inside the scope: porcelain status + path */
  changes: Array<{ status: string; path: string }>;
  /** this machine's name — the UI puts it in the suggested commit message */
  machine: string;
}

async function plansRepoTop(wsr: WorkspaceRuntime): Promise<string> {
  if (!(await isRepo(wsr.ws.plansDir))) throw new ClaimRefusedError("the task folder is not a git repository");
  return (await git(wsr.ws.plansDir, ["rev-parse", "--show-toplevel"])).trim();
}

/** `git remote -v` → [{name, fetchUrl, pushUrl}] */
async function listRemotes(repo: string): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> {
  const out = new Map<string, { name: string; fetchUrl: string; pushUrl: string }>();
  for (const line of (await git(repo, ["remote", "-v"])).split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line);
    if (!m) continue;
    const r = out.get(m[1]) ?? { name: m[1], fetchUrl: "", pushUrl: "" };
    if (m[3] === "fetch") r.fetchUrl = m[2];
    else r.pushUrl = m[2];
    out.set(m[1], r);
  }
  return [...out.values()];
}

/**
 * Status of the task folder: branch, every remote with ahead/behind, and
 * uncommitted changes. `fetch`: true = all remotes, a name = only that one.
 */
export async function plansGitStatus(
  wsr: WorkspaceRuntime,
  opts: { fetch?: boolean | string } = {},
): Promise<PlansGitStatus> {
  const repo = await plansRepoTop(wsr);
  const scope = relative(repo, wsr.ws.root) || ".";
  const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() || undefined;
  const upstream = await upstreamRef(repo);
  const defaultRemote = upstream ? upstream.slice(0, upstream.indexOf("/")) : undefined;
  const remotes: PlansRemote[] = [];
  const listed = await listRemotes(repo);
  // fetch in parallel with a short timeout: one dead remote (an unmounted
  // backup disk, no network) must not stall the page
  const fetchedBy = new Map(
    await Promise.all(
      listed.map(async (r) => {
        const want = branch && (opts.fetch === true || opts.fetch === r.name);
        const ok = want
          ? await git(repo, ["fetch", "-q", r.name, branch!], { timeoutMs: 8_000 }).then(() => true).catch(() => false)
          : false;
        return [r.name, ok] as const;
      }),
    ),
  );
  for (const r of listed) {
    const fetched = fetchedBy.get(r.name) ?? false;
    const ref = branch ? `${r.name}/${branch}` : undefined;
    const exists = ref ? await git(repo, ["rev-parse", "--verify", "-q", `refs/remotes/${ref}`]).then(() => true).catch(() => false) : false;
    const ab = exists && ref ? await aheadBehind(repo, ref).catch(() => ({ ahead: 0, behind: 0 })) : { ahead: 0, behind: 0 };
    remotes.push({ ...r, ref: exists ? ref : undefined, ...ab, fetched });
  }
  const up = remotes.find((r) => r.name === defaultRemote);
  const porcelain = await git(repo, ["status", "--porcelain", "--untracked-files=all", "--", scope]);
  const changes = porcelain
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  return { repo, scope, branch, upstream, defaultRemote, remotes, ahead: up?.ahead ?? 0, behind: up?.behind ?? 0, changes, machine: wsr.store.machine };
}

function pickRemote(st: PlansGitStatus, name?: string): PlansRemote {
  const want = name || st.defaultRemote;
  if (!want) throw new ClaimRefusedError("choose a remote — this branch has no upstream to default to");
  const r = st.remotes.find((x) => x.name === want);
  if (!r) throw new ClaimRefusedError(`no remote named '${want}' (git remote -v)`);
  return r;
}

/**
 * Pull from the chosen remote (default: the upstream's): fetch, then
 * fast-forward only. Diverged history or colliding local edits are refused —
 * those need a human at a terminal, never an automatic merge of the plans.
 */
export async function pullPlans(wsr: WorkspaceRuntime, remote?: string): Promise<{ remote: string; pulled: number; status: PlansGitStatus }> {
  return wsr.store.enqueue(async () => {
    const first = await plansGitStatus(wsr);
    const r0 = pickRemote(first, remote);
    const before = await plansGitStatus(wsr, { fetch: r0.name });
    const r = pickRemote(before, r0.name);
    if (!r.fetched) throw new ClaimRefusedError(`could not fetch from ${r.name} (${r.fetchUrl}) — offline?`);
    if (!r.ref) throw new ClaimRefusedError(`${r.name} has no branch ${before.branch}`);
    if (r.behind === 0) return { remote: r.name, pulled: 0, status: before };
    if (r.ahead > 0) {
      throw new ClaimRefusedError(
        `diverged from ${r.name}: ${r.ahead} local and ${r.behind} remote commit(s) — resolve in a terminal (git pull --rebase ${r.name} ${before.branch} in ${before.repo})`,
      );
    }
    try {
      await git(before.repo, ["merge", "--ff-only", r.ref], { timeoutMs: 60_000 });
    } catch (e) {
      throw new ClaimRefusedError(`pull refused by git (local uncommitted changes collide?): ${(e as Error).message.split("\n")[0]}`);
    }
    await wsr.store.reindex();
    void wsr.overlay?.rescan();
    return { remote: r.name, pulled: r.behind, status: await plansGitStatus(wsr) };
  });
}

/** Commit every change inside the task folder (nothing outside it); returns how many. */
async function commitTaskFolder(wsr: WorkspaceRuntime, st: PlansGitStatus, message: string): Promise<number> {
  if (!st.changes.length) return 0;
  await git(st.repo, ["add", "-A", "--", st.scope]);
  // pathspec: never sweep in staged changes from outside the task folder
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  await git(st.repo, ["commit", "-q", "-m", message.trim() || `Tasks: ${wsr.store.machine} — ${stamp}`, "--", st.scope]);
  return st.changes.length;
}

/** Commit (local only, no push): everything in the task folder. */
export async function commitPlans(wsr: WorkspaceRuntime, message: string): Promise<{ committed: number; status: PlansGitStatus }> {
  return wsr.store.enqueue(async () => {
    const st = await plansGitStatus(wsr);
    const committed = await commitTaskFolder(wsr, st, message);
    return { committed, status: await plansGitStatus(wsr) };
  });
}

/**
 * Commit & Push to the chosen remote (default: the upstream's): commit every
 * change inside the task folder (and nothing outside it), then push the
 * branch to the same branch on that remote. Refused while behind that remote.
 */
export async function commitAndPushPlans(
  wsr: WorkspaceRuntime,
  message: string,
  remote?: string,
): Promise<{ remote: string; committed: number; pushed: boolean; status: PlansGitStatus }> {
  return wsr.store.enqueue(async () => {
    const first = await plansGitStatus(wsr);
    const r0 = pickRemote(first, remote);
    if (!first.branch || first.branch === "HEAD") throw new ClaimRefusedError("the task folder is not on a branch");
    const before = await plansGitStatus(wsr, { fetch: r0.name });
    const r = pickRemote(before, r0.name);
    if (r.ref && r.behind > 0) throw new ClaimRefusedError(`behind ${r.name} by ${r.behind} commit(s) — pull from ${r.name} first`);
    const committed = await commitTaskFolder(wsr, before, message);
    const now = pickRemote(await plansGitStatus(wsr), r.name);
    if (now.ref && now.ahead === 0) return { remote: r.name, committed, pushed: false, status: await plansGitStatus(wsr) };
    try {
      await git(before.repo, ["push", r.name, `HEAD:refs/heads/${before.branch}`], { timeoutMs: 90_000, humanPlansPush: true });
    } catch (e) {
      throw new ClaimRefusedError(`push to ${r.name} failed: ${(e as Error).message.split("\n")[0]}`);
    }
    // refresh our view of that remote's branch
    await git(before.repo, ["fetch", "-q", r.name, before.branch!], { timeoutMs: 20_000 }).catch(() => {});
    return { remote: r.name, committed, pushed: true, status: await plansGitStatus(wsr) };
  });
}
