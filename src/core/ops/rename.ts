import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kebab, loadMachines } from "./machine.js";
import { teHome } from "../config/config.js";
import { ValidationError } from "../model/errors.js";

/**
 * Machine rename: one atomic sweep so `te machines rename <old> <new>`
 * never leaves a dangling reference. Touches, in order:
 *   1. machines/<old>.machine.md + .machine.local — renamed, `id:` and
 *      every edge `to:`/`paths:` key rewritten in all machine files;
 *   2. envs/*.env.md — `machines[].id` and `reach[].from/to`;
 *   3. <plansDir>/workspace.yaml — `targets.*.machine`;
 *   4. <teHome>/ops-probes/reach/*.json — stored from/to fields;
 *   5. <plansDir>/ops/{jobs,events}/<old> — runner-keyed dirs renamed,
 *      job ids `old-NNNN` and `machine:` fields rewritten inside;
 *   6. <plansDir>/ops/locks/*.yaml — `machine:` and `job:` fields.
 * Prose (rules text, file bodies, note blocks) is left alone — mentions
 * in notes are history, not references.
 */

export interface RenameReport {
  old: string;
  renamed_to: string;
  /** files and dirs moved */
  renamed: { from: string; to: string }[];
  /** files whose text changed, with the reference count */
  edited: { file: string; refs: number }[];
}

/** `---\n<fm>\n---\n<body>` — raw-text half of splitFrontmatter for field-level edits. */
function splitFmText(text: string): { fm: string; body: string } | undefined {
  const m = /^---\r?\n/.exec(text);
  if (!m) return undefined;
  const rest = text.slice(m[0].length);
  const end = /^---[ \t]*\r?\n/m.exec(rest) ?? /^---[ \t]*$/m.exec(rest);
  if (!end) return undefined;
  return { fm: rest.slice(0, end.index), body: rest.slice(end.index + end[0].length) };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

interface Rule {
  re: RegExp;
  rep: string;
}

/** machine-file frontmatter + .machine.local: id field, edge to:/app paths, paths-record keys */
function machineRules(o: string, n: string): Rule[] {
  const E = esc(o);
  return [
    { re: new RegExp(`^([ \\t]*id:[ \\t]*)${E}[ \\t]*$`, "gm"), rep: `$1${n}` },
    { re: new RegExp(`((?:from|to):[ \\t]*)${E}(?=[\\s,}\\/]|$)`, "gm"), rep: `$1${n}` },
    { re: new RegExp(`(?<=[{,\\s])${E}(?=[ \\t]*:)`, "g"), rep: `${n}` },
  ];
}

/** env-file frontmatter: machines entries carry `id:` but the env's own `id:` sits at column 0 — excluded */
function envRules(o: string, n: string): Rule[] {
  const E = esc(o);
  return [
    { re: new RegExp(`([{,\\- \\t]id:[ \\t]*)${E}(?=[\\s,}\\n]|$)`, "gm"), rep: `$1${n}` },
    { re: new RegExp(`((?:from|to):[ \\t]*)${E}(?=[\\s,}\\/]|$)`, "gm"), rep: `$1${n}` },
  ];
}

/** apply rules; return refs replaced */
function sweep(text: string, rules: Rule[]): { text: string; refs: number } {
  let refs = 0;
  for (const { re, rep } of rules) {
    refs += (text.match(re) ?? []).length;
    text = text.replace(re, rep);
  }
  return { text, refs };
}

function sweepFile(file: string, rules: Rule[], fmOnly: boolean, out: { file: string; refs: number }[]): void {
  const text = readFileSync(file, "utf8");
  let refs = 0;
  let next = text;
  if (fmOnly) {
    const s = splitFmText(text);
    if (!s) return;
    const r = sweep(s.fm, rules);
    refs = r.refs;
    next = `---\n${r.text}---\n${s.body}`;
  } else {
    const r = sweep(text, rules);
    refs = r.refs;
    next = r.text;
  }
  if (refs === 0) return;
  writeFileSync(file, next);
  out.push({ file, refs });
}

export function renameMachine(
  root: string,
  plansDir: string | undefined,
  home: string | undefined,
  oldId: string,
  newId: string,
): RenameReport {
  const o = kebab(oldId);
  const n = kebab(newId);
  if (!o || !n) throw new ValidationError("machine rename needs two ids");
  if (o === n) throw new ValidationError(`rename ${o} onto itself — nothing to do`);
  const loaded = loadMachines(root);
  const src = loaded.find((l) => l.machine?.id === o);
  if (!src?.machine) throw new ValidationError(`no machine '${o}' under machines/`);
  if (loaded.some((l) => l.machine?.id === n)) throw new ValidationError(`machine '${n}' already exists`);
  const srcFile = join(root, src.file);
  const srcStem = src.file.replace(/^machines\//, "").replace(/\.machine\.md$/, "");
  const dstFile = join(root, "machines", `${n}.machine.md`);
  if (existsSync(dstFile)) throw new ValidationError(`machines/${n}.machine.md already exists`);

  const report: RenameReport = { old: o, renamed_to: n, renamed: [], edited: [] };
  const mRules = machineRules(o, n);
  const eRules = envRules(o, n);

  // 1 — every machine file: references first, then the file move
  const mdir = join(root, "machines");
  for (const name of readdirSync(mdir).filter((x) => x.endsWith(".machine.md") || x.endsWith(".machine.local"))) {
    sweepFile(join(mdir, name), mRules, !name.endsWith(".local"), report.edited);
  }
  renameSync(srcFile, dstFile);
  report.renamed.push({ from: src.file, to: `machines/${n}.machine.md` });
  const localSrc = join(mdir, `${srcStem}.machine.local`);
  if (existsSync(localSrc)) {
    renameSync(localSrc, join(mdir, `${n}.machine.local`));
    report.renamed.push({ from: `machines/${srcStem}.machine.local`, to: `machines/${n}.machine.local` });
  }

  // 2 — env files: machines list + reach edges (frontmatter only)
  const edir = join(root, "envs");
  if (existsSync(edir)) {
    for (const name of readdirSync(edir).filter((x) => x.endsWith(".env.md"))) {
      sweepFile(join(edir, name), eRules, true, report.edited);
    }
  }

  // 3 — workspace.yaml targets.<t>.machine
  if (plansDir) {
    const wsFile = join(plansDir, "workspace.yaml");
    if (existsSync(wsFile)) {
      const E = esc(o);
      sweepFile(
        wsFile,
        [
          { re: new RegExp(`^([ \\t]*machine:[ \\t]*)${E}([ \\t]*(?:#.*)?)$`, "gm"), rep: `$1${n}$2` },
          { re: new RegExp(`([{,][ \\t]*machine:[ \\t]*)${E}(?=[\\s,}])`, "g"), rep: `$1${n}` },
        ],
        false,
        report.edited,
      );
    }
  }

  // 4 — stored reach probes: <teHome>/ops-probes/reach/<env>.json, results keyed from>to>via
  const reachDir = join(teHome(home), "ops-probes", "reach");
  if (existsSync(reachDir)) {
    for (const name of readdirSync(reachDir).filter((x) => x.endsWith(".json"))) {
      const file = join(reachDir, name);
      try {
        const arr = JSON.parse(readFileSync(file, "utf8")) as { from?: string; to?: string }[];
        if (!Array.isArray(arr)) continue;
        let refs = 0;
        for (const r of arr) {
          if (r.from === o) { r.from = n; refs++; }
          if (r.to === o) { r.to = n; refs++; }
        }
        if (!refs) continue;
        writeFileSync(file, JSON.stringify(arr, null, 2) + "\n");
        report.edited.push({ file, refs });
      } catch {
        /* unreadable probe file — skip it */
      }
    }
  }

  // 5 — runner-keyed state under the plans dir: ops/jobs/<old>, events/<old>
  if (plansDir) {
    const E = esc(o);
    const jobsDir = join(plansDir, "ops", "jobs", o);
    if (existsSync(jobsDir)) {
      for (const name of readdirSync(jobsDir).filter((x) => x.endsWith(".yaml"))) {
        const file = join(jobsDir, name);
        const { text, refs } = sweep(readFileSync(file, "utf8"), [
          { re: new RegExp(`^([ \\t]*machine:[ \\t]*)${E}[ \\t]*$`, "gm"), rep: `$1${n}` },
          { re: new RegExp(`^([ \\t]*id:[ \\t]*)${E}-`, "gm"), rep: `$1${n}-` },
        ]);
        if (refs) {
          writeFileSync(file, text);
          report.edited.push({ file, refs });
        }
        if (name.startsWith(`${o}-`)) renameSync(file, join(jobsDir, `${n}-${name.slice(o.length + 1)}`));
      }
      renameSync(jobsDir, join(plansDir, "ops", "jobs", n));
      report.renamed.push({ from: `ops/jobs/${o}`, to: `ops/jobs/${n}` });
    }
    const eventsDir = join(plansDir, "events", o);
    if (existsSync(eventsDir)) {
      const re = new RegExp(`"machine":[ ]?"${E}"`, "g");
      for (const name of readdirSync(eventsDir).filter((x) => x.endsWith(".jsonl"))) {
        const file = join(eventsDir, name);
        const { text, refs } = sweep(readFileSync(file, "utf8"), [{ re, rep: `"machine":"${n}"` }]);
        if (refs) {
          writeFileSync(file, text);
          report.edited.push({ file, refs });
        }
      }
      renameSync(eventsDir, join(plansDir, "events", n));
      report.renamed.push({ from: `events/${o}`, to: `events/${n}` });
    }

    // 6 — locks: files are keyed by target; the machine: and job: fields inside name the runner
    const locksDir = join(plansDir, "ops", "locks");
    if (existsSync(locksDir)) {
      for (const name of readdirSync(locksDir).filter((x) => x.endsWith(".yaml"))) {
        sweepFile(
          join(locksDir, name),
          [
            { re: new RegExp(`^([ \\t]*machine:[ \\t]*)${E}[ \\t]*$`, "gm"), rep: `$1${n}` },
            { re: new RegExp(`^([ \\t]*job:[ \\t]*)${E}-`, "gm"), rep: `$1${n}-` },
          ],
          false,
          report.edited,
        );
      }
    }
  }

  return report;
}
