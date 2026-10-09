import YAML from "yaml";
import { ParseError, ConflictMarkersError } from "../model/errors.js";
import { ItemMeta, type Section } from "../model/index.js";
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
  "priority",
  "version",
  "created",
  "updated",
  "legacy_id",
  "imported_from",
  "source",
  "simple_source",
  "archived",
  "archived_at",
  "question",
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

export const parseItemFile = (text: string, path?: string) =>
  parseMarkdown(text, ItemMeta, path);

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
