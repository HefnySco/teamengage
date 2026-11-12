import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Finding } from "../validate/validate.js";

/**
 * Playbooks (DESIGN §14): permanent ordered step lists for repeatable
 * operations — deploys, syncs. `<root>/ops/<name>.playbook.yaml`, synced
 * with the plans repo. The daemon validates and records; `te ops exec`
 * runs the commands — it never executes playbook commands itself.
 */

export const StepKind = z.enum(["cmd", "check", "agent", "gate"]);
export type StepKind = z.infer<typeof StepKind>;

export const PlaybookStep = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  kind: StepKind.default("cmd"),
  /** shell — required on cmd/check, forbidden on agent/gate (checked as findings) */
  run: z.string().optional(),
  expect_exit: z.number().int().default(0),
  /** duration string like 10m, 30s */
  timeout: z.string().default("10m"),
  /** fail: the job fails. stop: the job ends stopped — checked, nothing to do */
  on_fail: z.enum(["fail", "stop"]).default("fail"),
  /** an optional step may be skipped, with a recorded reason */
  optional: z.boolean().default(false),
  /** shell run by te ops rollback in reverse order */
  rollback: z.string().optional(),
  /** markdown for agent/gate steps */
  instruction: z.string().optional(),
});
export type PlaybookStep = z.infer<typeof PlaybookStep>;

export const PlaybookParam = z.object({
  name: z.string().min(1),
  default: z.string().optional(),
  required: z.boolean().default(false),
});
export type PlaybookParam = z.infer<typeof PlaybookParam>;

export const Playbook = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  /** default target id from workspace.yaml targets: */
  target: z.string().optional(),
  /** who may start a job — default human */
  start: z.enum(["human", "agent"]).default("human"),
  /** least agent tier that may start it (when start: agent) */
  min_tier: z.enum(["light", "standard", "heavy"]).optional(),
  /** step working directory — default the workspace root */
  cwd: z.string().optional(),
  params: z.array(PlaybookParam).default([]),
  /** env names whose values are masked in posted output */
  secret_env: z.array(z.string()).default([]),
  /** step id whose last non-empty output line becomes the deployed version */
  version_from: z.string().optional(),
  steps: z.array(PlaybookStep).min(1),
});
export type Playbook = z.infer<typeof Playbook>;

/** One `ops/*.playbook.yaml` — either a parsed playbook or its load error. */
export interface LoadedPlaybook {
  /** workspace-relative path, e.g. ops/auth-shadow-deploy.playbook.yaml */
  file: string;
  playbook?: Playbook;
  error?: string;
}

/** Load every `<root>/ops/*.playbook.yaml`. Missing dir means no playbooks. */
export function loadPlaybooks(root: string): LoadedPlaybook[] {
  const dir = join(root, "ops");
  if (!existsSync(dir)) return [];
  const out: LoadedPlaybook[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".playbook.yaml")).sort()) {
    const file = join(dir, name);
    const rel = `ops/${name}`;
    try {
      const parsed = Playbook.safeParse(YAML.parse(readFileSync(file, "utf8")));
      if (parsed.success) out.push({ file: rel, playbook: parsed.data });
      else out.push({ file: rel, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    } catch (e) {
      out.push({ file: rel, error: (e as Error).message.split("\n")[0] });
    }
  }
  return out;
}

/**
 * The semantic checks `te validate` runs on every playbook (GL-0268): an
 * unknown target, duplicate step ids, a gate/agent step with run, a
 * cmd/check step without run, an unknown version_from. Load errors are
 * findings too — a playbook that does not parse can't produce a job.
 */
export function playbookFindings(
  loaded: LoadedPlaybook[],
  targets: Readonly<Record<string, unknown>>,
): Finding[] {
  const out: Finding[] = [];
  const f = (file: string, message: string) => out.push({ severity: "error", kind: "playbook", path: file, message });
  for (const l of loaded) {
    if (!l.playbook) {
      f(l.file, `playbook ${l.file} does not parse: ${l.error}`);
      continue;
    }
    const pb = l.playbook;
    if (pb.target && !(pb.target in targets)) {
      f(l.file, `playbook ${pb.name} names unknown target '${pb.target}' — declare it in workspace.yaml targets:`);
    }
    const seen = new Set<string>();
    for (const s of pb.steps) {
      if (seen.has(s.id)) f(l.file, `playbook ${pb.name}: duplicate step id '${s.id}'`);
      seen.add(s.id);
      if ((s.kind === "gate" || s.kind === "agent") && s.run !== undefined) {
        f(l.file, `playbook ${pb.name}: ${s.kind} step '${s.id}' has run — ${s.kind} steps take an instruction, not a command`);
      }
      if ((s.kind === "cmd" || s.kind === "check") && !s.run?.trim()) {
        f(l.file, `playbook ${pb.name}: ${s.kind} step '${s.id}' has no run`);
      }
    }
    if (pb.version_from && !seen.has(pb.version_from)) {
      f(l.file, `playbook ${pb.name}: version_from '${pb.version_from}' names no step`);
    }
  }
  return out;
}
