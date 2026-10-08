import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { NotFoundError } from "../core/model/errors.js";
import type { ImportSource } from "./import.js";

/** Read a folder tree of markdown files into ImportSource[] (never modified). */
export async function scanFolder(dir: string): Promise<ImportSource[]> {
  if (!existsSync(dir)) throw new NotFoundError(`import folder not found: ${dir}`);
  const out: ImportSource[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue;
        await walk(p);
      } else if (e.name.toLowerCase().endsWith(".md")) {
        out.push({ path: relative(dir, p), content: await readFile(p, "utf8") });
      }
    }
  };
  await walk(dir);
  return out;
}
