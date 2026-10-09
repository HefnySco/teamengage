import { readFile } from "node:fs/promises";
import type { Document as YamlDocument } from "yaml";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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
import { withTeTag, withoutTeTag, toSourcePath, appendNote, resolveSource } from "../../core/files/source.js";
import { normalizeDomain, normalizeDomains, type DomainDef } from "../../core/domains/domains.js";

/** keywords: trimmed, lowercase, unique. */
const normalizeKeywords = (k: string[]) => [...new Set(k.map((w) => w.trim().toLowerCase()).filter(Boolean))];
import {
  filePrefix,
  nextTaskNumber,
  renderSimpleFile,
  renderTaskFile,
  taskFileName,
} from "../../core/files/template.js";
import { claimToYaml } from "../../core/claims/claims.js";
import { transition, type Action, type Actor, type Effect } from "../../core/state/machine.js";
import { DecisionMeta, type Event, type ItemMeta } from "../../core/model/index.js";
import type { Claim } from "../../core/model/claim.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/model/errors.js";
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
      summary?: string;
      acceptance?: string[];
      touches?: string[];
      simple?: string;
      domains?: string[];
    }>,
    actor: Actor,
  ): Promise<{ ids: string[]; files: string[] }> {
    return this.enqueue(async () => {
      await this.assertReady();
      await this.plansRepoHealthy();
      const { ItemMeta } = await import("../../core/model/item.js");
      const { allocateId, idPrefix } = await import("../../core/address/refs.js");
      const overlay = this.ws.config.mode === "overlay";
      const ids: string[] = [];
      const files: string[] = [];
      const writes: Array<{ rel: string; content: string }> = [];
      const taskWrites: Array<{ abs: string; content: string }> = [];
      const taken = new Map<string, number[]>(); // folder+prefix → numbers used in this batch
      const now = new Date().toISOString().slice(0, 10);
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
        };
        const project = d.project;
        const prefix = project
          ? this.ws.config.projects[project]?.prefix
          : this.ws.config.prefix;
        if (!prefix) throw new NotFoundError(`unknown project '${project}'`);
        const id = allocateId(prefix, [...this.items().metaIds(), ...ids]);
        let source: string | undefined;
        let simpleSource: string | undefined;
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
          if (d.simple?.trim()) {
            const simpleName = name.replace(/\.md$/, ".simple.md");
            simpleSource = toSourcePath(this.ws.root, join(abs, simpleName));
            taskWrites.push({ abs: join(abs, simpleName), content: renderSimpleFile(id, d.title, d.simple) });
          }
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
          domains: normalizeDomains(d.domains ?? []),
          priority: 2,
          version: 1,
          created: now,
          updated: now,
          ...(source ? { source, simple_source: simpleSource } : {}),
        });
        let body = "";
        if (!overlay) {
          body = `\n## Summary\n${d.summary ?? d.title}\n`;
          if (d.acceptance?.length) {
            body += `\n## Acceptance\n${d.acceptance.map((a) => `- [ ] ${a}`).join("\n")}\n`;
          }
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
        for (const d of items) {
          if (!created.includes(d.id)) continue;
          for (const rel of [d.source, d.simple_source]) {
            if (rel) await this.tagSource(rel, d.id);
          }
        }
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
          updated: now.slice(0, 10),
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
    const meta = { ...next, version: doc.meta.version + 1, updated: new Date().toISOString().slice(0, 10) } as ItemMeta;
    await this.writeItemDoc(abs, doc.raw.text, meta, lines);
    await this.index.upsertFile(abs);
    return true;
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
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now.slice(0, 10) } as ItemMeta;
      let path = it.path;
      const sectionWrites: Array<{ heading: string; text: string }> = [];
      if (this.ws.config.mode === "overlay" && doc.meta.source) {
        const rel = doc.meta.simple_source ?? doc.meta.source.replace(/\.md$/i, ".simple.md");
        const abs = join(this.ws.root, rel);
        const out = renderSimpleFile(id, doc.meta.title, text);
        await writeFileAtomic(abs, out);
        this.onFileWrite?.(abs, out);
        meta.simple_source = rel;
        path = rel;
      } else {
        // standard mode: replace the Simple section wholesale
        doc.sections = doc.sections.filter((s) => s.heading.toLowerCase() !== "simple");
        sectionWrites.push({ heading: "Simple", text: text.trim() + "\n" });
      }
      await this.writeItemDoc(absItem, doc.raw.text, meta, [`- ${now} ${actor.session} wrote the simple version`], sectionWrites);
      await this.commitPaths([it.path], `te: ${id} simple by ${actor.session}`);
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
      const meta = { ...doc.meta, version: doc.meta.version + 1, updated: now.slice(0, 10) } as ItemMeta;
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
      await this.index.upsertFile(absItem);
      return { path };
    });
  }

  /** Overlay mode: write `te: <id>` into a task file's frontmatter. */
  private async tagSource(rel: string, id: string): Promise<void> {
    const abs = join(this.ws.root, rel);
    if (!existsSync(abs)) return;
    const text = await readFile(abs, "utf8");
    const out = withTeTag(text, id);
    if (out === text) return;
    await writeFileAtomic(abs, out);
    this.onFileWrite?.(abs, out);
  }

  private items(): { metaIds: () => string[] } {
    return { metaIds: () => [...this.index.items.keys()] };
  }

  /**
   * Commit specific paths (+deletions) in the plans repo; skips when no repo,
   * nothing changed, or the workspace leaves committing to the human
   * (`commit: false`).
   */
  private async commitPaths(paths: string[], message: string, deletes: string[] = []): Promise<void> {
    if (!this.ws.config.commit) return;
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
