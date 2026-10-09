import { matchesSearch, type Index, type IndexedItem, type QueryFilter } from "../index/index.js";
import { parseItemRef } from "../address/refs.js";

/**
 * Mermaid renderer (DESIGN §7 graph tool, §8 Graph view). Deterministic —
 * same input, byte-identical output — so it can be diffed and cached.
 */

export interface MermaidOpts {
  /** Limit to these roots and their neighbourhood. */
  roots?: string[];
  /** Edge traversal depth from roots (default: unlimited). */
  depth?: number;
  filter?: QueryFilter;
  /** Node cap (default 40); extras collapse into a '+N more' node. */
  maxNodes?: number;
}

const CLASS_FOR: Record<string, string> = {
  draft: "draft",
  ready: "ready",
  hold: "hold",
  in_progress: "active",
  in_review: "review",
  waiting: "waiting",
  done: "done",
  dropped: "dropped",
};

// same palette as the web UI status colours (web/index.html .st-* / ST_BADGE)
const CLASS_DEFS = `  classDef draft fill:#6c757d,color:#fff
  classDef ready fill:#0d6efd,color:#fff
  classDef hold fill:#6d4c41,color:#fff
  classDef active fill:#ffc107,color:#000
  classDef review fill:#6f42c1,color:#fff
  classDef waiting fill:#0dcaf0,color:#000
  classDef done fill:#198754,color:#fff
  classDef dropped fill:#dc3545,color:#fff
  classDef blocked stroke:#dc3545,stroke-width:2px`;

function nodeId(id: string): string {
  return id.replace(/-/g, "_");
}

function escLabel(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "#quot;")
    .replace(/\[/g, "#91;")
    .replace(/\]/g, "#93;")
    .replace(/\{/g, "#123;")
    .replace(/\}/g, "#125;");
}

function passesFilter(it: IndexedItem, f?: QueryFilter): boolean {
  if (it.meta.archived && f?.archived === undefined) return false;
  if (!f) return true;
  const statuses = f.status === undefined ? undefined : Array.isArray(f.status) ? f.status : [f.status];
  if (statuses && !statuses.includes(it.meta.status)) return false;
  if (f.type && it.meta.type !== f.type) return false;
  if (f.domain && !it.meta.domains.includes(f.domain)) return false;
  if (!matchesSearch(it.meta, f.q)) return false;
  if (f.project && it.meta.project !== f.project) return false;
  if (f.resource && !it.meta.targets.some((t) => t.startsWith(`@${f.resource}`))) return false;
  if (f.text && !`${it.meta.title}\n${it.sections.map((s) => s.body).join("\n")}`.toLowerCase().includes(f.text.toLowerCase())) return false;
  return true;
}

function collect(index: Index, opts: MermaidOpts): Set<string> {
  const maxDepth = opts.depth ?? Infinity;
  const out = new Set<string>();
  if (!opts.roots || opts.roots.length === 0) {
    for (const it of index.items.values()) if (passesFilter(it, opts.filter)) out.add(it.meta.id);
    return out;
  }
  // BFS over depends_on (both directions) + parent/children from each root
  const queue: Array<[string, number]> = [];
  for (const r of opts.roots) {
    const id = parseItemRef(r).id;
    if (index.items.has(id)) queue.push([id, 0]);
  }
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (out.has(id) || d > maxDepth) continue;
    const it = index.items.get(id)!;
    if (!passesFilter(it, opts.filter)) continue;
    out.add(id);
    for (const dep of it.meta.depends_on) {
      try {
        const p = parseItemRef(dep);
        if (!p.workspace && index.items.has(p.id)) queue.push([p.id, d + 1]);
      } catch { /* ignore */ }
    }
    for (const b of it.blocks) queue.push([b, d + 1]);
    for (const c of it.children) queue.push([c, d + 1]);
    if (it.meta.parent) {
      try {
        const p = parseItemRef(it.meta.parent);
        if (!p.workspace && index.items.has(p.id)) queue.push([p.id, d + 1]);
      } catch { /* ignore */ }
    }
  }
  return out;
}

export function renderMermaid(index: Index, opts: MermaidOpts = {}): string {
  const max = opts.maxNodes ?? 40;
  const all = [...collect(index, opts)].sort();
  const shown = all.slice(0, max);
  const hidden = all.length - shown.length;
  const shownSet = new Set(shown);

  const lines: string[] = ["flowchart LR"];
  for (const id of shown) {
    const it = index.items.get(id)!;
    const label = `${id} ${it.meta.title}`;
    lines.push(`  ${nodeId(id)}["${escLabel(label)}"]:::${CLASS_FOR[it.meta.status] ?? "draft"}`);
  }
  if (hidden > 0) lines.push(`  more["+${hidden} more"]:::draft`);

  const edges: string[] = [];
  for (const id of shown) {
    const it = index.items.get(id)!;
    for (const dep of it.meta.depends_on) {
      try {
        const p = parseItemRef(dep);
        if (!p.workspace && shownSet.has(p.id)) edges.push(`  ${nodeId(p.id)} --> ${nodeId(id)}`);
      } catch { /* ignore */ }
    }
    if (it.meta.parent) {
      try {
        const p = parseItemRef(it.meta.parent);
        if (!p.workspace && shownSet.has(p.id)) edges.push(`  ${nodeId(p.id)} -.-> ${nodeId(id)}`);
      } catch { /* ignore */ }
    }
  }
  lines.push(...edges.sort());
  lines.push(CLASS_DEFS);
  return lines.join("\n") + "\n";
}
