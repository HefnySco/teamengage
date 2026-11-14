import { execStep } from "../ops/runner.js";
import { isRepo, revParse } from "../../resources/git/git.js";
import type { Check } from "../model/item.js";
import type { PlaybookStep } from "../ops/playbook.js";

/**
 * `te verify` — run an item's ## Checks in the worktree of each repo
 * (GL-0357). Reuses the ops step runner for the bash spawn, timeout kill
 * and secret masking; prints nothing itself. The result list is what the
 * CLI prints; GL-0358 stores it back on the item.
 */

export interface CheckRun {
  name: string;
  repo?: string;
  /** directory the check ran in (worktree when the item is claimed here) */
  dir: string;
  /** HEAD commit of dir, "" when not a git repo */
  commit: string;
  exit_code?: number;
  expect_exit: number;
  passed: boolean;
  timed_out?: boolean;
  /** set when the check could not run at all (no run, unknown repo) */
  error?: string;
  log_file?: string;
  /** full output, masked for secret values */
  output: string;
}

const SECRET_NAME = /(secret|token|pass|pwd|credential|api_key|private_key|_key$)/i;

/**
 * Env names whose values are masked in check output — secret-looking names
 * only, and only values long enough to be a real secret (masking a short
 * value like "1" would corrupt unrelated output).
 */
export function secretEnvNames(env: Record<string, string | undefined> = process.env): string[] {
  return Object.keys(env).filter((k) => SECRET_NAME.test(k) && (env[k]?.length ?? 0) >= 6);
}

export interface RunChecksOptions {
  item_id: string;
  checks: Check[];
  /** resource name → run directory (claim worktree or resource base) */
  dirs: Record<string, string>;
  /** run dir for a check with no repo — the first target's dir or the ws root */
  default_dir: string;
  logsDir: string;
  env?: Record<string, string | undefined>;
  bash?: string;
}

export async function runChecks(opts: RunChecksOptions): Promise<CheckRun[]> {
  const results: CheckRun[] = [];
  const playbook = { secret_env: secretEnvNames(opts.env ?? process.env) };
  const job = { id: `verify-${opts.item_id}`, params: {} };
  for (const check of opts.checks) {
    const expect_exit = check.expect_exit ?? 0;
    const base: CheckRun = {
      name: check.name,
      repo: check.repo,
      dir: "",
      commit: "",
      expect_exit,
      passed: false,
      output: "",
    };
    const dir = check.repo ? opts.dirs[check.repo] : opts.default_dir;
    if (!check.run) {
      results.push({ ...base, dir: dir ?? "", error: "no run command" });
      continue;
    }
    if (!dir) {
      results.push({
        ...base,
        error: check.repo ? `unknown repo '${check.repo}'` : "no run directory",
      });
      continue;
    }
    base.dir = dir;
    base.commit = (await isRepo(dir)) ? await revParse(dir, "HEAD").catch(() => "") : "";
    const step: PlaybookStep = {
      id: check.name.replace(/[^A-Za-z0-9._-]+/g, "-"),
      kind: "check",
      run: check.run,
      expect_exit,
      timeout: check.timeout ? `${check.timeout}s` : "10m",
      on_fail: "fail",
      optional: false,
    };
    const ran = await execStep(step, job, {
      playbook,
      cwd: dir,
      env: opts.env,
      logsDir: opts.logsDir,
      bash: opts.bash,
    });
    results.push({
      ...base,
      exit_code: ran.exit_code,
      timed_out: ran.timed_out,
      log_file: ran.log_file,
      output: ran.output,
      passed: !ran.timed_out && ran.exit_code === expect_exit,
    });
  }
  return results;
}
