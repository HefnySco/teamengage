import { join } from "node:path";
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
    if (touched.length && (await isRepo(wsr.ws.plansDir))) {
      await git(wsr.ws.plansDir, ["add", "--", ...touched]);
      await git(wsr.ws.plansDir, ["commit", "-m", `te: reconcile marked ${marked.size} conflicted`, "--", ...touched]).catch(() => {});
    }
    return [...marked];
  });
}
