import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute, sep, basename, dirname } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { NotFoundError } from "../core/model/errors.js";
import type { ImportSource } from "./import.js";

/**
 * Read a folder tree of markdown files into ImportSource[] (never modified).
 * A single `.md` file is a one-file import (paths relative to its folder).
 */
export async function scanFolder(dir: string): Promise<ImportSource[]> {
  if (!existsSync(dir)) throw new NotFoundError(`import folder not found: ${dir}`);
  if (statSync(dir).isFile()) return [{ path: basename(dir), content: await readFile(dir, "utf8") }];
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

/**
 * Stable idempotency key for an imported file: its absolute real path, written
 * `~/…` when under the home dir so desktop and laptop agree. Independent of
 * which folder was imported — importing `Phase-5-Tasks` and later its parent
 * yields the same key for the same file.
 */
export function sourceKey(root: string, rel: string, home = homedir()): string {
  const abs = join(root, rel);
  return abs === home || abs.startsWith(home + sep) ? `~${abs.slice(home.length)}` : abs;
}

/** Keys of already-imported files under `root`, as paths relative to it. */
export function sourcesUnder(root: string, keys: Iterable<string>, home = homedir()): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    const abs = k.startsWith("~/") ? join(home, k.slice(2)) : k;
    if (isAbsolute(abs) && abs.startsWith(root + sep)) out.add(relative(root, abs));
  }
  return out;
}

/** Canonical import root (absolute, symlinks resolved); a file's folder for a one-file import. */
export function importRoot(dir: string): string {
  const abs = realpathSync(resolve(dir));
  return statSync(abs).isFile() ? dirname(abs) : abs;
}
