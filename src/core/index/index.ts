import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { parseItemFile, parseMarkdown } from "../files/markdown.js";
import { parseClaimFile } from "../claims/claims.js";
import { DecisionMeta, type Artifact, type Check, type ItemMeta, type Section, type Status, type Turn, turnOf } from "../model/index.js";
import { parseItemRef, compareIds } from "../address/refs.js";
import type { Claim } from "../model/claim.js";

/** An item plus everything derived from the graph around it (DESIGN §5). */
/**
 * Does a dependency in `status` let its dependents start? done/dropped
 * always; in_review too unless the workspace turns review_unblocks off.
 */
export function depSatisfied(
  status: Status,
  reviewUnblocks: boolean,
  /** the dependency's own unblocks_on, when known (local items) */
  unblocksOn?: "review" | "done",
): boolean {
  if (status === "done" || status === "dropped") return true;
  if (status !== "in_review") return false;
  return unblocksOn ? unblocksOn === "review" : reviewUnblocks;
}

/** Board-style search shared by every page: all words must match. */
export function matchesSearch(meta: ItemMeta, q: string | undefined): boolean {
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [
    meta.id,
    meta.title,
    meta.project,
    meta.legacy_id,
    meta.source,
    ...meta.domains.map((d) => `#${d} ${d}`),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Plan lifecycle of an epic — derived, never stored (see Index.planState). */
export type PlanState = "draft" | "decomposing" | "ready" | "in_progress" | "done" | "dropped";

/**
 * Derived state of a source document (idea or discussion) — never stored.
 * Ideas use draft/ready/done/dropped; discussions use
 * draft/unplanned/planned/in_progress/done/dropped (TE-0156).
 */
export type IdeaState =
  | "draft"
  | "ready"
  | "unplanned"
  | "planned"
  | "in_progress"
  | "done"
  | "dropped";

/**
 * Pure rule: the idea's own status decides draft/dropped/done outright; a
 * triaged idea turns done when every live referrer is done (≥1 referrer),
 * otherwise it is ready — ideas never track in_progress, they are sources.
 */
export function ideaStateOf(status: Status, referrerStatuses: Status[]): IdeaState {
  if (status === "dropped") return "dropped";
  if (status === "draft") return "draft";
  if (status === "done") return "done";
  const live = referrerStatuses.filter((s) => s !== "dropped");
  if (live.length > 0 && live.every((s) => s === "done")) return "done";
  return "ready";
}

/**
 * The discussion's own status decides draft/dropped/done outright. Live
 * referrers (items that name it in `relates`) set the rest: none →
 * unplanned; all done → done; one being worked (in_progress, in_review or
 * waiting) → in_progress; otherwise planned.
 */
export function discussionStateOf(status: Status, referrerStatuses: Status[]): IdeaState {
  if (status === "dropped") return "dropped";
  if (status === "draft") return "draft";
  if (status === "done") return "done";
  const live = referrerStatuses.filter((s) => s !== "dropped");
  if (!live.length) return "unplanned";
  if (live.every((s) => s === "done")) return "done";
  if (live.some((s) => s === "in_progress" || s === "in_review" || s === "waiting"))
    return "in_progress";
  return "planned";
}

/** A problem item: type bug, or any item carrying the bug domain. */
export function isProblemItem(meta: ItemMeta): boolean {
  return meta.type === "bug" || (meta.domains ?? []).includes("bug");
}

export interface IndexedItem {
  meta: ItemMeta;
  sections: Section[];
  /** `## Artifacts` lines parsed at index time (domains already resolved) */
  artifacts: Artifact[];
  /** `## Checks` entries parsed at index time (GL-0348) — overlay items carry [] and read their task file on demand */
  checks: Check[];
  path: string;
  claim?: Claim;
  /** derived: any depends_on item (this workspace) not done */
  blocked: boolean;
  /** derived: an ancestor plan is on hold — parts keep their status but are never claimable */
  paused: boolean;
  /** the nearest held ancestor's id, when paused */
  paused_by?: string;
  /** derived: an ancestor plan is not ready (still decomposing) — parts can't start until the human closes it */
  unready: boolean;
  /** the nearest not-ready ancestor plan's id, when gated */
  unready_by?: string;
  /** derived: reverse of depends_on */
  blocks: string[];
  /** derived: items whose parent is this id */
  children: string[];
  /** status ready ∧ not blocked ∧ not claimed */
  ready: boolean;
  turn: Turn;
  /** epics only: derived plan lifecycle (undefined on non-epics) */
  plan_state?: PlanState;
  /** epics only: finished/total over all non-epic descendants */
  plan_progress?: { done: number; total: number };
  /** ideas and discussions only: derived state from the items that name it in relates */
  idea_state?: IdeaState;
  /** ideas and discussions only: done/total over the items that name it in relates (dropped not counted) */
  idea_progress?: { done: number; total: number };
  /** ideas and discussions only: ids of the items that name it in relates */
  idea_refs?: string[];
  /** derived: problem items (bug type or bug domain) whose found_by names this item */
  found_here: { id: string; status: Status }[];
  /** epics only: problem items found in this plan or its parts, open vs done */
  plan_problems?: { open: number; done: number };
  /** features only: ids of the plans (epics) that name this feature */
  feature_plans?: string[];
  /** features only: non-epic part ids across those plans (deduped) */
  feature_parts?: string[];
  /** features only: done/total summed over the plans' parts (plan_progress semantics) */
  feature_progress?: { done: number; total: number };
  /** set when the file can't be parsed — index keeps it, validator reports it */
  invalid?: string;
}

export interface QueryFilter {
  status?: Status | Status[];
  type?: string;
  /** source documents only: derived state; other items never match */
  idea_state?: IdeaState;
  project?: string;
  /** items touching this resource name */
  resource?: string;
  /** substring in title or summary */
  text?: string;
  claimed?: boolean;
  staleOnly?: boolean;
  /** items carrying this domain */
  domain?: string;
  /** board-style search: every word must occur in id/title/project/legacy id/file/#domains */
  q?: string;
  /** default false: archived items are hidden; true = only archived; "all" = both */
  archived?: boolean | "all";
  /** the human's watch marker; undefined = don't filter on it */
  starred?: boolean;
}

export class Index {
  items = new Map<string, IndexedItem>();
  decisions = new Map<string, { meta: DecisionMeta; sections: Section[]; path: string }>();
  claims = new Map<string, Claim>();
  /** ids that appeared in more than one file */
  duplicates: string[] = [];
  /** depends_on cycles found while deriving */
  cycles: string[][] = [];
  /** files that failed to parse: path → message */
  invalidFiles = new Map<string, string>();

  /** see workspace.yaml review_unblocks; set by the store from the config */
  reviewUnblocks = true;

  constructor(
    readonly plansDir: string,
    /** resolve a (possibly cross-workspace) dep ref → its status, or undefined if unknown */
    private depStatus: (ref: string) => Status | undefined = () => undefined,
  ) {}

  /** Scan items/, claims/, decisions/ into memory. */
  static async load(
    plansDir: string,
    depStatus?: (ref: string) => Status | undefined,
  ): Promise<Index> {
    const idx = new Index(plansDir, depStatus);
    const itemsDir = join(plansDir, "items");
    if (existsSync(itemsDir)) {
      const files: string[] = [];
      for await (const f of walk(itemsDir, ".md")) files.push(f);
      await Promise.all(
        files.map(async (file) => {
          const text = await readFile(file, "utf8");
          try {
            const doc = parseItemFile(text, file);
            const existing = idx.items.get(doc.meta.id);
            if (
              existing &&
              existing.path !== relative(plansDir, file) &&
              !idx.duplicates.includes(doc.meta.id)
            ) {
              idx.duplicates.push(doc.meta.id);
            }
            idx.items.set(doc.meta.id, {
              meta: doc.meta,
              sections: doc.sections,
              artifacts: doc.artifacts,
              checks: doc.checks,
              path: relative(plansDir, file),
              blocked: false,
              paused: false,
              unready: false,
              blocks: [],
              children: [],
              found_here: [],
              ready: false,
              turn: "agent",
            });
          } catch (e) {
            idx.invalidFiles.set(file, (e as Error).message);
          }
        }),
      );
    }
    const claimsDir = join(plansDir, "claims");
    if (existsSync(claimsDir)) {
      for await (const file of walk(claimsDir, ".yaml")) {
        try {
          const claim = parseClaimFile(await readFile(file, "utf8"), file);
          idx.claims.set(claim.item, claim);
        } catch (e) {
          idx.invalidFiles.set(file, (e as Error).message);
        }
      }
    }
    const decDir = join(plansDir, "decisions");
    if (existsSync(decDir)) {
      for await (const file of walk(decDir, ".md")) {
        try {
          const doc = parseMarkdown(await readFile(file, "utf8"), DecisionMeta, file);
          idx.decisions.set(doc.meta.id, { ...doc, path: file });
        } catch (e) {
          idx.invalidFiles.set(file, (e as Error).message);
        }
      }
    }
    idx.derive();
    return idx;
  }

  /** Incremental update of one item file (create/modify). */
  async upsertFile(path: string, deferDerive = false): Promise<void> {
    // callers pass absolute or relative paths; entries always store rel
    const abs = isAbsolute(path) ? path : join(this.plansDir, path);
    const rel = relative(this.plansDir, abs);
    const text = await readFile(abs, "utf8");
    this.invalidFiles.delete(abs);
    let doc;
    try {
      doc = parseItemFile(text, abs);
    } catch (e) {
      this.invalidFiles.set(abs, (e as Error).message);
      // keep the previous parsed version if we had one, marked invalid
      const old = [...this.items.values()].find((i) => i.path === rel);
      if (old) old.invalid = (e as Error).message;
      if (!deferDerive) this.derive();
      return;
    }
    const id = doc.meta.id;
    const existing = this.items.get(id);
    if (existing && existing.path !== rel) {
      if (!this.duplicates.includes(id)) this.duplicates.push(id);
    }
    this.items.set(id, {
      meta: doc.meta,
      sections: doc.sections,
      artifacts: doc.artifacts,
      checks: doc.checks,
      path: rel,
      blocked: false,
      paused: false,
      unready: false,
      blocks: [],
      children: [],
      found_here: [],
      ready: false,
      turn: "agent",
    });
    if (!deferDerive) this.derive();
  }

  /** Insert/update or remove a claim and re-derive. */
  setClaim(claim: Claim | null, item?: string): void {
    if (claim) this.claims.set(claim.item, claim);
    else if (item) this.claims.delete(item);
    this.derive();
  }

  /** Remove an item file from the index (delete/rename). */
  removeFile(path: string): void {
    const rel = relative(this.plansDir, path);
    for (const [id, it] of this.items) {
      if (it.path === rel) {
        this.items.delete(id);
        break;
      }
    }
    this.invalidFiles.delete(path);
    this.derive();
  }

  /** Recompute all derived fields. */
  private derive(): void {
    // attach claims
    for (const it of this.items.values()) it.claim = this.claims.get(it.meta.id);
    // blocks (reverse deps) + children
    for (const it of this.items.values()) {
      it.blocks = [];
      it.children = [];
    }
    for (const it of this.items.values()) {
      for (const dep of it.meta.depends_on) {
        let depId: string;
        try {
          depId = parseItemRef(dep).id;
        } catch {
          continue;
        }
        this.items.get(depId)?.blocks.push(it.meta.id);
      }
      if (it.meta.parent) {
        try {
          this.items.get(parseItemRef(it.meta.parent).id)?.children.push(it.meta.id);
        } catch {
          /* bad parent ref → validator finding */
        }
      }
    }
    // cycles (DFS over local dep edges)
    this.cycles = findCycles(
      [...this.items.values()].map((i) => [
        i.meta.id,
        i.meta.depends_on
          .map((d) => {
            try {
              return parseItemRef(d).id;
            } catch {
              return undefined;
            }
          })
          .filter((x): x is string => x !== undefined && this.items.has(x)),
      ]),
    );
    // blocked / ready / turn
    for (const it of this.items.values()) {
      it.blocked = it.meta.depends_on.some((d) => {
        let status: Status | undefined;
        let unblocksOn: "review" | "done" | undefined;
        try {
          const parsed = parseItemRef(d);
          const local = parsed.workspace ? undefined : this.items.get(parsed.id);
          status = local?.meta.status ?? this.depStatus(d);
          unblocksOn = local?.meta.unblocks_on;
        } catch {
          return false; // unparseable ref → validator finding, not a block
        }
        return status !== undefined && !depSatisfied(status, this.reviewUnblocks, unblocksOn);
      });
      // held-plan cascade: an ancestor epic on hold pauses the whole subtree —
      // parts keep their status but are never ready for an agent to claim.
      // Same walk: an ancestor plan the human has not closed yet is not ready —
      // its parts can't start until close_plan (a dropped plan's leftovers are
      // exempt: the plan is dead, not decomposing)
      it.paused = false;
      it.paused_by = undefined;
      it.unready = false;
      it.unready_by = undefined;
      for (let p = it.meta.parent, seen = new Set([it.meta.id]); p; ) {
        try {
          const ref = parseItemRef(p);
          if (ref.workspace || seen.has(ref.id)) break; // foreign / cycle — stop
          seen.add(ref.id);
          const anc = this.items.get(ref.id);
          if (!anc) break;
          if (!it.paused && anc.meta.status === "hold") {
            it.paused = true;
            it.paused_by = anc.meta.id;
          }
          if (!it.unready && anc.meta.type === "epic" && anc.meta.plan_closed !== true && anc.meta.status !== "dropped") {
            it.unready = true;
            it.unready_by = anc.meta.id;
          }
          if (it.paused && it.unready) break;
          p = anc.meta.parent;
        } catch {
          break; // unparseable ref → validator finding, not a pause
        }
      }
      it.turn = turnOf(it.meta.status);
      it.ready =
        it.meta.status === "ready" && !it.meta.archived && !it.blocked && !it.claim && !it.paused && !it.unready;
    }
    // plan lifecycle for epics (children are already built above)
    for (const it of this.items.values()) {
      it.plan_state = this.planState(it.meta.id);
      it.plan_progress = this.planProgress(it.meta.id);
    }
    // found_here: reverse of found_by, problem items only
    for (const it of this.items.values()) it.found_here = [];
    for (const it of this.items.values()) {
      if (!isProblemItem(it.meta)) continue;
      for (const ref of it.meta.found_by ?? []) {
        try {
          this.items.get(parseItemRef(ref).id)?.found_here.push({ id: it.meta.id, status: it.meta.status });
        } catch {
          /* bad ref → validator finding */
        }
      }
    }
    for (const it of this.items.values()) it.plan_problems = this.planProblems(it.meta.id);
    // feature roll-up (GL-0331): plans naming the feature, their parts, progress
    for (const it of this.items.values()) {
      if (it.meta.type !== "feature") {
        it.feature_plans = undefined;
        it.feature_parts = undefined;
        it.feature_progress = undefined;
        continue;
      }
      const plans = [...this.items.values()].filter((p) => {
        if (!p.meta.feature || p.meta.archived || p.meta.status === "dropped") return false;
        try {
          return parseItemRef(p.meta.feature).id === it.meta.id;
        } catch {
          return false;
        }
      });
      it.feature_plans = plans.map((p) => p.meta.id);
      const parts = new Set<string>();
      for (const p of plans) for (const d of this.nonEpicDescendants(p.meta.id)) parts.add(d);
      it.feature_parts = [...parts];
      it.feature_progress = {
        done: plans.reduce((n, p) => n + (p.plan_progress?.done ?? 0), 0),
        total: plans.reduce((n, p) => n + (p.plan_progress?.total ?? 0), 0),
      };
    }
    // idea/discussion state: reverse of relates, source documents only —
    // archived referrers count as hidden, the same way they drop out of
    // every list
    const named = new Map<string, { id: string; status: Status }[]>();
    for (const it of this.items.values()) {
      if (it.meta.archived) continue;
      for (const ref of it.meta.relates ?? []) {
        try {
          const p = parseItemRef(ref);
          if (p.workspace || p.id === it.meta.id) continue;
          const l = named.get(p.id) ?? [];
          l.push({ id: it.meta.id, status: it.meta.status });
          named.set(p.id, l);
        } catch {
          /* bad ref → validator finding */
        }
      }
    }
    for (const it of this.items.values()) {
      if (it.meta.type !== "idea" && it.meta.type !== "discussion") {
        it.idea_state = undefined;
        it.idea_progress = undefined;
        it.idea_refs = undefined;
        continue;
      }
      const refs = named.get(it.meta.id) ?? [];
      const statuses = refs.map((r) => r.status);
      it.idea_state =
        it.meta.type === "idea"
          ? ideaStateOf(it.meta.status, statuses)
          : discussionStateOf(it.meta.status, statuses);
      const live = refs.filter((r) => r.status !== "dropped");
      it.idea_progress = { done: live.filter((r) => r.status === "done").length, total: live.length };
      it.idea_refs = refs.map((r) => r.id).sort(compareIds);
    }
  }

  /** Change the review_unblocks rule and re-derive blocked/ready. */
  setReviewUnblocks(on: boolean): void {
    this.reviewUnblocks = on;
    this.derive();
  }

  get(id: string): IndexedItem | undefined {
    return this.items.get(id);
  }

  /**
   * An epic's derived plan lifecycle: `dropped` when the human drops it;
   * `draft` while it has no children; `in_progress` while any part is in
   * flight (the plan belongs to no machine: its parts may run on different
   * ones); `done` when its stored status is done — a hand or auto-done
   * verdict — or when every part is finished and no problem under it is
   * open. Otherwise `decomposing` until the human sets `plan_closed`, then
   * `ready`. In-flight parts beat a stored done: reopening a part drags the
   * plan back to in_progress. Parent cycles count as not done. Archived
   * descendants still count. Undefined for non-epics.
   */
  planState(id: string): PlanState | undefined {
    const it = this.items.get(id);
    if (!it || it.meta.type !== "epic") return undefined;
    // dropped is the human's kill verdict — it wins over whatever the parts say
    if (it.meta.status === "dropped") return "dropped";
    if (it.children.length === 0) return "draft";
    // live work in flight beats a stored done — a reopened part drags the
    // plan back off done. Only a closed plan can be in progress: an unclosed
    // plan with parts in flight shows decomposing (the gate keeps its
    // remaining parts from claiming until the human closes it)
    if (this.planInFlight(id)) return it.meta.plan_closed === true ? "in_progress" : "decomposing";
    if (
      it.meta.status === "done" ||
      (this.planFinished(id, new Set([id])) && (this.planProblems(id)?.open ?? 0) === 0)
    )
      return "done";
    return it.meta.plan_closed === true ? "ready" : "decomposing";
  }

  /** Any non-epic descendant in flight — claimed, waiting or under review. */
  private planInFlight(id: string): boolean {
    for (const cid of this.nonEpicDescendants(id)) {
      const st = this.items.get(cid)?.meta.status;
      if (st === "in_progress" || st === "waiting" || st === "in_review") return true;
    }
    return false;
  }

  /** `{done, total}` over all non-epic descendants; done counts done+dropped. */
  planProgress(id: string): { done: number; total: number } | undefined {
    const it = this.items.get(id);
    if (!it || it.meta.type !== "epic") return undefined;
    let done = 0;
    let total = 0;
    for (const cid of this.nonEpicDescendants(id)) {
      const c = this.items.get(cid);
      if (!c) continue;
      total += 1;
      if (c.meta.status === "done" || c.meta.status === "dropped") done += 1;
    }
    return { done, total };
  }

  /** All non-epic descendants of an item — the parts a plan (or feature) counts. */
  private nonEpicDescendants(id: string): string[] {
    const it = this.items.get(id);
    if (!it) return [];
    const out: string[] = [];
    const visited = new Set([id]);
    const stack = [...it.children];
    for (let cid = stack.pop(); cid !== undefined; cid = stack.pop()) {
      if (visited.has(cid)) continue; // parent cycle — don't loop
      visited.add(cid);
      const c = this.items.get(cid);
      if (!c) continue;
      if (c.meta.type === "epic") stack.push(...c.children);
      else out.push(cid);
    }
    return out;
  }

  /**
   * Epics only: the plan's problem set — problem items found in the plan or
   * any of its parts (found_here), plus problem items that are themselves
   * parts. id → status, each once. Undefined for non-epics.
   */
  private planProblemSet(id: string): Map<string, Status> | undefined {
    const it = this.items.get(id);
    if (!it || it.meta.type !== "epic") return undefined;
    const seen = new Map<string, Status>();
    for (const nid of [id, ...this.descendants(id)]) {
      const n = this.items.get(nid);
      if (!n) continue;
      for (const f of n.found_here) seen.set(f.id, this.items.get(f.id)?.meta.status ?? f.status);
      if (nid !== id && isProblemItem(n.meta)) seen.set(nid, n.meta.status);
    }
    return seen;
  }

  /**
   * Epics only: problem items found in the plan or any of its parts
   * (found_here), plus problem items that are themselves parts. Each counted
   * once. `open` is any status except done/dropped; dropped counts in neither.
   */
  planProblems(id: string): { open: number; done: number } | undefined {
    const seen = this.planProblemSet(id);
    if (!seen) return undefined;
    let open = 0;
    let done = 0;
    for (const st of seen.values()) {
      if (st === "done") done += 1;
      else if (st !== "dropped") open += 1;
    }
    return { open, done };
  }

  /**
   * Epics only: the problems planProblems counts, as {id, title, status} rows
   * for the UI's expandable list — open first, dropped left out.
   */
  planProblemItems(id: string): { id: string; title: string; status: Status }[] {
    const seen = this.planProblemSet(id);
    if (!seen) return [];
    return [...seen.entries()]
      .filter(([, st]) => st !== "dropped")
      .map(([pid, st]) => ({ id: pid, title: this.items.get(pid)?.meta.title ?? pid, status: st }))
      .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || compareIds(a.id, b.id));
  }

  /** All descendant ids — children recursively; a parent cycle just stops, never loops. */
  descendants(id: string): string[] {
    const seen = new Set([id]);
    const out: string[] = [];
    const stack = [...(this.items.get(id)?.children ?? [])];
    for (let cid = stack.pop(); cid !== undefined; cid = stack.pop()) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      out.push(cid);
      stack.push(...(this.items.get(cid)?.children ?? []));
    }
    return out;
  }

  /**
   * Every descendant finished — non-epics done, epics recursively finished
   * or themselves marked done (a hand or auto-done verdict counts); a
   * dropped part or sub-plan always counts (its subtree is skipped).
   * A revisited id means a parent cycle → not done.
   */
  private planFinished(id: string, visited: Set<string>): boolean {
    const children = this.items.get(id)?.children ?? [];
    // a childless, non-dropped epic is not finished - the empty loop
    // would let a parent auto-complete over an empty sub-plan
    if (children.length === 0) return false;
    for (const cid of children) {
      if (visited.has(cid)) return false;
      visited.add(cid);
      const c = this.items.get(cid);
      if (!c) continue;
      if (c.meta.status === "dropped") continue;
      const finished =
        c.meta.type === "epic"
          ? c.meta.status === "done" || this.planFinished(cid, visited)
          : c.meta.status === "done";
      if (!finished) return false;
    }
    return true;
  }

  /** Ready items, best first: priority asc, then oldest created. */
  readyItems(limit = Infinity): IndexedItem[] {
    return [...this.items.values()]
      .filter((i) => i.ready)
      .sort(
        (a, b) =>
          a.meta.priority - b.meta.priority ||
          (a.meta.created ?? "").localeCompare(b.meta.created ?? "") ||
          compareIds(a.meta.id, b.meta.id),
      )
      .slice(0, limit);
  }

  query(f: QueryFilter): IndexedItem[] {
    const statuses = f.status === undefined ? undefined : Array.isArray(f.status) ? f.status : [f.status];
    const text = f.text?.toLowerCase();
    // stable, natural id order — the map's order is file-load order
    return [...this.items.values()].sort((a, b) => compareIds(a.meta.id, b.meta.id)).filter((i) => {
      if (f.archived !== "all" && Boolean(i.meta.archived) !== Boolean(f.archived)) return false;
      if (f.starred !== undefined && Boolean(i.meta.star_color) !== f.starred) return false;
      if (statuses && !statuses.includes(i.meta.status)) return false;
      if (f.domain && !i.meta.domains.includes(f.domain)) return false;
      if (!matchesSearch(i.meta, f.q)) return false;
      if (f.type && i.meta.type !== f.type) return false;
      if (f.idea_state && i.idea_state !== f.idea_state) return false;
      if (f.project && i.meta.project !== f.project) return false;
      if (f.claimed !== undefined && Boolean(i.claim) !== f.claimed) return false;
      if (f.resource && !i.meta.targets.some((t) => t.startsWith(`@${f.resource}`))) return false;
      if (text) {
        const hay = (
          i.meta.title +
          "\n" +
          i.sections.map((s) => s.body).join("\n")
        ).toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  }
}

async function* walk(dir: string, ext: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, ext);
    else if (e.name.endsWith(ext)) yield p;
  }
}

function findCycles(edges: Array<[string, string[]]>): string[][] {
  const graph = new Map(edges);
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (n: string) => {
    if (state.get(n) === "done") return;
    if (state.get(n) === "visiting") {
      const i = stack.indexOf(n);
      cycles.push(stack.slice(i).concat(n));
      return;
    }
    state.set(n, "visiting");
    stack.push(n);
    for (const m of graph.get(n) ?? []) visit(m);
    stack.pop();
    state.set(n, "done");
  };
  for (const n of graph.keys()) visit(n);
  return cycles;
}
