import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Index } from "../../core/index/index.js";
import { EventLog, eventFileName } from "../../core/events/log.js";
import {
  parseItemFile,
  parseMarkdown,
  serializeMarkdown,
  appendLog,
  appendToSection,
  emitFrontmatter,
} from "../../core/files/markdown.js";
import { claimToYaml } from "../../core/claims/claims.js";
import { transition, type Action, type Actor, type Effect } from "../../core/state/machine.js";
import { DecisionMeta, type Event, type ItemMeta } from "../../core/model/index.js";
import type { Claim } from "../../core/model/claim.js";
import { ConflictError, NotFoundError } from "../../core/model/errors.js";
import { git, mergeInProgress, isRepo } from "../../resources/git/git.js";
import { writeFileAtomic } from "./atomic.js";
import type { LoadedWorkspace } from "../../core/config/config.js";

/**
 * Plans store (DESIGN §6.1, §6.2): the only code allowed to change plan files.
 * A single in-process queue serializes every mutation on this machine; each
 * mutation = CAS check → transition → atomic write → event → one git commit
 * in the plans repo. Never pushes (principle 7).
 */

export interface MutationSpec {
  /** Mutate the parsed doc. Return new meta (version bumped by the store),
   *  log lines, event stubs, effects, and optional aux file writes/deletes. */
  run: (doc: { meta: ItemMeta; sections: { heading: string; body: string }[]; path: string }) => {
    meta: ItemMeta;
    logLines?: string[];
    events?: Array<Omit<Event, "seq" | "machine">>;
    effects?: Effect[];
    writes?: Array<{ rel: string; content: string }>;
    deletes?: string[];
  };
  /** Commit message suffix, e.g. `GL-0013 claimed by a@m#1`. */
  message: string;
}

export interface PerformResult {
  meta: ItemMeta;
  effects: Effect[];
  /** Effects the daemon executes outside the plans repo (merge, worktrees…). */
  external: Effect[];
  events: Event[];
}

export class PlansStore {
  private tail: Promise<unknown> = Promise.resolve();
  private index!: Index;
  private events!: EventLog;
  private ready = false;
  /** Called for each committed event (SSE fan-out). */
  onEvent?: (ev: Event) => void;
  /**
   * Called after every file the store writes or deletes (absolute path;
   * content=null for deletes) — the watcher subscribes so daemon writes
   * aren't re-detected as human edits.
   */
  onFileWrite?: (absPath: string, content: string | null) => void;

  constructor(
    readonly ws: LoadedWorkspace,
    readonly machine: string,
  ) {}

  async init(): Promise<void> {
    this.index = await Index.load(this.ws.plansDir);
    this.events = new EventLog(join(this.ws.plansDir, "events"), this.machine);
    this.ready = true;
  }

  get idx(): Index {
    return this.index;
  }

  /** Serialize all writes through one queue. */
  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => {});
    return run;
  }

  private async assertReady(): Promise<void> {
    if (!this.ready) await this.init();
  }

  private async plansRepoHealthy(): Promise<void> {
    if (!(await isRepo(this.ws.plansDir))) return; // plans dir may not be a repo yet
    if (await mergeInProgress(this.ws.plansDir)) {
      throw new ConflictError("plans repo has a merge in progress — resolve it first");
    }
    const bad = await git(this.ws.plansDir, ["status", "--porcelain"]);
    if (/^(UU|AA|DD|U.|.U) /m.test(bad)) {
      throw new ConflictError("plans repo has unresolved git conflicts — resolve them first");
    }
  }

  /** Write one item file atomically; bumps version and `updated`. */
  private async writeItemDoc(
    path: string,
    text: string,
    meta: ItemMeta,
    logLines: string[],
    sectionWrites: Array<{ heading: string; text: string }> = [],
  ): Promise<string> {
    const doc = parseItemFile(text, path);
    doc.meta = meta;
    for (const l of logLines) appendLog(doc, l);
    for (const s of sectionWrites) appendToSection(doc, s.heading, s.text);
    const out = serializeMarkdown(doc);
    await writeFileAtomic(path, out);
    this.onFileWrite?.(path, out);
    return out;
  }

  /**
   * Apply a state-machine action to an item (CAS-checked). `ctx.guard` runs
   * inside the write queue, after the version check and before the transition
   * — use it for cross-item invariants like claim target overlap.
   */
  perform(
    id: string,
    expectedVersion: number,
    actor: Actor,
    action: Action,
    ctx: {
      depsDone?: boolean;
      guard?: () => void | Promise<void>;
      /** bump claim.last_seen in the same write+commit (used by log). */
      touchClaim?: boolean;
    } = {},
  ): Promise<PerformResult> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      if (it.meta.version !== expectedVersion) {
        throw new ConflictError(`${id} is at version ${it.meta.version}, you have ${expectedVersion}`, {
          item: it.meta,
        });
      }
      await ctx.guard?.();
      const absPath = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absPath, "utf8"), absPath);
      const claim = this.index.claims.get(id) ?? null;
      const now = new Date().toISOString();
      const tr = transition(doc.meta, action, actor, { now, claim, depsDone: ctx.depsDone });

      const newMeta = { ...tr.meta, version: expectedVersion + 1 };
      const writes: Array<{ rel: string; content: string }> = [];
      const deletes: string[] = [];
      const external: Effect[] = [];
      for (const e of tr.effects) {
        switch (e.type) {
          case "write_claim":
            writes.push({ rel: join("claims", `${id}.yaml`), content: claimToYaml(e.claim) });
            break;
          case "delete_claim":
            deletes.push(join("claims", `${id}.yaml`));
            break;
          case "create_decision":
            writes.push({
              rel: join("decisions", `${e.decisionId}.md`),
              content: decisionFile(e.decisionId, e.title, id, actor, now),
            });
            break;
          default:
            external.push(e);
        }
      }

      let touchedClaim: Claim | undefined;
      if (ctx.touchClaim && claim) {
        touchedClaim = { ...claim, last_seen: now };
        writes.push({ rel: join("claims", `${id}.yaml`), content: claimToYaml(touchedClaim) });
      }

      const relItem = relative(this.ws.plansDir, absPath);
      await this.writeItemDoc(absPath, doc.raw.text, newMeta, tr.log, tr.sectionWrites);
      for (const w of writes) {
        const p = join(this.ws.plansDir, w.rel);
        await writeFileAtomic(p, w.content);
        this.onFileWrite?.(p, w.content);
      }
      const { unlink } = await import("node:fs/promises");
      for (const d of deletes) {
        const p = join(this.ws.plansDir, d);
        if (existsSync(p)) await unlink(p);
        this.onFileWrite?.(p, null);
      }

      const events: Event[] = [];
      const eventFiles = new Set<string>();
      for (const e of tr.events) {
        const full = await this.events.append(e);
        // the event file is part of the same mutation — commit it too,
        // else it lingers untracked and never syncs
        eventFiles.add(join("events", this.machine, eventFileName(full.ts)));
        events.push(full);
        this.onEvent?.(full);
      }

      await this.commitPaths(
        [relItem, ...writes.map((w) => w.rel), ...eventFiles],
        `te: ${id} ${action.type} by ${actor.session}`,
        deletes,
      );

      // reindex
      await this.index.upsertFile(absPath);
      if (touchedClaim) this.index.setClaim(touchedClaim);
      for (const e of tr.effects) {
        if (e.type === "write_claim") this.index.setClaim(e.claim);
        if (e.type === "delete_claim") this.index.setClaim(null, id);
        if (e.type === "create_decision") {
          const dpath = join(this.ws.plansDir, "decisions", `${e.decisionId}.md`);
          const d = parseMarkdown(await readFile(dpath, "utf8"), DecisionMeta, dpath);
          this.index.decisions.set(e.decisionId, {
            meta: d.meta,
            sections: d.sections,
            path: dpath,
          });
        }
      }
      return { meta: newMeta, effects: tr.effects, external, events };
    });
  }

  /**
   * Create new draft items (propose). Agents and humans may create items but
   * only as `draft` (DESIGN §5). Ids are allocated per prefix as max+1.
   */
  createItems(
    drafts: Array<{
      type: string;
      title: string;
      project?: string;
      targets?: string[];
      depends_on?: string[];
      parent?: string;
      summary?: string;
    }>,
    actor: Actor,
  ): Promise<{ ids: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const { ItemMeta } = await import("../../core/model/item.js");
      const { allocateId, idPrefix } = await import("../../core/address/refs.js");
      const ids: string[] = [];
      const writes: Array<{ rel: string; content: string }> = [];
      const now = new Date().toISOString().slice(0, 10);
      for (const d of drafts) {
        const project = d.project;
        const prefix = project
          ? this.ws.config.projects[project]?.prefix
          : this.ws.config.prefix;
        if (!prefix) throw new NotFoundError(`unknown project '${project}'`);
        const id = allocateId(prefix, [...this.items().metaIds(), ...ids]);
        const meta = ItemMeta.parse({
          id,
          type: d.type,
          title: d.title,
          status: "draft",
          project,
          targets: d.targets ?? [],
          depends_on: d.depends_on ?? [],
          parent: d.parent,
          priority: 2,
          version: 1,
          created: now,
          updated: now,
        });
        const body = `\n## Summary\n${d.summary ?? d.title}\n`;
        writes.push({
          rel: join("items", idPrefix(id), `${id}.md`),
          content: `${emitFrontmatter(meta)}${body}`,
        });
        ids.push(id);
      }
      for (const w of writes) {
        const p = join(this.ws.plansDir, w.rel);
        await writeFileAtomic(p, w.content);
        this.onFileWrite?.(p, w.content);
      }
      await this.commitPaths(
        writes.map((w) => w.rel),
        `te: propose ${ids.join(", ")} by ${actor.session}`,
      );
      for (const w of writes) await this.index.upsertFile(join(this.ws.plansDir, w.rel));
      return { ids };
    });
  }

  /**
   * Bulk import (IM-0001): create items with an explicit status and legacy_id
   * in one commit. Idempotent — items whose legacy_id already exists are
   * skipped. Human-side operation; agents can't reach it.
   */
  importItems(
    items: Array<{
      id: string;
      legacy_id: string;
      type: string;
      title: string;
      status: string;
      depends_on: string[];
      summary: string;
      simple?: string;
      project?: string;
      /** relative path of the source file — the idempotency key */
      source?: string;
    }>,
    actor: Actor,
  ): Promise<{ created: string[]; skipped: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const { ItemMeta, Status } = await import("../../core/model/item.js");
      // dedup by source path (imported_from), not legacy_id — different
      // folders can legitimately share a basename
      const existingSources = new Set(
        [...this.index.items.values()]
          .map((i) => (i.meta as { imported_from?: string }).imported_from)
          .filter((x): x is string => Boolean(x)),
      );
      const now = new Date().toISOString().slice(0, 10);
      const created: string[] = [];
      const skipped: string[] = [];
      const writes: Array<{ rel: string; content: string }> = [];
      for (const d of items) {
        if (d.source && existingSources.has(d.source)) {
          skipped.push(d.id);
          continue;
        }
        const meta = ItemMeta.parse({
          id: d.id,
          type: d.type,
          title: d.title,
          status: Status.parse(d.status),
          project: d.project,
          targets: [],
          depends_on: d.depends_on,
          priority: 2,
          version: 1,
          created: now,
          updated: now,
          legacy_id: d.legacy_id,
          imported_from: d.source,
        });
        let body = `\n## Summary\n${d.summary}\n`;
        if (d.simple) body += `\n## Simple\n${d.simple}\n`;
        const { idPrefix } = await import("../../core/address/refs.js");
        writes.push({
          rel: join("items", idPrefix(d.id), `${d.id}.md`),
          content: `${emitFrontmatter(meta)}${body}`,
        });
        created.push(d.id);
      }
      for (const w of writes) {
        const p = join(this.ws.plansDir, w.rel);
        await writeFileAtomic(p, w.content);
        this.onFileWrite?.(p, w.content);
      }
      if (writes.length) {
        await this.commitPaths(
          writes.map((w) => w.rel),
          `te: import ${created.length} items by ${actor.session}`,
        );
        for (const w of writes) await this.index.upsertFile(join(this.ws.plansDir, w.rel));
      }
      return { created, skipped };
    });
  }

  /**
   * Re-point live claims held by an agent's old session ids at a new session
   * (MCP reconnect / daemon restart). Without this, `requireHolder` sees the
   * dead session id and every log/ask/submit returns FORBIDDEN. Serialized
   * and committed like any other claim mutation.
   */
  rebindClaims(claims: Claim[], holder: string): Promise<Claim[]> {
    return this.enqueue(async () => {
      await this.assertReady();
      const now = new Date().toISOString();
      const rebound: Claim[] = [];
      const touched: string[] = [];
      for (const c of claims) {
        if (c.holder === holder) {
          rebound.push(c);
          continue;
        }
        const next = { ...c, holder, last_seen: now };
        const rel = join("claims", `${c.item}.yaml`);
        const abs = join(this.ws.plansDir, rel);
        const yaml = claimToYaml(next);
        await writeFileAtomic(abs, yaml);
        this.onFileWrite?.(abs, yaml);
        this.index.setClaim(next);
        rebound.push(next);
        touched.push(rel);
      }
      if (touched.length) {
        await this.commitPaths(touched, `te: rebind ${touched.length} claim(s) to ${holder}`);
      }
      return rebound;
    });
  }

  /**
   * Daemon-internal annotation: append lines to a section and/or patch
   * frontmatter, bump version, commit. Used for merge records and sync notes —
   * not a state transition.
   */
  annotate(
    id: string,
    opts: { heading: string; lines: string[]; metaPatch?: Record<string, unknown> },
  ): Promise<ItemMeta> {
    return this.enqueue(async () => {
      await this.assertReady();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const absPath = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absPath, "utf8"), absPath);
      const meta = {
        ...doc.meta,
        ...(opts.metaPatch ?? {}),
        version: doc.meta.version + 1,
        updated: new Date().toISOString().slice(0, 10),
      } as ItemMeta;
      await this.writeItemDoc(absPath, doc.raw.text, meta, [], [
        { heading: opts.heading, text: opts.lines.join("\n") + "\n" },
      ]);
      await this.commitPaths([it.path], `te: ${id} annotated`);
      await this.index.upsertFile(absPath);
      return meta;
    });
  }

  private items(): { metaIds: () => string[] } {
    return { metaIds: () => [...this.index.items.keys()] };
  }

  /** Commit specific paths (+deletions) in the plans repo; skips when no repo or nothing changed. */
  private async commitPaths(paths: string[], message: string, deletes: string[] = []): Promise<void> {
    if (!(await isRepo(this.ws.plansDir))) return;
    const rel = paths.map((p) => relative(this.ws.plansDir, join(this.ws.plansDir, p)));
    const args = ["add", "--", ...rel];
    await git(this.ws.plansDir, args);
    for (const d of deletes) {
      try {
        await git(this.ws.plansDir, ["rm", "-q", "--", d]);
      } catch {
        /* already gone */
      }
    }
    const staged = await git(this.ws.plansDir, ["diff", "--cached", "--name-only"]);
    if (!staged.trim()) return;
    // pathspec: never sweep unrelated staged files into a te: commit
    await git(this.ws.plansDir, ["commit", "-m", message, "--", ...rel, ...deletes]);
  }
}

function decisionFile(id: string, title: string, item: string, actor: Actor, now: string): string {
  const meta = {
    id,
    title,
    item,
    decided_by: actor.kind === "human" ? "human" : actor.session,
    created: now.slice(0, 10),
    version: 1,
  };
  return `${emitFrontmatter(meta)}\n## Question\nSee ${item}.\n\n## Answer\n${title}\n`;
}
