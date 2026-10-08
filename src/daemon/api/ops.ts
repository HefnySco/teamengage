import { readFile } from "node:fs/promises";
import { parseItemRef, parseTargetRef, allocateId } from "../../core/address/refs.js";
import { targetsOverlap } from "../../core/claims/claims.js";
import type { IndexedItem } from "../../core/index/index.js";
import { renderMermaid, type MermaidOpts } from "../../core/mermaid/mermaid.js";
import type { Actor } from "../../core/state/machine.js";
import type { Claim } from "../../core/model/claim.js";
import type { Status } from "../../core/model/item.js";
import { ClaimRefusedError, InvalidTransitionError, NotFoundError, TeError } from "../../core/model/errors.js";
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
import { checkRemoteClaims } from "../sync/sync.js";
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

  async hello(agent: string, pid?: number): Promise<{ session: Session; resume: Claim[] }> {
    const session = this.sessions.hello(agent, pid);
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
    return { kind: "agent", session: session.id, machine: session.machine };
  }

  private depsDone(it: IndexedItem): boolean {
    return it.meta.depends_on.every((ref) => {
      let parsed;
      try {
        parsed = parseItemRef(ref);
      } catch {
        return false;
      }
      const status = parsed.workspace
        ? this.links?.statusOf(ref)
        : (this.index.get(parsed.id)?.meta.status ?? this.links?.statusOf(ref));
      return status === "done" || status === "dropped";
    });
  }

  // ---- reads ------------------------------------------------------------

  next(limit = 3): IndexedItem[] {
    const claimedTargets = [...this.index.claims.values()]
      .filter((c) => !c.conflicted)
      .flatMap((c) => c.targets);
    return this.index
      .readyItems(50)
      .filter((i) => !targetsOverlap(i.meta.targets, claimedTargets, resourceRoots(this.wsr.ws)).overlap)
      .slice(0, limit);
  }

  item(id: string): IndexedItem {
    const it = this.index.get(id);
    if (!it) throw new NotFoundError(`item ${id} not found`);
    return it;
  }

  brief(id: string) {
    const it = this.item(id);
    const sectionBody = (dep: IndexedItem, name: string) =>
      dep.sections.find((s) => s.heading.toLowerCase() === name.toLowerCase())?.body ?? "";
    const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).at(-1) ?? "";
    const deps = it.meta.depends_on.map((ref) => {
      const parsed = parseItemRef(ref);
      const dep = parsed.workspace ? undefined : this.index.get(parsed.id);
      return {
        ref,
        status: dep?.meta.status ?? this.links?.statusOf(ref) ?? "unknown",
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
    return { item: it, deps, decisions, targets, question: it.meta.question };
  }

  query(filter: Parameters<Index["query"]>[0]): IndexedItem[] {
    return this.index.query(filter);
  }

  graph(opts: MermaidOpts): string {
    return renderMermaid(this.index, opts);
  }

  findings(): Finding[] {
    return validate(this.index, {
      staleAfterMs: parseDuration(this.wsr.ws.config.stale_after),
      roots: resourceRoots(this.wsr.ws),
    });
  }

  // ---- agent writes -----------------------------------------------------

  async claim(
    id: string,
    session: Session,
  ): Promise<{ claim: Claim; version: number; resumed: Array<{ resource: string; branch: string }> }> {
    const it = this.item(id);
    const mine = it.claim;
    if (mine) {
      throw new ClaimRefusedError(
        `already claimed by ${mine.holder} on ${mine.machine}`,
        mine.holder,
        mine.machine,
      );
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
        guard: this.overlapGuard(it.meta.targets, roots),
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
  private overlapGuard(targets: string[], roots = resourceRoots(this.wsr.ws)) {
    return () => {
      for (const c of this.index.claims.values()) {
        if (c.conflicted) continue;
        const o = targetsOverlap(targets, c.targets, roots);
        if (o.overlap) {
          throw new ClaimRefusedError(
            `target ${o.via?.[0]} overlaps claim on ${c.item} held by ${c.holder} on ${c.machine}`,
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
    return r;
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
      summary?: string;
    }>,
    actor: Session | "human",
  ) {
    void this.actorFor(actor);
    return this.store.createItems(
      drafts.map((d) => ({ type: d.type ?? "task", ...d })),
      this.actorFor(actor),
    );
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

  async accept(id: string) {
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
    const r = await this.store.perform(id, it.meta.version, this.actorFor("human"), {
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

  async undrop(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "undrop" });
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
      { guard: this.overlapGuard(it.meta.targets) },
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
