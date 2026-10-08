import type { Status, ItemType } from "../core/model/item.js";
import { allocateId } from "../core/address/refs.js";

/**
 * Markdown-folder importer (DESIGN §9, IM-0001). Pure planning: takes file
 * paths + contents, produces new items (legacy ids preserved), a unified-diff-
 * style preview and an ambiguity report. Source files are never modified;
 * import only creates items — idempotent via `legacy_id` dedup.
 */

export interface ImportSource {
  /** path relative to the import root, e.g. `done/TASK-12 fix.md` */
  path: string;
  content: string;
}

export interface PlannedItem {
  legacy_id: string;
  title: string;
  type: ItemType;
  status: Status;
  /** new depends_on refs (resolved to new ids where possible) */
  depends_on: string[];
  summary: string;
  simple?: string;
  suggestedId: string;
  /** the file(s) this item came from */
  sources: string[];
}

export interface Ambiguity {
  kind: "unresolved_dep" | "unknown_status" | "duplicate_legacy" | "no_title";
  message: string;
  file: string;
}

export interface ImportPlan {
  items: PlannedItem[];
  ambiguities: Ambiguity[];
  /** human-readable diff-style preview */
  preview: string;
}

const FOLDER_STATUS: Record<string, Status> = {
  done: "done",
  "partially-done": "in_progress",
  "in-progress": "in_progress",
  in_progress: "in_progress",
  todo: "ready",
  ready: "ready",
  draft: "draft",
  backlog: "draft",
  review: "in_review",
  "in-review": "in_review",
  dropped: "dropped",
  archive: "dropped",
};

const PREFIX_TYPE: Record<string, ItemType> = {
  TASK: "task",
  PLAN: "epic",
  PHASE: "epic",
  MEGAPLAN: "epic",
  REVIEW: "review",
  BUG: "bug",
  WISH: "wish",
  SPIKE: "spike",
};

function typeFor(basename: string): ItemType {
  const m = /^([A-Za-z]+)[-_]/.exec(basename);
  return m ? (PREFIX_TYPE[m[1].toUpperCase()] ?? "task") : "task";
}

function statusFor(topFolder: string, file: string, amb: Ambiguity[]): Status {
  const s = FOLDER_STATUS[topFolder.toLowerCase()];
  if (!s) {
    amb.push({ kind: "unknown_status", message: `unknown folder '${topFolder}' → draft`, file });
    return "draft";
  }
  return s;
}

const DEP_RE = /^\s*(?:depends\s+on|order:\s*after|blocked\s+by)\s*:?\s+(.+)$/im;
const TITLE_RE = /^#\s+(.+)$/m;
const SIMPLE_SUFFIX = /\.simple\.md$/i;

export function planImport(
  files: ImportSource[],
  opts: { prefix: string; existingIds?: Iterable<string>; existingLegacyIds?: Set<string> },
): ImportPlan {
  const amb: Ambiguity[] = [];
  const seenLegacy = new Map<string, string>(); // legacy → file

  // group by base name: X.md and X.simple.md merge
  const groups = new Map<string, { main?: ImportSource; simple?: ImportSource; folder: string }>();
  for (const f of files) {
    const parts = f.path.split("/");
    const base = parts.at(-1)!;
    const folder = parts.length > 1 ? parts[0] : "";
    const key = base.replace(SIMPLE_SUFFIX, "").replace(/\.md$/i, "");
    const g = groups.get(`${folder}/${key}`) ?? { folder };
    if (SIMPLE_SUFFIX.test(base)) g.simple = f;
    else g.main = f;
    groups.set(`${folder}/${key}`, g);
  }

  // first pass: legacy → new id
  const ids = new Set(opts.existingIds ?? []);
  const legacyToId = new Map<string, string>();
  const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, g] of entries) {
    const legacy = key.split("/").pop()!;
    if (opts.existingLegacyIds?.has(legacy)) continue; // idempotent: already imported
    if (seenLegacy.has(legacy)) {
      amb.push({
        kind: "duplicate_legacy",
        message: `legacy id '${legacy}' also in ${seenLegacy.get(legacy)}`,
        file: g.main?.path ?? g.simple?.path ?? key,
      });
      continue;
    }
    seenLegacy.set(legacy, g.main?.path ?? key);
    const id = allocateId(opts.prefix, ids);
    ids.add(id);
    legacyToId.set(legacy, id);
  }

  // second pass: build items
  const items: PlannedItem[] = [];
  for (const [key, g] of entries) {
    const legacy = key.split("/").pop()!;
    const id = legacyToId.get(legacy);
    if (!id) continue;
    const content = g.main?.content ?? "";
    const titleM = TITLE_RE.exec(content);
    const title = titleM?.[1].trim() ?? legacy.replace(/[-_]/g, " ");
    if (!titleM) {
      amb.push({ kind: "no_title", message: `no '# ' title — using filename`, file: g.main?.path ?? key });
    }
    const depM = DEP_RE.exec(content);
    const depends_on: string[] = [];
    if (depM) {
      for (const raw of depM[1].split(/[,;]/)) {
        const name = raw.trim().replace(/\.md$/i, "").replace(SIMPLE_SUFFIX, "");
        const target = [...legacyToId.entries()].find(
          ([k]) => k === name || k.toLowerCase() === name.toLowerCase(),
        );
        if (target) depends_on.push(target[1]);
        else
          amb.push({
            kind: "unresolved_dep",
            message: `'${name}' not found among imported items`,
            file: g.main?.path ?? key,
          });
      }
    }
    const body = content
      .replace(TITLE_RE, "")
      .replace(DEP_RE, "")
      .trim();
    items.push({
      legacy_id: legacy,
      title,
      type: g.main ? typeFor(legacy) : "task",
      status: statusFor(g.folder, g.main?.path ?? key, amb),
      depends_on,
      summary: body.split("\n\n")[0] || title,
      simple: g.simple?.content.trim() || undefined,
      suggestedId: id,
      sources: [g.main?.path, g.simple?.path].filter((x): x is string => Boolean(x)),
    });
  }

  const preview = items
    .map(
      (i) =>
        `+ ${i.suggestedId} [${i.status}] ${i.type} "${i.title}"` +
        `${i.depends_on.length ? ` deps:[${i.depends_on.join(",")}]` : ""}` +
        ` ← ${i.sources.join(", ")}`,
    )
    .join("\n");
  return { items, ambiguities: amb, preview };
}
