import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionRegistry } from "../sessions/sessions.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { WorkspaceOps } from "../api/ops.js";
import type { Session } from "../../core/model/session.js";
import type { DispatchAgent } from "../../core/model/workspace.js";

/**
 * Daemon-side agent launcher (GL-0328). When `dispatch.enabled`, each sweep
 * starts a role's command while `next` finds work for that role and the
 * live-session count is under `max_sessions`. It never stops a session — a
 * started agent ends on its own. A role's command that fails three times in
 * a row switches dispatch off; every start and every switch-off writes an
 * event through `onEvent` (the daemon's bus).
 */
export class Dispatcher {
  private children = new Map<string, ChildProcess>();
  private failures = new Map<string, number>();
  private enabled: boolean;

  constructor(
    private wsr: WorkspaceRuntime,
    private sessions: SessionRegistry,
    private home: string,
    private onEvent?: (kind: string, data: Record<string, unknown>) => void,
  ) {
    this.enabled = wsr.ws.config.dispatch?.enabled ?? false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  status() {
    const cfg = this.wsr.ws.config.dispatch;
    return {
      enabled: this.enabled,
      max_sessions: cfg?.max_sessions ?? 0,
      agents: cfg?.agents ?? [],
      live_sessions: this.sessions.list().length,
      running: [...this.children.keys()],
      failures: Object.fromEntries(this.failures),
    };
  }

  /** One sweep — called from the daemon's timer. */
  tick(): void {
    const cfg = this.wsr.ws.config.dispatch;
    if (!this.enabled || !cfg?.agents.length) return;
    const ops = new WorkspaceOps(this.wsr, this.sessions, this.wsr.links, this.home);
    for (const agent of cfg.agents) {
      // spawned children count too — a started agent is a session in the
      // making; counting it prevents a spawn per tick until it hellos
      if (this.sessions.list().length + this.children.size >= cfg.max_sessions) break;
      if (this.children.has(agent.role)) continue; // one running command per role
      if (!this.workFor(ops, agent)) continue;
      this.startRole(agent);
    }
  }

  /** Does `next` see work for this role's pool? A probe session asks. */
  private workFor(ops: WorkspaceOps, agent: DispatchAgent): boolean {
    const now = new Date().toISOString();
    const probe: Session = {
      id: `dispatch-probe-${agent.role}`,
      agent: "dispatch",
      machine: this.wsr.store.machine,
      connected_at: now,
      last_seen: now,
      role: agent.role,
      ...(agent.tier ? { tier: agent.tier } : {}),
    };
    return ops.next(1, undefined, probe).length > 0;
  }

  private startRole(agent: DispatchAgent): void {
    const logDir = join(this.home, "runs", this.wsr.ws.name);
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, `dispatch-${agent.role}-${Date.now()}.log`);
    const out = createWriteStream(log);
    let child: ChildProcess;
    try {
      child = spawn("bash", ["-c", agent.command], {
        cwd: this.wsr.ws.root,
        env: { ...process.env, TE_ROLE: agent.role },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      out.close();
      this.recordFailure(agent.role, `spawn failed: ${(e as Error).message}`);
      return;
    }
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
    this.children.set(agent.role, child);
    this.onEvent?.("dispatch_start", {
      role: agent.role,
      command: agent.command,
      pid: child.pid ?? 0,
      log,
    });
    child.on("error", (err) => {
      this.children.delete(agent.role);
      this.recordFailure(agent.role, err.message);
    });
    child.on("exit", (code) => {
      this.children.delete(agent.role);
      if (code === 0) this.failures.set(agent.role, 0);
      else this.recordFailure(agent.role, `exit ${code}`);
    });
  }

  private recordFailure(role: string, why: string): void {
    const n = (this.failures.get(role) ?? 0) + 1;
    this.failures.set(role, n);
    this.onEvent?.("dispatch_fail", { role, failures: n, error: why });
    if (n >= 3) {
      this.enabled = false;
      this.onEvent?.("dispatch_off", { reason: `${role} command failed ${n} times in a row` });
    }
  }
}
