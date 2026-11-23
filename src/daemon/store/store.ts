import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import type { Document as YamlDocument } from "yaml";
import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Index } from "../../core/index/index.js";
import { EventLog, eventFileName } from "../../core/events/log.js";
import {
  parseItemFile,
  parseMarkdown,
  serializeMarkdown,
  appendLog,
  appendToSection,
  emitFrontmatter,
  parseArtifacts,
  renderChecks,
} from "../../core/files/markdown.js";
import {
  withTeTag,
  withoutTeTag,
  toSourcePath,
  appendNote,
  appendSection,
  setTouches,
  removeNote,
  resolveSource,
  setTitleLine,
  setDependsLine,
  setParentLine,
  setRelatesLine,
  setFoundByLine,
  replaceSection,
  removeSection,
  sectionBody,
  removeSectionLines,
  PROTECTED_SECTIONS,
} from "../../core/files/source.js";
import { normalizeDomain, normalizeDomains, type DomainDef } from "../../core/domains/domains.js";

/** keywords: trimmed, lowercase, unique. */
const normalizeKeywords = (k: string[]) => [...new Set(k.map((w) => w.trim().toLowerCase()).filter(Boolean))];

/** File types `attach` allows under `.artifacts/` (documents and mockups only). */
const ARTIFACT_TYPES = new Set(["png", "jpg", "webp", "gif", "svg", "pdf", "html", "md", "txt", "json", "csv"]);
import {
  DISCUSSION_SECTIONS,
  filePrefix,
  nextTaskNumber,
  renderSimpleFile,
  renderTaskFile,
  taskFileName,
} from "../../core/files/template.js";
import { claimToYaml } from "../../core/claims/claims.js";
import { transition, type Action, type Actor, type Effect } from "../../core/state/machine.js";
import { DecisionMeta, type Check, type Event, type ItemMeta, type Question, VerifyFile, type VerifyResult } from "../../core/model/index.js";
import type { Claim } from "../../core/model/claim.js";
import { ConflictError, InvalidTransitionError, NotFoundError, ValidationError } from "../../core/model/errors.js";
import { git, mergeInProgress, isRepo } from "../../resources/git/git.js";
import { remotePlanIds } from "../sync/sync.js";
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
  /** Called for each committed event (SSE fan-out; meta is the item's new meta). */
  onEvent?: (ev: Event, meta?: ItemMeta) => void;
  /**
   * Called after every file the store writes or deletes (absolute path;
   * content=null for deletes) — the watcher subscribes so daemon writes
   * aren't re-detected as human edits.
   */
  onFileWrite?: (absPath: string, content: string | null) => void;
  /**
   * Called after each commit the daemon writes to the plans repo — the
   * daemon wires it to the sync:auto push so every commit is published
   * promptly (DE-0299). Fired from inside the write queue; the listener
   * must only schedule work, never await git itself.
   */
  onCommit?: () => void;

  constructor(
    readonly ws: LoadedWorkspace,
    readonly machine: string,
  ) {}

  async init(): Promise<void> {
    this.index = await Index.load(this.ws.plansDir);
    this.index.setReviewUnblocks(this.ws.config.review_unblocks);
    this.events = new EventLog(join(this.ws.plansDir, "events"), this.machine);
    this.ready = true;
  }

  /** Append one event outside a transition — for ops that write state directly (GL-0355). */
  logEvent(e: Omit<Event, "seq" | "machine">): Promise<Event> {
    return this.events.append(e);
  }

  /** Re-read every plan file from disk (after a pull changed many at once). */
  reindex(): Promise<void> {
    return (async () => {
      this.index = await Index.load(this.ws.plansDir);
      this.index.setReviewUnblocks(this.ws.config.review_unblocks);
    })();
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
      /** issues verdicts since the last human action — evaluated inside the queue (send-back cap). */
      priorBounces?: () => number | Promise<number>;
      /** Whether the claim's holder can't act from this daemon — evaluated inside the queue. */
      holderAway?: () => boolean;
      /** Id of an ancestor plan on hold — evaluated inside the queue like holderAway. */
      planHold?: () => string | undefined;
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
      const tr = transition(doc.meta, action, actor, {
        now,
        claim,
        depsDone: ctx.depsDone,
        priorBounces: ctx.priorBounces ? await ctx.priorBounces() : undefined,
        holderAway: ctx.holderAway ? ctx.holderAway() : undefined,
        planHold: ctx.planHold ? ctx.planHold() : undefined,
        escalation: { after: this.ws.config.escalate_after, max: this.ws.config.max_attempts },
        reviewModels: this.ws.config.review_models,
      });

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
              content: decisionFile(e.decisionId, e.title, id, actor, now, undefined, e.question),
            });
            break;
          case "update_decision": {
            const prev = this.index.decisions.get(e.decisionId);
            writes.push({
              rel: join("decisions", `${e.decisionId}.md`),
              content: decisionFile(e.decisionId, e.title, id, actor, now, prev?.meta),
            });
            break;
          }
          case "decision_processed": {
            const prev = this.index.decisions.get(e.decisionId);
            if (!prev) break;
            writes.push({
              rel: join("decisions", `${e.decisionId}.md`),
              content: decisionFile(
                e.decisionId,
                prev.meta.title,
                id,
                actor,
                now,
                prev.meta,
                undefined,
                now,
              ),
            });
            break;
          }
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
        this.onEvent?.(full, newMeta);
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
        if (
          e.type === "create_decision" ||
          e.type === "update_decision" ||
          e.type === "decision_processed"
        ) {
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
   *
   * Overlay mode: each item also gets a real task file rendered from the
   * template (core/files/template.ts) at `<project folder>/TASK-NN-<slug>.md`
   * (epics: `PHASE-NN-…`), tagged `te: <id>`, plus an optional `.simple.md`
   * companion; the item records it as `source` and holds no copied content.
   * Task files are the human's to commit, like every task file.
   */
  createItems(
    drafts: Array<{
      type: string;
      title: string;
      project?: string;
      targets?: string[];
      depends_on?: string[];
      parent?: string;
      /** epics only: the feature this plan delivers */
      feature?: string;
      relates?: string[];
      found_by?: string[];
      summary?: string;
      acceptance?: string[];
      touches?: string[];
      checks?: Check[];
      /** discussion items: body text of the fixed ## sections, keyed by heading */
      sections?: Record<string, string>;
      simple?: string;
      domains?: string[];
      tier?: "light" | "standard" | "heavy";
    }>,
    actor: Actor,
  ): Promise<{ ids: string[]; files: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const { ItemMeta } = await import("../../core/model/item.js");
      const { allocateId, idPrefix, parseItemRef } = await import("../../core/address/refs.js");
      const overlay = this.ws.config.mode === "overlay";
      // DE-0299: ids another machine pushed but this checkout has not pulled
      // yet are taken too — a stale local counter must not hand one out again.
      const remoteTaken = await remotePlanIds(this.ws.plansDir);
      const ids: string[] = [];
      const files: string[] = [];
      const writes: Array<{ rel: string; content: string }> = [];
      const taskWrites: Array<{ abs: string; content: string }> = [];
      const taken = new Map<string, number[]>(); // folder+prefix → numbers used in this batch
      const now = new Date().toISOString();
      // `#N` in depends_on / parent = the N-th item of this batch (0-based),
      // so one propose call can carry a whole plan; only earlier items
      const local = (ref: string, at: number): string => {
        const m = /^#(\d+)$/.exec(ref.trim());
        if (!m) return ref;
        const n = Number(m[1]);
        if (n >= at) throw new ValidationError(`item ${at}: '${ref}' must point to an earlier item of the batch`);
        return ids[n];
      };
      for (const [at, raw] of drafts.entries()) {
        const d = {
          ...raw,
          depends_on: raw.depends_on?.map((r) => local(r, at)),
          parent: raw.parent === undefined ? undefined : local(raw.parent, at),
          feature: raw.feature === undefined ? undefined : local(raw.feature, at),
          relates: raw.relates?.map((r) => local(r, at)),
          found_by: raw.found_by?.map((r) => local(r, at)),
        };
        // GL-0331: the feature field is a plan→feature edge — only an epic
        // names one, and the named item must be a feature; a feature is a
        // flat delivery grouping, so it may not sit inside a plan.
        if (d.feature && d.type !== "epic") {
          throw new ValidationError(`item ${at} '${d.title}': only a plan (epic) names a feature`);
        }
        if (d.feature) {
          const fid = parseItemRef(d.feature).id;
          const inBatch = ids.indexOf(fid);
          const ft = inBatch >= 0 ? (drafts[inBatch].type ?? "task") : this.index.items.get(fid)?.meta.type;
          if (ft !== "feature") {
            throw new ValidationError(`item ${at} '${d.title}': feature '${d.feature}' does not name a feature item`);
          }
        }
        if (d.type === "feature" && d.parent) {
          throw new ValidationError(`item ${at} '${d.title}': a feature may not have a parent`);
        }
        const project = d.project;
        const prefix = project
          ? this.ws.config.projects[project]?.prefix
          : this.ws.config.prefix;
        if (!prefix) throw new NotFoundError(`unknown project '${project}'`);
        const id = allocateId(prefix, [...this.items().metaIds(), ...ids, ...remoteTaken]);
        let source: string | undefined;
        if (overlay) {
          const folder = this.projectFolder(project);
          const fp = filePrefix(d.type);
          const key = `${folder}\0${fp}`;
          const abs = join(this.ws.root, folder);
          // numbers still recorded by items (a deleted or not-yet-pulled file)
          // are never reused either
          const recorded = [...this.index.items.values()]
            .flatMap((i) => [i.meta.source, i.meta.simple_source])
            .filter((p): p is string => !!p && (folder === "" ? !p.includes("/") : p.startsWith(`${folder}/`)))
            .map((p) => new RegExp(`^${fp}-(\\d+)`, "i").exec(p.split("/").pop()!)?.[1])
            .filter((x): x is string => x !== undefined)
            .map(Number);
          let n = nextTaskNumber(abs, fp, [...(taken.get(key) ?? []), ...recorded]);
          let name = taskFileName(fp, n, d.title);
          // a file of the same name (another slug's number) never gets overwritten
          while (existsSync(join(abs, name)) || existsSync(join(abs, name.replace(/\.md$/, ".simple.md")))) {
            name = taskFileName(fp, ++n, d.title);
          }
          taken.set(key, [...(taken.get(key) ?? []), n]);
          source = toSourcePath(this.ws.root, join(abs, name));
          taskWrites.push({
            abs: join(abs, name),
            content: renderTaskFile({ id, ...d }),
          });
          // TE-0178: the simple version is a ## Simple section inside the
          // task file now — no X.simple.md companion for new items
          files.push(source);
        }
        const meta = ItemMeta.parse({
          id,
          type: d.type,
          title: d.title,
          status: "draft",
          project,
          targets: d.targets ?? [],
          depends_on: d.depends_on ?? [],
          parent: d.parent,
          feature: d.feature,
          relates: d.relates ?? [],
          ...(d.found_by?.length ? { found_by: d.found_by } : {}),
          domains: normalizeDomains(d.domains ?? []),
          ...(d.tier ? { tier: d.tier } : {}),
          ...(actor.kind === "agent" && actor.tier ? { authored_tier: actor.tier } : {}),
          priority: 2,
          version: 1,
          created: now,
          updated: now,
          ...(source ? { source } : {}),
        });
        let body = "";
        if (!overlay) {
          body = `\n## Summary\n${d.summary ?? d.title}\n`;
          // a discussion's distilled layer lives in the item file here —
          // the overlay writes it to the DISC-*.md source instead
          if (d.type === "discussion") {
            for (const h of DISCUSSION_SECTIONS) body += `\n## ${h}\n${d.sections?.[h]?.trim() ?? ""}\n`;
          }
          if (d.acceptance?.length) {
            body += `\n## Acceptance\n${d.acceptance.map((a) => `- [ ] ${a}`).join("\n")}\n`;
          }
          if (d.checks?.length) body += `\n## Checks\n${renderChecks(d.checks)}`;
          if (d.simple?.trim()) body += `\n## Simple\n${d.simple.trim()}\n`;
        }
        writes.push({
          rel: join("items", idPrefix(id), `${id}.md`),
          content: `${emitFrontmatter(meta)}${body}`,
        });
        ids.push(id);
      }
      const newDomains = await this.ensureDomains(normalizeDomains(drafts.flatMap((d) => d.domains ?? [])));
      if (newDomains.length) writes.push({ rel: "workspace.yaml", content: "" }); // committed below, not rewritten
      for (const w of writes) {
        if (w.rel === "workspace.yaml") continue;
        const p = join(this.ws.plansDir, w.rel);
        await writeFileAtomic(p, w.content);
        this.onFileWrite?.(p, w.content);
      }
      for (const t of taskWrites) {
        await writeFileAtomic(t.abs, t.content);
        this.onFileWrite?.(t.abs, t.content);
      }
      await this.commitPaths(
        writes.map((w) => w.rel),
        `te: propose ${ids.join(", ")} by ${actor.session}`,
      );
      // the new task files are the human's content: staged so they are never
      // orphaned (untracked), committed by the human
      await this.stageTaskFiles(taskWrites.map((t) => toSourcePath(this.ws.root, t.abs)));
      for (const w of writes) {
        if (w.rel !== "workspace.yaml") await this.index.upsertFile(join(this.ws.plansDir, w.rel));
      }
      return { ids, files };
    });
  }

  /**
   * Overlay: the folder (relative to the root) a project's task files live
   * in — `projects.<p>.path`, else the project name; workspace-level items go
   * in the root. Never outside the root.
   */
  private projectFolder(project: string | undefined): string {
    const cfg = project ? (this.ws.config.projects[project] as { path?: string } | undefined) : undefined;
    const folder = project ? (cfg?.path ?? project) : ".";
    const abs = resolve(this.ws.root, folder);
    if (abs !== this.ws.root && !abs.startsWith(this.ws.root + sep)) {
      throw new ValidationError(`project folder '${folder}' is outside the workspace root`);
    }
    return relative(this.ws.root, abs);
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
      relates?: string[];
      summary: string;
      simple?: string;
      project?: string;
      /** relative path of the source file — the idempotency key */
      source?: string;
      /** overlay mode: companion `.simple.md`, relative to the workspace root */
      simple_source?: string;
    }>,
    actor: Actor,
  ): Promise<{ created: string[]; skipped: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const { ItemMeta, Status } = await import("../../core/model/item.js");
      // dedup by source path (imported_from / source), not legacy_id —
      // different folders can legitimately share a basename
      const overlay = this.ws.config.mode === "overlay";
      const existingSources = new Set(
        [...this.index.items.values()]
          .map((i) => (overlay ? i.meta.source : i.meta.imported_from))
          .filter((x): x is string => Boolean(x)),
      );
      const now = new Date().toISOString();
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
          relates: d.relates ?? [],
          priority: 2,
          version: 1,
          created: now,
          updated: now,
          legacy_id: d.legacy_id,
          ...(overlay
            ? { source: d.source, simple_source: d.simple_source }
            : { imported_from: d.source }),
        });
        // overlay: the task file is the content — never copy it
        let body = overlay ? "" : `\n## Summary\n${d.summary}\n`;
        if (d.simple && !overlay) body += `\n## Simple\n${d.simple}\n`;
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
      if (overlay) {
        // tag each task file after its item exists: a half-done tagging pass
        // still resolves by the recorded `source` path. Task files are the
        // human's content — tagged, never committed by the daemon.
        const tagged: string[] = [];
        for (const d of items) {
          if (!created.includes(d.id)) continue;
          for (const rel of [d.source, d.simple_source]) {
            if (rel && (await this.tagSource(rel, d.id))) tagged.push(rel);
          }
        }
        await this.stageTaskFiles(tagged);
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
      const rebound: Claim[] = [];
      const touched: string[] = [];
      for (const c of claims) {
        if (c.holder === holder) {
          rebound.push(c);
          continue;
        }
        // TE-0206: adoption rebinds the holder only — it must not refresh
        // last_seen, or dead claims would look freshly worked and block
        // dispatch capacity
        const next = { ...c, holder };
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
   * sync:auto (DE-0299): the claim commit was written but the push after it
   * failed — mark the claim unsynced so the sync status keeps telling the
   * truth until a later push carries it.
   */
  markClaimUnsynced(item: string, claim: Claim): Promise<void> {
    return this.enqueue(async () => {
      await this.assertReady();
      const marked = { ...claim, unsynced: true };
      const rel = join("claims", `${item}.yaml`);
      const abs = join(this.ws.plansDir, rel);
      const yaml = claimToYaml(marked);
      await writeFileAtomic(abs, yaml);
      this.onFileWrite?.(abs, yaml);
      this.index.setClaim(marked);
      await this.commitPaths([rel], `te: ${item} claim marked unsynced — auto push failed`);
    });
  }

  /**
   * sync:auto (DE-0299) repair: the remote won the race for these ids — the
   * push after propose was refused and the ids exist on the upstream
   * already. Fold the unpushed te-commits back to the merge base (never a
   * human's commit), fast-forward to the remote tip, then re-apply the work
   * with fresh ids in one commit: item files renamed, `te:` lines and
   * in-batch references rewritten, the colliding files gone — so the result
   * is a plain child of the remote tip and the push goes out.
   * Throws ConflictError when the branch holds unpushed commits that are
   * not ours, or the fast-forward is refused: that is reported, never
   * resolved by merging on the daemon's own.
   */
  repairIdCollision(renames: ReadonlyMap<string, string>): Promise<void> {
    return this.enqueue(async () => {
      await this.assertReady();
      if (!renames.size) return;
      const { idPrefix, parseItemRef } = await import("../../core/address/refs.js");
      const { unlink } = await import("node:fs/promises");
      const plansDir = this.ws.plansDir;
      const bare = (r: string): string => {
        try {
          return parseItemRef(r).id;
        } catch {
          return r;
        }
      };
      const rewrite = (text: string): string => {
        let out = text;
        for (const [oldId, newId] of renames) {
          out = out.replace(new RegExp(`\\b${oldId}\\b`, "g"), newId);
        }
        return out;
      };
      const origHead = (await git(plansDir, ["rev-parse", "HEAD"])).trim();
      const remoteRef = (
        await git(plansDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(
          () => "",
        )
      ).trim();
      if (!remoteRef) throw new ConflictError("no upstream to repair against");
      const base = (await git(plansDir, ["merge-base", "HEAD", remoteRef])).trim();
      // only our own unpushed commits may be folded — a human's commit stays
      // the human's to rebase, never the daemon's to rewrite
      const subjects = (await git(plansDir, ["log", "--format=%s", `${base}..HEAD`]))
        .split("\n")
        .filter(Boolean);
      if (subjects.some((s) => !s.startsWith("te:"))) {
        throw new ConflictError(
          "plans repo diverged with unpushed commits not made by te — resolve it in a terminal",
        );
      }
      // remember the colliding items before the fold — after the fast-forward
      // the index names the remote's item for the same id, so path, text and
      // overlay source must come from our copy here
      const saved = new Map<string, { path: string; text: string; sources: string[] }>();
      for (const oldId of renames.keys()) {
        const it = this.index.items.get(oldId);
        if (!it) continue;
        const abs = join(plansDir, it.path);
        saved.set(oldId, {
          path: it.path,
          text: await readFile(abs, "utf8"),
          sources: [it.meta.source, it.meta.simple_source].filter((s): s is string => !!s),
        });
      }
      // fold the unpushed te-commits into the worktree: HEAD back to the
      // merge base, then unstage the plans paths — the human's staged files
      // outside the plans dir keep their staging either way
      await git(plansDir, ["reset", "-q", "--soft", base]);
      await git(plansDir, ["reset", "-q", "HEAD", "--", "."]);
      // drop the colliding item files so the remote's same-named files land
      for (const { path } of saved.values()) {
        const abs = join(plansDir, path);
        try {
          await unlink(abs);
          this.onFileWrite?.(abs, null);
        } catch {
          /* already gone */
        }
      }
      // fast-forward to the remote tip — refused when a local file stands in
      // the way of a remote one: put everything back and report
      try {
        await git(plansDir, ["merge", "--ff-only", remoteRef], { timeoutMs: 60_000 });
      } catch {
        await git(plansDir, ["reset", "-q", "--soft", origHead]).catch(() => {});
        await git(plansDir, ["reset", "-q", "HEAD", "--", "."]).catch(() => {});
        for (const { path, text } of saved.values()) {
          const abs = join(plansDir, path);
          await writeFileAtomic(abs, text).catch(() => {});
          this.onFileWrite?.(abs, text);
        }
        throw new ConflictError(
          "plans repo diverged — resolve it in a terminal; te never merges the plans repo",
        );
      }
      await this.reindex();
      // files of other items that reference a renamed id (depends_on lines
      // in the batch's own task files, the matching frontmatter elsewhere).
      // The colliding ids now name the remote's items — they are skipped,
      // their files and sources belong to the remote's ids.
      const relatedItems = new Set<string>();
      const relatedSources = new Set<string>();
      for (const it of this.index.items.values()) {
        const m = it.meta;
        if (renames.has(m.id)) continue;
        const refs = [...m.depends_on, ...m.relates, ...(m.found_by ?? []), m.parent, m.feature].filter(
          (r): r is string => !!r,
        );
        if (!refs.some((r) => renames.has(bare(r)))) continue;
        relatedItems.add(it.path);
        for (const s of [m.source, m.simple_source]) if (s) relatedSources.add(s);
      }
      for (const rel of relatedItems) {
        const abs = join(plansDir, rel);
        if (!existsSync(abs)) continue;
        const text = rewrite(await readFile(abs, "utf8"));
        await writeFileAtomic(abs, text);
        this.onFileWrite?.(abs, text);
      }
      const stagedSources: string[] = [];
      for (const [oldId, newId] of renames) {
        const keep = saved.get(oldId);
        if (!keep) continue;
        const rel = join("items", idPrefix(newId), `${newId}.md`);
        const abs = join(plansDir, rel);
        const text = rewrite(keep.text);
        await writeFileAtomic(abs, text);
        this.onFileWrite?.(abs, text);
        // the overlay task file: its `te:` frontmatter line carries the id —
        // rewrite it like the other sources, staged not committed (it is the
        // human's content, as at propose time)
        for (const s of keep.sources) relatedSources.add(s);
      }
      for (const src of relatedSources) {
        const abs = join(this.ws.root, src);
        if (!existsSync(abs)) continue;
        const text = rewrite(await readFile(abs, "utf8"));
        await writeFileAtomic(abs, text);
        this.onFileWrite?.(abs, text);
        stagedSources.push(src);
      }
      // one commit for the whole repaired state: the folded work (still in
      // the worktree) plus the renamed items — everything under the plans
      // dir is daemon-owned, so `add -A`/`commit -- .` cannot sweep the
      // human's files (task files live outside and stay staged only)
      await git(plansDir, ["add", "-A", "--", "."]);
      await git(plansDir, [
        "commit",
        "-q",
        "-m",
        `te: renumber ${[...renames].map(([o, n]) => `${o}→${n}`).join(", ")} — the remote claimed the id first`,
        "--",
        ".",
      ]);
      this.onCommit?.();
      if (stagedSources.length) await this.stageTaskFiles(stagedSources);
      await this.reindex();
    });
  }

  /**
   * Daemon-internal annotation: append lines to a section and/or patch
   * frontmatter, bump version, commit. Used for merge records and sync notes —
   * not a state transition.
   */
  annotate(
    id: string,
    opts: { heading: string; lines: string[]; metaPatch?: Record<string, unknown>; log?: string[] },
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
        updated: new Date().toISOString(),
      } as ItemMeta;
      await this.writeItemDoc(absPath, doc.raw.text, meta, opts.log ?? [], [
        { heading: opts.heading, text: opts.lines.join("\n") + "\n" },
      ]);
      await this.commitPaths([it.path], `te: ${id} annotated`);
      await this.index.upsertFile(absPath);
      return meta;
    });
  }

  /**
   * GL-0358: record one `te verify` result — merge it into
   * `verify/<ID>.yaml` (latest result per check name wins), append the
   * `verified:` line to ## Evidence, append a `verify` event with the
   * poster as actor, and commit all three files in one commit.
   */
  recordVerify(id: string, result: VerifyResult, evidenceLine: string, actor: Actor): Promise<ItemMeta> {
    return this.enqueue(async () => {
      await this.assertReady();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const verifyRel = join("verify", `${id}.yaml`);
      const verifyAbs = join(this.ws.plansDir, verifyRel);
      const YAML = (await import("yaml")).default;
      let file: VerifyFile = { item: id, results: [] };
      if (existsSync(verifyAbs)) {
        try {
          file = VerifyFile.parse(YAML.parse(await readFile(verifyAbs, "utf8")));
        } catch {
          file = { item: id, results: [] };
        }
      }
      // a result replaces only the same actor's result for the same check —
      // a reviewer's `te verify` is stored beside the submitter's
      const rest = file.results.filter((r) => !(r.check === result.check && r.actor === result.actor));
      file = { item: id, results: [...rest, result] };
      await mkdir(join(this.ws.plansDir, "verify"), { recursive: true });
      await writeFileAtomic(verifyAbs, YAML.stringify(file));

      const absPath = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absPath, "utf8"), absPath);
      const meta = {
        ...doc.meta,
        version: doc.meta.version + 1,
        updated: new Date().toISOString(),
      } as ItemMeta;
      await this.writeItemDoc(absPath, doc.raw.text, meta, [], [
        { heading: "Evidence", text: evidenceLine + "\n" },
      ]);

      const ev = await this.events.append({
        ts: new Date().toISOString(),
        actor: actor.session,
        session: actor.kind === "agent" ? actor.session : undefined,
        item: id,
        action: "verify",
        data: {
          check: result.check,
          passed: result.passed,
          exit_code: result.exit_code,
          commit: result.commit,
        },
      });
      this.onEvent?.(ev, meta);

      await this.commitPaths(
        [it.path, verifyRel, join("events", this.machine, eventFileName(ev.ts))],
        `te: ${id} verify ${result.check} by ${actor.session}`,
      );
      await this.index.upsertFile(absPath);
      return meta;
    });
  }

  /**
   * Overlay mode: record that an item's task file moved (found by its `te:`
   * tag). Version bumped and logged like any write; never a state change.
   */
  setSources(moves: Array<{ id: string; source?: string; simple_source?: string }>): Promise<string[]> {
    return this.enqueue(async () => {
      await this.assertReady();
      const done: string[] = [];
      const touched: string[] = [];
      const now = new Date().toISOString();
      for (const m of moves) {
        const it = this.index.get(m.id);
        if (!it) continue;
        const absPath = join(this.ws.plansDir, it.path);
        const doc = parseItemFile(await readFile(absPath, "utf8"), absPath);
        const patch: Partial<ItemMeta> = {};
        if (m.source !== undefined && m.source !== doc.meta.source) patch.source = m.source;
        if (m.simple_source !== undefined && m.simple_source !== doc.meta.simple_source) {
          patch.simple_source = m.simple_source;
        }
        if (!Object.keys(patch).length) continue;
        const meta = {
          ...doc.meta,
          ...patch,
          version: doc.meta.version + 1,
          updated: now,
        } as ItemMeta;
        const lines = Object.entries(patch).map(([k, v]) => `- ${now} human moved ${k} → ${v as string}`);
        await this.writeItemDoc(absPath, doc.raw.text, meta, lines);
        await this.index.upsertFile(absPath);
        done.push(m.id);
        touched.push(it.path);
      }
      if (touched.length) await this.commitPaths(touched, `te: ${done.join(", ")} task file moved`);
      return done;
    });
  }

  /**
   * Delete an item from tracking (human only — callers check). Removes the
   * item file; in overlay mode the task file(s) stay as plain Markdown: the
   * `te:` line is removed and the path goes into `ignore:` so it isn't
   * reported as untracked. Refused while claimed or while another item
   * depends on it or names it as parent. The event log keeps the record.
   */
  deleteItem(id: string, actor: Actor, reason?: string): Promise<{ untagged: string[]; ignored: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      if (this.index.claims.has(id)) {
        throw new ConflictError(`${id} is claimed by ${this.index.claims.get(id)!.holder} — release it first`);
      }
      const { parseItemRef } = await import("../../core/address/refs.js");
      const refsIt = (r: string) => {
        try {
          const p = parseItemRef(r);
          return !p.workspace && p.id === id;
        } catch {
          return false;
        }
      };
      const users = [...this.index.items.values()]
        .filter((o) => o.meta.id !== id && (o.meta.depends_on.some(refsIt) || (o.meta.parent && refsIt(o.meta.parent))))
        .map((o) => o.meta.id);
      if (users.length) {
        throw new ConflictError(`${id} is still used by ${users.join(", ")} (depends_on/parent) — change those first`);
      }

      const untagged: string[] = [];
      const ignored: string[] = [];
      if (this.ws.config.mode === "overlay") {
        for (const rel of [it.meta.source, it.meta.simple_source]) {
          if (!rel) continue;
          const abs = join(this.ws.root, rel);
          if (existsSync(abs)) {
            const text = await readFile(abs, "utf8");
            const out = withoutTeTag(text, id);
            if (out !== text) {
              await writeFileAtomic(abs, out);
              this.onFileWrite?.(abs, out);
              untagged.push(rel);
            }
          }
          if (!this.ws.config.ignore.includes(rel)) ignored.push(rel);
        }
        if (ignored.length) await this.addIgnores(ignored);
      }

      const absItem = join(this.ws.plansDir, it.path);
      const { unlink } = await import("node:fs/promises");
      await unlink(absItem);
      this.onFileWrite?.(absItem, null);
      this.index.removeFile(absItem);

      const full = await this.events.append({
        ts: new Date().toISOString(),
        actor: actor.session,
        item: id,
        action: "delete",
        from: it.meta.status,
        note: [it.meta.title, reason].filter(Boolean).join(" — "),
      });
      this.onEvent?.(full);
      await this.commitPaths(
        [join("events", this.machine, eventFileName(full.ts)), ...(ignored.length ? ["workspace.yaml"] : [])],
        `te: ${id} deleted by ${actor.session}`,
        [it.path],
      );
      await this.stageTaskFiles(untagged);
      return { untagged, ignored };
    });
  }

  /**
   * Edit workspace.yaml in place (comments and formatting kept) and refresh
   * the in-memory config from the result.
   */
  private async editWorkspaceYaml(edit: (doc: YamlDocument) => void): Promise<void> {
    const YAML = (await import("yaml")).default;
    const { WorkspaceConfig } = await import("../../core/model/workspace.js");
    const abs = join(this.ws.plansDir, "workspace.yaml");
    const doc = YAML.parseDocument(await readFile(abs, "utf8"));
    // an empty `domains:` is null — give it a map before anything writes into it
    if (doc.has("domains") && !YAML.isMap(doc.get("domains", true))) doc.set("domains", doc.createNode({}));
    edit(doc);
    const out = doc.toString();
    await writeFileAtomic(abs, out);
    this.onFileWrite?.(abs, out);
    const fresh = WorkspaceConfig.parse(YAML.parse(out) ?? {});
    this.ws.config.ignore.splice(0, this.ws.config.ignore.length, ...fresh.ignore);
    this.ws.config.domains = fresh.domains;
  }

  /** Append paths to workspace.yaml `ignore:`. */
  private async addIgnores(paths: string[]): Promise<void> {
    await this.editWorkspaceYaml((doc) => {
      const cur = ((doc.toJS() as { ignore?: string[] } | null)?.ignore ?? []).filter(Boolean);
      const next = [...cur, ...paths.filter((p) => !cur.includes(p))];
      doc.set("ignore", next);
      const seq = doc.get("ignore", true) as { flow?: boolean } | undefined;
      if (seq && next.length <= 3) seq.flow = true;
    });
  }

  /** The domain vocabulary as on disk now (a hand edit of workspace.yaml counts). */
  async currentDomains(): Promise<Record<string, DomainDef>> {
    const YAML = (await import("yaml")).default;
    const { WorkspaceConfig } = await import("../../core/model/workspace.js");
    const raw = YAML.parse(await readFile(join(this.ws.plansDir, "workspace.yaml"), "utf8")) ?? {};
    return WorkspaceConfig.parse(raw).domains;
  }

  /** Add domains that aren't in workspace.yaml yet (auto-add on use). */
  private async ensureDomains(names: string[]): Promise<string[]> {
    const known = await this.currentDomains();
    const missing = names.filter((n) => !(n in known));
    if (missing.length) {
      await this.editWorkspaceYaml((doc) => {
        for (const n of missing) doc.setIn(["domains", n], doc.createNode({}));
      });
    }
    return missing;
  }

  /** Rewrite one item's meta (version bump + History lines), re-index. */
  private async rewriteItem(id: string, patch: (meta: ItemMeta) => ItemMeta | null, lines: string[]): Promise<boolean> {
    const it = this.index.get(id);
    if (!it) return false;
    const abs = join(this.ws.plansDir, it.path);
    const doc = parseItemFile(await readFile(abs, "utf8"), abs);
    const next = patch({ ...doc.meta });
    if (!next) return false;
    const meta = { ...next, version: doc.meta.version + 1, updated: new Date().toISOString() } as ItemMeta;
    await this.writeItemDoc(abs, doc.raw.text, meta, lines);
    await this.index.upsertFile(abs);
    return true;
  }

  /** Set when an item's dependents may start (undefined = workspace default). */
  setUnblocksOn(id: string, on: "review" | "done" | undefined, actor: Actor): Promise<{ unblocks_on?: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      if (it.meta.unblocks_on === on) return { unblocks_on: on };
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const what =
        on === "done" ? "key task: dependents wait for acceptance"
        : on === "review" ? "dependents may start once it is in review"
        : "dependents follow the workspace default";
      await this.rewriteItem(
        id,
        (m) => {
          const next = { ...m } as ItemMeta;
          if (on) next.unblocks_on = on;
          else delete next.unblocks_on;
          return next;
        },
        [`- ${now} ${who} ${what}`],
      );
      // dependents' blocked flags depend on this item
      this.index.setReviewUnblocks(this.index.reviewUnblocks);
      await this.commitPaths([it.path], `te: ${id} unblocks_on ${on ?? "default"}`);
      return { unblocks_on: on };
    });
  }

  /** Set or clear an item's parent (plan membership). Reference validation lives in ops. */
  setParent(id: string, parent: string | undefined, actor: Actor): Promise<{ parent?: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      if (it.meta.parent === parent) return { parent };
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const what = parent
        ? `parent: ${parent}${it.meta.parent ? ` (was ${it.meta.parent})` : ""}`
        : `parent cleared (was ${it.meta.parent})`;
      await this.rewriteItem(
        id,
        (m) => {
          const next = { ...m } as ItemMeta;
          if (parent) next.parent = parent;
          else delete next.parent;
          return next;
        },
        [`- ${now} ${who} ${what}`],
      );
      if (this.ws.config.mode === "overlay" && it.meta.source) {
        const found = await resolveSource(this.ws.root, id, it.meta.source);
        if (found) {
          const out = setParentLine(found.text, parent);
          if (out !== found.text) {
            const abs = join(this.ws.root, found.path);
            await writeFileAtomic(abs, out);
            this.onFileWrite?.(abs, out);
            await this.stageTaskFiles([found.path]);
          }
        }
      }
      await this.commitPaths([it.path], `te: ${id} ${what}`);
      return { parent };
    });
  }

  /** Set an item's domains (normalized; unknown names are added to the vocabulary). */
  setDomains(id: string, domains: string[], actor: Actor): Promise<{ domains: string[]; added: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const next = normalizeDomains(domains);
      const before = it.meta.domains;
      const plus = next.filter((d) => !before.includes(d));
      const minus = before.filter((d) => !next.includes(d));
      if (!plus.length && !minus.length) return { domains: next, added: [] };
      const added = await this.ensureDomains(next);
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const change = [...plus.map((d) => `+${d}`), ...minus.map((d) => `−${d}`)].join(" ");
      await this.rewriteItem(id, (m) => ({ ...m, domains: next }), [`- ${now} ${who} domains: ${change}`]);
      await this.commitPaths([it.path, ...(added.length ? ["workspace.yaml"] : [])], `te: ${id} domains ${change}`);
      return { domains: next, added };
    });
  }

  /** Create or update a domain's description / colour / keywords. */
  defineDomain(name: string, patch: DomainDef): Promise<{ name: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      const n = normalizeDomain(name);
      if (!n) throw new ValidationError(`bad domain name '${name}'`);
      await this.editWorkspaceYaml((doc) => {
        if (!doc.hasIn(["domains", n])) doc.setIn(["domains", n], doc.createNode({}));
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) continue;
          if (v === "" || (Array.isArray(v) && !v.length)) doc.deleteIn(["domains", n, k]);
          else doc.setIn(["domains", n, k], doc.createNode(v));
        }
      });
      await this.commitPaths(["workspace.yaml"], `te: domain ${n} defined`);
      return { name: n };
    });
  }

  /**
   * Rename a domain; when `to` already exists this is a merge (its
   * definition wins, keywords are unioned). Every item is rewritten.
   */
  renameDomain(from: string, to: string, actor: Actor): Promise<{ items: string[]; merged: boolean }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const a = normalizeDomain(from);
      const b = normalizeDomain(to);
      if (!a || !b) throw new ValidationError("rename needs two domain names");
      if (a === b) return { items: [], merged: false };
      const known = await this.currentDomains();
      const users = [...this.index.items.values()].filter((i) => i.meta.domains.includes(a));
      if (!(a in known) && !users.length) throw new NotFoundError(`domain '${a}' not found`);
      const merged = b in known;
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const touched: string[] = [];
      for (const it of users) {
        await this.rewriteItem(
          it.meta.id,
          (m) => ({ ...m, domains: normalizeDomains(m.domains.map((d) => (d === a ? b : d))) }),
          [`- ${now} ${who} domain ${a} ${merged ? "merged into" : "renamed to"} ${b}`],
        );
        touched.push(it.path);
      }
      await this.editWorkspaceYaml((doc) => {
        const defA = (known[a] ?? {}) as DomainDef;
        if (merged) {
          const kw = normalizeKeywords([...(known[b]?.keywords ?? []), ...(defA.keywords ?? []), a]);
          doc.setIn(["domains", b, "keywords"], doc.createNode(kw));
        } else {
          doc.setIn(["domains", b], doc.createNode({ ...defA, keywords: normalizeKeywords([...(defA.keywords ?? []), a]) }));
        }
        doc.deleteIn(["domains", a]);
      });
      await this.commitPaths([...touched, "workspace.yaml"], `te: domain ${a} → ${b}`);
      return { items: users.map((i) => i.meta.id), merged };
    });
  }

  /** Remove a domain from every item and from the vocabulary. */
  deleteDomain(name: string, actor: Actor): Promise<{ items: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const n = normalizeDomain(name);
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const users = [...this.index.items.values()].filter((i) => i.meta.domains.includes(n));
      for (const it of users) {
        await this.rewriteItem(it.meta.id, (m) => ({ ...m, domains: m.domains.filter((d) => d !== n) }), [
          `- ${now} ${who} domain ${n} removed (domain deleted)`,
        ]);
      }
      await this.editWorkspaceYaml((doc) => {
        doc.deleteIn(["domains", n]);
      });
      await this.commitPaths([...users.map((i) => i.path), "workspace.yaml"], `te: domain ${n} deleted`);
      return { items: users.map((i) => i.meta.id) };
    });
  }

  /**
   * Write an item's plain-English version. Overlay: `<source>.simple.md`
   * (or the recorded simple_source) from the template, tagged and linked —
   * created or replaced as a whole, since it is derived from the task.
   * Standard mode: the `## Simple` section. Not a state change; any status.
   */
  setSimple(id: string, text: string, actor: Actor): Promise<{ path: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      if (!text.trim()) throw new ValidationError("simple text is empty");
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      const now = new Date().toISOString();
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now } as ItemMeta;
      let path = it.path;
      const sectionWrites: Array<{ heading: string; text: string }> = [];
      if (this.ws.config.mode === "overlay" && doc.meta.source) {
        if (doc.meta.simple_source) {
          // an existing companion stays the source of truth (TE-0178)
          const rel = doc.meta.simple_source;
          const abs = join(this.ws.root, rel);
          const out = renderSimpleFile(id, doc.meta.title, text);
          await writeFileAtomic(abs, out);
          this.onFileWrite?.(abs, out);
          path = rel;
        } else {
          // TE-0178: the simple version is a ## Simple section in the task file
          const found = await resolveSource(this.ws.root, id, doc.meta.source);
          if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
          const abs = join(this.ws.root, found.path);
          const out = replaceSection(found.text, "Simple", text.trim());
          await writeFileAtomic(abs, out);
          this.onFileWrite?.(abs, out);
          path = found.path;
        }
      } else {
        // standard mode: replace the Simple section wholesale
        doc.sections = doc.sections.filter((s) => s.heading.toLowerCase() !== "simple");
        sectionWrites.push({ heading: "Simple", text: text.trim() + "\n" });
      }
      await this.writeItemDoc(absItem, doc.raw.text, meta, [`- ${now} ${actor.session} wrote the simple version`], sectionWrites);
      await this.commitPaths([it.path], `te: ${id} simple by ${actor.session}`);
      if (path !== it.path) await this.stageTaskFiles([path]);
      await this.index.upsertFile(absItem);
      return { path };
    });
  }

  /**
   * Add a note (multi-line markdown) to the item: overlay → appended to the
   * task file's `## Notes` (found by its te: tag if it moved); standard → the
   * item's `## Notes` section. A short History line records who added it.
   */
  addNote(id: string, text: string, actor: Actor): Promise<{ path: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const note = text.replace(/\r\n/g, "\n").trim();
      if (!note) throw new ValidationError("note is empty");
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const block = `**${now.slice(0, 16).replace("T", " ")} · ${who}**\n\n${note}\n`;
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now } as ItemMeta;
      let path = it.path;
      const sectionWrites: Array<{ heading: string; text: string }> = [];
      if (this.ws.config.mode === "overlay" && doc.meta.source) {
        const found = await resolveSource(this.ws.root, id, doc.meta.source);
        if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
        const abs = join(this.ws.root, found.path);
        const out = appendNote(found.text, block);
        await writeFileAtomic(abs, out);
        this.onFileWrite?.(abs, out);
        path = found.path;
      } else {
        sectionWrites.push({ heading: "Notes", text: `\n${block}` });
      }
      const first = note.split("\n")[0];
      const summary = first.length > 80 ? `${first.slice(0, 80)}…` : first;
      await this.writeItemDoc(absItem, doc.raw.text, meta, [`- ${now} ${who} added a note: ${summary}`], sectionWrites);
      await this.commitPaths([it.path], `te: ${id} note by ${who}`);
      if (path !== it.path) await this.stageTaskFiles([path]);
      await this.index.upsertFile(absItem);
      return { path };
    });
  }

  /**
   * Attach a file to an item's `## Artifacts`. The source must resolve under
   * the workspace root; it is copied to
   * `.artifacts/<project>/<id-lowercase>-<basename>` unless it already sits
   * under `.artifacts/` (then it is only referenced). A `..` path, a file
   * outside the root, a disallowed type, a file over `artifacts.max_mb` or a
   * name clash with different content are refused. The list line is written
   * to the task file (overlay) or the item file (standard); attaching the
   * same path twice is a no-op. Any actor may attach — no claim, no state
   * change. `domains` equal to the item's own write no #tags, so the line
   * inherits the item's live domains instead of freezing a stale copy.
   */
  attachArtifact(
    id: string,
    a: { path: string; caption: string; domains?: string[]; sensitive?: boolean },
    actor: Actor,
  ): Promise<{ path: string; copied: boolean; already: boolean }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const caption = (a.caption ?? "").trim();
      if (!caption) throw new ValidationError("attach needs {path, caption} — the caption is empty");
      const given = (a.path ?? "").replace(/\\/g, "/");
      if (!given || given.split("/").includes("..")) {
        throw new ValidationError("attach: '..' is not allowed in the path");
      }
      const absSrc = resolve(this.ws.root, given);
      const underRoot = relative(this.ws.root, absSrc);
      if (underRoot.startsWith("..") || isAbsolute(underRoot)) {
        throw new ValidationError(`attach: ${a.path} is outside the task folder`);
      }
      const st = await stat(absSrc).catch(() => undefined);
      if (!st?.isFile()) throw new NotFoundError(`attach: file not found: ${a.path}`);
      const ext = extname(absSrc).slice(1).toLowerCase();
      if (!ARTIFACT_TYPES.has(ext)) {
        throw new ValidationError(
          `attach: .${ext || "?"} is not an allowed artifact type (png jpg webp gif svg pdf html md txt json csv)`,
        );
      }
      const maxMb = this.ws.config.artifacts.max_mb;
      if (st.size > maxMb * 1024 * 1024) {
        throw new ValidationError(
          `attach: ${a.path} is ${(st.size / 1048576).toFixed(1)} MB — over artifacts.max_mb (${maxMb} MB)`,
        );
      }

      const artifactsRoot = join(this.ws.root, ".artifacts");
      const inside = relative(artifactsRoot, absSrc);
      let rel: string;
      let copied = false;
      if (inside && !inside.startsWith("..") && !isAbsolute(inside)) {
        rel = inside.split(sep).join("/");
      } else {
        const project = it.meta.project ?? "_root";
        const safe = basename(absSrc).replace(/[^A-Za-z0-9._-]+/g, "-");
        rel = `${project}/${id.toLowerCase()}-${safe}`;
        const absDest = join(artifactsRoot, rel);
        if (existsSync(absDest)) {
          if (!(await readFile(absDest)).equals(await readFile(absSrc))) {
            throw new ConflictError(`attach: .artifacts/${rel} already exists with different content`);
          }
        } else {
          await mkdir(dirname(absDest), { recursive: true });
          await copyFile(absSrc, absDest);
          copied = true;
        }
      }

      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      // a #tag copy of the item's domains freezes a stale snapshot on the
      // line — write no own tags so the line inherits the live domains in
      // parseArtifacts (TE-0170); #tags are for artifact-specific domains
      const own = normalizeDomains(a.domains ?? []);
      const itemDomains = normalizeDomains(doc.meta.domains);
      const inherits =
        own.length === itemDomains.length && own.every((d) => itemDomains.includes(d));
      const tags = (inherits ? [] : own).map((d) => `#${d}`).join(" ");
      const line = `- ${rel} — ${caption}${tags ? ` ${tags}` : ""}${a.sensitive ? " !sensitive" : ""}`;
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now } as ItemMeta;
      const log = [`- ${now} ${who} attached .artifacts/${rel} — ${caption}`];
      if (this.ws.config.mode === "overlay" && doc.meta.source) {
        const found = await resolveSource(this.ws.root, id, doc.meta.source);
        if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
        const existing = parseArtifacts(sectionBody(found.text, "Artifacts"));
        if (existing.some((x) => x.path === rel)) return { path: rel, copied, already: true };
        const out = appendSection(found.text, "Artifacts", line);
        const abs = join(this.ws.root, found.path);
        await writeFileAtomic(abs, out);
        this.onFileWrite?.(abs, out);
        await this.writeItemDoc(absItem, doc.raw.text, meta, log);
        await this.commitPaths([it.path], `te: ${id} attach ${rel} by ${who}`);
        await this.stageTaskFiles([found.path]);
      } else {
        if (doc.artifacts.some((x) => x.path === rel)) return { path: rel, copied, already: true };
        await this.writeItemDoc(absItem, doc.raw.text, meta, log, [
          { heading: "Artifacts", text: `${line}\n` },
        ]);
        await this.commitPaths([it.path], `te: ${id} attach ${rel} by ${who}`);
      }
      if (copied) await this.stageTaskFiles([`.artifacts/${rel}`]);
      await this.index.upsertFile(absItem);
      return { path: rel, copied, already: false };
    });
  }

  /**
   * Remove one `## Artifacts` line — the file on disk stays. Refused when the
   * item has no artifact with that path.
   */
  detachArtifact(id: string, path: string, actor: Actor): Promise<{ path: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const want = (path ?? "").trim();
      if (!want) throw new ValidationError("detach needs {path}");
      const isLine = (l: string) => /^-\s+(\S+)\s+[—–]/.exec(l.trim())?.[1] === want;
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now } as ItemMeta;
      const log = [`- ${now} ${who} detached .artifacts/${want}`];
      const commit = `te: ${id} detach ${want} by ${who}`;
      if (this.ws.config.mode === "overlay" && doc.meta.source) {
        const found = await resolveSource(this.ws.root, id, doc.meta.source);
        if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
        const out = removeSectionLines(found.text, "Artifacts", isLine);
        if (out === undefined) throw new NotFoundError(`${id}: no artifact '${want}' in ## Artifacts`);
        const abs = join(this.ws.root, found.path);
        await writeFileAtomic(abs, out);
        this.onFileWrite?.(abs, out);
        await this.writeItemDoc(absItem, doc.raw.text, meta, log);
        await this.commitPaths([it.path], commit);
        await this.stageTaskFiles([found.path]);
      } else {
        const out = removeSectionLines(doc.raw.text, "Artifacts", isLine);
        if (out === undefined) throw new NotFoundError(`${id}: no artifact '${want}' in ## Artifacts`);
        await this.writeItemDoc(absItem, out, meta, log);
        await this.commitPaths([it.path], commit);
      }
      await this.index.upsertFile(absItem);
      return { path: want };
    });
  }

  /**
   * Write a discussion's raw transcript (TE-0157). Overlay: next to the
   * DISC file as `<same name>.transcript.md`; non-overlay: under
   * `.artifacts/<project>/<id>.transcript.md`. The discussion's
   * `## Artifacts` gets a line that points at it (`!sensitive` when set).
   * The size cap and the secret scan run in ops before this write.
   */
  captureTranscript(
    id: string,
    a: { content: string; caption: string; sensitive?: boolean },
    actor: Actor,
  ): Promise<{ path: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      if (it.meta.type !== "discussion") {
        throw new ValidationError(`captureTranscript: ${id} is a ${it.meta.type}, not a discussion`);
      }
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now } as ItemMeta;
      const log = [`- ${now} ${who} saved the raw transcript`];

      if (this.ws.config.mode === "overlay" && doc.meta.source) {
        const found = await resolveSource(this.ws.root, id, doc.meta.source);
        if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
        const rel = found.path.replace(/\.md$/i, ".transcript.md");
        const tAbs = join(this.ws.root, rel);
        await writeFileAtomic(tAbs, a.content);
        this.onFileWrite?.(tAbs, a.content);
        const line = `- ${rel} — ${a.caption}${a.sensitive ? " !sensitive" : ""}`;
        const out = appendSection(found.text, "Artifacts", line);
        const abs = join(this.ws.root, found.path);
        await writeFileAtomic(abs, out);
        this.onFileWrite?.(abs, out);
        await this.writeItemDoc(absItem, doc.raw.text, meta, log);
        await this.commitPaths([it.path], `te: ${id} capture transcript by ${who}`);
        await this.stageTaskFiles([found.path, rel]);
        await this.index.upsertFile(absItem);
        return { path: rel };
      }

      // non-overlay: the transcript lives under .artifacts/ like other files
      const project = it.meta.project ?? "_root";
      const rel = `${project}/${id.toLowerCase()}.transcript.md`;
      const tAbs = join(this.ws.root, ".artifacts", rel);
      await mkdir(dirname(tAbs), { recursive: true });
      await writeFileAtomic(tAbs, a.content);
      this.onFileWrite?.(tAbs, a.content);
      const line = `- ${rel} — ${a.caption}${a.sensitive ? " !sensitive" : ""}`;
      await this.writeItemDoc(absItem, doc.raw.text, meta, log, [
        { heading: "Artifacts", text: `${line}\n` },
      ]);
      await this.commitPaths([it.path], `te: ${id} capture transcript by ${who}`);
      await this.stageTaskFiles([`.artifacts/${rel}`]);
      await this.index.upsertFile(absItem);
      return { path: rel };
    });
  }

  /**
   * Record a promotion candidate on a discussion (TE-0160): the pending
   * entry lands in `meta.promotions` (a passthrough field) and the
   * `## Actions` line that names it goes into the DISC file in overlay
   * mode, the item file otherwise.
   */
  recordPromotion(
    id: string,
    a: { promo: Record<string, unknown>; action_line: string },
    actor: Actor,
  ): Promise<ItemMeta> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      const promotions = [...((doc.meta.promotions as unknown[] | undefined) ?? []), a.promo];
      const meta = {
        ...doc.meta,
        promotions,
        version: doc.meta.version + 1,
        updated: now,
      } as ItemMeta;
      const log = [`- ${now} ${who} promoted a line → ${(a.promo as { to?: string }).to ?? "?"}`];
      let path: string | undefined;
      if (this.ws.config.mode === "overlay" && doc.meta.source) {
        const found = await resolveSource(this.ws.root, id, doc.meta.source);
        if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
        const out = appendSection(found.text, "Actions", a.action_line);
        const abs = join(this.ws.root, found.path);
        await writeFileAtomic(abs, out);
        this.onFileWrite?.(abs, out);
        path = found.path;
        await this.writeItemDoc(absItem, doc.raw.text, meta, log);
      } else {
        await this.writeItemDoc(absItem, doc.raw.text, meta, log, [
          { heading: "Actions", text: `${a.action_line}\n` },
        ]);
      }
      await this.commitPaths([it.path], `te: ${id} promote by ${who}`);
      if (path) await this.stageTaskFiles([path]);
      await this.index.upsertFile(absItem);
      return meta;
    });
  }

  /**
   * Settle a pending promotion (TE-0160): mark it approved/rejected in
   * `meta.promotions` and append the result line to `## Actions`. The
   * materialization (lesson line, decision file) is the caller's.
   */
  settlePromotion(
    id: string,
    n: number,
    a: { state: "approved" | "rejected" | "pending"; action_line: string; commit_extra?: string[] },
    actor: Actor,
  ): Promise<ItemMeta> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      const promotions = ((doc.meta.promotions as Array<Record<string, unknown>> | undefined) ?? []).map(
        (p) => (p.n === n ? { ...p, state: a.state } : p),
      );
      const meta = {
        ...doc.meta,
        promotions,
        version: doc.meta.version + 1,
        updated: now,
      } as ItemMeta;
      const log = [`- ${now} ${who} ${a.state} promotion #${n}`];
      let path: string | undefined;
      if (this.ws.config.mode === "overlay" && doc.meta.source) {
        const found = await resolveSource(this.ws.root, id, doc.meta.source);
        if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
        const out = appendSection(found.text, "Actions", a.action_line);
        const abs = join(this.ws.root, found.path);
        await writeFileAtomic(abs, out);
        this.onFileWrite?.(abs, out);
        path = found.path;
        await this.writeItemDoc(absItem, doc.raw.text, meta, log);
      } else {
        await this.writeItemDoc(absItem, doc.raw.text, meta, log, [
          { heading: "Actions", text: `${a.action_line}\n` },
        ]);
      }
      // plansDir-relative extras (an approved lesson's file) commit with the item
      await this.commitPaths(
        [it.path, ...(a.commit_extra ?? [])],
        `te: ${id} promotion #${n} ${a.state} by ${who}`,
      );
      if (path) await this.stageTaskFiles([path]);
      await this.index.upsertFile(absItem);
      return meta;
    });
  }

  /**
   * Change a draft's scope in its task file (overlay): replace the
   * `**Touches:**` line and/or append `## Acceptance` items. The status gate
   * (draft only) and who may do it live in ops; this is the write.
   */
  rescope(
    id: string,
    change: { touches?: string[]; addAcceptance?: string[]; reason: string },
    actor: Actor,
  ): Promise<{ path: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      if (doc.meta.status !== "draft") {
        throw new InvalidTransitionError(`rescope: ${id} is ${doc.meta.status} — only drafts can change scope`, doc.meta.status, "rescope");
      }
      if (this.ws.config.mode !== "overlay" || !doc.meta.source) {
        throw new ValidationError("rescope works on task-folder (overlay) items with a task file");
      }
      const found = await resolveSource(this.ws.root, id, doc.meta.source);
      if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
      let out = found.text;
      if (change.touches) out = setTouches(out, change.touches);
      if (change.addAcceptance?.length) {
        const items = change.addAcceptance.map((a) => `- [ ] ${a.replace(/^-\s*(\[[ x]\]\s*)?/i, "")}`);
        out = appendSection(out, "Acceptance", items.join("\n"));
      }
      const abs = join(this.ws.root, found.path);
      await writeFileAtomic(abs, out);
      this.onFileWrite?.(abs, out);
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now } as ItemMeta;
      const what = [
        change.touches ? `touches → ${change.touches.join("; ")}` : "",
        change.addAcceptance?.length ? `+${change.addAcceptance.length} acceptance` : "",
      ].filter(Boolean).join(", ");
      await this.writeItemDoc(absItem, doc.raw.text, meta, [`- ${now} ${who} rescoped (${what}): ${change.reason}`]);
      await this.commitPaths([it.path], `te: ${id} rescope by ${who}`);
      await this.stageTaskFiles([found.path]);
      await this.index.upsertFile(absItem);
      return { path: found.path };
    });
  }

  /**
   * Rewrite a draft: any of title, summary, acceptance (replaces the
   * checklist), touches, depends_on, parent, targets, tier, domains and
   * `## <heading>` sections (protected ones refused). The draft gate and
   * reference checks live in ops; this is the write. Overlay mode edits the
   * task file's header lines and sections; standard mode the item's own
   * sections. The status stays `draft` — the human re-approves.
   */
  editDraft(
    id: string,
    change: {
      reason: string;
      title?: string;
      summary?: string;
      acceptance?: string[];
      touches?: string[];
      depends_on?: string[];
      parent?: string | null;
      relates?: string[];
      found_by?: string[];
      targets?: string[];
      tier?: "light" | "standard" | "heavy" | null;
      domains?: string[];
      sections?: Record<string, string>;
      /** replaces the `## Checks` section (GL-0348); [] clears it */
      checks?: Check[] | null;
    },
    actor: Actor,
  ): Promise<{ path?: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      if (doc.meta.status !== "draft") {
        throw new InvalidTransitionError(`edit: ${id} is ${doc.meta.status} — only drafts can be edited`, doc.meta.status, "edit");
      }
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now } as ItemMeta;
      const what: string[] = [];
      if (change.title && change.title !== doc.meta.title) {
        meta.title = change.title;
        what.push("title");
      }
      if (change.depends_on) {
        meta.depends_on = change.depends_on;
        what.push(`depends_on → ${change.depends_on.join(", ") || "nothing"}`);
      }
      if (change.parent !== undefined) {
        if (change.parent) meta.parent = change.parent;
        else delete meta.parent;
        what.push(`parent → ${change.parent ?? "cleared"}`);
      }
      if (change.relates) {
        meta.relates = change.relates;
        what.push(`relates → ${change.relates.join(", ") || "nothing"}`);
      }
      if (change.found_by) {
        if (change.found_by.length) meta.found_by = change.found_by;
        else delete meta.found_by;
        what.push(`found_by → ${change.found_by.join(", ") || "nothing"}`);
      }
      if (change.targets) {
        meta.targets = change.targets;
        what.push("targets");
      }
      if (change.tier !== undefined) {
        if (change.tier) meta.tier = change.tier;
        else delete meta.tier;
        what.push(`tier → ${change.tier ?? "any"}`);
      }
      if (change.domains) {
        meta.domains = normalizeDomains(change.domains);
        what.push("domains");
      }
      if (change.domains) await this.ensureDomains(meta.domains);
      const checklist = (a: string[]) =>
        a.map((c) => `- [ ] ${c.replace(/^-\s*(\[[ x]\]\s*)?/i, "")}`).join("\n");
      const sections = Object.entries(change.sections ?? {}).map(([h, b]) => {
        const heading = h.replace(/^#+\s*/, "").trim();
        if (!heading) throw new ValidationError("edit: empty section heading");
        if (PROTECTED_SECTIONS.has(heading.toLowerCase())) {
          throw new ValidationError(`edit: "## ${heading}" is managed by TeamEngage — not editable`);
        }
        return [heading, b] as [string, string];
      });
      const overlay = this.ws.config.mode === "overlay" && doc.meta.source;
      if (change.touches && !overlay) {
        throw new ValidationError("edit: touches is the task file's **Touches:** line — task-folder items only");
      }
      const bodyEdits: Array<[string, string]> = [];
      const clearSections: string[] = [];
      if (change.summary !== undefined) {
        bodyEdits.push(["Summary", change.summary]);
        what.push("summary");
      }
      if (change.acceptance) {
        bodyEdits.push(["Acceptance", checklist(change.acceptance)]);
        what.push("acceptance");
      }
      if (change.checks !== undefined) {
        if (change.checks && change.checks.length) bodyEdits.push(["Checks", renderChecks(change.checks)]);
        else clearSections.push("Checks");
        what.push(`checks → ${change.checks?.length ?? 0}`);
      }
      for (const [h, b] of sections) {
        bodyEdits.push([h, b]);
        what.push(`## ${h}`);
      }
      let path: string | undefined;
      let itemText = doc.raw.text;
      if (overlay) {
        const found = await resolveSource(this.ws.root, id, doc.meta.source);
        if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
        let out = found.text;
        if (change.title) out = setTitleLine(out, change.title);
        if (change.depends_on) out = setDependsLine(out, change.depends_on);
        if (change.parent !== undefined) out = setParentLine(out, change.parent ?? undefined);
        if (change.relates) out = setRelatesLine(out, change.relates);
        if (change.found_by) out = setFoundByLine(out, change.found_by);
        if (change.touches) {
          out = setTouches(out, change.touches);
          what.push("touches");
        }
        for (const [h, b] of bodyEdits) out = replaceSection(out, h, b);
        for (const h of clearSections) out = removeSection(out, h);
        const abs = join(this.ws.root, found.path);
        await writeFileAtomic(abs, out);
        this.onFileWrite?.(abs, out);
        path = found.path;
      } else {
        for (const [h, b] of bodyEdits) itemText = replaceSection(itemText, h, b);
        for (const h of clearSections) itemText = removeSection(itemText, h);
      }
      await this.writeItemDoc(absItem, itemText, meta, [
        `- ${now} ${who} edited the draft (${what.join(", ") || "no changes"}): ${change.reason}`,
      ]);
      await this.commitPaths([it.path], `te: ${id} edit by ${who}`);
      if (path) await this.stageTaskFiles([path]);
      await this.index.upsertFile(absItem);
      return { path };
    });
  }

  /**
   * Set an item's depends_on (human — callers check). Refs are validated in
   * ops (existence, self, cycles). Overlay mode rewrites the task file's
   * `**Depends on:**` line so doc and meta stay in sync.
   */
  setDepends(id: string, dependsOn: string[], actor: Actor): Promise<{ depends_on: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const same =
        it.meta.depends_on.length === dependsOn.length &&
        it.meta.depends_on.every((r, i) => r === dependsOn[i]);
      if (same) return { depends_on: dependsOn };
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const what = dependsOn.length ? dependsOn.join(", ") : "nothing";
      await this.rewriteItem(id, (m) => ({ ...m, depends_on: dependsOn }), [
        `- ${now} ${who} depends_on → ${what}`,
      ]);
      if (this.ws.config.mode === "overlay" && it.meta.source) {
        const found = await resolveSource(this.ws.root, id, it.meta.source);
        if (found) {
          const out = setDependsLine(found.text, dependsOn);
          if (out !== found.text) {
            const abs = join(this.ws.root, found.path);
            await writeFileAtomic(abs, out);
            this.onFileWrite?.(abs, out);
            await this.stageTaskFiles([found.path]);
          }
        }
      }
      await this.commitPaths([it.path], `te: ${id} depends_on → ${what}`);
      return { depends_on: dependsOn };
    });
  }

  /**
   * Set an item's relates (human — callers check). Loose references only —
   * no ordering, no cycle checks; refs are validated in ops. Overlay mode
   * rewrites the task file's `**Relates:**` line so doc and meta stay in sync.
   */
  setRelates(id: string, relates: string[], actor: Actor): Promise<{ relates: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const same =
        it.meta.relates.length === relates.length &&
        it.meta.relates.every((r, i) => r === relates[i]);
      if (same) return { relates };
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const what = relates.length ? relates.join(", ") : "nothing";
      await this.rewriteItem(id, (m) => ({ ...m, relates }), [
        `- ${now} ${who} relates → ${what}`,
      ]);
      if (this.ws.config.mode === "overlay" && it.meta.source) {
        const found = await resolveSource(this.ws.root, id, it.meta.source);
        if (found) {
          const out = setRelatesLine(found.text, relates);
          if (out !== found.text) {
            const abs = join(this.ws.root, found.path);
            await writeFileAtomic(abs, out);
            this.onFileWrite?.(abs, out);
            await this.stageTaskFiles([found.path]);
          }
        }
      }
      await this.commitPaths([it.path], `te: ${id} relates → ${what}`);
      return { relates };
    });
  }

  /**
   * Set an item's found_by (human — callers check). Loose references only —
   * no ordering, no gate. Overlay mode rewrites the task file's
   * `**Found by:**` line so doc and meta stay in sync. `[]` removes the key.
   */
  setFoundBy(id: string, foundBy: string[], actor: Actor): Promise<{ found_by: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const cur = it.meta.found_by ?? [];
      if (cur.length === foundBy.length && cur.every((r, i) => r === foundBy[i])) return { found_by: foundBy };
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const what = foundBy.length ? foundBy.join(", ") : "nothing";
      await this.rewriteItem(
        id,
        (m) => {
          const { found_by: _old, ...rest } = m;
          return (foundBy.length ? { ...rest, found_by: foundBy } : rest) as typeof m;
        },
        [`- ${now} ${who} found_by → ${what}`],
      );
      if (this.ws.config.mode === "overlay" && it.meta.source) {
        const found = await resolveSource(this.ws.root, id, it.meta.source);
        if (found) {
          const out = setFoundByLine(found.text, foundBy);
          if (out !== found.text) {
            const abs = join(this.ws.root, found.path);
            await writeFileAtomic(abs, out);
            this.onFileWrite?.(abs, out);
            await this.stageTaskFiles([found.path]);
          }
        }
      }
      await this.commitPaths([it.path], `te: ${id} found_by → ${what}`);
      return { found_by: foundBy };
    });
  }

  /**
   * Remove a daemon-written note block, identified by its `**ts · who**`
   * header (`body` disambiguates same-minute notes by one author). Overlay →
   * the task file's `## Notes`; standard → the item's `## Notes` section.
   * A History line records who removed it.
   */
  removeNote(id: string, note: { ts: string; who: string; body?: string }, actor: Actor): Promise<{ path: string }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const it = this.index.get(id);
      if (!it) throw new NotFoundError(`item ${id} not found`);
      const now = new Date().toISOString();
      const who = actor.kind === "human" ? "human" : actor.session;
      const absItem = join(this.ws.plansDir, it.path);
      const doc = parseItemFile(await readFile(absItem, "utf8"), absItem);
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now } as ItemMeta;
      let path = it.path;
      let text = doc.raw.text;
      if (this.ws.config.mode === "overlay" && doc.meta.source) {
        const found = await resolveSource(this.ws.root, id, doc.meta.source);
        if (!found) throw new NotFoundError(`${id}: task file ${doc.meta.source} not found`);
        const out = removeNote(found.text, note);
        if (out === undefined) throw new NotFoundError("note not found");
        const abs = join(this.ws.root, found.path);
        await writeFileAtomic(abs, out);
        this.onFileWrite?.(abs, out);
        path = found.path;
      } else {
        const out = removeNote(doc.raw.text, note);
        if (out === undefined) throw new NotFoundError("note not found");
        text = out;
      }
      await this.writeItemDoc(absItem, text, meta, [`- ${now} ${who} removed a note (${note.ts} · ${note.who})`]);
      await this.commitPaths([it.path], `te: ${id} note removed by ${who}`);
      if (path !== it.path) await this.stageTaskFiles([path]);
      await this.index.upsertFile(absItem);
      return { path };
    });
  }

  /** Overlay mode: write `te: <id>` into a task file's frontmatter. */
  private async tagSource(rel: string, id: string): Promise<boolean> {
    const abs = join(this.ws.root, rel);
    if (!existsSync(abs)) return false;
    const text = await readFile(abs, "utf8");
    const out = withTeTag(text, id);
    if (out === text) return false;
    await writeFileAtomic(abs, out);
    this.onFileWrite?.(abs, out);
    return true;
  }

  private items(): { metaIds: () => string[] } {
    return { metaIds: () => [...this.index.items.keys()] };
  }

  /**
   * Commit specific paths (+deletions) in the plans repo; skips when no repo,
   * nothing changed, or the workspace leaves committing to the human
   * (`commit: false`).
   */
  /**
   * `git add` (and `git rm --cached` for deletes) without committing. Paths
   * are relative to the plans dir; task files outside it are given as
   * `../global/TASK-…md`. Best effort: staging must never fail a write.
   */
  private async stagePaths(paths: string[], deletes: string[] = []): Promise<void> {
    if (!(await isRepo(this.ws.plansDir))) return;
    const onDisk = [...new Set(paths)].filter((p) => existsSync(join(this.ws.plansDir, p)));
    try {
      if (onDisk.length) await git(this.ws.plansDir, ["add", "--", ...onDisk]);
      for (const d of deletes) {
        await git(this.ws.plansDir, ["rm", "-q", "--cached", "--ignore-unmatch", "--", d]).catch(() => {});
      }
    } catch {
      /* index busy (the human is running git) — the next write stages again */
    }
  }

  /** Stage task files TeamEngage wrote (workspace-root relative) — never committed by the daemon. */
  private async stageTaskFiles(rootRelPaths: string[]): Promise<void> {
    await this.stagePaths(rootRelPaths.map((p) => relative(this.ws.plansDir, join(this.ws.root, p))));
  }

  /** Non-item plan-file writes get the same commit/stage treatment. */
  async commitPlanFiles(paths: string[], message: string, deletes: string[] = []): Promise<void> {
    await this.commitPaths(paths, message, deletes);
  }

  private async commitPaths(paths: string[], message: string, deletes: string[] = []): Promise<void> {
    if (!this.ws.config.commit) {
      // the human commits — but nothing TeamEngage writes is left untracked
      await this.stagePaths(paths, deletes);
      return;
    }
    if (!(await isRepo(this.ws.plansDir))) return;
    const rel = paths.map((p) => relative(this.ws.plansDir, join(this.ws.plansDir, p)));
    const onDisk = rel.filter((p) => existsSync(join(this.ws.plansDir, p)));
    if (onDisk.length) await git(this.ws.plansDir, ["add", "--", ...onDisk]);
    for (const d of deletes) {
      try {
        await git(this.ws.plansDir, ["rm", "-q", "--", d]);
      } catch {
        /* already gone or never tracked */
      }
    }
    const staged = new Set(
      (await git(this.ws.plansDir, ["diff", "--cached", "--name-only"]))
        .split("\n")
        .filter(Boolean),
    );
    // commit only intended paths that were actually staged: a never-tracked
    // deleted path is not "known to git" and would fail the pathspec
    const ours = [...new Set([...rel, ...deletes])].filter((p) => staged.has(p));
    if (!ours.length) return;
    // pathspec: never sweep unrelated staged files into a te: commit
    await git(this.ws.plansDir, ["commit", "-m", message, "--", ...ours]);
    this.onCommit?.();
  }
}

function decisionFile(
  id: string,
  title: string,
  item: string,
  actor: Actor,
  now: string,
  prev?: DecisionMeta,
  q?: Question,
  processed?: string,
): string {
  // a changed answer keeps its id, creation date and question; version +1
  const question = q?.text ?? (prev?.question as string | undefined);
  const options = q?.options ?? (prev?.options as string[] | undefined);
  const done = processed ?? (prev?.processed as string | undefined);
  const meta = {
    id,
    title,
    item,
    decided_by: actor.kind === "human" ? "human" : actor.session,
    created: prev?.created ?? now.slice(0, 10),
    version: (prev?.version ?? 0) + 1,
    ...(question ? { question } : {}),
    ...(options?.length ? { options } : {}),
    ...(done ? { processed: done } : {}),
  };
  const asked = question
    ? question + (options?.length ? "\n\nOptions:\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n") : "")
    : `See ${item}.`;
  return `${emitFrontmatter(meta)}\n## Question\n${asked}\n\n## Answer\n${title}\n`;
}
