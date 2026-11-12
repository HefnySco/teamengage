import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { daemonApi, type ApiError } from "../client.js";
import { teHome } from "../../core/config/config.js";
import { deployGuard, execJob, type ExecOutcome } from "../../core/ops/runner.js";
import { jobPlaybook, type Job } from "../../core/ops/job.js";
import type { LoadedPlaybook } from "../../core/ops/playbook.js";
import type { ProbeResult } from "../../core/ops/probe.js";
import type { TargetConfig } from "../../core/model/workspace.js";

/**
 * `te ops` — the ops runner's human surface. It talks to the daemon's
 * /api/ops/* routes; `exec` is the command that actually runs playbook
 * steps (bash, in the playbook cwd) and posts each result back.
 *
 * Exit codes (CI): 0 succeeded/stopped — 1 failed — 2 waiting on an
 * agent or a gate — 3 refused/locked — 4 usage or not found.
 */

const flag = (args: string[], n: string) => args.includes(n);
const opt = (args: string[], n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const opts = (args: string[], n: string) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const wsQ = (args: string[]) => {
  const w = opt(args, "--ws");
  return w ? `?ws=${encodeURIComponent(w)}` : "";
};

const USAGE =
  "usage: te ops <cmd>\n" +
  "  list     [--ws w] [--json]                      playbooks\n" +
  "  targets  [--ws w] [--json]                      workspace targets\n" +
  "  jobs     [--ws w] [--json]                      ops jobs\n" +
  "  start <playbook> [--target t] [--param k=v]…    start a job\n" +
  "  exec <job> [--step id] [--ws w] [--json]        run the cursor steps\n" +
  "  status <job> [--ws w] [--json]                  job + step states\n" +
  "  approve <job> [--ws w]                          approve the gate step\n" +
  "  abort <job> [--ws w]                            abort a live job\n" +
  "  resume <job> [--ws w]                           retry a failed job\n" +
  "  rollback <job> [--ws w]                         start a rollback job for a failed/finished job\n" +
  "exit: 0 done · 1 failed · 2 waiting · 3 refused/locked · 4 usage\n";

function printJob(j: Job): void {
  console.log(`${j.id}  ${j.playbook}${j.target ? ` on ${j.target}` : ""}  ${j.status}  cursor ${j.cursor}${j.version ? `  version ${j.version}` : ""}`);
  for (const s of j.steps) {
    const mark = { pending: "·", running: "▸", passed: "✓", failed: "✗", skipped: "—" }[s.status];
    console.log(`  ${mark} ${s.id}: ${s.status}${s.exit_code !== undefined ? ` (exit ${s.exit_code})` : ""}${s.reason ? ` — ${s.reason}` : ""}`);
  }
}

async function api<T>(method: string, path: string, body: unknown, home?: string): Promise<T> {
  return (await daemonApi(method, path, body, home)) as T;
}

/** Deploy guard (GL-0287): a refusal message when this runner may not work on the target's machine. */
async function guardDeploy(target: string | undefined, ws: string, home?: string): Promise<string | undefined> {
  if (!target) return undefined;
  const targets = await api<Record<string, TargetConfig>>("GET", `/api/ops/targets${ws}`, undefined, home);
  const cfg = targets[target];
  if (!cfg?.machine) return undefined;
  const wsc = await api<{ root: string }>("GET", `/api/workspace${ws}`, undefined, home);
  return deployGuard(wsc.root, cfg, hostname(), target);
}

/** The target a playbook deploys to, when --target did not say. */
async function playbookTarget(name: string, ws: string, home?: string): Promise<string | undefined> {
  const loaded = await api<LoadedPlaybook[]>("GET", `/api/ops/playbooks${ws}`, undefined, home);
  return loaded.find((l) => l.playbook?.name === name)?.playbook?.target;
}

/** Load the playbook a job was started from; rollback jobs run their frozen step_specs. */
async function playbookOf(job: Job, ws: string, home?: string) {
  const loaded = await api<LoadedPlaybook[]>("GET", `/api/ops/playbooks${ws}`, undefined, home);
  const hit = loaded.find((l) => l.playbook?.name === job.playbook);
  if (!hit?.playbook) throw Object.assign(new Error(`playbook '${job.playbook}' is not under ops/ anymore`), { code: "NOT_FOUND" });
  return jobPlaybook(job, hit.playbook);
}

export async function opsCmd(args: string[], home?: string): Promise<number> {
  const sub = args[0];
  const json = flag(args, "--json");
  const ws = wsQ(args);
  try {
    switch (sub) {
      case "list": {
        const loaded = await api<LoadedPlaybook[]>("GET", `/api/ops/playbooks${ws}`, undefined, home);
        if (json) return console.log(JSON.stringify(loaded, null, 2)), 0;
        if (!loaded.length) return console.log("no playbooks under ops/"), 0;
        for (const l of loaded) {
          if (l.error) console.log(`${l.file}: bad — ${l.error}`);
          else console.log(`${l.playbook!.name}  ${l.playbook!.title ?? ""}  ${l.playbook!.steps.length} steps  start:${l.playbook!.start}${l.playbook!.target ? `  target:${l.playbook!.target}` : ""}`);
        }
        return 0;
      }
      case "targets": {
        const t = await api<unknown>("GET", `/api/ops/targets${ws}`, undefined, home);
        return console.log(json ? JSON.stringify(t, null, 2) : formatTargets(t)), 0;
      }
      case "probe": {
        const targets = await api<Record<string, { probe?: string }>>("GET", `/api/ops/targets${ws}`, undefined, home);
        const one = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
        const ids = one ? [one] : Object.keys(targets).filter((k) => targets[k].probe).sort();
        if (!ids.length) return console.log(one ? `target '${one}' has no probe command` : "no targets with a probe command"), 4;
        const results: ProbeResult[] = [];
        let bad = 0;
        for (const t of ids) {
          const r = await api<ProbeResult>("POST", `/api/ops/probe/${encodeURIComponent(t)}${ws}`, {}, home);
          results.push(r);
          if (!json) {
            const what = r.timeout ? "timeout" : r.ok ? `ok — ${r.version ?? "no version line"}` : `exit ${r.exit_code ?? "?"}${r.error ? ` — ${r.error}` : ""}`;
            console.log(`${t}: ${what}`);
          }
          if (!r.ok) bad = 1;
        }
        if (json) console.log(JSON.stringify(one ? results[0] : results, null, 2));
        return bad;
      }
      case "jobs": {
        const jobs = await api<Job[]>("GET", `/api/ops/jobs${ws}`, undefined, home);
        if (json) return console.log(JSON.stringify(jobs, null, 2)), 0;
        if (!jobs.length) return console.log("no jobs"), 0;
        for (const j of jobs) console.log(`${j.id}  ${j.playbook}${j.target ? ` on ${j.target}` : ""}  ${j.status}`);
        return 0;
      }
      case "start": {
        const name = args[1];
        if (!name || name.startsWith("--")) return console.log("usage: te ops start <playbook> [--target t] [--param k=v]…"), 4;
        const params: Record<string, string> = {};
        for (const kv of opts(args, "--param")) {
          const eq = kv.indexOf("=");
          if (eq === -1) return console.log(`bad --param '${kv}' — want k=v`), 4;
          params[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        const wanted = opt(args, "--target");
        const refused = await guardDeploy(wanted ?? (await playbookTarget(name, ws, home)), ws, home);
        if (refused) return console.log(`refused: ${refused}`), 3;
        const job = await api<Job>("POST", `/api/ops/start${ws}`, {
          playbook: name,
          target: opt(args, "--target"),
          params,
        }, home);
        if (json) return console.log(JSON.stringify(job, null, 2)), 0;
        console.log(`started ${job.id} — run it with: te ops exec ${job.id}`);
        return 0;
      }
      case "exec": {
        const id = args[1];
        if (!id || id.startsWith("--")) return console.log("usage: te ops exec <job> [--step id] [--json]"), 4;
        const job = await api<Job>("GET", `/api/ops/job/${id}${ws}`, undefined, home);
        const refused = await guardDeploy(job.target, ws, home);
        if (refused) return console.log(`refused: ${refused}`), 3;
        const playbook = await playbookOf(job, ws, home);
        const wsc = await api<{ root: string }>("GET", `/api/workspace${ws}`, undefined, home);
        const outcome = await execJob({
          playbook,
          getJob: () => api<Job>("GET", `/api/ops/job/${id}${ws}`, undefined, home),
          postResult: (step_id, r) =>
            api<Job>("POST", `/api/ops/step/${id}${ws}`, { step: step_id, exit_code: r.exit_code, output: r.output }, home),
          cwd: playbook.cwd ? resolve(wsc.root, playbook.cwd) : wsc.root,
          logsDir: join(teHome(home), "ops-logs"),
          out: json ? undefined : (chunk) => process.stdout.write(chunk),
          onlyStep: opt(args, "--step"),
        });
        return reportExec(outcome, json);
      }
      case "status": {
        const id = args[1];
        if (!id || id.startsWith("--")) return console.log("usage: te ops status <job> [--json]"), 4;
        const job = await api<Job>("GET", `/api/ops/job/${id}${ws}`, undefined, home);
        if (json) return console.log(JSON.stringify(job, null, 2)), 0;
        printJob(job);
        return statusCode(job);
      }
      case "approve": {
        const id = args[1];
        if (!id || id.startsWith("--")) return console.log("usage: te ops approve <job>"), 4;
        const cur = await api<Job>("GET", `/api/ops/job/${id}${ws}`, undefined, home);
        const step = opt(args, "--step") ?? cur.steps[cur.cursor]?.id;
        const job = await api<Job>("POST", `/api/ops/approve/${id}${ws}`, { step }, home);
        if (json) return console.log(JSON.stringify(job, null, 2)), 0;
        console.log(`${job.id}: approved — ${job.status}`);
        return statusCode(job);
      }
      case "abort": {
        const id = args[1];
        if (!id || id.startsWith("--")) return console.log("usage: te ops abort <job>"), 4;
        const job = await api<Job>("POST", `/api/ops/abort/${id}${ws}`, {}, home);
        if (json) return console.log(JSON.stringify(job, null, 2)), 0;
        console.log(`${job.id}: ${job.status}`);
        return 0;
      }
      case "resume": {
        const id = args[1];
        if (!id || id.startsWith("--")) return console.log("usage: te ops resume <job>"), 4;
        const job = await api<Job>("POST", `/api/ops/resume/${id}${ws}`, {}, home);
        if (json) return console.log(JSON.stringify(job, null, 2)), 0;
        console.log(`${job.id}: ${job.status} — continue with: te ops exec ${job.id}`);
        return 0;
      }
      case "rollback": {
        const id = args[1];
        if (!id || id.startsWith("--")) return console.log("usage: te ops rollback <job>"), 4;
        const job = await api<Job>("POST", `/api/ops/rollback/${id}${ws}`, {}, home);
        if (json) return console.log(JSON.stringify(job, null, 2)), 0;
        console.log(`rollback job ${job.id} started for ${id} — run it with: te ops exec ${job.id}`);
        return 0;
      }
      default:
        console.log(USAGE);
        return sub ? 4 : 0;
    }
  } catch (e) {
    const err = e as ApiError & { code?: string };
    if (json) return console.log(JSON.stringify({ error: err.code ?? "ERROR", message: err.message }, null, 2)), 3;
    console.log(`ERROR ${err.code ?? "ERROR"}: ${err.message}`);
    return 3;
  }
}

function reportExec(o: ExecOutcome, json: boolean): number {
  if (json) {
    console.log(JSON.stringify({ state: o.state, job: o.job, waiting_on: o.waiting_on, error: o.error }, null, 2));
  } else {
    switch (o.state) {
      case "waiting":
        console.log(`job ${o.job.id} waits on ${o.waiting_on!.kind} step '${o.waiting_on!.step}'`);
        if (o.waiting_on!.instruction) console.log(o.waiting_on!.instruction);
        if (o.waiting_on!.kind === "gate") console.log(`approve it with: te ops approve ${o.job.id}`);
        else console.log("an agent picks this step up — post its result with ops_step");
        break;
      case "paused":
        printJob(o.job);
        break;
      case "refused":
        console.log(`refused: ${o.error}`);
        break;
      default:
        console.log(`job ${o.job.id}: ${o.job.status}${o.job.version ? ` — version ${o.job.version}` : ""}`);
    }
  }
  return { succeeded: 0, stopped: 0, paused: 0, failed: 1, waiting: 2, aborted: 3, refused: 3 }[o.state];
}

function statusCode(j: Job): number {
  return j.status === "succeeded" || j.status === "stopped" ? 0 : j.status === "failed" ? 1 : j.status === "waiting" ? 2 : 3;
}

function formatTargets(t: unknown): string {
  const entries = Object.entries((t ?? {}) as Record<string, { title?: string; service?: string; env?: string; probe?: string }>);
  if (!entries.length) return "no targets in workspace.yaml";
  return entries
    .map(([id, v]) => `${id}  ${v.title ?? ""}${v.service ? `  ${v.service}` : ""}${v.env ? `  env:${v.env}` : ""}${v.probe ? `  probe:${v.probe}` : ""}`)
    .join("\n");
}
