import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseDuration, type TargetConfig } from "../model/workspace.js";
import type { Job } from "./job.js";
import type { Playbook, PlaybookStep } from "./playbook.js";
import { kebab, loadMachines, type Machine } from "./machine.js";

/**
 * The ops runner — the only process that ever executes playbook commands.
 * `te ops exec` (CLI) and tests drive it; the daemon never runs steps
 * itself. Each cmd/check step runs under `bash -c` in the playbook cwd,
 * output streams to the terminal and to a full local log under
 * `~/.teamengage/ops-logs/<job>/<step>.log` (never synced). The posted
 * output is masked for the values of the playbook's secret_env names —
 * the job record that other machines see never carries a secret.
 */

export interface ExecStepResult {
  exit_code: number;
  /** full step output, masked for secret_env values — safe to post */
  output: string;
  log_file: string;
}

export type ExecState = "succeeded" | "stopped" | "failed" | "waiting" | "paused" | "aborted" | "refused";

export interface ExecOutcome {
  state: ExecState;
  job: Job;
  /** set when the cursor sits on an agent or gate step */
  waiting_on?: { step: string; kind: "agent" | "gate"; instruction?: string };
  /** set when the daemon refused a post (OPS_* or another error) */
  error?: string;
}

export interface ExecJobOptions {
  playbook: Playbook;
  /** reload the job record */
  getJob: () => Promise<Job>;
  /** post a step result — resolves with the updated job */
  postResult: (step_id: string, r: { exit_code: number; output: string }) => Promise<Job>;
  /** step working directory — the resolved playbook cwd */
  cwd: string;
  env?: Record<string, string | undefined>;
  /** e.g. <teHome>/ops-logs */
  logsDir: string;
  /** terminal stream — raw output, not masked */
  out?: (chunk: string) => void;
  /** run only this step (it must sit at the cursor), then stop */
  onlyStep?: string;
  bash?: string;
}

/** Replace every non-empty secret value in `text` with `***`. */
export function maskSecrets(text: string, values: (string | undefined)[]): string {
  for (const v of values) {
    if (v) text = text.split(v).join("***");
  }
  return text;
}

function secretValues(playbook: Playbook, env: Record<string, string | undefined>): (string | undefined)[] {
  return playbook.secret_env.map((name) => env[name]);
}

/** Run one cmd/check step under bash, stream + log its output, mask secrets. */
export async function execStep(
  step: PlaybookStep,
  job: Job,
  opts: {
    playbook: Playbook;
    cwd: string;
    env?: Record<string, string | undefined>;
    logsDir: string;
    out?: (chunk: string) => void;
    bash?: string;
  },
): Promise<ExecStepResult> {
  const dir = join(opts.logsDir, job.id);
  mkdirSync(dir, { recursive: true });
  const log_file = join(dir, `${step.id}.log`);
  const env = { ...process.env, ...opts.env, ...job.params };
  let timeout_ms = 0;
  if (step.timeout) {
    try {
      timeout_ms = parseDuration(step.timeout);
    } catch {
      throw new Error(`step '${step.id}' has a bad timeout '${step.timeout}'`);
    }
  }
  const ran = await new Promise<{ code: number; output: string }>((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(log_file);
    const child = spawn(opts.bash ?? "bash", ["-c", step.run ?? ""], { cwd: opts.cwd, env });
    let text = "";
    let timed_out = false;
    const timer = timeout_ms
      ? setTimeout(() => {
          timed_out = true;
          child.kill("SIGKILL");
        }, timeout_ms)
      : undefined;
    const take = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      text += s;
      stream.write(s);
      opts.out?.(s);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      stream.end();
      rejectPromise(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timed_out) {
        const note = `\n[te ops] step timed out after ${step.timeout}\n`;
        text += note;
        stream.write(note);
      }
      stream.end(() => resolvePromise({ code: timed_out ? -1 : (code ?? -1), output: text }));
    });
  });
  const output = maskSecrets(ran.output, secretValues(opts.playbook, env));
  return { exit_code: ran.code, output, log_file };
}

/**
 * Drive a job forward: run every cmd/check step at the cursor, post each
 * result, and stop at the first agent/gate step or terminal state.
 */
export async function execJob(opts: ExecJobOptions): Promise<ExecOutcome> {
  let job = await opts.getJob();
  for (;;) {
    if (job.status === "aborted") return { state: "aborted", job };
    if (job.status === "failed") return { state: "failed", job };
    if (job.status === "stopped") return { state: "stopped", job };
    const spec = opts.playbook.steps[job.cursor];
    if (!spec || job.status === "succeeded") return { state: "succeeded", job };
    if (opts.onlyStep && spec.id !== opts.onlyStep) {
      return {
        state: "refused",
        job,
        error: `step '${opts.onlyStep}' is not the cursor step — the cursor is at '${spec.id}'`,
      };
    }
    if (spec.kind === "agent" || spec.kind === "gate") {
      return {
        state: "waiting",
        job,
        waiting_on: { step: spec.id, kind: spec.kind, instruction: spec.instruction },
      };
    }
    const r = await execStep(spec, job, opts);
    try {
      job = await opts.postResult(spec.id, { exit_code: r.exit_code, output: r.output });
    } catch (e) {
      return { state: "refused", job, error: e instanceof Error ? e.message : String(e) };
    }
    if (opts.onlyStep) {
      if (job.status === "failed") return { state: "failed", job };
      if (job.status === "stopped") return { state: "stopped", job };
      if (job.status === "succeeded") return { state: "succeeded", job };
      const next = opts.playbook.steps[job.cursor];
      if (next?.kind === "agent" || next?.kind === "gate") {
        return {
          state: "waiting",
          job,
          waiting_on: { step: next.id, kind: next.kind, instruction: next.instruction },
        };
      }
      return { state: "paused", job };
    }
  }
}

/**
 * Deploy guard (GL-0287): a target that names a `machine:` may only be
 * worked on from machines that hold a `deploy` edge to it. The runner
 * resolves the machine record of the current computer — the record with
 * `runner: true` in its .machine.local file, else a `host` equal to the
 * hostname. Returns the refusal message, or undefined when the run may
 * proceed (no target machine, no deploy edges, or this runner is allowed).
 */
export function runnerMachine(root: string, hostname: string): Machine | undefined {
  const machines = loadMachines(root).flatMap((l) => (l.machine ? [l.machine] : []));
  return machines.find((m) => m.runner) ?? machines.find((m) => m.host && kebab(m.host) === kebab(hostname));
}

export function deployGuard(
  root: string,
  target: TargetConfig | undefined,
  hostname: string,
  targetName = "the target",
): string | undefined {
  const tm = target?.machine;
  if (!tm) return undefined;
  const machines = loadMachines(root).flatMap((l) => (l.machine ? [l.machine] : []));
  const allowed = machines.flatMap((m) =>
    m.edges.filter((e) => e.kind === "deploy" && kebab(e.to.split("/")[0]) === kebab(tm)).map((e) => ({ m, e })),
  );
  if (!allowed.length) return undefined;
  const runner = runnerMachine(root, hostname);
  if (runner && allowed.some((a) => a.m.id === runner.id)) return undefined;
  const list = allowed.map((a) => `${a.m.id}${a.e.repo ? ` (${a.e.repo})` : ""}`).join(", ");
  return `${targetName} (machine ${kebab(tm)}) is deployed from ${list}; this runner is ${runner?.id ?? kebab(hostname)}`;
}
