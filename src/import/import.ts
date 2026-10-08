import type { Status, ItemType } from "../core/model/item.js";
import { allocateId } from "../core/address/refs.js";
import { SIMPLE_SUFFIX } from "../core/files/source.js";

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
  kind: "unresolved_dep" | "unknown_status" | "duplicate_legacy" | "no_title" | "unknown_tag";
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

/**
 * Status from ANY path segment — `Phase-1-Fixes/DONE/x.md` and `done/x.md`
 * both mean done. Deepest match wins (closest to the file).
 */
function statusFor(dirSegments: string[], file: string, amb: Ambiguity[]): Status {
  for (let i = dirSegments.length - 1; i >= 0; i--) {
    const s = FOLDER_STATUS[dirSegments[i].toLowerCase()];
    if (s) return s;
  }
  amb.push({
    kind: "unknown_status",
    message: `no status folder in path → draft`,
    file,
  });
  return "draft";
}

/**
 * Dep lines: `Depends on: X`, `**Depends on:** X`, `Order: after X`.
 * The value ends at a new `**bold**` span (e.g. `**Unblocks:**`), else EOL.
 */
const DEP_RE =
  /^\s*\*{0,2}\s*(?:depends\s+on|order\s*:\s*\*{0,2}\s*after|blocked\s+by)\s*:?\s*\*{0,2}\s*(.+?)\s*$/im;
/** Values that mean "no dependencies" rather than naming one. */
const NO_DEP_RE = /^(nothing|none|no\b.*|-|—|n\/a)$/i;
const TITLE_RE = /^#\s+(.+)$/m;
/** A dep-list ends at the next bold LABEL (`**Unblocks:**`), not any `**`. */
const DEP_CUT_RE = /\*\*[A-Za-z][^*]*:\*\*/;
/** Ref-shaped tokens: `P4B-10`, `SU-05`, `TASK-P4B-03A` → `P4B-03A`. */
const REF_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*-\d+[A-Za-z]?\b/g;
/** Normalize a name for equality: lowercase, alnum only. */
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Pull ref-shaped tokens out of a dep-list entry, expanding ranges
 * (`P6-01…P6-08`, same letter prefix) and `/NN` shorthand (`P1F-01/02`).
 * Entries with no ref-shaped token are prose, not references.
 */
function extractRefs(entry: string): string[] {
  // expand `X-nn…X-mm` / `X-nn..mm` / `X-nn–mm` ranges sharing a prefix
  let s = entry.replace(
    /([A-Za-z][A-Za-z0-9]*)-(\d+)([A-Za-z]?)\s*(?:…|\.\.|–)\s*(?:\1-)?(\d+)([A-Za-z]?)/g,
    (all, p: string, a: string, aSuf: string, b: string) => {
      const lo = parseInt(a, 10);
      const hi = parseInt(b, 10);
      if (hi <= lo || hi - lo > 50) return all;
      return Array.from(
        { length: hi - lo + 1 },
        (_, i) => `${p}-${String(lo + i).padStart(a.length, "0")}${aSuf}`,
      ).join(" ");
    },
  );
  // expand `X-nn/mm` shorthand — `P1F-01/02` → `P1F-01 P1F-02`
  s = s.replace(
    /([A-Za-z][A-Za-z0-9]*)-(\d+[A-Za-z]?)((?:\/\d+[A-Za-z]?)+)/g,
    (_all, p: string, first: string, rest: string) =>
      [`${p}-${first}`, ...rest.slice(1).split("/").map((n) => `${p}-${n}`)].join(" "),
  );
  return [...s.matchAll(REF_TOKEN_RE)].map((m) => m[0]);
}

export function planImport(
  files: ImportSource[],
  opts: { prefix: string; existingIds?: Iterable<string>; existingSources?: Set<string> },
): ImportPlan {
  const amb: Ambiguity[] = [];
  const seenLegacy = new Map<string, string>(); // legacy → file

  // group by full dir + base name: X.md and X.simple.md / X-simplified.md merge
  const groups = new Map<
    string,
    { main?: ImportSource; simple?: ImportSource; dirSegments: string[] }
  >();
  for (const f of files) {
    const parts = f.path.split("/");
    const base = parts.at(-1)!;
    const dirSegments = parts.slice(0, -1);
    const key = base.replace(SIMPLE_SUFFIX, "").replace(/\.md$/i, "");
    const groupKey = [...dirSegments, key].join("/");
    const g = groups.get(groupKey) ?? { dirSegments };
    if (SIMPLE_SUFFIX.test(base)) g.simple = f;
    else g.main = f;
    groups.set(groupKey, g);
  }

  // first pass: group key → new id (every file gets one, even name dupes)
  const ids = new Set(opts.existingIds ?? []);
  const keyToId = new Map<string, string>();
  const legacyToIds = new Map<string, string[]>();
  const normToIds = new Map<string, string[]>();
  const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, g] of entries) {
    const legacy = key.split("/").pop()!;
    // idempotent: skip files already imported — identified by their RELATIVE
    // PATH (recorded as `imported_from`), not the bare basename; different
    // folders can legitimately share one
    if (
      opts.existingSources &&
      [g.main?.path, g.simple?.path].some((p) => p && opts.existingSources!.has(p))
    )
      continue;
    if (seenLegacy.has(legacy)) {
      // same basename elsewhere: still gets its OWN id — human resolves which
      amb.push({
        kind: "duplicate_legacy",
        message: `legacy id '${legacy}' also in ${seenLegacy.get(legacy)} — imported as separate item`,
        file: g.main?.path ?? g.simple?.path ?? key,
      });
    } else {
      seenLegacy.set(legacy, g.main?.path ?? key);
    }
    const id = allocateId(opts.prefix, ids);
    ids.add(id);
    keyToId.set(key, id);
    legacyToIds.set(legacy, [...(legacyToIds.get(legacy) ?? []), id]);
    normToIds.set(normName(legacy), [...(normToIds.get(normName(legacy)) ?? []), id]);
  }

  /** Resolve a dep name to new ids: exact or boundary-anchored short ref
   *  (`P1F-01` inside `TASK-P1F-01-…`). Multiple hits → ambiguous. */
  const matchDep = (name: string): { ids: string[] } => {
    const n = name.toLowerCase();
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundary = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`);
    const idsOut: string[] = [];
    for (const [legacy, idList] of legacyToIds) {
      const l = legacy.toLowerCase();
      if (l === n || boundary.test(l)) idsOut.push(...idList);
    }
    return { ids: idsOut };
  };

  // second pass: build items
  const items: PlannedItem[] = [];
  for (const [key, g] of entries) {
    const legacy = key.split("/").pop()!;
    const id = keyToId.get(key);
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
      // the dep list ends where the next bold LABEL begins (**Unblocks:**…)
      // parentheticals are commentary ("nothing (geo fns come from P4B-03;
      // stub them)") — drop them before splitting on `;`/`,`. Only the first
      // sentence names deps: "VG-01 committed. The owner answers OD-3…"
      const depText = depM[1]
        .split(DEP_CUT_RE)[0]
        .replace(/\([^)]*\)?/g, " ")
        .split(/\.\s+(?=[A-Z])/)[0];
      // "nothing. Do it before VG-02" — a leading no-dep word means none,
      // whatever prose follows
      const noDeps = /^\s*(nothing|none|n\/a)\b/i.test(depText);
      for (const raw of noDeps ? [] : depText.split(/[,;]/)) {
        const entry = raw
          .replace(/\([^)]*\)/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .replace(/[.\s]+$/, "")
          .replace(/\.md$/i, "")
          .replace(SIMPLE_SUFFIX, "")
          .trim();
        if (!entry || NO_DEP_RE.test(entry)) continue;
        const refs = extractRefs(entry);
        if (!refs.length) {
          // no ref-shaped token: a full name still resolves by normalized
          // equality; otherwise it's prose ("Phase 2", "this") — skip it
          const hit = normToIds.get(normName(entry));
          if (hit?.length === 1) depends_on.push(hit[0]);
          else if (hit && hit.length > 1)
            amb.push({
              kind: "unresolved_dep",
              message: `'${entry}' matches ${hit.length} items — ambiguous`,
              file: g.main?.path ?? key,
            });
          continue;
        }
        for (const ref of refs) {
          const m = matchDep(ref);
          if (m.ids.length === 1) {
            depends_on.push(m.ids[0]);
          } else {
            amb.push({
              kind: "unresolved_dep",
              message:
                m.ids.length > 1
                  ? `'${ref}' matches ${m.ids.length} items — ambiguous`
                  : `'${ref}' not found among imported items`,
              file: g.main?.path ?? key,
            });
          }
        }
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
      status: statusFor(g.dirSegments, g.main?.path ?? key, amb),
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
