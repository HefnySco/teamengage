/**
 * Domains: hashtag-like labels on items (an item can have many), next to the
 * single `project`. The workspace keeps the vocabulary in workspace.yaml
 * `domains:` (description, colour, keywords); a new name used on an item is
 * added to it automatically, and the Domains page renames/merges/deletes.
 * Pure helpers — no I/O.
 */

export interface DomainDef {
  description?: string;
  color?: string;
  /** words/paths that suggest this domain (first tagging, te domains suggest) */
  keywords?: string[];
}

/** `Web Client` → `web-client`; lowercase, [a-z0-9-_], no leading/trailing dashes. */
export function normalizeDomain(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalize, drop empties, de-duplicate, keep first-seen order. */
export function normalizeDomains(names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const n of names) {
    const d = normalizeDomain(n);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** A stable colour for a domain without one (hue from a string hash). */
export function domainColor(name: string, def?: DomainDef): string {
  if (def?.color) return def.color;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

/**
 * Domains whose keywords (or the domain name itself) occur in `text` as a
 * whole word / path segment, case-insensitive. Used for suggestions only.
 */
export function suggestDomains(text: string, defs: Record<string, DomainDef>): string[] {
  const hay = text.toLowerCase();
  const out: string[] = [];
  for (const [name, def] of Object.entries(defs)) {
    const words = [name, ...(def.keywords ?? [])].map((w) => w.toLowerCase()).filter(Boolean);
    const hit = words.some((w) => {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(hay);
    });
    if (hit) out.push(name);
  }
  return out;
}

/** Whole-word / path-segment occurrences of a domain's name + keywords. */
function occurrences(hay: string, name: string, def: DomainDef): number {
  let n = 0;
  for (const w of [name, ...(def.keywords ?? [])].map((x) => x.toLowerCase()).filter(Boolean)) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    n += (hay.match(new RegExp(`(^|[^a-z0-9])${esc}(?=[^a-z0-9]|$)`, "g")) ?? []).length;
  }
  return n;
}

export interface SuggestInput {
  /** title, file path, legacy id, project, the **Touches:** line — what the task IS about */
  strong: string;
  /** the opening summary (first paragraphs) */
  lead: string;
  /** the rest of the file — passing mentions */
  body: string;
}

/**
 * Ranked suggestions: strong hits weigh 6, lead hits 2, body hits 1 (body
 * capped at 4 per domain so a long file can't win on volume). Keeps domains
 * scoring ≥ `min` (default 6 — one strong hit, or a lead hit plus several
 * body mentions), at most `max` (default 3), best first.
 */
export function rankDomains(
  input: SuggestInput,
  defs: Record<string, DomainDef>,
  opts: { min?: number; max?: number } = {},
): string[] {
  const strong = input.strong.toLowerCase();
  const lead = input.lead.toLowerCase();
  const body = input.body.toLowerCase();
  return Object.entries(defs)
    .map(([name, def]) => ({
      name,
      score:
        6 * occurrences(strong, name, def) +
        2 * occurrences(lead, name, def) +
        Math.min(4, occurrences(body, name, def)),
    }))
    .filter((x) => x.score >= (opts.min ?? 6))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, opts.max ?? 3)
    .map((x) => x.name);
}
