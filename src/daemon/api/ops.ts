import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveSource, stripFrontmatter } from "../../core/files/source.js";
import {
  normalizeDomain,
  domainColor,
  rankDomains,
  type DomainDef,
} from "../../core/domains/domains.js";
import { parseItemRef, parseTargetRef, allocateId } from "../../core/address/refs.js";
import { targetsOverlap } from "../../core/claims/claims.js";
import { depSatisfied, type IndexedItem } from "../../core/index/index.js";
import { renderMermaid, type MermaidOpts } from "../../core/mermaid/mermaid.js";
import type { Actor } from "../../core/state/machine.js";
import type { Claim } from "../../core/model/claim.js";
import { StarColor, tierRank, type Status } from "../../core/model/item.js";
import { ClaimRefusedError, ForbiddenError, InvalidTransitionError, NotFoundError, TeError, ValidationError } from "../../core/model/errors.js";
import { parseDuration } from "../../core/model/workspace.js";
import { validate, type Finding } from "../../core/validate/validate.js";
import { renumber as doRenumber } from "../../core/address/renumber.js";
import {
  plannedPaths,
  setupWork,
  cleanupWork,
  mergeWork,
  snapshotDiff,
  rollbackWork,
  itemSnapshots,
  cleanupSnapshots,
} from "../effects/effects.js";
import { checkRemoteClaims, fetchPlansRepo } from "../sync/sync.js";
import { resourceRoots } from "../../core/config/config.js";
import type { WorkspaceRuntime } from "../server/context.js";
import type { SessionRegistry } from "../sessions/sessions.js";
import type { Session } from "../../core/model/session.js";
import type { Index } from "../../core/index/index.js";

/**
 * Workspace operations shared by MCP tools (compact text) and the human REST
 * API (JSON). All mutations go through the store's serialized queue.
 */

export interface Links {
  statusOf(ref: string): Status | undefined;
  index(name: string): Index | undefined;
  missing(): string[];
}

export class WorkspaceOps {
  constructor(
    readonly wsr: WorkspaceRuntime,
    private sessions: SessionRegistry,
    private links?: Links,
    /** home dir for machine-local clones/snapshots (~/.teamengage). */
    private home?: string,
  ) {}

  get store() {
    return this.wsr.store;
  }
  get index() {
    return this.wsr.store.idx;
  }

  // ---- sessions ---------------------------------------------------------

  async hello(agent: string, pid?: number, tier?: Session["tier"]): Promise<{ session: Session; resume: Claim[] }> {
    const session = this.sessions.hello(agent, pid, tier);
    // rebind only claims held by DEAD sessions — a second window of the same
    // agent on this machine must not take over a live session's claims.
    // (Dead = transport closed, client process gone, or minted before a
    // daemon restart.)
    const prior = this.sessions
      .resumeClaims(agent, this.index.claims.values())
      .filter((c) => !this.sessions.isLive(c.holder));
    const resume = await this.store.rebindClaims(prior, session.id);
    return { session, resume };
  }

  private actorFor(session: Session | "human"): Actor {
    if (session === "human") {
      return { kind: "human", session: "human", machine: this.wsr.store.machine };
    }
    this.sessions.touch(session.id);
    return { kind: "agent", session: session.id, machine: session.machine, ...(session.tier ? { tier: session.tier } : {}) };
  }

  private depsDone(it: IndexedItem): boolean {
    return it.meta.depends_on.every((ref) => {
      let parsed;
      try {
        parsed = parseItemRef(ref);
      } catch {
        return false;
      }
      const local = parsed.workspace ? undefined : this.index.get(parsed.id);
      const status = local?.meta.status ?? this.links?.statusOf(ref);
      return status !== undefined && depSatisfied(status, this.wsr.ws.config.review_unblocks, local?.meta.unblocks_on);
    });
  }

  // ---- reads ------------------------------------------------------------

  /**
   * `tier`: the asking session's tier — items needing more are left out, and
   * items at exactly that tier come first (a heavy agent isn't handed light work
   * while heavy work waits).
   */
  next(limit = 3, domain?: string, tier?: Session["tier"]): IndexedItem[] {
    const claimedTargets = [...this.index.claims.values()]
      .filter((c) => !c.conflicted)
      .flatMap((c) => c.targets);
    const d = domain ? normalizeDomain(domain) : undefined;
    return this.index
      .readyItems()
      .filter((i) => i.meta.type !== "epic" && i.meta.type !== "idea") // plans and sources — agents claim tasks
      .filter((i) => !d || i.meta.domains.includes(d))
      .filter((i) => !targetsOverlap(i.meta.targets, claimedTargets, resourceRoots(this.wsr.ws)).overlap)
      .filter((i) => !tier || !i.meta.tier || tierRank(i.meta.tier) <= tierRank(tier))
      .map((i, n) => ({ i, n, k: tier && i.meta.tier === tier ? 0 : 1 }))
      .sort((a, b) => a.k - b.k || a.n - b.n)
      .map((x) => x.i)
      .slice(0, limit);
  }

  // ---- domains ------------------------------------------------------------

  /** The vocabulary with item counts (archived items not counted as open). */
  async domains() {
    const defs = await this.store.currentDomains();
    const names = new Set(Object.keys(defs));
    for (const it of this.index.items.values()) for (const d of it.meta.domains) names.add(d);
    return [...names].sort().map((name) => {
      const items = [...this.index.items.values()].filter((i) => i.meta.domains.includes(name));
      return {
        name,
        description: defs[name]?.description,
        keywords: defs[name]?.keywords ?? [],
        color: domainColor(name, defs[name]),
        count: items.filter((i) => !i.meta.archived).length,
        open: items.filter((i) => !i.meta.archived && !["done", "dropped"].includes(i.meta.status)).length,
        archived: items.filter((i) => i.meta.archived).length,
      };
    });
  }

  async setDomains(id: string, domains: string[], actor: Session | "human") {
    this.item(id);
    return this.store.setDomains(id, domains, this.actorFor(actor));
  }

  defineDomain(name: string, patch: DomainDef) {
    return this.store.defineDomain(name, patch);
  }

  renameDomain(from: string, to: string) {
    return this.store.renameDomain(from, to, this.actorFor("human"));
  }

  deleteDomain(name: string) {
    return this.store.deleteDomain(name, this.actorFor("human"));
  }

  /**
   * Keyword-based suggestions: for each non-archived item, domains whose
   * keywords occur in its title / task file / simple text and that it
   * doesn't have yet. Nothing is changed.
   */
  async suggestDomains(): Promise<Array<{ id: string; title: string; current: string[]; add: string[] }>> {
    const defs = await this.store.currentDomains();
    const out: Array<{ id: string; title: string; current: string[]; add: string[] }> = [];
    for (const it of this.index.items.values()) {
      if (it.meta.archived) continue;
      let text = "";
      if (this.wsr.ws.config.mode === "overlay" && it.meta.source) {
        const src = await resolveSource(this.wsr.ws.root, it.meta.id, it.meta.source);
        if (src) text = stripFrontmatter(src.text);
      } else {
        text = it.sections.map((s) => s.body).join("\n");
      }
      const touches = text.match(/^\**touches:?\**:?.*$/im)?.[0] ?? "";
      const body = text.replace(/^#.*$/m, ""); // the title line counts as strong already
      const lead = body.split(/\n\s*\n/).filter((p) => p.trim()).slice(0, 2).join("\n");
      // the file name, not its folder: the folder is the project, already shown
      const fileName = (it.meta.source ?? "").split("/").pop() ?? "";
      const strong = [it.meta.title, it.meta.legacy_id ?? "", fileName, touches].join("\n");
      const add = rankDomains({ strong, lead, body }, defs).filter((d) => !it.meta.domains.includes(d));
      if (add.length) out.push({ id: it.meta.id, title: it.meta.title, current: it.meta.domains, add });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Apply suggestions (only adds — never removes a domain). */
  async applySuggestions(ids?: string[]) {
    const all = await this.suggestDomains();
    const pick = ids ? all.filter((s) => ids.includes(s.id)) : all;
    for (const s of pick) await this.setDomains(s.id, [...s.current, ...s.add], "human");
    return { items: pick.length, added: pick.reduce((n, s) => n + s.add.length, 0) };
  }

  item(id: string): IndexedItem {
    const it = this.index.get(id);
    if (!it) throw new NotFoundError(`item ${id} not found`);
    return it;
  }

  async brief(id: string) {
    const it = this.item(id);
    const source = await this.source(it);
    const sectionBody = (dep: IndexedItem, name: string) =>
      dep.sections.find((s) => s.heading.toLowerCase() === name.toLowerCase())?.body ?? "";
    // archiving/starring is bookkeeping, not an outcome — skip those lines
    const lastLine = (s: string) =>
      s.trim().split("\n").filter((l) => l && !/ (un)?(archived|starred)( \w+)? \(status /.test(l)).at(-1) ?? "";
    const deps = it.meta.depends_on.map((ref) => {
      const parsed = parseItemRef(ref);
      const dep = parsed.workspace ? undefined : this.index.get(parsed.id);
      return {
        ref,
        status: dep?.meta.status ?? this.links?.statusOf(ref) ?? "unknown",
        archived: Boolean(dep?.meta.archived),
        /** satisfied only because review_unblocks: its work may still be rejected */
        pending:
          dep?.meta.status === "in_review" &&
          depSatisfied("in_review", this.wsr.ws.config.review_unblocks, dep.meta.unblocks_on),
        /** a key task: dependents wait for its acceptance */
        key: (dep?.meta.unblocks_on ?? (this.wsr.ws.config.review_unblocks ? "review" : "done")) === "done",
        outcome: dep ? lastLine(sectionBody(dep, "Log")) : "",
        evidence: dep ? lastLine(sectionBody(dep, "Evidence")) : "",
      };
    });
    const decisions = [...this.index.decisions.values()].filter((d) => {
      try {
        const depIds = new Set(it.meta.depends_on.map((r) => parseItemRef(r).id));
        return depIds.has(parseItemRef(d.meta.item).id) || parseItemRef(d.meta.item).id === id;
      } catch {
        return false;
      }
    });
    const targets = it.meta.targets.map((t) => {
      const parsed = parseTargetRef(t);
      const res = this.wsr.ws.resources.get(parsed.resource);
      return {
        ref: t,
        resource: parsed.resource,
        kind: res?.config.kind ?? "unknown",
        path: it.claim?.paths?.[parsed.resource] ?? res?.path,
        host: res?.config.kind === "ssh" ? res.config.host : undefined,
      };
    });
    // reverse edges: the items this one unblocks (it.blocks is derived by the index)
    const dependents = it.blocks.map((ref) => {
      const dep = this.index.get(ref);
      return { ref, status: dep?.meta.status ?? "unknown", archived: Boolean(dep?.meta.archived) };
    });
    // loose references, both ways — e.g. a plan pointing back at the idea(s)
    // it was generated from. Reference only: no ordering, no blocking.
    const relates = it.meta.relates.map((ref) => {
      const parsed = parseItemRef(ref);
      const dep = parsed.workspace ? undefined : this.index.get(parsed.id);
      return { ref, status: dep?.meta.status ?? this.links?.statusOf(ref) ?? "unknown" };
    });
    const wsName = this.wsr.ws.config.name;
    const referenced_by = [...this.index.items.values()]
      .filter(
        (x) =>
          x.meta.id !== id &&
          x.meta.relates.some((r) => {
            try {
              const p = parseItemRef(r);
              return (p.workspace === undefined || p.workspace === wsName) && p.id === id;
            } catch {
              return false;
            }
          }),
      )
      .map((x) => ({ ref: x.meta.id, status: x.meta.status }));
    return { item: it, deps, dependents, decisions, targets, relates, referenced_by, question: it.meta.question, source, reviewUnblocks: this.wsr.ws.config.review_unblocks, autonomy: this.wsr.ws.config.autonomy, autoAcceptAt: this.autoAcceptAt(it) };
  }

  /**
   * Overlay mode: the item's task file (frontmatter stripped), found by its
   * recorded path or, after a rename/move, by its `te:` tag. `missing` when
   * the item records a source that no longer exists anywhere.
   */
  private async source(it: IndexedItem): Promise<
    | { path: string; text: string; moved: boolean; simple?: { path: string; text: string } }
    | { path: string; missing: true }
    | undefined
  > {
    if (this.wsr.ws.config.mode !== "overlay" || !it.meta.source) return undefined;
    const root = this.wsr.ws.root;
    const main = await resolveSource(root, it.meta.id, it.meta.source);
    if (!main) return { path: it.meta.source, missing: true };
    const simple = it.meta.simple_source
      ? await resolveSource(root, it.meta.id, it.meta.simple_source, { simple: true })
      : undefined;
    return {
      path: main.path,
      text: stripFrontmatter(main.text),
      moved: main.moved,
      ...(simple ? { simple: { path: simple.path, text: stripFrontmatter(simple.text) } } : {}),
    };
  }

  query(filter: Parameters<Index["query"]>[0]): IndexedItem[] {
    return this.index.query(filter);
  }

  graph(opts: MermaidOpts): string {
    return renderMermaid(this.index, opts);
  }

  /** All descendant ids of an item (children recursively, parent-cycle safe). */
  descendants(id: string): string[] {
    return this.index.descendants(id);
  }

  findings(): Finding[] {
    return [
      ...validate(this.index, {
        staleAfterMs: parseDuration(this.wsr.ws.config.stale_after),
        roots: resourceRoots(this.wsr.ws),
      }),
      ...(this.wsr.overlay?.findings() ?? []),
    ];
  }

  // ---- agent writes -----------------------------------------------------

  async claim(
    id: string,
    session: Session,
  ): Promise<{ claim: Claim; version: number; resumed: Array<{ resource: string; branch: string }> }> {
    const it = this.item(id);
    if (it.meta.type === "epic") {
      throw new ClaimRefusedError("epics are plans — claim their tasks");
    }
    if (it.meta.type === "idea") {
      throw new ClaimRefusedError("ideas are sources — plan from them");
    }
    const mine = it.claim;
    if (mine) {
      // takeover: an AI-flagged submission (in_review + issues) stays
      // claimed to its machine — another session here may pick the fix up.
      // The state machine makes the final call.
      const takeover =
        it.meta.status === "in_review" &&
        it.meta.ai_review?.verdict === "issues" &&
        mine.machine === session.machine;
      if (!takeover) {
        throw new ClaimRefusedError(
          `already claimed by ${mine.holder} on ${mine.machine} — release on ${mine.machine} or by the human here`,
          mine.holder,
          mine.machine,
        );
      }
    }
    const now = new Date().toISOString();
    const claim: Claim = {
      item: id,
      holder: session.id,
      actor: "agent",
      machine: session.machine,
      targets: it.meta.targets,
      claimed_at: now,
      last_seen: now,
      paths: await plannedPaths(this.wsr.ws, id, it.meta.targets),
      ...(session.tier ? { tier: session.tier } : {}),
    };
    // SY-0001: shrink the double-claim race — fetch plans repo and check
    // remote claims before writing ours (manual sync mode). The local
    // overlap check runs inside the store's write queue via `guard` —
    // checking it here raced with other claims mid-flight.
    await checkRemoteClaims(this.wsr, claim);
    const roots = resourceRoots(this.wsr.ws);
    const r = await this.store.perform(
      id,
      it.meta.version,
      this.actorFor(session),
      { type: "claim", claim },
      {
        depsDone: this.depsDone(it),
        guard: this.overlapGuard(it.meta.targets, roots, id),
      },
    );
    // worktrees/snapshots come after the committed claim; failure → release
    let resumed: Array<{ resource: string; branch: string }> = [];
    try {
      resumed = (await setupWork(this.wsr.ws, id, claim, this.home)).resumed;
    } catch (e) {
      await this.release(id, session, `setup failed: ${(e as Error).message}`).catch(() => {});
      throw e;
    }
    for (const res of resumed) {
      await this.store.annotate(id, {
        heading: "Log",
        lines: [`- resumed prior work on branch ${res.branch} (@${res.resource})`],
      });
    }
    return { claim, version: r.meta.version, resumed };
  }

  /** Overlap check that runs inside the store's serialized write queue. */
  private overlapGuard(targets: string[], roots = resourceRoots(this.wsr.ws), except_item?: string) {
    return () => {
      for (const c of this.index.claims.values()) {
        if (c.conflicted) continue;
        if (c.item === except_item) continue; // an item's own claim can't conflict with it (takeover)
        const o = targetsOverlap(targets, c.targets, roots);
        if (o.overlap) {
          throw new ClaimRefusedError(
            `target ${o.via?.[0]} overlaps claim on ${c.item} held by ${c.holder} on ${c.machine} — release on ${c.machine} or by the human here`,
            c.holder,
            c.machine,
            o.via?.[0],
          );
        }
      }
    };
  }

  async release(id: string, actor: Session | "human", note?: string) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(id, it.meta.version, this.actorFor(actor), {
      type: "release",
      note,
    });
    if (claim) {
      await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
    }
    // refresh our view of other machines' claims — the release itself only
    // reaches them when the human pushes, but a fetch keeps the next claim's
    // remote check current
    if (this.wsr.ws.config.sync === "manual") await fetchPlansRepo(this.wsr.ws.plansDir);
    return r;
  }

  /**
   * The item's claim holder can't act from this daemon: the claim lives on
   * another machine, or its local session is no longer live. Human claims
   * never count — the human acts through any machine's UI.
   */
  private holderAway(it: IndexedItem): boolean {
    const c = it.claim;
    if (!c || c.actor === "human") return false;
    return c.machine !== this.wsr.store.machine || !this.sessions.isLive(c.holder);
  }

  private assertLiveClaim(it: IndexedItem): void {
    if (it.claim?.conflicted) {
      throw new ClaimRefusedError(
        `claim on ${it.meta.id} lost a sync conflict — stop work and release (see inbox)`,
        it.claim.holder,
        it.claim.machine,
      );
    }
  }

  async log(id: string, session: Session, note: string) {
    const it = this.item(id);
    this.assertLiveClaim(it);
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "log",
      note,
    }, {
      // persist last_seen inside the write queue + the same commit
      touchClaim: this.sessions.shouldTouchClaim(id),
    });
  }

  async ask(id: string, session: Session, text: string, options?: string[]) {
    const it = this.item(id);
    this.assertLiveClaim(it);
    const question = {
      text,
      options,
      asked_by: session.id,
      asked_at: new Date().toISOString(),
    };
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "ask",
      question,
    });
  }

  async submit(
    id: string,
    session: Session,
    evidence?: { commits?: string[]; tests?: string; notes?: string },
  ) {
    const it = this.item(id);
    this.assertLiveClaim(it);
    // RS-0006/7: attach the live-vs-snapshot diff for ssh/folder targets
    const diffs: string[] = [];
    const seen = new Set<string>();
    for (const t of it.claim?.targets ?? []) {
      const { resource } = parseTargetRef(t);
      if (seen.has(resource)) continue;
      seen.add(resource);
      const r = this.wsr.ws.resources.get(resource);
      if (!r || (r.config.kind !== "ssh" && r.config.kind !== "folder")) continue;
      const d = await snapshotDiff(this.wsr.ws, id, resource, this.home);
      if (d) diffs.push(`@${resource}: ${d}`);
    }
    const ev = diffs.length
      ? { ...evidence, notes: [evidence?.notes, diffs.join("\n")].filter(Boolean).join("\n") }
      : evidence;
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "submit",
      evidence: ev,
    });
  }

  /**
   * AI peer review of a submission: a second agent session (never the
   * holder) records verdict ok|issues + note. Pure annotation — the item
   * stays `in_review`, the human still accepts. Find submissions with
   * `query status=in_review`.
   */
  async review(
    id: string,
    session: Session,
    verdict: "ok" | "issues",
    note?: string,
    summary?: string,
  ) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(
      id,
      it.meta.version,
      this.actorFor(session),
      { type: "review", verdict, note, summary },
      { holderAway: () => this.holderAway(this.item(id)) },
    );
    // an `issues` verdict on a holder that can't act released the claim
    if (claim && r.meta.status !== "in_review") {
      await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
    }
    return r;
  }

  /**
   * AI bounce: a reviewer session sends a broken submission back to its
   * holder (in_progress, claim kept — like the human's reject, but capped).
   */
  async bounce(id: string, session: Session, reason: string, summary?: string) {
    const it = this.item(id);
    const claim = it.claim;
    return this.store.perform(
      id,
      it.meta.version,
      this.actorFor(session),
      { type: "bounce", reason, summary },
      {
        priorBounces: () => this.aiBouncesSinceHumanTouch(id),
        holderAway: () => this.holderAway(this.item(id)),
      },
    ).then(async (r) => {
      if (claim && r.meta.status !== "in_progress") {
        await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
      }
      return r;
    });
  }

  /**
   * The holder is stuck: record problem / tried / state / next in the task's
   * ## Handoff, release the claim (branches kept) so a fresh session — or a
   * stronger tier after escalate_after attempts — picks it up from the note.
   */
  async handoff(id: string, session: Session, h: { problem: string; tried: string; state?: string; next?: string }) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(id, it.meta.version, this.actorFor(session), { type: "handoff", ...h });
    if (claim) await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
    return r;
  }

  /** A stronger session checks a light-authored draft; under solo an `ok` approves it. */
  async vet(id: string, session: Session, verdict: "ok" | "issues", note?: string) {
    const it = this.item(id);
    const r = await this.store.perform(id, it.meta.version, this.actorFor(session), { type: "vet", verdict, note });
    if (verdict === "ok" && this.wsr.ws.config.autonomy === "solo") {
      await this.store.perform(id, r.meta.version, this.daemonActor(), { type: "approve_plan" });
      await this.store.annotate(id, { heading: "Log", lines: ["- auto-approved after vet ok (autonomy: solo)"] });
      return { ...r, approved: true };
    }
    return { ...r, approved: false };
  }

  /** Human: set or clear the tier an item needs; `reset` zeroes its attempts. */
  async setTier(id: string, tier?: Session["tier"], reset = false) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "set_tier", tier, reset });
  }

  /**
   * Bounces by AI reviewers this item took since anything else happened to
   * it — the holder's fix/submit cycle in between doesn't count, but any
   * human/daemon action or a new claim starts a fresh cycle (loop guard).
   * Best-effort: reads the merged event streams, so a machine behind on
   * pull may miss the most recent bounces from other machines.
   */
  private async aiBouncesSinceHumanTouch(id: string): Promise<number> {
    const { readAllEvents } = await import("../../core/events/log.js");
    const r = await readAllEvents(join(this.wsr.ws.plansDir, "events"));
    let bounces = 0;
    for (const e of [...r.events].reverse()) {
      if (e.item !== id) continue;
      if (e.action === "bounce") {
        bounces++;
        continue;
      }
      // the holder's own line of work between bounces
      if (e.action === "submit" || e.action === "log" || e.action === "review" || e.action === "ask") {
        continue;
      }
      break;
    }
    return bounces;
  }

  /** `te rollback` — restore claim snapshots back onto live targets (RS-0006/7). */
  async rollback(id: string, force = false) {
    const it = this.item(id);
    // a stale snapshot must not silently revert live state long after the fact
    if (it.meta.status === "done" && !force) {
      throw new TeError("INVALID_TRANSITION", `${id} is done — rollback refused (use --force to override)`);
    }
    const claimRes = new Set(
      (it.claim?.targets ?? []).map((t) => parseTargetRef(t).resource),
    );
    const snaps = await itemSnapshots(this.wsr.ws, id, this.home);
    const resources = [...new Set([...claimRes, ...snaps])];
    const restored = await rollbackWork(this.wsr.ws, id, resources, this.home);
    if (!restored.length) {
      throw new NotFoundError(`no snapshots for ${id}`);
    }
    await this.store.annotate(id, {
      heading: "Log",
      lines: [`- rollback: restored snapshot for ${restored.map((r) => `@${r}`).join(", ")}`],
    });
    return { restored };
  }

  async propose(
    drafts: Array<{
      type?: string;
      title: string;
      project?: string;
      targets?: string[];
      depends_on?: string[];
      parent?: string;
      relates?: string[];
      summary?: string;
      acceptance?: string[];
      touches?: string[];
      simple?: string;
      domains?: string[];
      tier?: "light" | "standard" | "heavy";
    }>,
    actor: Session | "human",
  ) {
    void this.actorFor(actor);
    const r = await this.store.createItems(
      drafts.map((d) => ({ type: d.type ?? "task", ...d })),
      this.actorFor(actor),
    );
    // autonomy: solo — an agent's follow-up/fix of known work needs no
    // approve: it lands ready. Epics and free-standing items stay drafts.
    const ready: string[] = [];
    if (this.wsr.ws.config.autonomy === "solo" && actor !== "human") {
      for (const id of r.ids) {
        const it = this.index.items.get(id);
        if (!it || it.meta.type === "epic" || it.meta.type === "idea" || !it.meta.depends_on.length) continue;
        if (it.meta.authored_tier === "light") continue; // a stronger session vets it first
        const known = it.meta.depends_on.every((ref) => {
          try {
            const dep = this.index.items.get(parseItemRef(ref).id);
            return dep !== undefined && dep.meta.status !== "dropped";
          } catch {
            return false;
          }
        });
        if (!known) continue;
        await this.store.perform(id, it.meta.version, this.daemonActor(), { type: "approve_plan" });
        await this.store.annotate(id, { heading: "Log", lines: ["- auto-approved: follow-up task (autonomy: solo)"] });
        ready.push(id);
      }
    }
    return { ...r, ready };
  }

  private daemonActor(): Actor {
    return { kind: "daemon", session: "daemon", machine: this.wsr.store.machine };
  }

  /**
   * autonomy: solo — submissions whose latest peer review is `ok` and older
   * than auto_accept_after are accepted by the daemon (same local merge, never
   * a push). Key tasks, archived items and human claims wait for the human;
   * a resubmit, bounce or `issues` verdict changes ai_review and so resets it.
   */
  autoAcceptDue(now = Date.now()): string[] {
    return [...this.index.items.values()]
      .filter((it) => {
        const at = this.autoAcceptAt(it);
        return at !== undefined && Date.parse(at) <= now;
      })
      .map((it) => it.meta.id);
  }

  /** When the daemon will auto-accept this item (ISO), or undefined if it won't. */
  autoAcceptAt(it: IndexedItem): string | undefined {
    const cfg = this.wsr.ws.config;
    const m = it.meta;
    const rv = m.ai_review;
    if (
      cfg.autonomy !== "solo" ||
      m.status !== "in_review" ||
      rv?.verdict !== "ok" ||
      m.unblocks_on === "done" ||
      m.archived ||
      m.auto_accept_off ||
      (m.tier === "heavy" && rv.reviewer_tier === "light") ||
      it.claim?.actor === "human"
    ) {
      return undefined;
    }
    return new Date(Date.parse(rv.reviewed_at) + parseDuration(cfg.auto_accept_after)).toISOString();
  }

  /** Human: stop auto-accept for the current submission (a resubmit re-arms it). */
  async stopAutoAccept(id: string) {
    this.item(id);
    await this.store.annotate(id, {
      heading: "Log",
      lines: [`- ${new Date().toISOString()} human stopped auto-accept`],
      metaPatch: { auto_accept_off: true },
    });
    return { meta: this.item(id).meta };
  }

  async autoAccept(now = Date.now()) {
    const done: string[] = [];
    for (const id of this.autoAcceptDue(now)) {
      const r = await this.accept(id, "daemon");
      if (!r.bounced?.length) {
        await this.store.annotate(id, { heading: "Log", lines: ["- auto-accepted after ok review (autonomy: solo)"] });
        done.push(id);
      }
    }
    return done;
  }

  // ---- human writes -------------------------------------------------------

  async approve(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "approve_plan",
    });
  }

  async answer(id: string, decisionTitle: string) {
    const it = this.item(id);
    const decisionId = allocateId("D", this.index.decisions.keys());
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "answer",
      decisionId,
      decisionTitle,
    });
  }

  /** Revise the answer already given: the item's latest decision. */
  async changeAnswer(id: string, decisionTitle: string) {
    const it = this.item(id);
    const own = [...this.index.decisions.values()]
      .filter((d) => {
        try {
          return parseItemRef(d.meta.item).id === id;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.meta.id.localeCompare(b.meta.id, undefined, { numeric: true }));
    const last = own[own.length - 1];
    if (!last) {
      throw new InvalidTransitionError(`cannot change_answer: ${id} has no answer yet`, it.meta.status, "change_answer");
    }
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "change_answer",
      decisionId: last.meta.id,
      decisionTitle,
      previous: last.meta.title,
    });
  }

  async accept(id: string, by: "human" | "daemon" = "human"): Promise<{ meta: unknown; merged: unknown[]; bounced?: string[] }> {
    const it = this.item(id);
    // refuse early — never merge work for an item that isn't in_review
    if (it.meta.status !== "in_review") {
      throw new InvalidTransitionError(
        `cannot accept from ${it.meta.status}`,
        it.meta.status,
        "accept",
      );
    }
    const claim = it.claim;
    // RS-0003: merge the claim branch(es) into base BEFORE marking done —
    // a conflict bounces the item back to in_progress while it's still
    // in_review (the state machine's merge_conflict action).
    let merged: Array<{ resource: string; repo: string; mergeCommit: string; branch: string }> = [];
    if (claim) {
      const m = await mergeWork(this.wsr.ws, id, claim, this.home);
      if (m.conflicts.length || m.dirty.length) {
        const why = [
          ...m.conflicts.flatMap((c) => c.files.map((f) => `${c.resource}:${f}`)),
          ...m.dirty.map((d) => `${d} (dirty main checkout)`),
        ];
        const cur = this.item(id);
        await this.store.perform(
          id,
          cur.meta.version,
          { kind: "daemon", session: "daemon", machine: this.wsr.store.machine },
          { type: "merge_conflict", conflicts: why },
        );
        return { meta: cur.meta, merged: [], bounced: why };
      }
      merged = m.merged;
    }
    const r = await this.store.perform(id, it.meta.version, by === "daemon" ? this.daemonActor() : this.actorFor("human"), {
      type: "accept",
    });
    for (const g of merged) {
      await this.store.annotate(id, {
        heading: "Evidence",
        lines: [`- merged ${g.branch} → ${g.mergeCommit.slice(0, 12)} (not pushed)`],
        metaPatch: {
          deliveries: [
            ...(((this.item(id).meta as Record<string, unknown>).deliveries as unknown[]) ?? []),
            {
              resource: g.resource,
              repo: g.repo,
              branch: g.branch,
              merge_commit: g.mergeCommit,
              at: new Date().toISOString(),
            },
          ],
        },
      });
    }
    if (claim) await cleanupWork(this.wsr.ws, id, claim, { home: this.home });
    // snapshots are evidence for review only — expire them once accepted
    await cleanupSnapshots(this.wsr.ws, id, this.home).catch(() => {});
    return { ...r, merged };
  }

  async reject(id: string, reason?: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "reject",
      reason,
    });
  }

  async drop(id: string, reason?: string) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "drop",
      reason,
    });
    if (claim) await cleanupWork(this.wsr.ws, id, claim, { home: this.home });
    return r;
  }

  /** Human: mark done from any status — no review, no merge; branches kept. */
  async complete(id: string, note?: string) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "complete",
      note,
    });
    if (claim) await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
    return r;
  }

  /** Human: park a draft/ready item — agents can't see or claim it. */
  async hold(id: string, reason?: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "hold", reason });
  }

  /** Human: release a hold → ready. */
  async unhold(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "unhold" });
  }

  /** Human: ready/hold/done → draft (needs approval again; reopens a done-by-mistake item). */
  async toDraft(id: string, reason?: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "to_draft", reason });
  }

  /** Human: hide an item (status kept); refused while claimed. */
  async archive(id: string, reason?: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "archive", reason });
  }

  async unarchive(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "unarchive" });
  }

  /** Human: bookmark an item (any status, even claimed — board ★, no workflow effect). */
  async star(id: string, color?: string) {
    const it = this.item(id);
    const parsed = color === undefined ? undefined : StarColor.safeParse(color);
    if (parsed && !parsed.success) {
      throw new TeError("USAGE", `star color must be one of ${StarColor.options.join("|")}`);
    }
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "star", color: parsed?.data });
  }

  async unstar(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "unstar" });
  }

  /** Human: remove an item from tracking (task file stays, untagged). */
  async deleteItem(id: string, reason?: string) {
    this.item(id);
    return this.store.deleteItem(id, this.actorFor("human"), reason);
  }

  /** Agent or human: write the plain-English version (no claim needed — it touches no code). */
  async simple(id: string, actor: Session | "human", text: string) {
    this.item(id);
    return this.store.setSimple(id, text, this.actorFor(actor));
  }

  /** Add a multi-line note to the item (task file `## Notes`). */
  async note(id: string, actor: Session | "human", text: string) {
    this.item(id);
    return this.store.addNote(id, text, this.actorFor(actor));
  }

  /**
   * Correct a wrong `## Evidence` line without rewriting it: appends a
   * `supersedes` entry naming the old line, the correct value and the
   * reason — the old line stays visible. Append-only; any session may
   * correct the record (the reviewer who spots it is rarely the holder).
   */
  async supersede(
    id: string,
    actor: Session | "human",
    s: { line: string; correct: string; reason?: string },
  ) {
    this.item(id);
    const line = s.line.trim();
    const correct = s.correct.trim();
    if (!line || !correct) throw new ValidationError("supersede needs {line, correct[, reason]}");
    const who = actor === "human" ? "human" : actor.id;
    const now = new Date().toISOString();
    return this.store.annotate(id, {
      heading: "Evidence",
      lines: [
        `- supersedes "${line}" → ${correct}${s.reason?.trim() ? ` — ${s.reason.trim()}` : ""} (${who}, ${now.slice(0, 16).replace("T", " ")})`,
      ],
      log: [`- ${now} ${who} superseded an Evidence line`],
    });
  }

  /** Agent asks the human to drop this item — advisory flag, status untouched. */
  async flagDrop(id: string, session: Session, reason?: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "flag_drop",
      reason,
    });
  }

  /** Human dismisses a drop flag — the item stays. */
  async unflagDrop(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "unflag_drop",
    });
  }

  /**
   * Change a draft's scope (Touches line, extra acceptance). Only drafts: a
   * human moving an item back to draft is the go-ahead to rescope it. Agents
   * need a tier above light (the dispatcher doesn't plan); it stays a draft —
   * the human approves the new scope.
   */
  async rescope(
    id: string,
    actor: Session | "human",
    change: { touches?: string[]; addAcceptance?: string[]; reason: string },
  ) {
    this.item(id);
    if (actor !== "human" && actor.tier === "light") {
      throw new ForbiddenError("rescope needs a standard- or heavy-tier session (planner), not light");
    }
    if (!change.touches && !change.addAcceptance?.length) {
      throw new ValidationError("rescope: give touches and/or add_acceptance");
    }
    return this.store.rescope(id, change, this.actorFor(actor));
  }

  /**
   * Rewrite a draft — any field of it. Drafts only (a non-draft must be
   * moved back to draft by the human first); agents need a planner tier.
   * depends_on/parent refs are checked here (existence, self, cycles incl.
   * linked workspaces); the store writes and logs. It stays a draft.
   */
  async editDraft(
    id: string,
    actor: Session | "human",
    change: {
      reason: string;
      title?: string;
      summary?: string;
      acceptance?: string[];
      touches?: string[];
      depends_on?: string[];
      parent?: string | null;
      relates?: string[];
      targets?: string[];
      tier?: "light" | "standard" | "heavy" | null;
      domains?: string[];
      sections?: Record<string, string>;
    },
  ) {
    this.item(id);
    if (actor !== "human" && actor.tier === "light") {
      throw new ForbiddenError("edit needs a standard- or heavy-tier session (planner), not light");
    }
    if (!change.reason?.trim()) throw new ValidationError("edit needs a reason");
    const { reason: _reason, ...fields } = change;
    if (!Object.values(fields).some((v) => v !== undefined)) {
      throw new ValidationError("edit: give at least one field to change");
    }
    if (change.depends_on) this.assertDeps(id, change.depends_on);
    if (change.parent) this.assertParent(id, change.parent);
    if (change.relates) this.assertRefs(id, change.relates);
    for (const t of change.targets ?? []) parseTargetRef(t); // throws on a bad ref
    return this.store.editDraft(id, change, this.actorFor(actor));
  }

  /** Human: replace an item's depends_on (any status). Refs + cycles checked here. */
  async setDepends(id: string, dependsOn: string[]) {
    this.item(id);
    this.assertDeps(id, dependsOn);
    return this.store.setDepends(id, dependsOn, this.actorFor("human"));
  }

  /** Human: replace an item's relates (any status). Reference-only refs checked here. */
  async setRelates(id: string, relates: string[]) {
    this.item(id);
    this.assertRefs(id, relates);
    return this.store.setRelates(id, relates, this.actorFor("human"));
  }

  /**
   * Loose refs (relates): each must parse, exist (local index or a linked
   * workspace) and not be the item itself. No cycle checks — relates is
   * reference only, never ordering.
   */
  private assertRefs(id: string, refs: string[]) {
    const wsName = this.wsr.ws.config.name;
    for (const r of refs) {
      const parsed = parseItemRef(r); // throws ValidationError on bad refs
      const here = parsed.workspace === undefined || parsed.workspace === wsName;
      if (here && parsed.id === id) {
        throw new ValidationError(`relates: ${id} may not reference itself`);
      }
      if (here) this.item(parsed.id);
      else if (this.links?.statusOf(r) === undefined) {
        throw new NotFoundError(`reference ${r} not found`);
      }
    }
  }

  /**
   * depends_on refs: each must parse, exist (local index or a linked
   * workspace) and not be the item itself; and none may already depend on
   * `id` — adding such an edge would close a dependency cycle.
   */
  private assertDeps(id: string, refs: string[]) {
    const wsName = this.wsr.ws.config.name;
    for (const r of refs) {
      const parsed = parseItemRef(r); // throws ValidationError on bad refs
      const here = parsed.workspace === undefined || parsed.workspace === wsName;
      if (here && parsed.id === id) {
        throw new ValidationError(`depends_on: ${id} may not depend on itself`);
      }
      if (here) this.item(parsed.id);
      else if (this.links?.statusOf(r) === undefined) {
        throw new NotFoundError(`dependency ${r} not found`);
      }
    }
    // a new dep closes a cycle iff `id` is reachable from it via depends_on
    const seen = new Set<string>();
    const stack = refs.map((r) => parseItemRef(r));
    while (stack.length) {
      const cur = stack.pop()!;
      const key = `${cur.workspace ?? ""}:${cur.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const here = cur.workspace === undefined || cur.workspace === wsName;
      if (here && cur.id === id) {
        throw new ValidationError(`depends_on cycle: ${id} is an ancestor of ${cur.id}`);
      }
      const deps = here
        ? this.index.get(cur.id)?.meta.depends_on
        : this.links?.index(cur.workspace!)?.get(cur.id)?.meta.depends_on;
      for (const d of deps ?? []) {
        try {
          stack.push(parseItemRef(d));
        } catch {
          /* dangling refs can't close a cycle */
        }
      }
    }
  }

  /**
   * Parent refs: must parse, exist (local index or a linked workspace), and
   * not make `id` its own ancestor — walking the new parent's ancestor
   * chain (local + linked) must never reach `id`.
   */
  private assertParent(id: string, parent: string) {
    const parsed = parseItemRef(parent); // throws ValidationError on bad refs
    const wsName = this.wsr.ws.config.name;
    if (parsed.workspace === undefined || parsed.workspace === wsName) this.item(parsed.id);
    else if (this.links?.statusOf(parent) === undefined) {
      throw new NotFoundError(`parent ${parent} not found`);
    }
    // refuse a parent cycle: walk the new ancestor chain (local + linked)
    const seen = new Set<string>();
    let cur: { workspace?: string; id: string } | undefined = parsed;
    while (cur) {
      const key = `${cur.workspace ?? ""}:${cur.id}`;
      if (seen.has(key)) break;
      seen.add(key);
      const here = cur.workspace === undefined || cur.workspace === wsName;
      if (here && cur.id === id) {
        throw new ValidationError(`parent cycle: ${id} is an ancestor of ${parent}`);
      }
      const anc = here
        ? this.index.get(cur.id)?.meta.parent
        : this.links?.index(cur.workspace!)?.get(cur.id)?.meta.parent;
      if (!anc) break;
      try {
        cur = parseItemRef(anc);
      } catch {
        break;
      }
    }
  }

  /** Human: remove a note block, identified by its `**ts · who**` header. */
  async removeNote(id: string, note: { ts: string; who: string; body?: string }) {
    this.item(id);
    return this.store.removeNote(id, note, this.actorFor("human"));
  }

  /** Human: when may this item's dependents start — "done" (key task), "review", or default. */
  async setUnblocksOn(id: string, on: "review" | "done" | "default") {
    this.item(id);
    return this.store.setUnblocksOn(id, on === "default" ? undefined : on, this.actorFor("human"));
  }

  /**
   * Human: set or clear an item's parent epic (`undefined` clears). Validates
   * the ref, existence (local index or linked workspace), self-parenting and
   * ancestor cycles — including chains that cross a linked workspace.
   */
  async setParent(id: string, parent: string | undefined) {
    this.item(id);
    if (parent !== undefined) this.assertParent(id, parent);
    return this.store.setParent(id, parent, this.actorFor("human"));
  }

  async undrop(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "undrop" });
  }

  /**
   * Close a plan (epic): no more parts are coming. plan_state turns `active`,
   * then `done` when every descendant finishes. Human-only — an agent actor
   * is refused by the state machine.
   */
  async closePlan(id: string, actor: Session | "human" = "human") {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor(actor), { type: "close_plan" });
  }

  /** Reopen a closed plan — more parts may still be added. Human-only. */
  async reopenPlan(id: string, actor: Session | "human" = "human") {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor(actor), { type: "reopen_plan" });
  }

  async humanClaim(id: string) {
    const it = this.item(id);
    const now = new Date().toISOString();
    const claim: Claim = {
      item: id,
      holder: "human",
      actor: "human",
      machine: this.wsr.store.machine,
      targets: it.meta.targets,
      claimed_at: now,
      last_seen: now,
      paths: await plannedPaths(this.wsr.ws, id, it.meta.targets),
    };
    const r = await this.store.perform(
      id,
      it.meta.version,
      this.actorFor("human"),
      { type: "claim", claim },
      // a human claim locks paths against agents — it must not trample a
      // live agent claim either
      { guard: this.overlapGuard(it.meta.targets, undefined, id) },
    );
    try {
      const { resumed } = await setupWork(this.wsr.ws, id, claim, this.home);
      for (const res of resumed) {
        await this.store.annotate(id, {
          heading: "Log",
          lines: [`- resumed prior work on branch ${res.branch} (@${res.resource})`],
        });
      }
    } catch (e) {
      await this.release(id, "human", `setup failed: ${(e as Error).message}`).catch(() => {});
      throw e;
    }
    return r;
  }

  async renumber(oldId: string, newId: string) {
    const r = await doRenumber(this.wsr.ws.plansDir, oldId, newId);
    // daemon writes — mark them so the watcher doesn't re-detect human edits
    for (const { from, to } of r.renamedFiles) {
      this.store.onFileWrite?.(from, null);
      const c = await readFile(to, "utf8").catch(() => null);
      if (c !== null) this.store.onFileWrite?.(to, c);
      this.store.idx.removeFile(from);
    }
    // reload touched files
    for (const f of r.changedFiles) {
      const c = await readFile(f, "utf8").catch(() => null);
      if (c !== null) this.store.onFileWrite?.(f, c);
      await this.store.idx.upsertFile(f);
    }
    return r;
  }
}
