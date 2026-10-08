import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { parseItemFile, parseMarkdown } from "../files/markdown.js";
import { parseClaimFile } from "../claims/claims.js";
import { DecisionMeta, type ItemMeta, type Section, type Status, type Turn, turnOf } from "../model/index.js";
import { parseItemRef } from "../address/refs.js";
import type { Claim } from "../model/claim.js";

/** An item plus everything derived from the graph around it (DESIGN §5). */
export interface IndexedItem {
  meta: ItemMeta;
  sections: Section[];
  path: string;
  claim?: Claim;
  /** derived: any depends_on item (this workspace) not done */
  blocked: boolean;
  /** derived: reverse of depends_on */
  blocks: string[];
  /** derived: items whose parent is this id */
  children: string[];
  /** status ready ∧ not blocked ∧ not claimed */
  ready: boolean;
  turn: Turn;
  /** set when the file can't be parsed — index keeps it, validator reports it */
  invalid?: string;
}

export interface QueryFilter {
  status?: Status | Status[];
  type?: string;
  project?: string;
  /** items touching this resource name */
  resource?: string;
  /** substring in title or summary */
  text?: string;
  claimed?: boolean;
  staleOnly?: boolean;
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
              path: relative(plansDir, file),
              blocked: false,
              blocks: [],
              children: [],
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
      path: rel,
      blocked: false,
      blocks: [],
      children: [],
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
        try {
          const parsed = parseItemRef(d);
          status = parsed.workspace
            ? this.depStatus(d)
            : (this.items.get(parsed.id)?.meta.status ?? this.depStatus(d));
        } catch {
          return false; // unparseable ref → validator finding, not a block
        }
        return status !== undefined && status !== "done" && status !== "dropped";
      });
      it.turn = turnOf(it.meta.status);
      it.ready = it.meta.status === "ready" && !it.blocked && !it.claim;
    }
  }

  get(id: string): IndexedItem | undefined {
    return this.items.get(id);
  }

  /** Ready items, best first: priority asc, then oldest created. */
  readyItems(limit = Infinity): IndexedItem[] {
    return [...this.items.values()]
      .filter((i) => i.ready)
      .sort(
        (a, b) =>
          a.meta.priority - b.meta.priority ||
          (a.meta.created ?? "").localeCompare(b.meta.created ?? "") ||
          a.meta.id.localeCompare(b.meta.id),
      )
      .slice(0, limit);
  }

  query(f: QueryFilter): IndexedItem[] {
    const statuses = f.status === undefined ? undefined : Array.isArray(f.status) ? f.status : [f.status];
    const text = f.text?.toLowerCase();
    return [...this.items.values()].filter((i) => {
      if (statuses && !statuses.includes(i.meta.status)) return false;
      if (f.type && i.meta.type !== f.type) return false;
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
