import { readdir, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { ID_RE } from "../model/refs.js";
import { ValidationError } from "../model/errors.js";
import { idPrefix } from "./refs.js";

/**
 * renumber(oldId, newId): rewrite every reference to oldId in the plans repo —
 * item ids, depends_on/parent/relates, body mentions, claim files — and rename
 * the item file itself. Needed when two machines allocated the same ID while
 * offline (DESIGN CR-0005).
 */

const REF_ARRAY_FIELDS = ["depends_on", "relates"] as const;
const REF_SCALAR_FIELDS = ["id", "parent", "item"] as const;

function wordRe(id: string): RegExp {
  return new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
}

async function* walk(dir: string): AsyncGenerator<string> {
  if (!existsSync(dir)) return;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md") || e.name.endsWith(".yaml")) yield p;
  }
}

/** Replace references inside one file's text; returns new text or null. */
export function rewriteText(text: string, oldId: string, newId: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  let out = text;
  let changed = false;
  if (fm) {
    let meta: Record<string, unknown>;
    try {
      meta = (YAML.parse(fm[1]) ?? {}) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    let metaChanged = false;
    for (const f of REF_SCALAR_FIELDS) {
      if (meta[f] === oldId) {
        meta[f] = newId;
        metaChanged = true;
      }
    }
    for (const f of REF_ARRAY_FIELDS) {
      const arr = meta[f];
      if (Array.isArray(arr)) {
        meta[f] = arr.map((v) => (v === oldId ? newId : v));
        if ((meta[f] as unknown[]).some((v, i) => v !== arr[i])) metaChanged = true;
      }
    }
    // textual mentions in scalar fields (title, notes, question text, …)
    const re = wordRe(oldId);
    for (const [k, v] of Object.entries(meta)) {
      if (typeof v !== "string") continue;
      if ((REF_SCALAR_FIELDS as readonly string[]).includes(k)) continue;
      if (k === "targets") continue;
      const nv = v.replace(re, newId);
      if (nv !== v) {
        meta[k] = nv;
        metaChanged = true;
      }
    }
    if (metaChanged) {
      const doc = new YAML.Document(meta);
      const map = doc.contents;
      if (map && YAML.isMap(map)) {
        for (const pair of map.items) if (pair.value && YAML.isSeq(pair.value)) pair.value.flow = true;
      }
      out = `---\n${doc.toString({ flowCollectionPadding: false })}---` + out.slice(fm[0].length);
      changed = true;
    }
  }
  // body references (anything after the frontmatter)
  const bodyStart = fm ? fm[0].length : 0;
  const body = out.slice(bodyStart).replace(wordRe(oldId), newId);
  if (body !== out.slice(bodyStart)) {
    out = out.slice(0, bodyStart) + body;
    changed = true;
  }
  return changed ? out : null;
}

export interface RenumberResult {
  changedFiles: string[];
  renamedFiles: Array<{ from: string; to: string }>;
}

export async function renumber(plansDir: string, oldId: string, newId: string): Promise<RenumberResult> {
  if (!ID_RE.test(oldId) || !ID_RE.test(newId)) {
    throw new ValidationError(`renumber needs real ids, got '${oldId}' → '${newId}'`);
  }
  if (idPrefix(oldId) !== idPrefix(newId)) {
    throw new ValidationError(`renumber cannot change prefix ('${oldId}' → '${newId}')`);
  }
  const result: RenumberResult = { changedFiles: [], renamedFiles: [] };
  const dirs = ["items", "claims", "decisions"];
  for (const sub of dirs) {
    for await (const file of walk(join(plansDir, sub))) {
      const text = await readFile(file, "utf8");
      const out = rewriteText(text, oldId, newId);
      if (out === null) continue;
      await writeFile(file, out);
      result.changedFiles.push(file);
    }
  }
  // rename the item file itself
  const itemFile = join(plansDir, "items", idPrefix(oldId), `${oldId}.md`);
  if (existsSync(itemFile)) {
    const target = join(dirname(itemFile), `${newId}.md`);
    if (!existsSync(target)) {
      await rename(itemFile, target);
      result.renamedFiles.push({ from: itemFile, to: target });
    }
  }
  const claimFile = join(plansDir, "claims", `${oldId}.yaml`);
  if (existsSync(claimFile)) {
    const target = join(plansDir, "claims", `${newId}.yaml`);
    if (!existsSync(target)) {
      await mkdir(dirname(target), { recursive: true });
      await rename(claimFile, target);
      result.renamedFiles.push({ from: claimFile, to: target });
    }
  }
  return result;
}
