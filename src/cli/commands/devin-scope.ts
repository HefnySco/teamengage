import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  expandTilde,
  loadRegistry,
  resolveRepoDirs,
  resolveWorkspace,
  resolveWorkspaceByName,
  type LoadedWorkspace,
} from "../../core/config/config.js";

/**
 * `te devin-scope [--install|--uninstall|--check] [--ws <name>]`
 *
 * Agents spawned by `te run` / dispatch start in the workspace root — that is
 * their whole write scope. A claim that hands them a repo checkout outside it
 * (git resources, `repos:` entries) fails every write, and `devin -p` cannot
 * approve the scope prompt: the tool call is rejected in print mode, so the
 * agent can only ask the human. The fix is a project-level Devin config:
 * `<root>/.devin/config.local.json` with `Write(<dir>/**)` grants for every
 * directory a claim can hand out. `config.local.json` is Devin's
 * not-committed project file — the paths are machine-local, so this file is
 * generated per machine and `.devin/` is kept out of git.
 *
 * Re-run `--install` after `repos:` or `resources:` change; `--check` reports
 * drift without writing.
 */

const REL = join(".devin", "config.local.json");

type LocalConfig = { permissions?: { allow?: string[]; [k: string]: unknown }; [k: string]: unknown };

/** Directories a claim can hand an agent: the workspace root (in-root
 *  worktrees and .teNNNN-work dirs live under it) plus every repo dir a
 *  Touches name resolves to. Each dir yields its resolved path and, when a
 *  symlink is in the way, its real path — the agent may write through either. */
export function scopeGrants(ws: LoadedWorkspace, home?: string): string[] {
  const dirs = new Set<string>([resolve(ws.root)]);
  for (const dir of resolveRepoDirs(ws, home).values()) dirs.add(resolve(dir));
  const grants = new Set<string>();
  for (const dir of dirs) {
    grants.add(`Write(${dir}/**)`);
    try {
      const real = realpathSync(dir);
      if (real !== dir) grants.add(`Write(${real}/**)`);
    } catch {
      /* dir missing — keep the declared path */
    }
  }
  return [...grants].sort();
}

const configPath = (root: string) => join(root, REL);

/** Merge our grants into (or, `remove: true`, out of) an existing config.local.json. */
export function mergeScope(current: LocalConfig, grants: string[], remove = false): LocalConfig {
  const allow = (current.permissions?.allow ?? []).filter(
    (e) => !(typeof e === "string" && /^Write\(/.test(e) && grants.includes(e)),
  );
  const next: LocalConfig = {
    ...current,
    permissions: { ...(current.permissions ?? {}), allow: [...allow, ...(remove ? [] : grants)] },
  };
  if (!next.permissions!.allow!.length) {
    delete next.permissions!.allow;
    if (!Object.keys(next.permissions!).length) delete next.permissions;
  }
  return next;
}

/** Keep `.devin/` out of the plans repo — the file is machine-local. */
function ensureGitignored(root: string): string | null {
  if (!existsSync(join(root, ".git"))) return null;
  const gi = join(root, ".gitignore");
  let lines: string[] = [];
  if (existsSync(gi)) {
    lines = readFileSync(gi, "utf8").split("\n");
    if (lines.some((l) => l.trim() === ".devin" || l.trim() === ".devin/" || l.trim() === "/.devin/"))
      return null;
  }
  lines.push(".devin/");
  writeFileSync(gi, lines.join("\n"));
  return "added .devin/ to .gitignore";
}

function workspaces(args: string[], home?: string): LoadedWorkspace[] {
  const i = args.indexOf("--ws");
  if (i !== -1) return [resolveWorkspaceByName(args[i + 1], { home })];
  const out: LoadedWorkspace[] = [];
  for (const entry of Object.values(loadRegistry(home).workspaces)) {
    try {
      out.push(resolveWorkspace(expandTilde(entry.root, home), { home }));
    } catch {
      /* a broken workspace gets no config */
    }
  }
  return out;
}

export async function devinScopeCmd(args: string[], home?: string): Promise<number> {
  const install = args.includes("--install");
  const uninstall = args.includes("--uninstall");
  const check = args.includes("--check");
  if (install && uninstall) {
    process.stderr.write("pick one of --install / --uninstall\n");
    return 1;
  }
  const wss = workspaces(args, home);
  if (!wss.length) {
    process.stderr.write("no workspaces registered — run `te init` first\n");
    return 1;
  }
  let rc = 0;
  for (const ws of wss) {
    const file = configPath(ws.root);
    const grants = scopeGrants(ws, home);
    let current: LocalConfig = {};
    if (existsSync(file)) {
      try {
        current = JSON.parse(readFileSync(file, "utf8")) as LocalConfig;
      } catch (e) {
        process.stderr.write(`${ws.name}: refusing to touch ${file}: not valid JSON (${(e as Error).message})\n`);
        rc = 1;
        continue;
      }
    }
    const have = (current.permissions?.allow ?? []).filter((e) => /^Write\(/.test(e));
    if (check) {
      const missing = grants.filter((g) => !have.includes(g));
      const extra = have.filter((g) => !grants.includes(g));
      process.stdout.write(
        `${ws.name}: ${file}\n` +
          (missing.length ? `  missing: ${missing.join(", ")}\n` : "") +
          (extra.length ? `  also present (kept): ${extra.join(", ")}\n` : "") +
          (missing.length ? "" : "  in sync\n"),
      );
      if (missing.length) rc = 1;
      continue;
    }
    if (!install && !uninstall) {
      process.stdout.write(
        JSON.stringify(mergeScope({}, grants), null, 2) +
          `\n\n# te devin-scope --install writes this to ${file}` +
          `\n# grants (${ws.name}):\n` +
          grants.map((g) => `#   ${g}`).join("\n") +
          "\n",
      );
      continue;
    }
    const next = mergeScope(current, grants, uninstall);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.te-tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, file);
    const gi = uninstall ? null : ensureGitignored(ws.root);
    process.stdout.write(
      uninstall
        ? `${ws.name}: removed the TeamEngage write scopes from ${file}\n`
        : `${ws.name}: ${grants.length} Write() scopes installed in ${file}` +
            `${gi ? ` (${gi})` : ""}\n  covers ` +
            grants.map((g) => g.slice(6, -4)).join(", ") +
            `\n  takes effect in new Devin sessions — a running session keeps its old scope\n`,
    );
  }
  return rc;
}
