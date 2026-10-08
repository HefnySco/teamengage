import { parseItemRef, parseTargetRef, allocateId } from "../../core/address/refs.js";
import { targetsOverlap } from "../../core/claims/claims.js";
import type { IndexedItem } from "../../core/index/index.js";
import { renderMermaid, type MermaidOpts } from "../../core/mermaid/mermaid.js";
import type { Actor } from "../../core/state/machine.js";
import type { Claim } from "../../core/model/claim.js";
import type { Status } from "../../core/model/item.js";
import { ClaimRefusedError, NotFoundError } from "../../core/model/errors.js";
import { parseDuration } from "../../core/model/workspace.js";
import { validate, type Finding } from "../../core/validate/validate.js";
import { renumber as doRenumber } from "../../core/address/renumber.js";
import {
  plannedPaths,
  setupWork,
  cleanupWork,
  mergeWork,
} from "../effects/effects.js";
import { checkRemoteClaims } from "../sync/sync.js";
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

  hello(agent: string): { session: Session; resume: Claim[] } {
    const session = this.sessions.hello(agent);
    const resume = this.sessions.resumeClaims(agent, this.index.claims.values());
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
      .filter((i) => !targetsOverlap(i.meta.targets, claimedTargets).overlap)
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
    });
  }

  // ---- agent writes -----------------------------------------------------

  async claim(id: string, session: Session): Promise<{ claim: Claim; version: number }> {
    const it = this.item(id);
    const mine = it.claim;
    if (mine) {
      throw new ClaimRefusedError(
        `already claimed by ${mine.holder} on ${mine.machine}`,
        mine.holder,
        mine.machine,
      );
    }
    for (const c of this.index.claims.values()) {
      if (c.conflicted) continue;
      const o = targetsOverlap(it.meta.targets, c.targets);
      if (o.overlap) {
        throw new ClaimRefusedError(
          `target ${o.via?.[0]} overlaps claim on ${c.item} held by ${c.holder} on ${c.machine}`,
          c.holder,
          c.machine,
          o.via?.[0],
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
    };
    // SY-0001: shrink the double-claim race — fetch plans repo and check
    // remote claims before writing ours (manual sync mode).
    await checkRemoteClaims(this.wsr, claim);
    const r = await this.store.perform(
      id,
      it.meta.version,
      this.actorFor(session),
      { type: "claim", claim },
      { depsDone: this.depsDone(it) },
    );
    // worktrees/snapshots come after the committed claim; failure → release
    try {
      await setupWork(this.wsr.ws, id, claim, this.home);
    } catch (e) {
      await this.release(id, session, `setup failed: ${(e as Error).message}`).catch(() => {});
      throw e;
    }
    return { claim, version: r.meta.version };
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
    if (this.sessions.shouldTouchClaim(id)) {
      // persist last_seen in the claim file (throttled)
      const claim = this.index.claims.get(id);
      if (claim) {
        const { writeFileAtomic } = await import("../store/atomic.js");
        const { claimToYaml } = await import("../../core/claims/claims.js");
        const { join } = await import("node:path");
        await writeFileAtomic(
          join(this.wsr.ws.plansDir, "claims", `${id}.yaml`),
          claimToYaml({ ...claim, last_seen: new Date().toISOString() }),
        ).catch(() => {});
      }
    }
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "log",
      note,
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
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "submit",
      evidence,
    });
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
    const r = await this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "claim",
      claim,
    });
    try {
      await setupWork(this.wsr.ws, id, claim, this.home);
    } catch (e) {
      await this.release(id, "human", `setup failed: ${(e as Error).message}`).catch(() => {});
      throw e;
    }
    return r;
  }

  async renumber(oldId: string, newId: string) {
    const r = await doRenumber(this.wsr.ws.plansDir, oldId, newId);
    // reload touched files
    for (const f of r.changedFiles) await this.store.idx.upsertFile(f);
    return r;
  }
}
