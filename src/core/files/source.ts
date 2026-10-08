import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import YAML from "yaml";

/**
 * Overlay-mode task files (DESIGN §9): the human's own Markdown files, tagged
 * with a single `te: <ID>` frontmatter key so an item survives renames and
 * moves on any machine. Everything else in the file is the human's — this
 * module only ever adds or rewrites that one key.
 */

/** Plain-English companion of a task file: `X.simple.md` or `X-simplified.md`. */
export const SIMPLE_SUFFIX = /(?:\.simple|-simplified)\.md$/i;

const LEADING_FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Leading frontmatter, only when it is a YAML map (a leading `---` rule is not). */
function leadingFrontmatter(text: string): { block: string; yaml: string; map: Record<string, unknown> } | undefined {
  const m = LEADING_FM.exec(text);
  if (!m) return undefined;
  try {
    const map: unknown = YAML.parse(m[1]);
    if (map && typeof map === "object" && !Array.isArray(map)) {
      return { block: m[0], yaml: m[1], map: map as Record<string, unknown> };
    }
  } catch {
    /* not frontmatter */
  }
  return undefined;
}

/** The `te:` id a task file is tagged with, if any. */
export function readTeTag(text: string): string | undefined {
  const v = leadingFrontmatter(text)?.map.te;
  return typeof v === "string" ? v : undefined;
}

/** File text without its leading frontmatter. */
export function stripFrontmatter(text: string): string {
  const fm = leadingFrontmatter(text);
  return fm ? text.slice(fm.block.length) : text;
}

/**
 * Tag a task file with `te: <id>`. Existing frontmatter keeps every other key
 * and line verbatim; a file without one gets a two-line block. Returns the
 * text unchanged when already tagged with `id`.
 */
export function withTeTag(text: string, id: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const fm = leadingFrontmatter(text);
  if (!fm) return `---${eol}te: ${id}${eol}---${eol}${text}`;
  if (fm.map.te === id) return text;
  const lines = fm.yaml.split(/\r?\n/);
  const at = lines.findIndex((l) => /^te:/.test(l));
  if (at === -1) lines.unshift(`te: ${id}`);
  else lines[at] = `te: ${id}`;
  return `---${eol}${lines.join(eol)}${eol}---${eol}${text.slice(fm.block.length)}`;
}

/** Workspace-relative path with `/` separators — the same on every machine. */
export function toSourcePath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export interface ResolvedSource {
  /** workspace-relative path where the file was found */
  path: string;
  text: string;
  /** true when the file is no longer at the recorded `source` path */
  moved: boolean;
}

/**
 * Find an item's task file: the recorded path when it still carries this id
 * (or no tag at all), else any `.md` under the root tagged `te: <id>` — a
 * main file is preferred over a simple companion (`.simple.md` /
 * `-simplified.md`). Dot-dirs (the plans
 * dir, .git) are never searched.
 */
export async function resolveSource(
  root: string,
  id: string,
  recorded: string | undefined,
  opts: { simple?: boolean } = {},
): Promise<ResolvedSource | undefined> {
  if (recorded) {
    const abs = join(root, recorded);
    if (existsSync(abs)) {
      const text = await readFile(abs, "utf8");
      const tag = readTeTag(text);
      if (tag === undefined || tag === id) return { path: recorded, text, moved: false };
    }
  }
  const hits: ResolvedSource[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.toLowerCase().endsWith(".md")) {
        const text = await readFile(p, "utf8");
        if (readTeTag(text) === id) hits.push({ path: toSourcePath(root, p), text, moved: true });
      }
    }
  };
  if (existsSync(root)) await walk(root);
  const isSimple = (h: ResolvedSource) => SIMPLE_SUFFIX.test(h.path);
  return hits.find((h) => isSimple(h) === Boolean(opts.simple)) ?? (opts.simple ? undefined : hits[0]);
}

/** `*` (no `/`), `**` (any depth) and `?` glob → anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches zero or more directories
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export interface TaskTreeScan {
  /** te id → workspace-relative paths of files tagged with it */
  tagged: Map<string, string[]>;
  /** `.md` files without a `te:` tag (ignore globs applied) */
  untracked: string[];
}

/** Every `.md` under the root (dot-dirs skipped), split into tagged / untagged. */
export async function scanTaskTree(root: string, ignore: string[] = []): Promise<TaskTreeScan> {
  const ig = ignore.map(globToRegExp);
  const tagged = new Map<string, string[]>();
  const untracked: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.toLowerCase().endsWith(".md")) {
        const rel = toSourcePath(root, p);
        const tag = readTeTag(await readFile(p, "utf8"));
        if (tag) tagged.set(tag, [...(tagged.get(tag) ?? []), rel]);
        else if (!ig.some((r) => r.test(rel))) untracked.push(rel);
      }
    }
  };
  if (existsSync(root)) await walk(root);
  untracked.sort();
  return { tagged, untracked };
}

export interface OverlayFinding {
  kind: "untracked_task_file" | "missing_source" | "duplicate_tag" | "unknown_tag";
  severity: "error" | "warning" | "info";
  item?: string;
  path?: string;
  message: string;
}

export interface SourceMove {
  id: string;
  source?: string;
  simple_source?: string;
}

/**
 * Compare a task-tree scan with the items' recorded sources: files that
 * moved (→ new `source`), files that vanished, one id tagged on two files
 * (a copied task file), tags of unknown ids, and untracked task files.
 * Pure — the caller applies the moves.
 */
export function overlayReport(
  scan: TaskTreeScan,
  items: Array<{ id: string; source?: string; simple_source?: string }>,
): { moves: SourceMove[]; findings: OverlayFinding[] } {
  const moves: SourceMove[] = [];
  const findings: OverlayFinding[] = [];
  const known = new Set(items.map((i) => i.id));
  const untracked = new Set(scan.untracked);
  const isSimple = (p: string) => SIMPLE_SUFFIX.test(p);

  for (const it of items) {
    if (!it.source) continue;
    const paths = scan.tagged.get(it.id) ?? [];
    const move: SourceMove = { id: it.id };
    const slots: Array<["source" | "simple_source", string | undefined, string[]]> = [
      ["source", it.source, paths.filter((p) => !isSimple(p))],
      ["simple_source", it.simple_source, paths.filter(isSimple)],
    ];
    // a source that is itself a simple companion (no main file) lives in `source`
    if (isSimple(it.source)) {
      slots[0][2] = paths.filter(isSimple);
      slots.pop();
    }
    for (const [key, recorded, found] of slots) {
      if (!recorded) continue;
      if (found.includes(recorded)) {
        if (found.length > 1) {
          findings.push({
            kind: "duplicate_tag",
            severity: "error",
            item: it.id,
            path: found.filter((p) => p !== recorded).join(", "),
            message: `te: ${it.id} also tagged on ${found.filter((p) => p !== recorded).join(", ")} — copied task file? give the copy its own id (remove the te: line)`,
          });
        }
        continue;
      }
      // the tag wins: a new untagged file at the old path is a different task
      if (found.length === 1) move[key] = found[0];
      else if (found.length === 0 && untracked.has(recorded)) {
        // the recorded file still exists, untagged: still tracked by path
        untracked.delete(recorded);
      } else if (found.length > 1) {
        findings.push({
          kind: "duplicate_tag",
          severity: "error",
          item: it.id,
          path: found.join(", "),
          message: `${it.id} moved, but te: ${it.id} is on ${found.length} files: ${found.join(", ")}`,
        });
      } else {
        findings.push({
          kind: "missing_source",
          severity: key === "source" ? "warning" : "info",
          item: it.id,
          path: recorded,
          message: `${it.id} task file ${recorded} is gone (deleted, or not pulled yet)`,
        });
      }
    }
    if (move.source !== undefined || move.simple_source !== undefined) moves.push(move);
  }

  for (const [id, paths] of scan.tagged) {
    if (known.has(id)) continue;
    for (const p of paths) {
      findings.push({
        kind: "unknown_tag",
        severity: "warning",
        path: p,
        message: `${p} is tagged te: ${id}, which is not in this workspace — pull the plans first?`,
      });
    }
  }
  for (const p of untracked) {
    findings.push({
      kind: "untracked_task_file",
      severity: "info",
      path: p,
      message: `untracked task file ${p} — te import it, or add it to ignore`,
    });
  }
  return { moves, findings };
}
