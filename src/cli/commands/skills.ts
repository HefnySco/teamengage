import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandTilde } from "../../core/config/config.js";

/**
 * `te skills [--install|--uninstall|--check] [--dir <path>] [--src <dir>]`
 * — deploy the repo's `skills/te-*` folders into the known agent skill
 * directories as symlinks.
 *
 * Skills ship in the repo and agents load them from per-agent folders
 * (~/.claude/skills, ~/.config/devin/skills, ~/.codeium/windsurf/skills).
 * They must be LINKED, never copied: a copied SKILL.md goes stale the day
 * the repo moves on and silently teaches agents an outdated protocol.
 * --install links (an existing real dir is moved aside to
 * <name>.te-bak-<date>, never deleted), --uninstall removes only links that
 * point into this repo, --check reports drift and exits 1 on any.
 * Bare `te skills` prints the same report without changing anything.
 */

/** agent skill folders managed by default (only ones that exist or whose
 *  parent exists are touched) */
function defaultAgentDirs(home: string): string[] {
  return [
    join(home, ".claude", "skills"),
    join(home, ".config", "devin", "skills"),
    join(home, ".codeium", "windsurf", "skills"),
  ];
}

/** the repo's skills dir, relative to this file (src/… or dist/…) */
export function repoSkillsDir(fromFile?: string): string {
  const here = dirname(fileURLToPath(fromFile ?? import.meta.url));
  for (let d = here; ; d = dirname(d)) {
    const cand = join(d, "skills");
    if (existsSync(join(cand, "te-work", "SKILL.md"))) return cand;
    if (dirname(d) === d) throw new Error("skills/ with te-work not found above " + here);
  }
}

/** repo skill folder names (dirs under skills/, e.g. te-review) */
export function repoSkills(skillsDir: string): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("te-"))
    .map((e) => e.name)
    .sort();
}

export type SkillState =
  | "linked" // symlink → this repo's skill dir
  | "linked-other" // symlink → somewhere else
  | "copy" // real dir/files identical to the repo's
  | "stale" // real dir/files differing from the repo's
  | "broken" // symlink whose target is gone
  | "missing";

function filesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** shallow compare: same file set, SKILL.md byte-equal (the file that
 *  teaches the protocol; ancillary files are compared too when present) */
function dirSameAsRepo(dir: string, repoDir: string): boolean {
  try {
    const a = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
    const b = readdirSync(repoDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
    if (a.join("") !== b.join("")) return false;
    return b.every((f) => filesEqual(join(dir, f), join(repoDir, f)));
  } catch {
    return false;
  }
}

export function skillState(path: string, repoDir: string): SkillState {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) return "missing";
  if (st.isSymbolicLink()) {
    try {
      // realpath both sides: link chains and mount aliases (~/TDisk ->
      // /mnt/…) still count as linked when they land on the repo dir
      return realpathSync(resolve(dirname(path), readlinkSync(path))) === realpathSync(repoDir)
        ? "linked"
        : "linked-other";
    } catch {
      return "broken";
    }
  }
  return dirSameAsRepo(path, repoDir) ? "copy" : "stale";
}

export interface SkillRow {
  agentDir: string;
  skill: string;
  state: SkillState;
}

export function survey(agentDirs: string[], skillsDir: string): SkillRow[] {
  const rows: SkillRow[] = [];
  for (const agentDir of agentDirs) {
    for (const skill of repoSkills(skillsDir)) {
      rows.push({ agentDir, skill, state: skillState(join(agentDir, skill), join(skillsDir, skill)) });
    }
  }
  return rows;
}

const BAD: SkillState[] = ["copy", "stale", "broken", "linked-other", "missing"];

function backupPath(path: string, stamp: string): string {
  let p = `${path}.te-bak-${stamp}`;
  for (let i = 2; existsSync(p); ++i) p = `${path}.te-bak-${stamp}.${i}`;
  return p;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

/** one agent dir worth installing into: it exists, or its parent does
 *  (so `mkdir -p` lands inside a real agent config dir) */
function installable(agentDir: string): boolean {
  return existsSync(agentDir) || existsSync(dirname(agentDir));
}

function report(rows: SkillRow[], skillsDir: string, agentDirs: string[]): string {
  const out: string[] = [`skills source: ${skillsDir}`];
  for (const agentDir of agentDirs) {
    const dirRows = rows.filter((r) => r.agentDir === agentDir);
    if (!existsSync(agentDir)) {
      out.push(`${agentDir}  (absent — ${installable(agentDir) ? "would create on --install" : "agent not installed here"})`);
      continue;
    }
    out.push(
      `${agentDir}  ` +
        dirRows.map((r) => `${r.skill}:${r.state === "copy" ? "copy (in sync — drifts on update)" : r.state}`).join("  "),
    );
  }
  return out.join("\n") + "\n";
}

export async function skillsCmd(args: string[], home?: string, srcDir?: string): Promise<number> {
  const hm = home ?? homedir();
  const extra: string[] = [];
  let srcArg: string | undefined;
  for (let i = 0; i < args.length; ++i) {
    if (args[i] === "--dir" && args[i + 1] !== undefined) {
      extra.push(resolve(expandTilde(args[++i], hm)));
    } else if (args[i] === "--src" && args[i + 1] !== undefined) {
      srcArg = resolve(expandTilde(args[++i], hm));
    }
  }
  const install = args.includes("--install");
  const uninstall = args.includes("--uninstall");
  const check = args.includes("--check");
  const skillsDir = srcDir ?? srcArg ?? repoSkillsDir();
  const agentDirs = [...defaultAgentDirs(hm), ...extra.filter((d) => !defaultAgentDirs(hm).includes(d))];
  const stampStr = stamp();

  if (install || uninstall) {
    for (const agentDir of agentDirs) {
      if (install) {
        if (!installable(agentDir)) continue;
        mkdirSync(agentDir, { recursive: true });
      }
      if (!existsSync(agentDir)) continue;
      if (uninstall) {
        // remove only links pointing inside this repo's skills dir —
        // covers skills since deleted from the repo; real dirs untouched
        for (const name of readdirSync(agentDir)) {
          const path = join(agentDir, name);
          if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() !== true) continue;
          const raw = resolve(agentDir, readlinkSync(path));
          // ours when the link names this repo's skills dir (even if the
          // skill was since deleted) or lands there through an alias chain
          let ours = dirname(raw) === resolve(skillsDir);
          if (!ours) {
            try {
              ours = dirname(realpathSync(raw)) === realpathSync(skillsDir);
            } catch {
              /* target gone and not this repo's path — leave it */
            }
          }
          if (!ours) continue;
          rmSync(path);
          process.stdout.write(`removed ${path}\n`);
        }
        continue;
      }
      for (const skill of repoSkills(skillsDir)) {
        const path = join(agentDir, skill);
        const target = join(skillsDir, skill);
        const state = skillState(path, target);
        if (state === "linked") continue;
        if (state !== "missing") {
          const bak = backupPath(path, stampStr);
          renameSync(path, bak);
          process.stdout.write(`moved aside ${path} -> ${bak}\n`);
        }
        symlinkSync(target, path, "dir");
        process.stdout.write(`linked ${path} -> ${target}\n`);
      }
    }
    process.stdout.write(install ? "skills linked — agents read the repo copies from now on\n" : "TeamEngage skill links removed\n");
    return 0;
  }

  const rows = survey(agentDirs, skillsDir);
  process.stdout.write(report(rows, skillsDir, agentDirs));
  // drift only counts where the agent dir exists — a missing dir means
  // that agent isn't installed here, not that a skill is out of date
  const drift = rows.filter((r) => BAD.includes(r.state) && existsSync(r.agentDir));
  if (check) {
    if (drift.length > 0) {
      process.stdout.write(`drift: ${drift.length} entr${drift.length === 1 ? "y" : "ies"} need 'te skills --install'\n`);
      return 1;
    }
    process.stdout.write("all deployed skills are linked to this repo\n");
    return 0;
  }
  if (drift.length > 0) {
    process.stdout.write("\nrun 'te skills --install' to link them (real dirs are moved aside to .te-bak-<date>, never deleted)\n");
  }
  return 0;
}
