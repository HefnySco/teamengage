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

  /** Register a session; returns the session record. */
  hello(agent: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: `${agent}@${this.machine}#${randomBytes(2).toString("hex")}`,
      agent,
      machine: this.machine,
      connected_at: now,
      last_seen: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
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
