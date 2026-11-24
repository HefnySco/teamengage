import { open, rename, mkdir } from "node:fs/promises";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomic file write: temp file in the same directory → fsync → rename →
 * fsync the directory. A crash leaves either the old or the new file,
 * never a partial one (DESIGN §6.2).
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await open(tmp, "w");
  try {
    await fh.write(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  const dh = await open(dir, "r");
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

/**
 * Sync variant of writeFileAtomic — same temp → fsync → rename → dir-fsync
 * order, for callers that cannot await (dispatch runtime state, TE-0223).
 */
export function writeFileAtomicSync(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}
