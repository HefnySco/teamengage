import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import type { FastifyInstance, FastifyReply } from "fastify";
import { JobStore, jobPlaybook, type Job, type JobRepoState, type StepResult } from "../../core/ops/job.js";
import { EventLog } from "../../core/events/log.js";
import type { EventBus } from "./events.js";
import type { Event } from "../../core/model/event.js";
import { loadPlaybooks, Playbook, type LoadedPlaybook } from "../../core/ops/playbook.js";
import { ProbeResult, loadProbes, probeHistory, probeStats, runProbe, saveProbe, loadReachProbes, saveReachProbes, runReachProbe, PROBE_TIMEOUT_MS, type ReachProbeResult } from "../../core/ops/probe.js";
import { loadMachines, type Machine } from "../../core/ops/machine.js";
import { deployedForMachine, type DeployedApp } from "../../core/ops/deployed.js";
import { appendNote, bodyWithoutNotes, linkNote, noteFile, noteTaskDraft, parseNotes, readNotes } from "../../core/ops/notes.js";
import { loadTrans } from "../../core/ops/trans.js";
import { WorkspaceOps } from "./ops.js";
import { basename } from "node:path";
import { currentEnv, loadEnvs, reachableFrom, wifiName, type Env } from "../../core/ops/env.js";
import { runnerMachine } from "../../core/ops/runner.js";
import { renameMachine } from "../../core/ops/rename.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { hostname } from "node:os";
import { checkRemoteTargetLock, commitPlans } from "../sync/sync.js";
import { fireNotify, gateWait } from "../effects/notify.js";
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

/** stored probe results — machine-local files under <home>/ops-probes/, never synced */
export function opsProbes(ctx: DaemonCtx): Record<string, ProbeResult> {
  return loadProbes(ctx.home);
}

/**
 * Run a target's probe — the one command the daemon itself executes
 * (DESIGN §14.5): read-only, killed at 30 s (or the target's
 * probe_timeout_ms). Human-only: a session identity refuses.
 */
export async function opsProbe(wsr: WorkspaceRuntime, ctx: DaemonCtx, target: string, session?: Session): Promise<ProbeResult | { target: string; not_reachable: string }> {
  if (session) throw new ForbiddenError("probes are human-only — an agent session cannot start one");
  const t = wsr.ws.config.targets[target];
  if (!t) throw new NotFoundError(`target '${target}' not in workspace.yaml targets:`);
  if (!t.probe) throw new ValidationError(`target '${target}' has no probe command in workspace.yaml`);
  // GL-0337: no reach edge in the selected env — answer, run nothing, store nothing
  const { runner, env } = reachContext(wsr);
  if (!reachableFrom(env, runner, t.machine)) return { target, not_reachable: env!.id };
  const run = await runProbe(t.probe, { cwd: wsr.ws.root, timeoutMs: (t.probe_timeout_ms as number | undefined) ?? PROBE_TIMEOUT_MS });
  const result: ProbeResult = { target, by: "human", ...run };
  saveProbe(result, ctx.home);
  return result;
}

/**
 * Record a probe result posted by `te ops watch` (GL-0334): the runner
 * executes the probe, the daemon only stores it — by: "watch" and the
 * daemon's machine name are stamped here so a post cannot fake them.
 */
export function opsProbeResult(wsr: WorkspaceRuntime, ctx: DaemonCtx, target: string, body: unknown): ProbeResult {
  const t = wsr.ws.config.targets[target];
  if (!t) throw new NotFoundError(`target '${target}' not in workspace.yaml targets:`);
  if (!t.probe) throw new ValidationError(`target '${target}' has no probe command in workspace.yaml`);
  const run = ProbeResult.omit({ target: true, by: true, machine: true }).parse(body ?? {});
  const result: ProbeResult = { target, by: "watch", machine: ctx.machine, ...run };
  saveProbe(result, ctx.home);
  return result;
}

/**
 * Machines + envs over the GL-0286 files (GL-0289): the UI's Machines
 * view reads these. `active` marks the env select (manual pin or wifi
 * match) — the same select `te env` prints.
 */
export function opsMachines(wsr: WorkspaceRuntime) {
  const runner = runnerMachine(wsr.ws.root, hostname())?.id;
  const loaded = loadMachines(wsr.ws.root);
  return {
    runner,
    machines: loaded.flatMap((l) => (l.machine ? [{ ...l.machine, file: l.file }] : [])),
    errors: loaded.flatMap((l) => (l.error ? [{ file: l.file, error: l.error }] : [])),
  };
}

/**
 * The deployed join's inputs (GL-0305): workspace targets, every job of
 * every runner and the stored probes — read-only, no probe runs.
 * `reach` is the runner machine and the selected env (GL-0337): a
 * target with no reach edge from the runner is not_reachable.
 */
function deployedInputs(wsr: WorkspaceRuntime, ctx: DaemonCtx) {
  return {
    targets: opsTargets(wsr),
    jobs: jobStore(wsr, ctx).listAll(),
    probes: opsProbes(ctx),
    reach: reachContext(wsr),
  };
}

/** The runner machine id and the selected env — reach edges decide not_reachable (GL-0337). */
function reachContext(wsr: WorkspaceRuntime): { runner?: string; env?: Env } {
  return {
    runner: runnerMachine(wsr.ws.root, hostname())?.id,
    env: currentEnv(wsr.ws.root, loadEnvs(wsr.ws.root), wifiName() || undefined).env,
  };
}

/** Which targets the runner cannot reach in the selected env — `te ops watch` skips them (GL-0337). */
export function opsReach(wsr: WorkspaceRuntime) {
  const { runner, env } = reachContext(wsr);
  return {
    runner,
    env: env?.id,
    unreachable: Object.entries(wsr.ws.config.targets)
      .filter(([, t]) => !reachableFrom(env, runner, t.machine))
      .map(([id]) => id),
  };
}

function deployedOf(machine: Machine, wsr: WorkspaceRuntime, ctx: DaemonCtx): DeployedApp[] {
  const { targets, jobs, probes, reach } = deployedInputs(wsr, ctx);
  return deployedForMachine(machine, targets, jobs, probes, reach);
}

export function opsMachine(wsr: WorkspaceRuntime, ctx: DaemonCtx, id: string) {
  const l = loadMachines(wsr.ws.root).find((x) => x.machine?.id === id);
  if (!l?.machine) throw new NotFoundError(`machine '${id}' not under machines/`);
  return {
    ...l.machine,
    file: l.file,
    notes: bodyWithoutNotes(l.body ?? ""),
    human_notes: parseNotes(l.body ?? ""),
    deployed: deployedOf(l.machine, wsr, ctx),
    trans: loadTrans(wsr.ws.root, id),
  };
}

/**
 * Human notes (GL-0297): keep the human's words in the file, then open a
 * ready task for an agent to turn the note into a YAML change. Human
 * only — an agent session is refused. A playbook note task is a key task
 * (unblocks_on: done), so solo auto-accept never takes it: the human
 * accepts every playbook change.
 */
export async function opsAddNote(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  kind: "machine" | "playbook",
  id: string,
  text: string,
  session?: Session,
): Promise<{ file: string; ts: string; item: string }> {
  if (session) throw new ForbiddenError("notes are the human's — an agent session cannot add one");
  if (!text?.trim()) throw new ValidationError("a note needs {text}");
  const root = wsr.ws.root;
  if (kind === "machine") {
    if (!loadMachines(root).some((x) => x.machine?.id === id)) throw new NotFoundError(`machine '${id}' not under machines/`);
  } else if (!loadPlaybooks(root).some((x) => x.playbook?.name === id)) {
    throw new NotFoundError(`playbook '${id}' not under ops/`);
  }
  const file = noteFile(kind, id);
  let ts: string;
  try {
    ts = appendNote(root, kind, id, text);
  } catch (e) {
    throw new ValidationError((e as Error).message);
  }
  const ops = new WorkspaceOps(wsr, ctx.sessions, wsr.links, ctx.home);
  const r = await ops.propose([noteTaskDraft(kind, id, ts, text, basename(root))], "human");
  const item = r.ids[0];
  linkNote(root, kind, id, ts, item);
  await ops.approve(item);
  if (kind === "playbook") await ops.setUnblocksOn(item, "done");
  return { file, ts, item };
}

/**
 * GL-0358: post one `te verify` result for an item. Shared by the REST route
 * (CLI `te verify`, actor "human" unless the body names a live session) and
 * the agent tool `verify_result` (actor = the session). The daemon records
 * only — it never runs the check.
 */
export async function postVerifyResult(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  id: string,
  args: {
    check: string;
    exit_code: number;
    passed: boolean;
    commit?: string;
    output_tail?: string;
    output_sha256?: string;
    session?: string;
  },
  session?: Session,
) {
  const resolved = session ?? (args.session ? ctx.sessions.get(args.session) : undefined);
  const ops = new WorkspaceOps(wsr, ctx.sessions, wsr.links, ctx.home);
  return ops.verifyResult(id, args, resolved ?? "human");
}

export function opsEnvs(wsr: WorkspaceRuntime) {
  const loaded = loadEnvs(wsr.ws.root);
  const active = currentEnv(wsr.ws.root, loaded, wifiName() || undefined).env?.id;
  return {
    active,
    envs: loaded.flatMap((l) => (l.env ? [{ ...l.env, file: l.file, active: l.env.id === active }] : [])),
    errors: loaded.flatMap((l) => (l.error ? [{ file: l.file, error: l.error }] : [])),
  };
}

export function opsEnv(wsr: WorkspaceRuntime, ctx: DaemonCtx, id: string) {
  const loaded = loadEnvs(wsr.ws.root);
  const l = loaded.find((x) => x.env?.id === id);
  if (!l?.env) throw new NotFoundError(`env '${id}' not under envs/`);
  const machines = new Map(
    loadMachines(wsr.ws.root).flatMap((x) =>
      x.machine ? [[x.machine.id, { ...x.machine, notes: bodyWithoutNotes(x.body ?? ""), human_notes: parseNotes(x.body ?? "") }] as const] : [],
    ),
  );
  const active = currentEnv(wsr.ws.root, loaded, wifiName() || undefined).env?.id === l.env.id;
  const { targets, jobs, probes, reach } = deployedInputs(wsr, ctx);
  return {
    ...l.env,
    file: l.file,
    active,
    notes: l.body ?? "",
    machines: l.env.machines.map((p) => {
      const m = machines.get(p.id);
      return { ...p, machine: m ? { ...m, deployed: deployedForMachine(m, targets, jobs, probes, reach), trans: loadTrans(wsr.ws.root, m.id) } : undefined };
    }),
    probes: loadReachProbes(l.env.id, ctx.home),
  };
}

/**
 * Run the reach probes of one env — human-only like target probes. Each
 * reach edge becomes one ReachProbeResult; the wifi precondition inside
 * runReachProbe answers 'not expected' without running anything.
 */
export async function opsReachProbes(
  wsr: WorkspaceRuntime,
  ctx: DaemonCtx,
  envId: string,
  session?: Session,
  /** probe only the reach edges into this machine — one node's signal */
  to?: string,
): Promise<ReachProbeResult[]> {
  if (session) throw new ForbiddenError("probes are human-only — an agent session cannot start one");
  const l = loadEnvs(wsr.ws.root).find((x) => x.env?.id === envId);
  if (!l?.env) throw new NotFoundError(`env '${envId}' not under envs/`);
  const machines = new Map(loadMachines(wsr.ws.root).flatMap((x) => (x.machine ? [[x.machine.id, x.machine] as const] : [])));
  const wifi = wifiName() || undefined;
  // only edges whose `from` is this machine run here — the rest answer 'not probed from here'
  const runner = runnerMachine(wsr.ws.root, hostname())?.id ?? "";
  const results: ReachProbeResult[] = [];
  for (const r of l.env.reach.filter((r) => !to || r.to === to)) {
    const run = await runReachProbe(l.env, r, machines, { wifi, cwd: wsr.ws.root, runner });
    results.push({ env: l.env.id, from: r.from, to: r.to, via: r.via, by: "human", ...run });
  }
  saveReachProbes(l.env.id, results, ctx.home);
  return results;
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
  // GL-0327: a job that just parked on a gate step is a decision for the human
  if (out && typeof out === "object" && "status" in out) {
    const job = out as unknown as Job;
    if (job.status === "waiting") {
      try {
        const gate = gateWait(job, playbookOf(wsr, job));
        if (gate)
          void fireNotify(wsr.ws, "ops_gate", { job: job.id, ...gate }).catch((e: Error) =>
            ctx.bus.notify("notify", { workspace: wsr.ws.config.name, message: `notify failed: ${e.message}` }),
          );
      } catch {
        /* a missing playbook never blocks the mutation — findings report it */
      }
    }
  }
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

/**
 * The playbook repos' HEAD commit + dirty flag at job start (GL-0340).
 * git reads only — same class as the plans-repo commits the daemon makes;
 * the job record keeps them so the job page shows exactly what code it ran.
 */
function repoStates(wsr: WorkspaceRuntime, pb: Playbook): JobRepoState[] {
  const out: JobRepoState[] = [];
  for (const p of pb.repos) {
    const dir = resolve(wsr.ws.root, p);
    try {
      const commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
      out.push({ path: p, commit, dirty });
    } catch (e) {
      out.push({ path: p, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  }
  return out;
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
  const repos = repoStates(wsr, pb);
  return mutate(
    wsr,
    ctx,
    (s) => s.start(pb, { params: args.params, target, by, session: args.session?.id, unsynced, repos }),
    (j) => `ops: job ${j.id} started — ${pb.name}${target ? ` on ${target}` : ""} by ${by}`,
  );
}

/**
 * The ops jobs that deployed one of an item's Evidence commits (GL-0340):
 * for each `commit <repo>@<sha>` line, a job matches when its recorded
 * repo path resolves to the resource's path and the sha is an ancestor
 * of the recorded HEAD.
 */
export function opsJobsForItem(wsr: WorkspaceRuntime, ctx: DaemonCtx, commits: { repo: string; sha: string }[]): Job[] {
  if (!commits.length) return [];
  const jobs: Job[] = [];
  const seen = new Set<string>();
  for (const c of commits) {
    const res = wsr.ws.resources.get(c.repo);
    if (!res?.path) continue;
    const dir = resolve(res.path);
    for (const job of jobStore(wsr, ctx).listAll()) {
      if (seen.has(job.id) || !job.repos) continue;
      for (const r of job.repos) {
        if (!r.commit || resolve(wsr.ws.root, r.path) !== dir) continue;
        try {
          execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", c.sha, r.commit]);
          jobs.push(job);
          seen.add(job.id);
        } catch {
          /* sha not in this job's recorded HEAD */
        }
        break;
      }
    }
  }
  return jobs;
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
  app.get("/api/ops/probes", async (_req, reply) => {
    try {
      return opsProbes(ctx);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/probe/:target", async (req, reply) => {
    try {
      const { target } = req.params as { target: string };
      // an agent session identity on the human API refuses — probes are human-only
      const session = req.headers["x-te-session"] ? ({ id: String(req.headers["x-te-session"]) } as Session) : undefined;
      return await opsProbe(opsWsr(ctx, wsOf(req.query)), ctx, target, session);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.get("/api/ops/reach", async (req, reply) => {
    try {
      return opsReach(opsWsr(ctx, wsOf(req.query)));
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.get("/api/ops/targets/:id/probes", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const wsr = opsWsr(ctx, wsOf(req.query));
      if (!wsr.ws.config.targets[id]) throw new NotFoundError(`target '${id}' not in workspace.yaml targets:`);
      const history = probeHistory(id, ctx.home);
      return { history, stats: probeStats(history) };
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/probe/:target/result", async (req, reply) => {
    try {
      const { target } = req.params as { target: string };
      return opsProbeResult(opsWsr(ctx, wsOf(req.query)), ctx, target, req.body);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.get("/api/ops/machines", async (req, reply) => {
    try {
      return opsMachines(opsWsr(ctx, wsOf(req.query)));
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.get("/api/ops/machines/:id", async (req, reply) => {
    try {
      return opsMachine(opsWsr(ctx, wsOf(req.query)), ctx, (req.params as { id: string }).id);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/machines/:id/rename", async (req, reply) => {
    try {
      // human-only — an agent session cannot rename a machine record
      const session = req.headers["x-te-session"] ? ({ id: String(req.headers["x-te-session"]) } as Session) : undefined;
      if (session) throw new ForbiddenError("machine rename is human-only");
      const wsr = opsWsr(ctx, wsOf(req.query));
      const to = String(((req.body ?? {}) as { to?: unknown }).to ?? "");
      const rep = renameMachine(wsr.ws.root, wsr.ws.plansDir, ctx.home, (req.params as { id: string }).id, to);
      // workspace.yaml just changed — reload so cached targets resolve under the new id
      wsr.ws = resolveWorkspace(wsr.ws.root, { home: ctx.home });
      return rep;
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.get("/api/ops/envs", async (req, reply) => {
    try {
      return opsEnvs(opsWsr(ctx, wsOf(req.query)));
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.get("/api/ops/envs/:id", async (req, reply) => {
    try {
      return opsEnv(opsWsr(ctx, wsOf(req.query)), ctx, (req.params as { id: string }).id);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  for (const kind of ["machine", "playbook"] as const) {
    const base = kind === "machine" ? "/api/ops/machines/:id/notes" : "/api/ops/playbooks/:id/notes";
    app.get(base, async (req, reply) => {
      try {
        return readNotes(opsWsr(ctx, wsOf(req.query)).ws.root, kind, (req.params as { id: string }).id);
      } catch (e) {
        return sendOpsErr(reply, e);
      }
    });
    app.post(base, async (req, reply) => {
      try {
        // an agent session identity on the human API refuses — notes are the human's
        const session = req.headers["x-te-session"] ? ({ id: String(req.headers["x-te-session"]) } as Session) : undefined;
        const text = String(((req.body ?? {}) as { text?: unknown }).text ?? "");
        return await opsAddNote(opsWsr(ctx, wsOf(req.query)), ctx, kind, (req.params as { id: string }).id, text, session);
      } catch (e) {
        return sendOpsErr(reply, e);
      }
    });
  }
  app.post("/api/ops/envs/:id/probe", async (req, reply) => {
    try {
      // an agent session identity on the human API refuses — probes are human-only
      const session = req.headers["x-te-session"] ? ({ id: String(req.headers["x-te-session"]) } as Session) : undefined;
      const to = ((req.body ?? {}) as { to?: unknown }).to;
      return await opsReachProbes(opsWsr(ctx, wsOf(req.query)), ctx, (req.params as { id: string }).id, session, typeof to === "string" && to ? to : undefined);
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
      // GL-0339: an agent's `te ops exec` carries its session — it becomes the
      // step actor; an unknown or absent id stays "human"
      const session = req.headers["x-te-session"]
        ? ctx.sessions.get(String(req.headers["x-te-session"]))
        : undefined;
      return await opsStep(opsWsr(ctx, wsOf(req.query)), ctx, id, (req.body ?? {}) as OpsStepArgs, session);
    } catch (e) {
      return sendOpsErr(reply, e);
    }
  });
  app.post("/api/ops/skip/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as { step?: string; reason?: string };
      if (!b.step) throw new ValidationError("skip needs {step}");
      const session = req.headers["x-te-session"]
        ? ctx.sessions.get(String(req.headers["x-te-session"]))
        : undefined;
      return await opsSkip(opsWsr(ctx, wsOf(req.query)), ctx, id, { step: b.step, reason: b.reason }, session);
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
