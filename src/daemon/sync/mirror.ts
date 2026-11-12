import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { expandTilde } from "../../core/config/config.js";
import { git, remotes } from "../../resources/git/git.js";

/**
 * Mirror remotes (workspace `mirror_remotes`): extra remotes — a USB drive,
 * a second server — that `te sync` carries code and plans through with the
 * same fast-forward-only rules as the primary remote. Shared by the code
 * sync (code.ts) and the plans sync (sync.ts).
 */

/** `names` that exist on `repo`, minus `exclude` (the primary remote). */
export async function repoMirrors(
  repo: string,
  names: string[],
  exclude?: string,
): Promise<string[]> {
  if (!names.length) return [];
  const all = await remotes(repo);
  return names.filter((n) => n !== exclude && all.includes(n));
}

/** The fetch URL of remote `name`; undefined when the repo lacks it. */
export async function remoteUrl(repo: string, name: string): Promise<string | undefined> {
  try {
    return (await git(repo, ["remote", "get-url", name])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The filesystem path a remote URL points at — a plain path, `~/…` or
 * `file://…`. Undefined for network URLs (https/ssh/git/…) and scp-like
 * `host:path` remotes, which are never "not mounted".
 */
export function localRemotePath(url: string): string | undefined {
  if (url.startsWith("file://")) return url.slice("file://".length);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return undefined;
  // scp-like syntax [user@]host:path — the part before ':' has no '/'
  if (/^(?:[^\s/:]+@)?[^\s/:]+:/.test(url) && !/^[/~.]/.test(url)) return undefined;
  return url;
}

/**
 * The local path remote `name` points at when it does not exist — the USB
 * mirror is not mounted. Undefined for network remotes (they are never
 * "not mounted"), for existing paths, and for repos without the remote.
 */
export async function missingLocalRemotePath(
  repo: string,
  name: string,
  home?: string,
): Promise<string | undefined> {
  const url = await remoteUrl(repo, name);
  if (!url) return undefined;
  const p = localRemotePath(url);
  if (p === undefined) return undefined;
  const expanded = expandTilde(p, home);
  const abs = isAbsolute(expanded) ? expanded : resolve(repo, expanded);
  return existsSync(abs) ? undefined : abs;
}

/**
 * True when the remote's URL is a local path that does not exist — the USB
 * mirror is not mounted. Network remotes and existing paths return false.
 */
export async function mirrorNotMounted(
  repo: string,
  name: string,
  home?: string,
): Promise<boolean> {
  return (await missingLocalRemotePath(repo, name, home)) !== undefined;
}

/** `git rev-parse --verify -q <ref>` as a boolean. */
export async function hasRef(repo: string, ref: string): Promise<boolean> {
  return git(repo, ["rev-parse", "--verify", "-q", ref]).then(
    () => true,
    () => false,
  );
}
