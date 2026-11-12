import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { TeError, ValidationError } from "../model/errors.js";
import { EventLog } from "../events/log.js";
import { readLockFile, removeLockFile, writeLockFile } from "./lock.js";
import type { Playbook } from "./playbook.js";

/**
 * Jobs (DESIGN §14.3, §14.4): one execution of a playbook against a
 * target, recorded step by step under
 * `.teamengage/ops/jobs/<machine>/<job-id>.yaml`. Each machine writes
 * only its own folder, so plans-git convergence never conflicts. Every
 * change also goes to the event log so the UI updates live.
 */

/** Ops refusals carry their own codes — OPS_ORDER and friends are part of the agent protocol. */
export type OpsErrorCode =
  | "OPS_ORDER"
  | "OPS_PLAYBOOK_CHANGED"
  | "OPS_NOT_OPTIONAL"
  | "OPS_TARGET_BUSY"
  | "OPS_STATE";

export class OpsError extends TeError {
  constructor(code: OpsErrorCode, message: string, details?: Record<string, unknown>) {
    super("VALIDATION", message, details);
    (this as { code: string }).code = code;
  }
}

export const JobState = z.enum(["running", "waiting", "failed", "stopped", "succeeded", "aborted"]);
export type JobState = z.infer<typeof JobState>;

export const JobStepState = z.enum(["pending", "running", "passed", "failed", "skipped"]);
export type JobStepState = z.infer<typeof JobStepState>;

export const JobStepRecord = z.object({
  id: z.string(),
  status: JobStepState.default("pending"),
  exit_code: z.number().int().optional(),
  /** last 100 lines, secrets masked by the caller */
  output_tail: z.string().optional(),
  output_sha256: z.string().optional(),
  /** agent steps write their evidence here */
  evidence: z.string().optional(),
  /** why an optional step was skipped */
  reason: z.string().optional(),
  session: z.string().optional(),
  started: z.string().optional(),
  ended: z.string().optional(),
});
export type JobStepRecord = z.infer<typeof JobStepRecord>;

export const Job = z.object({
  /** <machine>-<NNNN> — also the file name */
  id: z.string(),
  machine: z.string(),
  /** playbook name — the file basename under <root>/ops/ */
  playbook: z.string(),
  /** sha256 of the playbook file, pinned at start */
  playbook_sha256: z.string(),
  target: z.string().optional(),
  kind: z.enum(["run", "rollback"]).default("run"),
  status: JobState.default("running"),
  params: z.record(z.string(), z.string()).default({}),
  started: z.object({ ts: z.string(), by: z.string() }),
  /** index into steps — only the step at the cursor may start or take a result */
  cursor: z.number().int().default(0),
  /** on success: last non-empty output line of the version_from step */
  version: z.string().optional(),
  steps: z.array(JobStepRecord),
});
export type Job = z.infer<typeof Job>;

export interface StepResult {
  exit_code?: number;
  /** full step output — the tail and the sha256 are stored */
  output?: string;
  evidence?: string;
  session?: string;
  /** explicit pass/fail — cmd/check derive it from exit_code when absent */
  ok?: boolean;
}

export interface JobStoreOpts {
  /** daemon passes its own log so seq stays single-writer; default opens one on <teDir>/events */
  events?: EventLog;
  /** notify the watcher about daemon writes (see PlansStore.onFileWrite) */
  onFileWrite?: (absPath: string, content: string | null) => void;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const OUTPUT_TAIL_LINES = 100;

function outputTail(output: string): string {
  const lines = output.split("\n");
  return lines.length <= OUTPUT_TAIL_LINES ? output : lines.slice(-OUTPUT_TAIL_LINES).join("\n");
}

/** last non-empty line of a step's stored tail — the deployed version */
export function versionFromTail(tail: string | undefined): string | undefined {
  if (!tail) return undefined;
  for (const line of tail.split("\n").reverse()) {
    if (line.trim() !== "") return line;
  }
  return undefined;
}

function writeYamlAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * One writer per machine. Job files live at
 * `<teDir>/ops/jobs/<machine>/<job-id>.yaml`; playbooks are re-hashed at
 * `<root>/ops/<playbook>.playbook.yaml` on every step change.
 */
export class JobStore {
  private events: EventLog;

  constructor(
    /** workspace root — playbook files are read under <root>/ops/ */
    private root: string,
    /** the .teamengage dir — jobs and events live under it */
    private teDir: string,
    private machine: string,
    opts: JobStoreOpts = {},
  ) {
    this.events = opts.events ?? new EventLog(join(teDir, "events"), machine);
    this.onFileWrite = opts.onFileWrite;
  }

  private onFileWrite?: (absPath: string, content: string | null) => void;

  private dir(): string {
    return join(this.teDir, "ops", "jobs", this.machine);
  }

  private locksDir(): string {
    return join(this.teDir, "ops", "locks");
  }

  private path(id: string, machine = this.machine): string {
    return join(this.teDir, "ops", "jobs", machine, `${id}.yaml`);
  }

  private playbookSha(playbook: string): string {
    const file = join(this.root, "ops", `${playbook}.playbook.yaml`);
    return sha256Text(existsSync(file) ? readFileSync(file, "utf8") : "");
  }

  private save(job: Job): void {
    mkdirSync(this.dir(), { recursive: true });
    const p = this.path(job.id);
    const text = YAML.stringify(job);
    writeYamlAtomic(p, text);
    this.onFileWrite?.(p, text);
  }

  load(id: string): Job | undefined {
    return this.loadFrom(this.machine, id);
  }

  private loadFrom(machine: string, id: string): Job | undefined {
    const p = this.path(id, machine);
    if (!existsSync(p)) return undefined;
    const parsed = Job.safeParse(YAML.parse(readFileSync(p, "utf8")));
    return parsed.success ? parsed.data : undefined;
  }

  private jobStatus(machine: string, id: string): JobState | undefined {
    return this.loadFrom(machine, id)?.status;
  }

  /** a job record from another machine is read-only here — its own machine changes it */
  private checkOwn(job: Job): void {
    if (job.machine !== this.machine) {
      throw new OpsError(
        "OPS_STATE",
        `job ${job.id} belongs to ${job.machine} — only that machine may change it`,
      );
    }
  }

  /** terminal states release the target lock; failed keeps it (resume or abort later) */
  private releaseLock(job: Job): void {
    if (!job.target) return;
    const p = removeLockFile(this.locksDir(), job.target, job.id);
    if (p) this.onFileWrite?.(p, null);
  }

  list(): Job[] {
    return this.listDir(this.dir());
  }

  /** jobs of every machine — for the Ops screen; writes stay per-machine */
  listAll(): Job[] {
    const jobsRoot = join(this.teDir, "ops", "jobs");
    if (!existsSync(jobsRoot)) return [];
    const out: Job[] = [];
    for (const machine of readdirSync(jobsRoot)) {
      out.push(...this.listDir(join(jobsRoot, machine)));
    }
    return out;
  }

  private listDir(dir: string): Job[] {
    if (!existsSync(dir)) return [];
    const out: Job[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort()) {
      const parsed = Job.safeParse(YAML.parse(readFileSync(join(dir, f), "utf8")));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  private nextId(): string {
    const dir = this.dir();
    let max = 0;
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        const m = /-(\d+)\.yaml$/.exec(f);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    }
    return `${this.machine}-${String(max + 1).padStart(4, "0")}`;
  }

  /** guards shared by every step mutation: live job, unchanged playbook, cursor step */
  private guard(job: Job, step_id: string): { step: JobStepRecord; index: number } {
    this.checkOwn(job);
    if (job.status !== "running" && job.status !== "waiting") {
      throw new OpsError("OPS_STATE", `job ${job.id} is ${job.status} — no step may change`);
    }
    if (this.playbookSha(job.playbook) !== job.playbook_sha256) {
      throw new OpsError(
        "OPS_PLAYBOOK_CHANGED",
        `playbook ${job.playbook} changed since job ${job.id} started — abort and start a new job`,
      );
    }
    const index = job.cursor;
    const step = job.steps[index];
    if (!step || step.id !== step_id) {
      throw new OpsError(
        "OPS_ORDER",
        `job ${job.id} cursor is at step '${step?.id}' — a result for '${step_id}' is out of order`,
      );
    }
    return { step, index };
  }

  private async emit(action: string, by: string, job: Job, data: Record<string, unknown> = {}): Promise<void> {
    await this.events.append({
      ts: new Date().toISOString(),
      actor: by,
      action,
      data: { job: job.id, playbook: job.playbook, status: job.status, ...data },
    });
  }

  /** After the cursor moves: a waiting step kind parks the job, past the end completes it. */
  private settle(job: Job, playbook: Playbook): void {
    if (job.cursor >= job.steps.length) {
      job.status = "succeeded";
      if (playbook.version_from) {
        const vs = job.steps.find((s) => s.id === playbook.version_from);
        job.version = versionFromTail(vs?.output_tail);
      }
      return;
    }
    const kind = playbook.steps[job.cursor]?.kind;
    job.status = kind === "agent" || kind === "gate" ? "waiting" : "running";
  }

  /**
   * Start a job. Stores the playbook sha256 and the resolved params
   * (defaults applied, required params must be given or defaulted).
   */
  async start(
    playbook: Playbook,
    args: {
      params?: Record<string, string>;
      target?: string;
      by: string;
      session?: string;
      /** set when the plans remote could not be fetched — the lock is marked unsynced */
      unsynced?: boolean;
    },
  ): Promise<Job> {
    const params: Record<string, string> = {};
    for (const p of playbook.params) {
      const v = args.params?.[p.name] ?? p.default;
      if (v === undefined) {
        if (p.required) throw new ValidationError(`playbook ${playbook.name}: param '${p.name}' is required`);
        continue;
      }
      params[p.name] = v;
    }
    const job: Job = Job.parse({
      id: this.nextId(),
      machine: this.machine,
      playbook: playbook.name,
      playbook_sha256: this.playbookSha(playbook.name),
      target: args.target ?? playbook.target,
      status: "running",
      params,
      started: { ts: new Date().toISOString(), by: args.by },
      cursor: 0,
      steps: playbook.steps.map((s) => ({ id: s.id, status: "pending" })),
    });
    this.settle(job, playbook);
    // one live job per target: a live lock — running, waiting or failed
    // — refuses the start; a stale lock (finished or missing job) is
    // simply overwritten
    if (job.target) {
      const existing = readLockFile(this.locksDir(), job.target);
      if (existing) {
        const st = this.jobStatus(existing.machine, existing.job);
        if (st === "running" || st === "waiting" || st === "failed") {
          throw new OpsError(
            "OPS_TARGET_BUSY",
            `target busy: job ${existing.job} on ${existing.machine}`,
            { job: existing.job, machine: existing.machine },
          );
        }
      }
    }
    this.save(job);
    if (job.target) {
      const p = writeLockFile(this.locksDir(), {
        target: job.target,
        job: job.id,
        machine: this.machine,
        session: args.session,
        ts: new Date().toISOString(),
        unsynced: args.unsynced || undefined,
      });
      this.onFileWrite?.(p, YAML.stringify(readLockFile(this.locksDir(), job.target)));
    }
    await this.emit("ops.job.start", args.by, job, { target: job.target, params: job.params });
    return job;
  }

  /** Mark the cursor step running — agent/gate steps park the job as waiting. */
  async startStep(job: Job, playbook: Playbook, step_id: string, by: string): Promise<Job> {
    const { step, index } = this.guard(job, step_id);
    if (step.status !== "pending") {
      throw new OpsError("OPS_STATE", `step '${step_id}' of job ${job.id} is ${step.status} — it cannot start`);
    }
    step.status = "running";
    step.started = new Date().toISOString();
    const kind = playbook.steps[index]?.kind;
    job.status = kind === "agent" || kind === "gate" ? "waiting" : "running";
    this.save(job);
    await this.emit("ops.step.start", by, job, { step: step_id });
    return job;
  }

  /** Post a result for the cursor step — exit code, output, evidence. */
  async stepResult(job: Job, playbook: Playbook, step_id: string, result: StepResult, by: string): Promise<Job> {
    const { step, index } = this.guard(job, step_id);
    if (step.status !== "pending" && step.status !== "running") {
      throw new OpsError("OPS_STATE", `step '${step_id}' of job ${job.id} already ${step.status}`);
    }
    const now = new Date().toISOString();
    step.status = "running";
    step.started ??= now;
    step.ended = now;
    if (result.exit_code !== undefined) step.exit_code = result.exit_code;
    if (result.output !== undefined) {
      step.output_tail = outputTail(result.output);
      step.output_sha256 = sha256Text(result.output);
    }
    if (result.evidence !== undefined) step.evidence = result.evidence;
    if (result.session !== undefined) step.session = result.session;

    const spec = playbook.steps[index];
    const ok = result.ok ?? (spec.kind === "cmd" || spec.kind === "check"
      ? result.exit_code !== undefined && result.exit_code === spec.expect_exit
      : true);

    if (ok) {
      step.status = "passed";
      job.cursor += 1;
      this.settle(job, playbook);
    } else {
      step.status = "failed";
      job.status = spec.on_fail === "stop" ? "stopped" : "failed";
    }
    if (job.status === "succeeded" || job.status === "stopped") this.releaseLock(job);
    this.save(job);
    await this.emit("ops.step.result", by, job, { step: step_id, step_status: step.status, ok });
    return job;
  }

  /** Skip the cursor step — only an optional step, and only with a recorded reason. */
  async skipStep(job: Job, playbook: Playbook, step_id: string, reason: string | undefined, by: string): Promise<Job> {
    const { step, index } = this.guard(job, step_id);
    const spec = playbook.steps[index];
    if (!spec.optional) {
      throw new OpsError("OPS_NOT_OPTIONAL", `step '${step_id}' of playbook ${playbook.name} is not optional — it cannot be skipped`);
    }
    if (!reason?.trim()) throw new ValidationError(`skip of step '${step_id}' needs a reason`);
    if (step.status !== "pending" && step.status !== "running") {
      throw new OpsError("OPS_STATE", `step '${step_id}' of job ${job.id} already ${step.status}`);
    }
    const now = new Date().toISOString();
    step.status = "skipped";
    step.reason = reason;
    step.started ??= now;
    step.ended = now;
    job.cursor += 1;
    this.settle(job, playbook);
    if (job.status === "succeeded") this.releaseLock(job);
    this.save(job);
    await this.emit("ops.step.skip", by, job, { step: step_id, reason });
    return job;
  }

  /** Abort a live job — running, waiting or failed. */
  async abort(job: Job, by: string): Promise<Job> {
    this.checkOwn(job);
    if (job.status !== "running" && job.status !== "waiting" && job.status !== "failed") {
      throw new OpsError("OPS_STATE", `job ${job.id} is ${job.status} — it cannot abort`);
    }
    const from = job.status;
    job.status = "aborted";
    this.releaseLock(job);
    this.save(job);
    await this.events.append({
      ts: new Date().toISOString(),
      actor: by,
      action: "ops.job.abort",
      from,
      to: "aborted",
      data: { job: job.id, playbook: job.playbook },
    });
    return job;
  }

  /**
   * Resume a failed job — back to running at the same cursor (same
   * machine only: its file lives here). The failed cursor step goes
   * back to pending so it can take a new result.
   */
  async resume(job: Job, by: string): Promise<Job> {
    this.checkOwn(job);
    if (job.status !== "failed") {
      throw new OpsError("OPS_STATE", `job ${job.id} is ${job.status} — only a failed job resumes`);
    }
    job.status = "running";
    const step = job.steps[job.cursor];
    if (step && step.status === "failed") {
      job.steps[job.cursor] = { id: step.id, status: "pending" };
    }
    // the lock stays with the job — refresh who holds it now
    if (job.target) {
      const lock = readLockFile(this.locksDir(), job.target);
      if (lock?.job === job.id && lock.session !== by) {
        const p = writeLockFile(this.locksDir(), { ...lock, session: by });
        this.onFileWrite?.(p, YAML.stringify(lock));
      }
    }
    this.save(job);
    await this.events.append({
      ts: new Date().toISOString(),
      actor: by,
      action: "ops.job.resume",
      from: "failed",
      to: "running",
      data: { job: job.id, playbook: job.playbook },
    });
    return job;
  }
}
