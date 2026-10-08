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
 * main file is preferred over a `.simple.md` companion. Dot-dirs (the plans
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
  const isSimple = (h: ResolvedSource) => /\.simple\.md$/i.test(h.path);
  return hits.find((h) => isSimple(h) === Boolean(opts.simple)) ?? (opts.simple ? undefined : hits[0]);
}
