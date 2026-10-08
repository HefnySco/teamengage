import { open, rename, mkdir } from "node:fs/promises";
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
