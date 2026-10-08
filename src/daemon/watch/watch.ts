import { watch, type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { parseItemFile, serializeMarkdown } from "../../core/files/markdown.js";
import { ConflictMarkersError, TeError } from "../../core/model/errors.js";
import { validate, type Finding } from "../../core/validate/validate.js";
import { writeFileAtomic } from "../store/atomic.js";
import { resourceRoots } from "../../core/config/config.js";
import type { PlansStore } from "../store/store.js";

/**
 * File watcher (DESIGN §6.2 "Human edits"). The daemon's own writes are
 * suppressed via content-hash tracking; a human edit is accepted as a write
 * by `human` (version bumped, event recorded, re-indexed). Files that fail
 * to parse — including git conflict markers — are marked invalid in the
 * index and surfaced as findings; the daemon never rewrites them.
 */

export interface WatchEvent {
  kind: "human_edit" | "invalid" | "removed" | "claim_change";
  path: string;
  item?: string;
  message?: string;
}

export interface PlansWatcherOpts {
  debounceMs?: number;
  onEvent?: (e: WatchEvent) => void;
  /** stale_after for claim staleness findings. */
  staleAfterMs?: number;
}

const DELETED = "#deleted"; // sentinel — never a valid sha256 hex

export class PlansWatcher {
  private watcher!: FSWatcher;
  private ownWrites = new Map<string, string>(); // path → content hash | DELETED
  private pending = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(
    private store: PlansStore,
    private opts: PlansWatcherOpts = {},
  ) {}

  /**
   * Call after the store writes a file so its own change event is ignored.
   * content=null marks a daemon-side delete (suppresses the unlink event).
   */
  markOwnWrite(path: string, content: string | null): void {
    this.ownWrites.set(
      path,
      content === null ? DELETED : createHash("sha256").update(content).digest("hex"),
    );
  }

  async start(): Promise<void> {
    const plans = this.store.ws.plansDir;
    // the store tells us about its own writes so we never re-detect them
    this.store.onFileWrite = (p, c) => this.markOwnWrite(p, c);
    this.watcher = watch(plans, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignored: (p) =>
        /(^|\/)\.git(\/|$)/.test(p) ||
        p.includes("/events/") ||
        p.includes("/worktrees/") ||
        basename(p).endsWith(".tmp"),
      depth: 3,
    });
    const onChange = (path: string) => this.debounce(path);
    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);
    this.watcher.on("unlink", (path) => {
      // only a delete mark suppresses unlink — a pending write mark belongs
      // to a change event, and a stale one is useless once the file's gone
      const mark = this.ownWrites.get(path);
      this.ownWrites.delete(path);
      if (mark === DELETED) return; // the store deleted it
      if (this.isItemFile(path)) {
        this.store.enqueue(async () => {
          this.store.idx.removeFile(path);
          this.emit({ kind: "removed", path });
        }).catch(() => {});
      }
      if (this.isClaimFile(path)) {
        this.store.enqueue(async () => {
          const item = basename(path, ".yaml");
          this.store.idx.setClaim(null, item);
          this.emit({ kind: "claim_change", path, item });
        }).catch(() => {});
      }
    });
    await new Promise<void>((res) => this.watcher.on("ready", res));
  }

  private isItemFile(p: string) {
    return p.endsWith(".md") && p.includes("/items/");
  }

  private isClaimFile(p: string) {
    return p.endsWith(".yaml") && p.includes("/claims/") && basename(p) !== "workspace.yaml";
  }

  private isDecisionFile(p: string) {
    return p.endsWith(".md") && p.includes("/decisions/");
  }

  private debounce(path: string): void {
    if (this.closed) return;
    if (!this.isItemFile(path) && !this.isClaimFile(path) && !this.isDecisionFile(path)) return;
    const t = this.pending.get(path);
    if (t) clearTimeout(t);
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path);
        void this.handle(path).catch(() => {});
      }, this.opts.debounceMs ?? 300),
    );
  }

  private async handle(path: string): Promise<void> {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return;
    // suppress the daemon's own writes (content-identical). A DELETED mark is
    // stale here — the file exists, so process it; a pending unlink (if any)
    // is ordered after this change anyway.
    const mark = this.ownWrites.get(path);
    if (mark !== undefined) this.ownWrites.delete(path);
    const hash = createHash("sha256").update(text).digest("hex");
    if (mark !== undefined && mark !== DELETED && mark === hash) return;
    if (this.isClaimFile(path)) {
      await this.store.enqueue(async () => {
        try {
          const { parseClaimFile } = await import("../../core/claims/claims.js");
          this.store.idx.setClaim(parseClaimFile(text, path));
          this.emit({ kind: "claim_change", path, item: basename(path, ".yaml") });
        } catch (e) {
          this.emit({ kind: "invalid", path, message: (e as Error).message });
        }
      });
      return;
    }
    if (!this.isItemFile(path)) return; // decisions: index already scans on demand

    await this.store.enqueue(async () => {
      try {
        const doc = parseItemFile(text, path);
        // human edit accepted: bump version, write back as actor human
        doc.meta.version += 1;
        doc.meta.updated = new Date().toISOString().slice(0, 10);
        const out = serializeMarkdown(doc);
        await writeFileAtomic(path, out);
        this.markOwnWrite(path, out);
        await this.store.idx.upsertFile(path);
        this.emit({ kind: "human_edit", path, item: doc.meta.id });
      } catch (e) {
        if (e instanceof ConflictMarkersError) {
          this.store.idx.invalidFiles.set(path, e.message);
          this.emit({ kind: "invalid", path, message: "conflict markers — not rewriting" });
        } else if (e instanceof TeError) {
          this.store.idx.invalidFiles.set(path, e.message);
          this.emit({ kind: "invalid", path, message: e.message });
        } else {
          throw e;
        }
      }
    });
  }

  /** Current findings for the inbox (validator + invalid files). */
  findings(): Finding[] {
    return validate(this.store.idx, {
      staleAfterMs: this.opts.staleAfterMs,
      roots: resourceRoots(this.store.ws),
    });
  }

  private emit(e: WatchEvent): void {
    this.opts.onEvent?.(e);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.pending.values()) clearTimeout(t);
    await this.watcher?.close();
  }
}
