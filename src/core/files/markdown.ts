import YAML from "yaml";
import { ParseError, ConflictMarkersError } from "../model/errors.js";
import { ItemMeta, Check, type Artifact, type Section } from "../model/index.js";
import { normalizeDomains } from "../domains/domains.js";
import type { z, ZodTypeAny } from "zod";

export interface ParsedFile<T> {
  meta: T;
  /** Body text before the first `## ` heading (usually just a blank line). */
  preamble: string;
  sections: Section[];
  /** Originals captured at parse time for stable round-trips. */
  raw: { text: string; frontmatter: string; body: string; meta: T; eol: "\n" | "\r\n" };
}

/** Known-meta key order for canonical re-emission; extras keep insertion order. */
const META_KEY_ORDER = [
  "id",
  "type",
  "title",
  "status",
  "project",
  "domains",
  "targets",
  "depends_on",
  "parent",
  "relates",
  "found_by",
  "priority",
  "version",
  "created",
  "updated",
  "legacy_id",
  "imported_from",
  "source",
  "simple_source",
  "unblocks_on",
  "archived",
  "archived_at",
  "star_color",
  "starred_at",
  "question",
  "ai_review",
];

const CONFLICT_RE = /^(<{7}|={7}|>{7})( |$)/m;

function splitSections(body: string): { preamble: string; sections: Section[] } {
  const lines = body.split(/(?<=^|\n)(?=## )/);
  let preamble = "";
  const sections: Section[] = [];
  for (const chunk of lines) {
    if (chunk.startsWith("## ")) {
      const nl = chunk.indexOf("\n");
      const heading = (nl === -1 ? chunk.slice(3) : chunk.slice(3, nl)).trimEnd();
      const bodyText = nl === -1 ? "" : chunk.slice(nl + 1);
      sections.push({ heading, body: bodyText });
    } else {
      preamble = chunk;
    }
  }
  return { preamble, sections };
}

/**
 * Parse `<frontmatter yaml>\n<body markdown>` into {meta, preamble, sections}.
 * Files containing git conflict markers throw ConflictMarkersError — they are
 * never parsed and therefore never rewritten (DESIGN §6.2, §6.5).
 */
export function parseMarkdown<S extends ZodTypeAny>(
  text: string,
  schema: S,
  path?: string,
): ParsedFile<z.output<S>> {
  if (CONFLICT_RE.test(text)) throw new ConflictMarkersError(path);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const m = /^---\r?\n/.exec(text);
  if (!m) throw new ParseError("missing frontmatter (expected leading '---')", path);
  const rest = text.slice(m[0].length);
  const end = /^---[ \t]*\r?\n/m.exec(rest) ?? /^---[ \t]*$/m.exec(rest);
  if (!end) throw new ParseError("unterminated frontmatter", path);
  const frontmatter = rest.slice(0, end.index);
  const body = rest.slice(end.index + end[0].length);
  let meta: z.output<S>;
  try {
    const rawMeta: unknown = YAML.parse(frontmatter) ?? {};
    meta = schema.parse(rawMeta);
  } catch (e) {
    throw new ParseError(
      `frontmatter does not validate: ${e instanceof Error ? e.message : String(e)}`,
      path,
    );
  }
  const { preamble, sections } = splitSections(body);
  return {
    meta,
    preamble,
    sections,
    raw: { text, frontmatter, body, meta: structuredClone(meta), eol },
  };
}

export interface ParsedItemFile extends ParsedFile<ItemMeta> {
  /** `## Artifacts` lines parsed into entries (see parseArtifacts). */
  artifacts: Artifact[];
  /** `## Checks` entries parsed at index time (GL-0348; overlay items carry [] — their checks live in the task file). */
  checks: Check[];
}

const ARTIFACT_LINE = /^-\s+(\S+)\s+[—–]\s+(.+?)\s*$/;

/**
 * Parse the `## Artifacts` list — one file per line:
 * `- <path under .artifacts/> — <caption> [#domain ...] [!sensitive]`.
 * Trailing #tags are the artifact's own domains; `!sensitive` marks private
 * content. A line with no #tag inherits `itemDomains` (the item's domains).
 * Lines that do not match the format are skipped.
 */
export function parseArtifacts(body: string | undefined, itemDomains: string[] = []): Artifact[] {
  const out: Artifact[] = [];
  if (!body) return out;
  for (const raw of body.split(/\r?\n/)) {
    const m = ARTIFACT_LINE.exec(raw.trim());
    if (!m) continue;
    const tokens = m[2].split(/\s+/);
    const own: string[] = [];
    let sensitive = false;
    let t: string | undefined;
    while ((t = tokens.pop()) !== undefined) {
      if (t === "!sensitive") sensitive = true;
      else if (/^#\S+$/.test(t)) own.unshift(t);
      else {
        tokens.push(t);
        break;
      }
    }
    out.push({
      path: m[1],
      caption: tokens.join(" "),
      domains: own.length ? normalizeDomains(own) : [...itemDomains],
      sensitive,
    });
  }
  return out;
}

export const parseItemFile = (text: string, path?: string): ParsedItemFile => {
  const doc = parseMarkdown(text, ItemMeta, path);
  return {
    ...doc,
    artifacts: parseArtifacts(getSection(doc, "artifacts"), doc.meta.domains),
    checks: parseChecks(getSection(doc, "checks"), path),
  };
};

/**
 * Parse a `## Checks` body (GL-0348): a YAML list of {name, repo, run,
 * timeout, expect_exit}. Absent or empty → []. A section that is present
 * but not a valid list throws — the file is machine-managed, so a bad
 * hand-edit must be loud (invalid file → `te validate`), not silent.
 */
export function parseChecks(body: string | undefined, path?: string): Check[] {
  if (!body || !body.trim()) return [];
  let raw: unknown;
  try {
    raw = YAML.parse(body);
  } catch (e) {
    throw new ParseError(
      `## Checks does not parse as a YAML list: ${e instanceof Error ? e.message : String(e)}`,
      path,
    );
  }
  if (raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ParseError("## Checks must be a YAML list of checks", path);
  }
  return raw.map((entry, i) => {
    const parsed = Check.safeParse(entry);
    if (!parsed.success) {
      throw new ParseError(
        `## Checks entry ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".") || "entry"} ${x.message}`).join("; ")}`,
        path,
      );
    }
    return parsed.data;
  });
}

/** Render a `## Checks` body from checks (inverse of parseChecks). */
export function renderChecks(checks: Check[]): string {
  if (!checks.length) return "";
  return `${YAML.stringify(checks).trimEnd()}\n`;
}

function orderedMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string) => {
    const v = meta[k];
    if (v === undefined) return;
    if (Array.isArray(v) && v.length === 0) return; // drop schema-default empties
    out[k] = v;
  };
  for (const k of META_KEY_ORDER) if (k in meta) put(k);
  for (const k of Object.keys(meta)) if (!(k in out)) put(k);
  return out;
}

/** Canonical frontmatter emission: fixed key order, flow-style arrays. */
export function emitFrontmatter(meta: object): string {
  const doc = new YAML.Document(orderedMeta(meta as Record<string, unknown>));
  const map = doc.contents;
  if (map && YAML.isMap(map)) {
    for (const pair of map.items) {
      if (pair.value && YAML.isSeq(pair.value)) pair.value.flow = true;
    }
  }
  return `---\n${doc.toString({ flowCollectionPadding: false })}---\n`;
}

function joinBody(preamble: string, sections: Section[]): string {
  return preamble + sections.map((s) => `## ${s.heading}\n${s.body}`).join("");
}

/**
 * Serialize back to text. Untouched files emit the original bytes
 * (byte-identical round-trip, minimal git diffs). Changed meta is re-emitted
 * canonically; changed sections keep their verbatim content; original EOL
 * style is preserved.
 */
export function serializeMarkdown<T>(doc: ParsedFile<T>): string {
  const body = joinBody(doc.preamble, doc.sections);
  const metaChanged = JSON.stringify(doc.meta) !== JSON.stringify(doc.raw.meta);
  const bodyChanged = body !== doc.raw.body;
  if (!metaChanged && !bodyChanged) return doc.raw.text;
  const fm = metaChanged ? emitFrontmatter(doc.meta as object) : `---\n${doc.raw.frontmatter}---\n`;
  let out = fm + (bodyChanged ? body : doc.raw.body);
  if (doc.raw.eol === "\r\n") out = out.replace(/(?<!\r)\n/g, "\r\n");
  return out;
}

export function getSection<T>(doc: ParsedFile<T>, heading: string): string | undefined {
  return doc.sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase())?.body;
}

export function setSection<T>(doc: ParsedFile<T>, heading: string, body: string): void {
  const s = doc.sections.find((x) => x.heading.toLowerCase() === heading.toLowerCase());
  if (s) s.body = body;
  else doc.sections.push({ heading, body });
}

/** Append text at the end of a section (creates it if missing). */
export function appendToSection<T>(doc: ParsedFile<T>, heading: string, text: string): void {
  const s = doc.sections.find((x) => x.heading.toLowerCase() === heading.toLowerCase());
  if (!s) {
    doc.sections.push({ heading, body: text.endsWith("\n") ? text : text + "\n" });
    return;
  }
  if (!s.body.endsWith("\n") && s.body.length > 0) s.body += "\n";
  s.body += text.endsWith("\n") ? text : text + "\n";
}

/** Append a line at the end of `## Log` (creates the section if missing). */
export function appendLog<T>(doc: ParsedFile<T>, line: string): void {
  const s = doc.sections.find((x) => x.heading.toLowerCase() === "log");
  if (!s) {
    doc.sections.push({ heading: "Log", body: `${line}\n` });
    return;
  }
  if (!s.body.endsWith("\n") && s.body.length > 0) s.body += "\n";
  s.body += `${line}\n`;
}
