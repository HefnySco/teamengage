import { kebab, sameApp, type Machine } from "./machine.js";
import { versionFromTail, type Job } from "./job.js";
import type { ProbeResult } from "./probe.js";
import type { TargetConfig } from "../model/workspace.js";

/**
 * Deployed view (GL-0305): what runs on a machine right now, joined from
 * three records — the machine's apps, the workspace targets that name
 * machine+app, the last succeeded job per target (the synced ledger) and
 * the last stored probe per target (machine-local, never run here). One
 * core function feeds the machines/envs API, `te machines show` and the
 * Ops side panel, so all three print the same data. Reading it runs no
 * probe and no ssh.
 */

export type DeployedState = "deployed" | "drift" | "unknown" | "no_target";

export interface DeployedJob {
  id: string;
  version?: string;
  /** ISO — the last step end, or the job start when no step recorded an end */
  finished: string;
  /** the machine that ran the job — the runner */
  machine: string;
}

export interface DeployedProbe {
  ts: string;
  ok: boolean;
  /** the version line the probe printed — or its last output line */
  version?: string;
  output?: string;
}

export interface DeployedTarget {
  target: string;
  job?: DeployedJob;
  probe?: DeployedProbe;
  /** the probe version differs from the job version */
  drift: boolean;
}

export interface DeployedApp {
  name: string;
  env?: string;
  port?: number;
  targets: DeployedTarget[];
  state: DeployedState;
}

/** when a succeeded job finished — the last step end, else its start */
function jobFinished(job: Job): string {
  let last = job.started.ts;
  for (const s of job.steps) {
    if (s.ended && s.ended > last) last = s.ended;
  }
  return last;
}

/**
 * One entry per app of the machine. A target belongs to an app when its
 * `machine:` is this machine and its `app:` names the app (case-
 * insensitive, like every other app compare). Per target: the newest
 * succeeded job (failed and aborted jobs never count) and the stored
 * probe. State: no_target when no target names the app; unknown when no
 * target has a job or a probe; drift when any target's probe version
 * differs from its job version; deployed otherwise — a job and a probe
 * agree, a job with no probe, or a probe with no job.
 */
export function deployedForMachine(
  machine: Pick<Machine, "id" | "apps">,
  targets: Record<string, TargetConfig>,
  jobs: readonly Job[],
  probes: Record<string, ProbeResult>,
): DeployedApp[] {
  // the last succeeded job per target — jobs of every runner machine count
  const lastJob = new Map<string, Job>();
  for (const j of jobs) {
    if (j.status !== "succeeded" || !j.target) continue;
    const cur = lastJob.get(j.target);
    if (!cur || j.started.ts > cur.started.ts || (j.started.ts === cur.started.ts && j.id > cur.id)) {
      lastJob.set(j.target, j);
    }
  }
  return machine.apps.map((app) => {
    const appTargets = Object.keys(targets)
      .filter((t) => {
        const c = targets[t];
        return kebab(c.machine ?? "") === machine.id && c.app !== undefined && sameApp(c.app, app.name);
      })
      .sort();
    const list: DeployedTarget[] = appTargets.map((t) => {
      const j = lastJob.get(t);
      const p = probes[t];
      const probeVersion = p ? (p.version ?? versionFromTail(p.output)) : undefined;
      return {
        target: t,
        job: j ? { id: j.id, version: j.version, finished: jobFinished(j), machine: j.machine } : undefined,
        probe: p ? { ts: p.ts, ok: p.ok, version: probeVersion, output: p.output } : undefined,
        drift: j?.version !== undefined && probeVersion !== undefined && j.version !== probeVersion,
      };
    });
    return { name: app.name, env: app.env, port: app.port, targets: list, state: appState(list) };
  });
}

function appState(list: DeployedTarget[]): DeployedState {
  if (!list.length) return "no_target";
  if (list.some((t) => t.drift)) return "drift";
  if (!list.some((t) => t.job || t.probe)) return "unknown";
  return "deployed";
}

/** the target with the newest evidence — the one an app line reports */
function primaryTarget(list: DeployedTarget[]): DeployedTarget | undefined {
  let best: DeployedTarget | undefined;
  let bestTs = "";
  for (const t of list) {
    const ts = t.job?.finished ?? t.probe?.ts ?? "";
    if (ts > bestTs) {
      bestTs = ts;
      best = t;
    }
  }
  return best;
}

function agoText(ts: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(ts)) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

/**
 * The one-line form `te machines show` prints and the Ops panel mirrors:
 * name, port, env badge text, version, age, job link text, state. With
 * several targets the newest-evidence target speaks for the app.
 */
export function deployedAppLine(app: DeployedApp, now: number = Date.now()): string {
  const head = `${app.name}${app.port !== undefined ? ` :${app.port}` : ""}${app.env ? ` [${app.env}]` : ""}`;
  if (app.state === "no_target") return `${head} — no target names this app`;
  const t = primaryTarget(app.targets);
  if (!t) return `${head} — unknown (${app.targets.map((x) => x.target).join(", ")}: no job or probe)`;
  const bits: string[] = [];
  const version = t.job?.version ?? t.probe?.version;
  if (version) bits.push(version);
  const ts = t.job?.finished ?? t.probe?.ts;
  if (ts) bits.push(`${agoText(ts, now)} ago`);
  if (t.job) bits.push(`job ${t.job.id} on ${t.job.machine}`);
  if (t.drift) bits.push(`drift — probe ${t.probe?.version ?? "?"} ≠ job ${t.job?.version ?? "?"}`);
  else bits.push(app.state);
  return `${head} ${bits.join(" · ")}`;
}
