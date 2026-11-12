import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import type { FastifyInstance, FastifyReply } from "fastify";
import { JobStore, jobPlaybook, type Job, type StepResult } from "../../core/ops/job.js";
import { EventLog } from "../../core/events/log.js";
import type { EventBus } from "./events.js";
import type { Event } from "../../core/model/event.js";
import { loadPlaybooks, Playbook, type LoadedPlaybook } from "../../core/ops/playbook.js";
import { checkRemoteTargetLock, commitPlans } from "../sync/sync.js";
import { ForbiddenError, NotFoundError, ParseError, ValidationError } from "../../core/model/errors.js";
import { tierRank } from "../../core/model/item.js";
import type { DaemonCtx } from "../server/context.js";
import type { WorkspaceRuntime } from "../server/context.js";
import type { Session } from "../../core/model/session.js";

/**
 * Ops API (GL-0271): the daemon side of playbooks and jobs — shared by the
 * human REST routes (/api/ops/*) and the agent tools (ops_*). The daemon
 * validates, locks, stores and accepts step results in order; it never
 * executes playbook commands (DESIGN §14.5).
 */

/** EventLog that also pushes each committed event to the SSE bus — ops changes reach the UI live, same as store events. */
class PublishingEventLog extends EventLog {
  constructor(
    dir: string,
    machine: string,
    private bus: EventBus,
  ) {
    super(dir, machine);
  }
  override async append(ev: Omit<Event, "seq" | "machine"> & { ts?: string }): Promise<Event> {
    const full = await super.append(ev);
    this.bus.publish(full);
    return full;
  }
}

/** A fresh JobStore per call: its EventLog reads the current seq from the file, so ops events never collide with the store's own writer. */
export function jobStore(wsr: WorkspaceRuntime, ctx: DaemonCtx): JobStore {
  return new JobStore(wsr.ws.root, wsr.ws.plansDir, wsr.store.machine, {
    events: new PublishingEventLog(join(wsr.ws.plansDir, "events"), wsr.store.machine, ctx.bus),
    onFileWrite: wsr.store.onFileWrite,
  });
}

export function opsPlaybooks(wsr: WorkspaceRuntime): LoadedPlaybook[] {
  return loadPlaybooks(wsr.ws.root);
}

export function opsTargets(wsr: WorkspaceRuntime) {
  return wsr.ws.config.targets;
}

export function opsJobs(wsr: WorkspaceRuntime, ctx: DaemonCtx, f: { playbook?: string; target?: string; status?: string; machine?: string } = {}): Job[] {
  return jobStore(wsr, ctx)
    .listAll()
    .filter(
      (j) =>
        (!f.playbook || j.playbook === f.playbook) &&
        (!f.target || j.target === f.target) &&
        (!f.status || j.status === f.status) &&
        (!f.machine || j.machine === f.machine),
    );
}

function mustJob(store: JobStore, id: string): Job {
  const job = store.listAll().find((j) => j.id === id);
  if (!job) throw new NotFoundError(`job ${id} not found`);
  return job;
}

export function opsJob(wsr: WorkspaceRuntime, ctx: DaemonCtx, id: string): Job {
  return mustJob(jobStore(wsr, ctx), id);
}

function playbookByName(wsr: WorkspaceRuntime, name: string): Playbook {
  const l = loadPlaybooks(wsr.ws.root).find((x) => x.playbook?.name === name || x.file === `ops/${name}.playbook.yaml`);
  if (!l) throw new NotFoundError(`playbook ${name} not found under ops/`);
  if (!l.playbook) throw new ParseError(`playbook ${l.file} does not parse: ${l.error}`, l.file);
  return l.playbook;
}

/** the playbook a job was started from — by its pinned name */
function playbookOf(wsr: WorkspaceRuntime, job: Job): Playbook {
  const file = join(wsr.ws.root, "ops", `${job.playbook}.playbook.yaml`);
  if (!existsSync(file)) throw new ParseError(`playbook file gone: ops/${job.playbook}.playbook.yaml`, file);
  return jobPlaybook(job, Playbook.parse(YAML.parse(readFileSync(file, "utf8"))));
}

/**
 * Serialize the mutation with the store's own write queue, then commit the
 * plans repo — job, lock and event files ride the same channel as claims.
 */
async function mutate<T>(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  fn: (store: JobStore) => Promise<T>,
  message: (out: T) => string,
): Promise<T> {
  const store = jobStore(wsr, ctx);
  const out = await wsr.store.enqueue(() => fn(store));
  await commitPlans(wsr, message(out));
  return out;
}

/** an agent session may start only `start: agent` playbooks, and only at min_tier or higher */
function startPolicy(pb: Playbook, session?: Session): void {
  if (!session) return; // human — no policy
  if (pb.start !== "agent") {
    throw new ForbiddenError(`playbook ${pb.name} is start: human — the human starts it (Ops page or te ops run)`);
  }
  if (pb.min_tier && session.tier && tierRank(session.tier) < tierRank(pb.min_tier)) {
    throw new ForbiddenError(`playbook ${pb.name} needs ${pb.min_tier} tier — this session is ${session.tier}`);
  }
}

export async function opsStart(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  args: { playbook: string; target?: string; params?: Record<string, string>; session?: Session },
): Promise<Job> {
  const pb = playbookByName(wsr, args.playbook);
  startPolicy(pb, args.session);
  const target = args.target ?? pb.target;
  let unsynced = false;
  if (target) ({ unsynced } = await checkRemoteTargetLock(wsr, target));
  const by = args.session?.id ?? "human";
  return mutate(
    wsr,
    ctx,
    (s) => s.start(pb, { params: args.params, target, by, session: args.session?.id, unsynced }),
    (j) => `ops: job ${j.id} started — ${pb.name}${target ? ` on ${target}` : ""} by ${by}`,
  );
}

export interface OpsStepArgs {
  step: string;
  /** "passed" | "failed" — cmd/check derive it from exit_code when absent */
  status?: string;
  exit_code?: number;
  /** the step output — the daemon keeps the tail and the sha256 */
  output?: string;
  /** runner-posted tail — treated as output when output is absent */
  output_tail?: string;
  output_sha256?: string;
  evidence?: string;
}

function stepRefusal(pb: Playbook, job: Job, session?: Session): void {
  const spec = pb.steps[job.cursor];
  if (spec?.kind === "gate" && session) {
    throw new ForbiddenError(`gate step '${spec.id}' is human-only — the human approves it (Ops page)`);
  }
}

export async function opsStep(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  id: string,
  args: OpsStepArgs,
  session?: Session,
): Promise<Job> {
  const by = session?.id ?? "human";
  return mutate(
    wsr,
    ctx,
    (s) => {
      const job = mustJob(s, id);
      const pb = playbookOf(wsr, job);
      stepRefusal(pb, job, session);
      if (args.status !== undefined && args.status !== "passed" && args.status !== "failed") {
        throw new ValidationError(`step status must be "passed" or "failed", got '${args.status}'`);
      }
      const result: StepResult = {
        ok: args.status === undefined ? undefined : args.status === "passed",
        exit_code: args.exit_code,
        output: args.output ?? args.output_tail,
        evidence: args.evidence,
        session: session?.id,
      };
      return s.stepResult(job, pb, args.step, result, by);
    },
    (j) => `ops: job ${j.id} step ${args.step} — status ${j.status}`,
  );
}

export async function opsSkip(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  id: string,
  args: { step: string; reason?: string },
  session?: Session,
): Promise<Job> {
  const by = session?.id ?? "human";
  return mutate(
    wsr,
    ctx,
    (s) => {
      const job = mustJob(s, id);
      const pb = playbookOf(wsr, job);
      stepRefusal(pb, job, session);
      return s.skipStep(job, pb, args.step, args.reason, by);
    },
    (j) => `ops: job ${j.id} step ${args.step} skipped — status ${j.status}`,
  );
}

/** human-only: approve the gate step at the cursor. */
export async function opsApprove(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  id: string,
  args: { step: string },
  session?: Session,
): Promise<Job> {
  if (session) throw new ForbiddenError("gate steps are human-only — the human approves on the Ops page");
  return mutate(
    wsr,
    ctx,
    (s) => {
      const job = mustJob(s, id);
      return s.stepResult(job, playbookOf(wsr, job), args.step, { ok: true }, "human");
    },
    (j) => `ops: job ${j.id} step ${args.step} approved — status ${j.status}`,
  );
}

export async function opsAbort(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  id: string,
  session?: Session,
): Promise<Job> {
  const by = session?.id ?? "human";
  return mutate(
    wsr,
    ctx,
    (s) => s.abort(mustJob(s, id), by),
    (j) => `ops: job ${j.id} aborted by ${by}`,
  );
}

/**
 * Start a rollback job for a failed or finished job — same start policy
 * and target lock as the source playbook; the two jobs name each other.
 */
export async function opsRollback(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  id: string,
  session?: Session,
): Promise<Job> {
  return mutate(
    wsr,
    ctx,
    (s) => {
      const source = mustJob(s, id);
      const pb = playbookOf(wsr, source);
      startPolicy(pb, session);
      return s.startRollback(source, pb, { by: session?.id ?? "human", session: session?.id });
    },
    (j) => `ops: rollback job ${j.id} started for ${id}`,
  );
}

export async function opsResume(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  id: string,
  session?: Session,
): Promise<Job> {
  const by = session?.id ?? "human";
  return mutate(
    wsr,
    ctx,
    (s) => s.resume(mustJob(s, id), by),
    (j) => `ops: job ${j.id} resumed by ${by} — status ${j.status}`,
  );
}

// ---- REST routes (/api/ops/*) — the human's half, no session -------------

const wsOf = (q: unknown) => (q as { ws?: string }).ws;

function opsWsr(ctx: DaemonCtx, ws?: string): WorkspaceRuntime {
  const wsr = ws ? ctx.workspaces.get(ws) : ctx.workspaces.size === 1 ? ctx.workspaces.values().next().value : undefined;
  if (!wsr) throw new NotFoundError(ws ? `workspace '${ws}' not registered` : "no workspace registered on this machine");
  return wsr;
}

export function registerOpsApiRoutes(app: FastifyInstance, ctx: DaemonCtx): void {
  app.get("/api/ops/playbooks", async (req, reply) => {
    try {
      return opsPlaybooks(opsWsr(ctx, wsOf(req.query)));
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.get("/api/ops/targets", async (req, reply) => {
    try {
      return opsTargets(opsWsr(ctx, wsOf(req.query)));
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.get("/api/ops/jobs", async (req, reply) => {
    try {
      const q = req.query as Record<string, string>;
      return opsJobs(opsWsr(ctx, q.ws), ctx, {
        playbook: q.playbook,
        target: q.target,
        status: q.status,
        machine: q.machine,
      });
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.get("/api/ops/job/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      return opsJob(opsWsr(ctx, wsOf(req.query)), ctx, id);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/start", async (req, reply) => {
    try {
      const q = req.query as Record<string, string>;
      const b = (req.body ?? {}) as { playbook?: string; target?: string; params?: Record<string, string> };
      if (!b.playbook) throw new ValidationError("start needs {playbook}");
      return await opsStart(opsWsr(ctx, q.ws), ctx, { playbook: b.playbook, target: b.target, params: b.params });
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/step/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      return await opsStep(opsWsr(ctx, wsOf(req.query)), ctx, id, (req.body ?? {}) as OpsStepArgs);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/skip/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as { step?: string; reason?: string };
      if (!b.step) throw new ValidationError("skip needs {step}");
      return await opsSkip(opsWsr(ctx, wsOf(req.query)), ctx, id, { step: b.step, reason: b.reason });
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/approve/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as { step?: string };
      if (!b.step) throw new ValidationError("approve needs {step}");
      return await opsApprove(opsWsr(ctx, wsOf(req.query)), ctx, id, { step: b.step });
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/abort/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      return await opsAbort(opsWsr(ctx, wsOf(req.query)), ctx, id);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/rollback/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      return await opsRollback(opsWsr(ctx, wsOf(req.query)), ctx, id);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/resume/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      return await opsResume(opsWsr(ctx, wsOf(req.query)), ctx, id);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
}

function sendOpsErr(reply: FastifyReply, e: unknown) {
  const err = e as { code?: string; message: string };
  if (typeof err.code === "string" && err.code) {
    const status =
      err.code === "NOT_FOUND" ? 404
      : err.code === "FORBIDDEN" ? 403
      : err.code === "CONFLICT" || err.code === "CLAIM_REFUSED" || err.code.startsWith("OPS_") ? 409
      : 400;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  return reply.code(500).send({ error: "INTERNAL", message: (e as Error).message });
}
