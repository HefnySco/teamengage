import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { pidAlive, type SessionRegistry } from "../sessions/sessions.js";
import { writeFileAtomicSync } from "../store/atomic.js";
import type { Session } from "../../core/model/session.js";
import { agentTokens } from "../../agent/http.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { WorkspaceOps } from "../api/ops.js";
import { loadMachineConfig } from "../../core/config/config.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/model/errors.js";
import { RunConfig, parseDuration, type DispatchAgent } from "../../core/model/workspace.js";
import { tierRank, type Tier } from "../../core/model/item.js";
import {
  agentName,
  listDispatchCandidates,
  parseDispatchFilter,
  pickNext,
  promptFor,
  reviewerModelAllowed,
  type AdmissionContext,
  type DispatchFilter,
  type MatchedCandidate,
  type Mode,
  type Pick,
  type RunItem,
  type RunState,
} from "../../core/dispatch/selector.js";

export interface RunningDispatch {
  id: string;
  mode: Mode;
  role: "coder" | "reviewer";
  pid: number;
  started_at: string;
  /** TE-0229: a dispatch-<id>-*.log exists under <home>/runs/<ws>/ */
  has_log?: boolean;
  /** TE-0229: the log's last non-empty line, capped at 160 chars */
  last_line?: string;
}

export interface DispatchUpdate {
  enabled?: boolean;
  max_issues?: number;
  filter?: string;
}

/** TE-0223: runtime state written to <home>/dispatch/<ws>.json on every change. */
interface DispatchPersistedState {
  enabled?: boolean;
  max_issues?: number;
  filter?: string;
  /** pausedReason — null means "not paused"; "" is a pause with no reason */
  paused?: string | null;
  fixes?: Record<string, number>;
  tried_versions?: Record<string, number>;
  item_failures?: Record<string, number>;
  minted_ids?: string[];
}

interface ActiveChild extends RunningDispatch {
  child?: ChildProcess;
  token?: string;
  sessionId?: string;
  /** TE-0229: the run log this child's stdout/stderr is piped to */
  log?: string;
  /** TE-0219: item version when an orphan was reattached — the reap baseline */
  baselineVersion?: number;
}

interface ResolvedCommand {
  command: string;
  source: "dispatch" | "run";
  /** dispatch.agents tier — a run.* fallback carries none (untiered = every tier) */
  tier?: Tier;
}

interface ResolvedCommands {
  coders: ResolvedCommand[];
  reviewers: ResolvedCommand[];
  fixRounds: number;
  defaultConcurrency: number;
}

const LEGACY_TE_RUN_RE = /(?:^|\s|\/)(?:te|teamengage)\s+run(?:\s|$)/;
const PROMPT_ARG_TAIL_RE = /(?:^|\s)(?:--|-p|--prompt)\s*$/;

export function isLegacyTeRunCommand(command: string): boolean {
  return LEGACY_TE_RUN_RE.test(command.trim());
}

/** The model id a dispatch command declares (`--model x` or `--model=x`). */
export function commandModel(cmd: string): string | undefined {
  return /(?:^|\s)--?model(?:=|\s+)(\S+)/.exec(cmd)?.[1];
}

function buildSpawnScript(command: string, source: "dispatch" | "run"): string {
  if (command.includes("TE_PROMPT")) return command;
  if (source === "run" || PROMPT_ARG_TAIL_RE.test(command)) {
    return `${command} "$TE_PROMPT"`;
  }
  return command;
}

/** A process found in /proc — TE_* markers identify a spawned agent. */
export interface ProcScan {
  pid: number;
  ppid: number;
  started_at: string;
  item?: string;
  mode?: Mode;
  role?: "coder" | "reviewer";
  token?: string;
}

export interface DiscoverReattached {
  pid: number;
  id: string;
  session: string;
  claim: "adopted" | "none";
  token: boolean;
}

export interface DiscoverSkipped {
  pid: number;
  item?: string;
  reason: string;
}

export interface DiscoverReport {
  scanned: number;
  reattached: DiscoverReattached[];
  skipped: DiscoverSkipped[];
}

const SCAN_MODES = new Set(["work", "fix", "resume", "review", "takeover"]);

/**
 * TE-0219: read /proc for agent processes — a spawned child carries TE_ITEM,
 * TE_MODE, TE_ROLE and its X-TE-Session token in TE_SESSION. Processes whose
 * environ is unreadable (another uid, gone mid-scan) come back unmarked.
 */
export function scanProcesses(procRoot = "/proc"): ProcScan[] {
  const out: ProcScan[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(procRoot, name);
    const scan: ProcScan = { pid: Number(name), ppid: 0, started_at: "" };
    try {
      scan.started_at = statSync(dir).mtime.toISOString();
      const env: Record<string, string> = {};
      for (const part of readFileSync(join(dir, "environ")).toString("latin1").split("\0")) {
        const eq = part.indexOf("=");
        if (eq > 0) env[part.slice(0, eq)] = part.slice(eq + 1);
      }
      scan.ppid = Number(/^PPid:\s*(\d+)$/m.exec(readFileSync(join(dir, "status"), "utf8"))?.[1] ?? 0);
      if (env.TE_ITEM) scan.item = env.TE_ITEM;
      if (env.TE_MODE && SCAN_MODES.has(env.TE_MODE)) scan.mode = env.TE_MODE as Mode;
      if (env.TE_ROLE === "coder" || env.TE_ROLE === "reviewer") scan.role = env.TE_ROLE;
      if (env.TE_SESSION) scan.token = env.TE_SESSION;
    } catch {
      // unreadable or exited mid-scan — stays unmarked
    }
    out.push(scan);
  }
  return out;
}

/**
 * TE-0229: the last n lines of a file, read in tail chunks so a large run
 * log never loads whole. A trailing partial line (still being written)
 * counts as a line.
 */
function tailLines(path: string, n: number): string[] {
  const { size } = statSync(path);
  if (size === 0) return [];
  const fd = openSync(path, "r");
  try {
    let end = size;
    let buf = Buffer.alloc(0);
    let breaks = 0;
    while (end > 0 && breaks <= n) {
      const start = Math.max(0, end - 64 * 1024);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      for (const byte of chunk) if (byte === 0x0a) breaks++;
      buf = Buffer.concat([chunk, buf]);
      end = start;
    }
    const lines = buf.toString("utf8").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n);
  } finally {
    closeSync(fd);
  }
}

export class Dispatcher {
  private children = new Map<string, ActiveChild>();
  private failures = new Map<string, number>();
  private fixes = new Map<string, number>();
  private triedVersions = new Map<string, number>();
  /** failed runs per item — two in a row set dispatch_blocked (TE-0208) */
  private itemFailures = new Map<string, number>();
  /** session ids this dispatcher opened — resume trusts only these (TE-0208) */
  private mintedIds = new Set<string>();
  /** dispatch.agents entries filtered as legacy te run commands (TE-0208) */
  private configWarnings: string[] = [];
  private pendingClaim?: string;
  /** set by the pause lever (TE-0209) — reported through status().why_idle */
  pausedReason?: string;
  private eventLog: Array<{ kind: string; at: string; data: Record<string, unknown> }> = [];
  private enabled: boolean;
  private maxIssues: number;
  private filter: DispatchFilter;
  private baseUrl?: string;

  constructor(
    private wsr: WorkspaceRuntime,
    private sessions: SessionRegistry,
    private home: string,
    private onEvent?: (kind: string, data: Record<string, unknown>) => void,
  ) {
    const cfg = wsr.ws.config.dispatch;
    const resolved = this.resolveCommands();
    this.enabled = cfg?.enabled ?? false;
    this.maxIssues = cfg?.max_issues ?? cfg?.max_sessions ?? resolved.defaultConcurrency;
    try {
      this.filter = parseDispatchFilter(cfg?.filter ?? "");
    } catch {
      this.filter = parseDispatchFilter("");
    }
    // TE-0223: runtime state saved on every change wins over the
    // workspace.yaml defaults; an absent or corrupt file keeps them.
    const saved = this.loadState();
    if (saved) {
      if (typeof saved.enabled === "boolean") this.enabled = saved.enabled;
      if (Number.isInteger(saved.max_issues) && saved.max_issues! >= 1) {
        this.maxIssues = saved.max_issues!;
      }
      if (typeof saved.filter === "string") {
        try {
          this.filter = parseDispatchFilter(saved.filter);
        } catch {
          // a filter the current parser rejects keeps the config one
        }
      }
      if (typeof saved.paused === "string") this.pausedReason = saved.paused;
      for (const [map, savedCounts] of [
        [this.fixes, saved.fixes],
        [this.triedVersions, saved.tried_versions],
        [this.itemFailures, saved.item_failures],
      ] as const) {
        for (const [id, count] of Object.entries(savedCounts ?? {})) {
          if (typeof count === "number" && Number.isFinite(count)) map.set(id, count);
        }
      }
      for (const id of saved.minted_ids ?? []) {
        if (typeof id === "string") this.mintedIds.add(id);
      }
    }
    // TE-0208: a legacy te run command in dispatch.agents is filtered — never
    // silently. One event and a status warning name every dropped entry.
    for (const agent of cfg?.agents ?? []) {
      if (!isLegacyTeRunCommand(agent.command)) continue;
      const warning = `dispatch.agents ${agent.role} command '${agent.command}' is a legacy te run — ignored`;
      this.configWarnings.push(warning);
      this.emit("dispatch_config", { warning });
    }
  }

  private stateFile(): string {
    return join(this.home, "dispatch", `${this.wsr.ws.name}.json`);
  }

  private loadState(): DispatchPersistedState | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.stateFile(), "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      return parsed as DispatchPersistedState;
    } catch {
      return undefined;
    }
  }

  /**
   * TE-0223: every runtime-state change lands on disk at once — a restart
   * must never lose enabled, pause, the filter or the retry counters.
   * A failed write is reported, never thrown: dispatch keeps running.
   */
  private persist(): void {
    const state: DispatchPersistedState = {
      enabled: this.enabled,
      max_issues: this.maxIssues,
      filter: this.filter.raw,
      paused: this.pausedReason ?? null,
      fixes: Object.fromEntries(this.fixes),
      tried_versions: Object.fromEntries(this.triedVersions),
      item_failures: Object.fromEntries(this.itemFailures),
      minted_ids: [...this.mintedIds],
    };
    try {
      writeFileAtomicSync(this.stateFile(), `${JSON.stringify(state, null, 2)}\n`);
    } catch (e) {
      this.emit("dispatch_persist_error", { error: (e as Error).message });
    }
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on && !this.enabled) {
      this.triedVersions.clear();
    }
    // TE-0209: "on" also lifts a pause — one obvious way to resume
    if (on) this.pausedReason = undefined;
    this.enabled = on;
    this.persist();
  }

  update(patch: DispatchUpdate): void {
    if (patch.max_issues !== undefined) {
      if (!Number.isInteger(patch.max_issues) || patch.max_issues < 1) {
        throw new ValidationError("max_issues must be an integer >= 1");
      }
      this.maxIssues = patch.max_issues;
    }
    if (patch.filter !== undefined) {
      this.filter = parseDispatchFilter(patch.filter);
      this.triedVersions.clear();
    }
    if (patch.enabled !== undefined) {
      this.setEnabled(patch.enabled);
    }
    this.persist();
  }

  stopAll(): void {
    for (const active of this.children.values()) {
      active.child?.kill();
      if (active.token && this.baseUrl) {
        void this.closeRemoteSession(this.baseUrl, active.token);
      }
    }
    this.children.clear();
    this.pendingClaim = undefined;
  }

  // ---- forced correction levers (TE-0209) — the human's hand on dispatch --

  private persistLever(action: string, note: string, item?: string): void {
    void this.wsr.store
      .logEvent({
        ts: new Date().toISOString(),
        actor: "human",
        action,
        ...(item ? { item } : {}),
        note,
      })
      .catch(() => {});
  }

  /** Stop new starts at once; kill also stops the running children. */
  pause(reason?: string, kill = false): void {
    this.pausedReason = reason || "";
    this.emit("dispatch_pause", { reason: this.pausedReason, kill });
    this.persistLever("dispatch_pause", reason ? `paused: ${reason}` : "paused");
    if (kill) this.stopAll();
    this.persist();
  }

  unpause(): void {
    if (this.pausedReason === undefined) return;
    this.pausedReason = undefined;
    this.emit("dispatch_resume", {});
    this.persistLever("dispatch_resume", "resumed");
    this.persist();
    if (this.enabled) this.tick();
  }

  /** Persisted block — the human's version of the per-item breaker. */
  async blockItem(id: string, reason: string): Promise<void> {
    const ops = new WorkspaceOps(this.wsr, this.sessions, this.wsr.links, this.home);
    const it = ops.index.get(id);
    if (!it) throw new NotFoundError(`no item '${id}'`);
    await ops.store.perform(it.meta.id, it.meta.version, this.humanActor(), {
      type: "dispatch_block",
      reason,
    });
    this.emit("dispatch_block", { id, reason });
  }

  async unblockItem(id: string): Promise<void> {
    const ops = new WorkspaceOps(this.wsr, this.sessions, this.wsr.links, this.home);
    const it = ops.index.get(id);
    if (!it) throw new NotFoundError(`no item '${id}'`);
    await ops.store.perform(it.meta.id, it.meta.version, this.humanActor(), {
      type: "dispatch_unblock",
    });
    this.emit("dispatch_unblock", { id });
  }

  /**
   * TE-0230: stop one active child — the per-item version of pause --kill.
   * A spawned child gets child.kill(); a rediscovered orphan has no
   * ChildProcess handle, so its pid gets SIGTERM. The minted session is
   * closed, a pending claim on the item is cleared and the item's version
   * goes into triedVersions so the next tick does not restart it. With
   * release=true the item's claim is freed too — only while it holds one
   * in a status release accepts (in_progress/waiting).
   */
  async stopItem(id: string, release = false): Promise<void> {
    const active = this.children.get(id);
    if (!active) throw new NotFoundError(`no running dispatch for '${id}'`);
    this.children.delete(id);
    if (this.pendingClaim === id) this.pendingClaim = undefined;
    if (active.child) {
      active.child.kill();
    } else if (active.pid > 0) {
      try {
        process.kill(active.pid, "SIGTERM");
      } catch {
        // already gone — the next reap probe would have caught it
      }
    }
    const ops = new WorkspaceOps(this.wsr, this.sessions, this.wsr.links, this.home);
    const it = ops.index.get(id);
    const canRelease =
      release &&
      it !== undefined &&
      it.claim != null &&
      (it.meta.status === "in_progress" || it.meta.status === "waiting");
    try {
      if (canRelease) await ops.release(id, "human");
    } finally {
      // the tried marker lands after the release — release bumps the
      // version and collectBoard drops a marker that names a stale one
      const version = ops.index.get(id)?.meta.version;
      if (version !== undefined) this.triedVersions.set(id, version);
      this.persist();
      const cleanup =
        active.token && this.baseUrl
          ? this.closeRemoteSession(this.baseUrl, active.token)
          : Promise.resolve();
      void cleanup.finally(() => this.persist());
      if (active.sessionId) this.sessions.disconnect(active.sessionId);
      this.emit("dispatch_stop", { id, pid: active.pid, release });
      this.persistLever("dispatch_stop", release ? "stopped + claim released" : "stopped", id);
    }
  }

  /**
   * Clear the in-memory triedVersions, fix count and per-item failure count
   * for one item so a repaired environment can retry clean. A persisted
   * dispatch_blocked stays — that is the unblock lever's job.
   */
  async resetItem(id: string): Promise<void> {
    this.triedVersions.delete(id);
    this.fixes.delete(id);
    this.itemFailures.delete(id);
    this.persist();
    const ops = new WorkspaceOps(this.wsr, this.sessions, this.wsr.links, this.home);
    const it = ops.index.get(id);
    if (!it) throw new NotFoundError(`no item '${id}'`);
    await ops.store.perform(it.meta.id, it.meta.version, this.humanActor(), {
      type: "dispatch_reset",
    });
    this.emit("dispatch_reset", { id });
  }

  private humanActor() {
    return { kind: "human" as const, session: "human", machine: this.wsr.store.machine };
  }

  private resolveCommands(): ResolvedCommands {
    let runCfg = RunConfig.parse({});
    let hasRunBlock = false;
    try {
      const machineCfg = loadMachineConfig(this.home);
      hasRunBlock = machineCfg.run !== undefined;
      runCfg = RunConfig.parse(machineCfg.run ?? {});
    } catch {
      runCfg = RunConfig.parse({});
    }
    const configuredAgents = (this.wsr.ws.config.dispatch?.agents ?? []).filter(
      (agent) => !isLegacyTeRunCommand(agent.command),
    );
    // TE-0225: every non-legacy entry stays a candidate — the pick chooses
    // one per item; the machine.yaml run: block fills a role with no entry
    const coders: ResolvedCommand[] = configuredAgents
      .filter((agent) => agent.role === "coder")
      .map((agent) => ({ command: agent.command, source: "dispatch", tier: agent.tier }));
    const reviewers: ResolvedCommand[] = configuredAgents
      .filter((agent) => agent.role === "reviewer")
      .map((agent) => ({ command: agent.command, source: "dispatch", tier: agent.tier }));
    if (!coders.length && runCfg.coder) {
      coders.push({ command: runCfg.coder, source: "run" });
    }
    if (!reviewers.length && runCfg.reviewer) {
      reviewers.push({ command: runCfg.reviewer, source: "run" });
    }
    return {
      coders,
      reviewers,
      fixRounds: runCfg.fix_rounds,
      defaultConcurrency: hasRunBlock ? runCfg.concurrency : 2,
    };
  }

  /**
   * TE-0225: the lowest-tier coder entry that can take the item. A declared
   * tier must be >= the item's; an untiered entry counts as an exact match
   * for the item ("matches all tiers") and loses the tie to a declared
   * entry at the item's tier — a specialist wins its own tier, the
   * untiered default covers everything else.
   */
  private pickCoder(resolved: ResolvedCommands, tier?: Tier): ResolvedCommand | undefined {
    const need = tierRank(tier);
    let best: ResolvedCommand | undefined;
    let bestRank = Infinity;
    let bestDeclared = false;
    for (const entry of resolved.coders) {
      if (entry.tier !== undefined && tierRank(entry.tier) < need) continue;
      const rank = entry.tier === undefined ? need : tierRank(entry.tier);
      const declared = entry.tier !== undefined;
      if (rank < bestRank || (rank === bestRank && declared && !bestDeclared)) {
        best = entry;
        bestRank = rank;
        bestDeclared = declared;
      }
    }
    return best;
  }

  /**
   * TE-0225: the first reviewer entry whose parsed --model differs from the
   * submission's model and satisfies review_models (deep at or above
   * deep_from_tier, quick or deep below).
   */
  private pickReviewer(resolved: ResolvedCommands, item: RunItem): ResolvedCommand | undefined {
    const rm = this.wsr.ws.config.review_models;
    return resolved.reviewers.find((entry) =>
      reviewerModelAllowed(commandModel(entry.command), item, rm),
    );
  }

  private effectiveAgents(resolved: ResolvedCommands): DispatchAgent[] {
    const out: DispatchAgent[] = [];
    for (const entry of resolved.coders) {
      out.push({ role: "coder", command: entry.command, ...(entry.tier ? { tier: entry.tier } : {}) });
    }
    for (const entry of resolved.reviewers) {
      out.push({ role: "reviewer", command: entry.command, ...(entry.tier ? { tier: entry.tier } : {}) });
    }
    return out;
  }

  /**
   * Live-capacity window (TE-0206): a claim counts while its holder session
   * is live AND its last_seen is fresher than this. Active work keeps a
   * claim fresh through throttled touches; adopted-but-idle claims go stale.
   */
  private liveWindowMs(): number {
    return parseDuration(this.wsr.ws.config.live_claim_window);
  }

  /**
   * TE-0219: a rediscovered orphan has no ChildProcess handle — the pid
   * probe is its exit. Reaped like a normal exit: the token's session is
   * closed, and "gone with no status change since adoption" counts as a
   * failed run under the TE-0208 breaker.
   */
  private reapAdoptedChildren(): void {
    for (const entry of [...this.children.values()]) {
      if (entry.child !== undefined || entry.pid <= 0 || pidAlive(entry.pid)) continue;
      this.children.delete(entry.id);
      if (this.pendingClaim === entry.id) this.pendingClaim = undefined;
      const baseline = entry.baselineVersion;
      const cleanup =
        entry.token && this.baseUrl
          ? this.closeRemoteSession(this.baseUrl, entry.token)
          : Promise.resolve();
      void cleanup.finally(() => {
        try {
          const current = new WorkspaceOps(
            this.wsr,
            this.sessions,
            this.wsr.links,
            this.home,
          ).index.get(entry.id);
          if (
            entry.mode !== "review" &&
            baseline !== undefined &&
            current &&
            current.meta.version === baseline &&
            (current.meta.status === "ready" || current.meta.status === "in_progress")
          ) {
            this.triedVersions.set(entry.id, baseline);
            this.recordItemFailure(entry.id, "discovered agent exited with no status change");
          } else {
            this.itemFailures.delete(entry.id);
          }
        } finally {
          this.persist();
        }
      });
      this.emit("dispatch_reaped", { id: entry.id, pid: entry.pid });
    }
  }

  private collectBoard(ops: WorkspaceOps): {
    items: RunItem[];
    ready: string[];
    onlineIds: Set<string>;
    tried: Set<string>;
  } {
    this.reapAdoptedChildren();
    const machine = this.wsr.store.machine;
    const now = Date.now();
    const windowMs = this.liveWindowMs();
    const onlineIds = new Set<string>(this.children.keys());
    if (this.pendingClaim) onlineIds.add(this.pendingClaim);
    const tried = new Set<string>();
    const items: RunItem[] = [];

    for (const indexed of ops.index.items.values()) {
      if (indexed.meta.archived) continue;
      const dead = indexed.claim ? ops.claimDead(indexed.claim) : false;
      if (
        indexed.meta.status === "in_progress" &&
        indexed.claim &&
        this.sessions.claimIsLiveCapacity(indexed.claim, machine, windowMs, now)
      ) {
        onlineIds.add(indexed.meta.id);
        tried.add(indexed.meta.id);
      }
      const triedAtVersion = this.triedVersions.get(indexed.meta.id);
      if (triedAtVersion !== undefined) {
        if (triedAtVersion === indexed.meta.version) {
          tried.add(indexed.meta.id);
        } else {
          this.triedVersions.delete(indexed.meta.id);
        }
      }
      if (
        this.fixes.has(indexed.meta.id) &&
        (indexed.meta.status === "done" ||
          indexed.meta.status === "dropped" ||
          indexed.meta.status === "draft")
      ) {
        this.fixes.delete(indexed.meta.id);
      }
      items.push({
        id: indexed.meta.id,
        status: indexed.meta.status,
        title: indexed.meta.title,
        type: indexed.meta.type,
        parent: indexed.meta.parent,
        domains: indexed.meta.domains,
        tier: indexed.meta.tier,
        attempts: indexed.meta.attempts,
        dispatch_blocked: indexed.meta.dispatch_blocked,
        findings: indexed.meta.findings?.length,
        claim: indexed.claim ? { ...indexed.claim, dead } : null,
        ai_review: indexed.meta.ai_review,
        submitted_model: indexed.meta.submitted_model,
        question: indexed.meta.question,
      });
    }

    const ready = ops.next(500).map((entry) => entry.meta.id);
    return { items, ready, onlineIds, tried };
  }

  /** TE-0208: the live state admit() needs — rebuilt per tick, never cached. */
  private admissionCtx(resolved: ResolvedCommands, now: number): AdmissionContext {
    return {
      machine: this.wsr.store.machine,
      now,
      maxAttempts: this.wsr.ws.config.max_attempts,
      fixRounds: resolved.fixRounds,
      fixes: this.fixes,
      coderNames: resolved.coders.map((entry) => agentName(entry.command)),
      mintedSessions: this.mintedIds,
      isLive: (id) => this.sessions.isLive(id),
      takeoverGraceMs: parseDuration(this.wsr.ws.config.takeover_grace_after),
      reviewModels: this.wsr.ws.config.review_models,
      reviewerModels: resolved.reviewers.map((entry) => commandModel(entry.command)),
    };
  }

  status() {
    const ops = new WorkspaceOps(this.wsr, this.sessions, this.wsr.links, this.home);
    const resolved = this.resolveCommands();
    const agents = this.effectiveAgents(resolved);
    const { items, ready, onlineIds, tried } = this.collectBoard(ops);
    const runCfg = RunConfig.parse({
      ...(resolved.coders[0] ? { coder: resolved.coders[0].command } : {}),
      ...(resolved.reviewers[0] ? { reviewer: resolved.reviewers[0].command } : {}),
      concurrency: this.maxIssues,
      fix_rounds: resolved.fixRounds,
    });
    const admission = this.admissionCtx(resolved, Date.now());
    const blockedIds = new Set(items.filter((i) => i.dispatch_blocked).map((i) => i.id));
    const matched: Array<MatchedCandidate & { blocked?: boolean }> =
      resolved.coders.length || resolved.reviewers.length
        ? listDispatchCandidates(
            runCfg,
            { fixes: this.fixes, tried },
            items,
            ready,
            this.wsr.store.machine,
            undefined,
            this.filter,
            admission,
          ).map((c) => ({ ...c, blocked: blockedIds.has(c.id) }))
        : [];
    const running: RunningDispatch[] = [...this.children.values()].map((entry) => {
      const known = entry.log ?? this.latestLogPath(entry.id);
      const log = known !== undefined && existsSync(known) ? known : undefined;
      return {
        id: entry.id,
        mode: entry.mode,
        role: entry.role,
        pid: entry.pid,
        started_at: entry.started_at,
        has_log: log !== undefined,
        last_line: log === undefined ? "" : this.lastLogLine(log),
      };
    });
    const agentsReady = Boolean(resolved.coders.length || resolved.reviewers.length);
    // TE-0206: a starved dispatcher is never silent — name why nothing starts
    let whyIdle: string | null = null;
    if (this.pausedReason !== undefined)
      whyIdle = `paused${this.pausedReason ? `: ${this.pausedReason}` : ""}`;
    else if (!this.enabled) whyIdle = "disabled";
    else if (!agentsReady) whyIdle = "no_agents";
    else if (onlineIds.size >= this.maxIssues) whyIdle = "cap";
    else if (!matched.length) {
      const unfiltered = listDispatchCandidates(
        runCfg,
        { fixes: this.fixes, tried },
        items,
        ready,
        this.wsr.store.machine,
        undefined,
        undefined,
      );
      whyIdle = unfiltered.length ? "filter" : "no_match";
    } else if (!matched.some((c) => c.admission?.ok !== false)) {
      // candidates exist but admission refused every one — the board names why
      whyIdle = "admission";
    } else if (this.pendingClaim) whyIdle = "backlog";
    return {
      enabled: this.enabled,
      max_issues: this.maxIssues,
      max_sessions: this.maxIssues,
      online_issues: onlineIds.size,
      live_issues: onlineIds.size,
      cap_over: onlineIds.size >= this.maxIssues,
      why_idle: whyIdle,
      paused: this.pausedReason !== undefined ? this.pausedReason : null,
      live_sessions: this.sessions.list().length,
      filter: this.filter.raw,
      warnings: this.configWarnings,
      matched,
      running,
      agents,
      agents_ready: agentsReady,
      failures: Object.fromEntries(this.failures),
      events: this.eventLog.slice(-10),
    };
  }

  private runsDir(): string {
    return join(this.home, "runs", this.wsr.ws.name);
  }

  /**
   * TE-0229: the newest dispatch-<id>-<mode>-<ts>.log under
   * <home>/runs/<ws>/ — the numeric <ts> suffix after the last '-'
   * decides, not the file name's text (the mode word sorts before the
   * time stamp, so a text compare lets an old work log hide a newer
   * review or fix log). The id segment must match exactly.
   */
  latestLogPath(id: string): string | undefined {
    let best: string | undefined;
    let bestTs = -1;
    try {
      for (const name of readdirSync(this.runsDir())) {
        const m = /^dispatch-(.+)-[a-z]+-(\d+)\.log$/.exec(name);
        if (m === null || m[1] !== id) continue;
        const ts = Number(m[2]);
        if (ts > bestTs) {
          best = name;
          bestTs = ts;
        }
      }
    } catch {
      return undefined;
    }
    return best === undefined ? undefined : join(this.runsDir(), best);
  }

  /** The log's last non-empty line, trimmed and capped at 160 chars. */
  private lastLogLine(path: string): string {
    try {
      const tail = tailLines(path, 20);
      for (let i = tail.length - 1; i >= 0; i--) {
        const line = tail[i].trim();
        if (line) return line.slice(0, 160);
      }
    } catch {
      // gone between the dir scan and the read — treated as empty
    }
    return "";
  }

  /**
   * TE-0229: the tail of the item's newest dispatch log, for the human's
   * GET /api/dispatch/log. The resolved realpath must stay inside
   * <home>/runs/<ws>/ — an id that escapes it is refused, a missing log
   * answers 404.
   */
  dispatchLogTail(id: string, lines = 80): { id: string; file: string; lines: string[] } {
    const path = this.latestLogPath(id);
    if (path === undefined) throw new NotFoundError(`no dispatch log for '${id}'`);
    const real = realpathSync(path);
    const rel = relative(realpathSync(this.runsDir()), real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ForbiddenError(`log for '${id}' is outside the runs dir`);
    }
    const capped = Math.min(500, Math.max(1, Math.trunc(lines)));
    return { id, file: basename(real), lines: tailLines(real, capped) };
  }

  private emit(kind: string, data: Record<string, unknown>): void {
    this.eventLog.push({ kind, at: new Date().toISOString(), data });
    if (this.eventLog.length > 20) this.eventLog.splice(0, this.eventLog.length - 20);
    this.onEvent?.(kind, data);
  }

  tick(): void {
    if (!this.enabled || this.pausedReason !== undefined) return;
    const resolved = this.resolveCommands();
    if (!resolved.coders.length && !resolved.reviewers.length) return;

    const ops = new WorkspaceOps(this.wsr, this.sessions, this.wsr.links, this.home);
    if (this.pendingClaim) {
      const pendingItem = ops.index.get(this.pendingClaim);
      if (
        !this.children.has(this.pendingClaim) ||
        pendingItem?.claim != null ||
        pendingItem?.meta.status !== "ready"
      ) {
        this.pendingClaim = undefined;
      }
    }

    const { items, ready, onlineIds, tried } = this.collectBoard(ops);
    const runningModes = new Map<string, Mode>();
    for (const [id, entry] of this.children) {
      runningModes.set(id, entry.mode);
    }

    const runCfg = RunConfig.parse({
      ...(resolved.coders[0] ? { coder: resolved.coders[0].command } : {}),
      ...(resolved.reviewers[0] ? { reviewer: resolved.reviewers[0].command } : {}),
      concurrency: Math.max(1, this.maxIssues),
      fix_rounds: resolved.fixRounds,
    });
    const state: RunState = {
      running: runningModes,
      fixes: this.fixes,
      tried,
      pendingClaim: this.pendingClaim,
      started: 0,
    };
    const admission = this.admissionCtx(resolved, Date.now());

    while (this.enabled && onlineIds.size < this.maxIssues) {
      const pick = pickNext(
        runCfg,
        state,
        items,
        ready,
        this.wsr.store.machine,
        Infinity,
        undefined,
        this.filter,
        admission,
      );
      if (!pick) break;
      // TE-0225: the item decides which configured command spawns — coder
      // by tier, reviewer by submitted_model + review_models
      const pickedItem = items.find((entry) => entry.id === pick.id);
      const cmdSpec =
        pick.mode === "review"
          ? pickedItem
            ? this.pickReviewer(resolved, pickedItem)
            : undefined
          : this.pickCoder(resolved, pickedItem?.tier);
      if (!cmdSpec) break;
      const startVersion = ops.index.get(pick.id)?.meta.version ?? 0;
      onlineIds.add(pick.id);
      state.running.set(pick.id, pick.mode);
      if (pick.mode === "work") {
        this.pendingClaim = pick.id;
        state.pendingClaim = pick.id;
      }
      if (pick.mode === "fix") {
        this.fixes.set(pick.id, (this.fixes.get(pick.id) ?? 0) + 1);
        this.persist();
      }
      this.startItem(pick, cmdSpec, startVersion);
      if (pick.mode === "work") break;
    }
  }

  private async openRemoteSession(
    baseUrl: string,
    agent: string,
    role: "coder" | "reviewer",
    label: string,
    adopt: boolean,
  ): Promise<{ token: string; resume: string[]; sessionId?: string }> {
    const res = await fetch(`${baseUrl}/agent/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent,
        role,
        label,
        workspace: this.wsr.ws.name,
        dispatch: true,
        adopt,
      }),
    });
    const text = await res.text();
    const token = /^token (\S+)/m.exec(text)?.[1];
    if (!res.ok || !token) {
      throw new Error(`hello failed: ${text.split("\n")[0] ?? res.status}`);
    }
    const resume = /^resume: (.+)$/m.exec(text)?.[1]?.split(/,\s*/) ?? [];
    // TE-0206: mark the minted session on the shared registry — ops.claim
    // hard-caps claims from sessions the dispatcher opened
    const sessionId = /^session (\S+)/m.exec(text)?.[1];
    if (sessionId) {
      this.sessions.markDispatchMinted(sessionId);
      // TE-0208: resume admits only holders this dispatcher minted itself
      this.mintedIds.add(sessionId);
      this.persist();
    }
    return { token, resume, sessionId };
  }

  /**
   * Item ids this dispatcher holds right now — running children plus the
   * pending work claim. The claim sweep (TE-0207) must never touch them.
   */
  heldItemIds(): Set<string> {
    const ids = new Set<string>(this.children.keys());
    if (this.pendingClaim) ids.add(this.pendingClaim);
    return ids;
  }

  /**
   * TE-0219 — reattach orphaned agent processes. A dispatch child outlives
   * its session two ways: the session is idle-pruned while the agent stays
   * quiet, or the daemon restarts (sessions, HTTP tokens and `children` are
   * in-memory). For each marked orphan: mint a session carrying its pid,
   * adopt the item's dead claim so the holder matches the new session,
   * rebind its recovered TE_SESSION token so the next X-TE-Session call
   * works without a new hello, and put the pid back in `children` so it
   * counts toward `online_issues` and exits are reaped.
   */
  async discoverOrphans(
    opts: {
      scan?: () => ProcScan[];
      rebind?: (token: string, session: Session, wsr: WorkspaceRuntime) => void;
    } = {},
  ): Promise<DiscoverReport> {
    const rebind = opts.rebind ?? agentTokens.rebind;
    const procs = (opts.scan ?? (() => scanProcesses()))();
    const ops = new WorkspaceOps(this.wsr, this.sessions, this.wsr.links, this.home);
    const report: DiscoverReport = { scanned: procs.length, reattached: [], skipped: [] };
    // a marker tree shares one env — only the process whose parent does NOT
    // carry the same TE_ITEM is the spawned root we track
    const markedByItem = new Map<string, Set<number>>();
    for (const p of procs) {
      if (!p.item) continue;
      let set = markedByItem.get(p.item);
      if (!set) markedByItem.set(p.item, (set = new Set()));
      set.add(p.pid);
    }
    const roots = procs
      .filter((p) => p.item !== undefined && !markedByItem.get(p.item)!.has(p.ppid))
      .sort((a, b) => a.pid - b.pid);
    const rootPids = new Set(roots.map((p) => p.pid));
    for (const p of procs) {
      if (!p.item) report.skipped.push({ pid: p.pid, reason: "no_marker" });
      else if (!rootPids.has(p.pid))
        report.skipped.push({ pid: p.pid, item: p.item, reason: "child_process" });
    }
    for (const p of roots) {
      const item = p.item!;
      const skip = (reason: string) => report.skipped.push({ pid: p.pid, item, reason });
      // the daemon itself may carry TE_* from the agent whose te call spawned it
      if (p.pid === process.pid) {
        skip("daemon_self");
        continue;
      }
      if (this.children.has(item)) {
        skip("already_running");
        continue;
      }
      if (!pidAlive(p.pid)) {
        skip("exited");
        continue;
      }
      const it = ops.index.get(item);
      if (!it) {
        skip("unknown_item");
        continue;
      }
      // a reviewer never holds the claim — the submitter's claim stays as is
      const isReview = p.mode === "review";
      if (!isReview && it.claim && !ops.claimDead(it.claim)) {
        skip("claim_live");
        continue;
      }
      // adoption matches the holder's agent name — take it from the dead
      // claim; an unclaimed item gets a plain "discovered" session.
      // A reviewer gets the "<agent>-review" name and does not adopt.
      const baseAgent = it.claim ? it.claim.holder.split("@")[0].split("#")[0] : "discovered";
      const agent = isReview ? `${baseAgent}-review` : baseAgent;
      const { session, resume } = await ops.hello(
        agent,
        p.pid,
        undefined,
        p.role,
        undefined,
        item,
        !isReview,
      );
      this.mintedIds.add(session.id);
      this.persist();
      if (p.token) rebind?.(p.token, session, this.wsr);
      this.children.set(item, {
        id: item,
        mode: p.mode ?? "work",
        role: p.role ?? "coder",
        pid: p.pid,
        started_at: p.started_at || new Date().toISOString(),
        token: p.token,
        sessionId: session.id,
        baselineVersion: it.meta.version,
        log: this.latestLogPath(item),
      });
      this.emit("dispatch_discover", {
        id: item,
        pid: p.pid,
        session: session.id,
        adopted: resume.length > 0,
      });
      report.reattached.push({
        pid: p.pid,
        id: item,
        session: session.id,
        claim: resume.length > 0 ? "adopted" : "none",
        token: p.token !== undefined,
      });
    }
    return report;
  }

  private closeRemoteSession(baseUrl: string, token: string): Promise<void> {
    return fetch(`${baseUrl}/agent/bye`, {
      method: "POST",
      headers: { "x-te-session": token },
    }).then(
      () => {},
      () => {},
    );
  }

  private startItem(
    pick: Pick,
    cmdSpec: { command: string; source: "dispatch" | "run" },
    startVersion: number,
  ): void {
    const role: "coder" | "reviewer" = pick.mode === "review" ? "reviewer" : "coder";
    const startedAt = new Date().toISOString();
    const activeEntry: ActiveChild = {
      id: pick.id,
      mode: pick.mode,
      role,
      pid: 0,
      started_at: startedAt,
    };
    this.children.set(pick.id, activeEntry);

    if (!this.baseUrl) {
      this.spawnChildProcess(pick, role, cmdSpec, startVersion, activeEntry, undefined);
      return;
    }

    const baseUrl = this.baseUrl;
    const baseAgent = agentName(cmdSpec.command);
    const sessionAgent = role === "reviewer" ? `${baseAgent}-review` : baseAgent;
    void this.openRemoteSession(baseUrl, sessionAgent, role, pick.id, pick.mode === "resume")
      .then((opened) => {
        if (!this.children.has(pick.id)) {
          void this.closeRemoteSession(baseUrl, opened.token);
          return;
        }
        if (pick.mode === "resume" && !opened.resume.includes(pick.id)) {
          this.children.delete(pick.id);
          this.triedVersions.set(pick.id, startVersion);
          this.persist();
          void this.closeRemoteSession(baseUrl, opened.token);
          return;
        }
        activeEntry.token = opened.token;
        activeEntry.sessionId = opened.sessionId;
        this.spawnChildProcess(pick, role, cmdSpec, startVersion, activeEntry, opened.token);
      })
      .catch((err: Error) => {
        this.children.delete(pick.id);
        if (this.pendingClaim === pick.id) this.pendingClaim = undefined;
        this.recordFailure(role, pick.id, err.message);
      });
  }

  private spawnChildProcess(
    pick: Pick,
    role: "coder" | "reviewer",
    cmdSpec: { command: string; source: "dispatch" | "run" },
    startVersion: number,
    activeEntry: ActiveChild,
    token: string | undefined,
  ): void {
    const logDir = join(this.home, "runs", this.wsr.ws.name);
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, `dispatch-${pick.id}-${pick.mode}-${Date.now()}.log`);
    const out = createWriteStream(log);
    activeEntry.log = log;
    // an unhandled stream error (e.g. home removed mid-run) must not crash the daemon
    out.on("error", () => {});
    const base = this.baseUrl ?? "http://127.0.0.1:4747";
    const name = agentName(cmdSpec.command);
    const prompt = promptFor(pick.mode, pick.id, name, base, token);
    const script = buildSpawnScript(cmdSpec.command, cmdSpec.source);
    const { ACP_BACKEND: _acp, AI_AGENT: _ai, ...cleanEnv } = process.env;

    let child: ChildProcess;
    try {
      child = spawn("bash", ["-c", script], {
        cwd: this.wsr.ws.root,
        env: {
          ...cleanEnv,
          TE_ROLE: role,
          TE_ITEM: pick.id,
          TE_MODE: pick.mode,
          TE_PROMPT: prompt,
          ...(token ? { TE_SESSION: token } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      out.close();
      this.children.delete(pick.id);
      if (this.pendingClaim === pick.id) this.pendingClaim = undefined;
      if (token && this.baseUrl) void this.closeRemoteSession(this.baseUrl, token);
      this.recordFailure(role, pick.id, `spawn failed: ${(e as Error).message}`);
      return;
    }

    activeEntry.child = child;
    activeEntry.pid = child.pid ?? 0;
    // TE-0218: the minted session carries no pid from hello — attach the
    // child's so the pid probe (not the 2h idle limit) keeps a quiet agent
    // live while its process runs
    if (activeEntry.sessionId && child.pid) {
      this.sessions.attachPid(activeEntry.sessionId, child.pid);
    }
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
    this.emit("dispatch_start", {
      id: pick.id,
      mode: pick.mode,
      role,
      command: cmdSpec.command,
      pid: child.pid ?? 0,
      log,
      // TE-0208: the admission checks this pick qualified on
      reasons: pick.reasons ?? [],
    });

    const finalizeExit = (errOrCode: Error | number | null) => {
      if (!this.children.has(pick.id)) return;
      this.children.delete(pick.id);
      if (this.pendingClaim === pick.id) this.pendingClaim = undefined;
      const cleanup =
        token && this.baseUrl ? this.closeRemoteSession(this.baseUrl, token) : Promise.resolve();
      void cleanup.finally(() => {
        try {
          if (errOrCode instanceof Error) {
            this.recordFailure(role, pick.id, errOrCode.message);
            this.recordItemFailure(pick.id, errOrCode.message);
            return;
          }
          if (errOrCode === 0) {
            this.failures.set(role, 0);
            const current = new WorkspaceOps(
              this.wsr,
              this.sessions,
              this.wsr.links,
              this.home,
            ).index.get(pick.id);
            if (
              pick.mode !== "review" &&
              current &&
              current.meta.version === startVersion &&
              (current.meta.status === "ready" || current.meta.status === "in_progress")
            ) {
              this.triedVersions.set(pick.id, startVersion);
              // TE-0208: a clean exit with no progress counts as a failed run
              this.recordItemFailure(pick.id, "finished with no status change");
            } else {
              this.itemFailures.delete(pick.id);
            }
          } else {
            this.recordFailure(role, pick.id, `exit ${errOrCode}`);
            this.recordItemFailure(pick.id, `exit ${errOrCode}`);
          }
        } finally {
          this.persist();
        }
      });
    };

    child.on("error", (err) => finalizeExit(err));
    child.on("exit", (code) => finalizeExit(code));
  }

  private recordFailure(role: string, itemId: string, why: string): void {
    const count = (this.failures.get(role) ?? 0) + 1;
    this.failures.set(role, count);
    this.emit("dispatch_fail", { id: itemId, role, failures: count, error: why });
    if (count >= 3) {
      this.enabled = false;
      this.emit("dispatch_off", { reason: `${role} command failed ${count} times in a row` });
    }
    this.persist();
  }

  /**
   * TE-0208 per-item breaker: two failed runs on one item (nonzero exit or a
   * clean exit with no progress) write dispatch_blocked on the item — admit
   * refuses it until a human unblocks. The Log line names the last reason.
   */
  private recordItemFailure(itemId: string, why: string): void {
    const count = (this.itemFailures.get(itemId) ?? 0) + 1;
    this.itemFailures.set(itemId, count);
    if (count < 2) return;
    this.itemFailures.delete(itemId);
    const ops = new WorkspaceOps(this.wsr, this.sessions, this.wsr.links, this.home);
    const it = ops.index.get(itemId);
    if (!it || it.meta.dispatch_blocked) return;
    void ops.store
      .perform(it.meta.id, it.meta.version, this.daemonActor(), {
        type: "dispatch_block",
        reason: `two failed dispatch runs — last: ${why}`,
      })
      .catch(() => {});
  }

  private daemonActor() {
    return { kind: "daemon" as const, session: "daemon", machine: this.wsr.store.machine };
  }
}
