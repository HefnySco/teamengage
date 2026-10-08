import { randomBytes } from "node:crypto";
import type { Session } from "../../core/model/session.js";
import type { Claim } from "../../core/model/claim.js";

/**
 * Session registry (DESIGN §3 Session, §6.2). `hello(agent)` mints
 * `<agent>@<machine>#<4hex>`. Every call updates the session's last_seen;
 * claim last_seen writes are throttled to at most one per claim per 5 min so
 * activity doesn't create a commit per call.
 */
export class SessionRegistry {
  private sessions = new Map<string, Session>();
  private lastClaimWrite = new Map<string, number>();

  constructor(
    private machine: string,
    private claimTouchIntervalMs = 5 * 60_000,
  ) {}

  /**
   * Register a session; returns the session record. `pid` is the local
   * client process (sent by the `te mcp` shim) — agents are local (DESIGN
   * §6.4), so its liveness tells us whether the session survived a crash.
   */
  hello(agent: string, pid?: number): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: `${agent}@${this.machine}#${randomBytes(2).toString("hex")}`,
      agent,
      machine: this.machine,
      connected_at: now,
      last_seen: now,
      ...(pid ? { pid } : {}),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * A session is live while it's registered AND its client process (when
   * known) still exists. `disconnect` marks a clean end of its MCP transport;
   * a crashed or killed IDE never says goodbye, so the pid probe catches it.
   * A daemon restart empties the registry, so claims held by anything not in
   * the map are dead and rebindable on `hello`.
   */
  isLive(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.pid !== undefined && !pidAlive(s.pid)) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  /** Mark a session dead — its transport closed (or it was replaced). */
  disconnect(id: string): void {
    this.sessions.delete(id);
  }

  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.last_seen = new Date().toISOString();
  }

  /**
   * Claims this agent previously held on this machine — resume after
   * reconnect/restart. Matches on the `<agent>@<machine>` prefix of holders.
   */
  resumeClaims(agent: string, claims: Iterable<Claim>): Claim[] {
    const prefix = `${agent}@${this.machine}#`;
    return [...claims].filter((c) => c.holder.startsWith(prefix) && !c.conflicted);
  }

  /**
   * Should a claim's last_seen be persisted now? Throttled: at most one write
   * per claim per claimTouchIntervalMs.
   */
  shouldTouchClaim(item: string, now = Date.now()): boolean {
    const last = this.lastClaimWrite.get(item) ?? 0;
    if (now - last >= this.claimTouchIntervalMs) {
      this.lastClaimWrite.set(item, now);
      return true;
    }
    return false;
  }

  /** For tests: time source for claimTouchIntervalMs. */
  markClaimTouched(item: string, ts: number): void {
    this.lastClaimWrite.set(item, ts);
  }
}

/** Does a local process exist? (signal 0 probes without sending anything) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else — still alive
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
