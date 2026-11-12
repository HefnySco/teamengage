import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

/**
 * Target locks (DESIGN §14.4): `.teamengage/ops/locks/<target>.yaml` —
 * one live job per target, across sessions and machines. A job start
 * takes the lock; `succeeded`, `stopped` and `aborted` release it; a
 * `failed` job keeps it until resume or abort. The remote half of the
 * check (fetch the plans repo, read the pushed lock) lives in
 * src/daemon/sync/sync.ts — same fetch-before pattern claims use.
 */

export const TargetLock = z.object({
  target: z.string().min(1),
  /** job id holding the lock, e.g. laptop-0007 */
  job: z.string().min(1),
  machine: z.string().min(1),
  session: z.string().optional(),
  ts: z.string(),
  /** taken while the plans remote was unreachable */
  unsynced: z.boolean().optional(),
});
export type TargetLock = z.infer<typeof TargetLock>;

export function lockFilePath(locksDir: string, target: string): string {
  return join(locksDir, `${target}.yaml`);
}

/** Parse a lock file's text — undefined when malformed (used for remote reads too). */
export function parseLockText(text: string): TargetLock | undefined {
  const parsed = TargetLock.safeParse(YAML.parse(text));
  return parsed.success ? parsed.data : undefined;
}

export function readLockFile(locksDir: string, target: string): TargetLock | undefined {
  const p = lockFilePath(locksDir, target);
  if (!existsSync(p)) return undefined;
  try {
    return parseLockText(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeLockFile(locksDir: string, lock: TargetLock): string {
  mkdirSync(locksDir, { recursive: true });
  const p = lockFilePath(locksDir, lock.target);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, YAML.stringify(lock));
  renameSync(tmp, p);
  return p;
}

/**
 * Delete the lock file — only when it names `job` (or always when `job`
 * is omitted). Returns the removed path, undefined when nothing went.
 */
export function removeLockFile(locksDir: string, target: string, job?: string): string | undefined {
  const p = lockFilePath(locksDir, target);
  if (!existsSync(p)) return undefined;
  if (job !== undefined) {
    const lock = readLockFile(locksDir, target);
    if (lock?.job !== job) return undefined;
  }
  unlinkSync(p);
  return p;
}
