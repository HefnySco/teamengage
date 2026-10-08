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
import { parseClaimFile, claimToYaml, targetsOverlap } from "../../core/claims/claims.js";
import { ClaimRefusedError } from "../../core/model/errors.js";
import type { Claim } from "../../core/model/claim.js";
import type { WorkspaceRuntime } from "../server/context.js";

/**
 * Plans-repo sync (SY-0001/2, RS-0004). TeamEngage pushes nothing (principle
 * 7) — but in `manual` mode a read-only fetch before claim shrinks the
 * double-claim race window, and post-pull reconciliation marks loser claims
 * conflicted rather than letting two agents collide.
 */

/** Best-effort fetch of the plans repo. Returns true when a fetch happened. */
export async function fetchPlansRepo(plansDir: string, timeoutMs = 10_000): Promise<boolean> {
  if (!(await isRepo(plansDir))) return false;
  if ((await remotes(plansDir)).length === 0) return false;
  try {
    await gitFetch(plansDir, undefined, timeoutMs);
    return true;
  } catch {
    return false; // offline — proceed, mark unsynced
  }
}

/** claims/ files at a ref (FETCH_HEAD after fetch). */
export async function remoteClaims(plansDir: string, ref = "FETCH_HEAD"): Promise<Claim[]> {
  let listing: string;
  try {
    listing = await git(plansDir, ["ls-tree", "-r", "--name-only", ref, "claims/"]);
  } catch {
    return [];
  }
  const out: Claim[] = [];
  for (const path of listing.split("\n").filter((p) => p.endsWith(".yaml"))) {
    try {
      out.push(parseClaimFile(await showFile(plansDir, ref, path), `${ref}:${path}`));
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
  for (const rc of remote) {
    if (rc.conflicted) continue;
    if (rc.item === claim.item) {
      throw new ClaimRefusedError(
        `claimed on ${rc.machine} by ${rc.holder} — pull first`,
        rc.holder,
        rc.machine,
      );
    }
    const o = targetsOverlap(claim.targets, rc.targets);
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
  const claims = [...wsr.store.idx.claims.values()].filter((c) => !c.conflicted);
  const marked = new Set<string>();
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      const o = targetsOverlap(a.targets, b.targets);
      if (!o.overlap) continue;
      const [keep, lose] = a.claimed_at <= b.claimed_at ? [a, b] : [b, a];
      if (marked.has(lose.item)) continue;
      marked.add(lose.item);
      const path = join(wsr.ws.plansDir, "claims", `${lose.item}.yaml`);
      await writeFileAtomic(path, claimToYaml({ ...lose, conflicted: true }));
      wsr.store.idx.setClaim({ ...lose, conflicted: true });
      notify?.(
        `claim conflict: ${lose.item} held by ${lose.holder}@${lose.machine} loses to ${keep.holder}@${keep.machine} (earlier claim) — worktree kept`,
      );
    }
  }
  return [...marked];
}
