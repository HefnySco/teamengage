import { watch, type FSWatcher } from "chokidar";
import { basename } from "node:path";
import { scanTaskTree, overlayReport, type OverlayFinding } from "../../core/files/source.js";
import type { PlansStore } from "../store/store.js";

/**
 * Overlay-mode task-file tracker. Watches the task folder (outside the plans
 * dir) and, on any `.md` add/change/move/delete — the human's edits or a
 * `git pull` — rescans the whole tree once (debounced): moved files update
 * their item's `source`, everything else becomes an inbox finding. A full
 * rescan is a few hundred small reads; it is simpler and more robust than
 * pairing unlink/add events into moves.
 */

export interface OverlayEvent {
  kind: "sources_moved" | "overlay_findings";
  items?: string[];
  message: string;
}

export class OverlayTracker {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private running: Promise<void> = Promise.resolve();
  private current: OverlayFinding[] = [];
  private closed = false;

  constructor(
    private store: PlansStore,
    private opts: { debounceMs?: number; onEvent?: (e: OverlayEvent) => void } = {},
  ) {}

  async start(): Promise<void> {
    const root = this.store.ws.root;
    await this.rescan();
    this.watcher = watch(root, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      // dot-dirs (plans dir, .git) are never task files; non-.md files are
      // irrelevant but directories must pass so chokidar descends into them
      ignored: (p, stats) =>
        p !== root &&
        (basename(p).startsWith(".") || (stats?.isFile() === true && !p.toLowerCase().endsWith(".md"))),
    });
    const kick = () => this.schedule();
    for (const ev of ["add", "change", "unlink", "unlinkDir"] as const) this.watcher.on(ev, kick);
    await new Promise<void>((res) => this.watcher!.on("ready", () => res()));
  }

  /** Overlay findings from the last scan (inbox / `te validate`). */
  findings(): OverlayFinding[] {
    return this.current;
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.rescan().catch(() => {});
    }, this.opts.debounceMs ?? 500);
  }

  /** Scan the tree, apply moves, refresh findings. Calls never overlap. */
  rescan(): Promise<void> {
    const next = this.running.then(() => this.doRescan());
    this.running = next.catch(() => {});
    return next;
  }

  private async doRescan(): Promise<void> {
    const scan = await scanTaskTree(this.store.ws.root, this.store.ws.config.ignore);
    const items = [...this.store.idx.items.values()].map((i) => ({
      id: i.meta.id,
      source: i.meta.source,
      simple_source: i.meta.simple_source,
    }));
    const { moves, findings } = overlayReport(scan, items);
    if (moves.length) {
      const moved = await this.store.setSources(moves);
      if (moved.length) {
        this.opts.onEvent?.({
          kind: "sources_moved",
          items: moved,
          message: `task file moved: ${moved.join(", ")}`,
        });
      }
    }
    const before = JSON.stringify(this.current);
    this.current = findings;
    if (JSON.stringify(findings) !== before) {
      this.opts.onEvent?.({ kind: "overlay_findings", message: `${findings.length} overlay finding(s)` });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    await this.running;
  }
}
