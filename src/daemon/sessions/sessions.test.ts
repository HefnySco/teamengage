import { describe, it, expect } from "vitest";
import { SessionRegistry } from "./sessions.js";
import type { Claim } from "../../core/model/claim.js";

const claim = (holder: string): Claim => ({
  item: "GL-0001",
  holder,
  actor: "agent",
  machine: "test",
  targets: [],
  claimed_at: "t",
  last_seen: "t",
});

describe("SessionRegistry", () => {
  it("mints unique stable session ids", () => {
    const r = new SessionRegistry("desktop");
    const a = r.hello("claude-code");
    const b = r.hello("gemini-cli");
    expect(a.id).toMatch(/^claude-code@desktop#[0-9a-f]{4}$/);
    expect(b.id).toMatch(/^gemini-cli@desktop#/);
    expect(a.id).not.toBe(b.id);
    expect(r.get(a.id)).toBe(a);
  });

  it("touch updates last_seen", () => {
    const r = new SessionRegistry("desktop");
    const s = r.hello("a");
    r.touch(s.id);
    expect(Date.parse(r.get(s.id)!.last_seen)).toBeGreaterThanOrEqual(Date.parse(s.last_seen));
  });

  it("hello normalizes a name that already carries @<machine> or #hex (TE-0193)", () => {
    const r = new SessionRegistry("mhefnyDT");
    expect(r.hello("devin-desktop@mhefnyDT").id).toMatch(/^devin-desktop@mhefnyDT#[0-9a-f]{4}$/);
    expect(r.hello("devin@mhefnyDT#828f").id).toMatch(/^devin@mhefnyDT#[0-9a-f]{4}$/);
    expect(r.hello("devin@mhefnyDT@mhefnyDT").id).toMatch(/^devin@mhefnyDT#[0-9a-f]{4}$/);
  });

  it("resume still finds claims whose ids repeat the machine part", () => {
    const r = new SessionRegistry("mhefnyDT");
    const claims = [
      claim("devin@mhefnyDT#828f"),
      claim("devin@mhefnyDT@mhefnyDT#1944"),
      claim("devin@laptop#9999"),
      claim("devin2@mhefnyDT#0000"),
    ];
    const back = r.resumeClaims("devin@mhefnyDT#828f", claims);
    expect(back.map((c) => c.holder).sort()).toEqual(["devin@mhefnyDT#828f", "devin@mhefnyDT@mhefnyDT#1944"]);
  });

  it("resume returns claims this agent held on this machine", () => {
    const r = new SessionRegistry("desktop");
    const claims = [
      claim("claude-code@desktop#a1f3"),
      claim("claude-code@laptop#9999"),
      claim("gemini-cli@desktop#77b0"),
      { ...claim("claude-code@desktop#beef"), conflicted: true },
    ];
    const back = r.resumeClaims("claude-code", claims);
    expect(back.map((c) => c.holder)).toEqual(["claude-code@desktop#a1f3"]);
  });

  it("claim last_seen writes are throttled", () => {
    const r = new SessionRegistry("desktop", 5 * 60_000);
    const t0 = 1_000_000;
    expect(r.shouldTouchClaim("GL-1", t0)).toBe(true);
    expect(r.shouldTouchClaim("GL-1", t0 + 60_000)).toBe(false); // 1 min later
    expect(r.shouldTouchClaim("GL-1", t0 + 5 * 60_000 + 1)).toBe(true); // >5 min
    expect(r.shouldTouchClaim("GL-2", t0 + 60_000)).toBe(true); // different claim
  });
});

describe("idle limit (TE-0165)", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("a session with no pid and an old last_seen is not live and leaves list()", () => {
    const r = new SessionRegistry("desktop");
    r.idleAfterMs = 60_000;
    const s = r.hello("curl-agent");
    s.last_seen = ago(61_000);
    expect(r.isLive(s.id)).toBe(false);
    expect(r.list().map((x) => x.id)).not.toContain(s.id);
    expect(r.get(s.id)).toBeUndefined();
  });

  it("a session with no pid that called inside the limit stays live", () => {
    const r = new SessionRegistry("desktop");
    r.idleAfterMs = 60_000;
    const s = r.hello("curl-agent");
    s.last_seen = ago(61_000);
    r.touch(s.id);
    expect(r.isLive(s.id)).toBe(true);
    expect(r.list().map((x) => x.id)).toContain(s.id);
  });

  it("a session with a live pid keeps the pid rule only", () => {
    const r = new SessionRegistry("desktop");
    r.idleAfterMs = 60_000;
    const s = r.hello("mcp-agent", { pid: process.pid });
    s.last_seen = ago(10 * 60_000);
    expect(r.isLive(s.id)).toBe(true);
  });
});

describe("attachPid — a minted session follows its child process (TE-0218)", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("a session with a live pid attached stays live past the idle limit without touch", () => {
    const r = new SessionRegistry("desktop");
    r.idleAfterMs = 60_000;
    const s = r.hello("dispatch-agent"); // minted without a pid, as openRemoteSession leaves it
    r.attachPid(s.id, process.pid);
    s.last_seen = ago(10 * 60_000);
    expect(r.isLive(s.id)).toBe(true);
    expect(r.list().map((x) => x.id)).toContain(s.id);
  });

  it("a session whose attached pid is dead leaves the registry on the next isLive", () => {
    const r = new SessionRegistry("desktop");
    const s = r.hello("dispatch-agent");
    r.attachPid(s.id, 2 ** 22); // at pid_max — cannot exist
    expect(r.isLive(s.id)).toBe(false);
    expect(r.get(s.id)).toBeUndefined();
  });

  it("attachPid on an unknown id is a no-op", () => {
    const r = new SessionRegistry("desktop");
    r.attachPid("ghost@desktop#0000", process.pid);
    expect(r.get("ghost@desktop#0000")).toBeUndefined();
  });
});

describe("dispatch-minted sessions and live claim capacity (TE-0206)", () => {
  it("marks a live session dispatch-minted; disconnect and the idle prune unmark it", () => {
    const r = new SessionRegistry("test");
    const s = r.hello("worker");
    r.markDispatchMinted(s.id);
    expect(r.isDispatchMinted(s.id)).toBe(true);
    r.markDispatchMinted("ghost@test#0000"); // unknown id — no-op
    expect(r.isDispatchMinted("ghost@test#0000")).toBe(false);
    r.disconnect(s.id);
    expect(r.isDispatchMinted(s.id)).toBe(false);
  });

  it("unmarks a session pruned by the idle limit", () => {
    const r = new SessionRegistry("test");
    r.idleAfterMs = 1_000;
    const s = r.hello("worker");
    r.markDispatchMinted(s.id);
    expect(r.isLive(s.id, Date.parse(s.last_seen) + 2_000)).toBe(false);
    expect(r.isDispatchMinted(s.id)).toBe(false);
  });

  it("claimIsLiveCapacity: live holder plus fresh last_seen counts; stale, remote and dead do not", () => {
    const r = new SessionRegistry("test");
    const live = r.hello("worker");
    const windowMs = 30 * 60_000;
    const fresh = { ...claim(live.id), last_seen: new Date().toISOString() };
    expect(r.claimIsLiveCapacity(fresh, "test", windowMs)).toBe(true);
    const stale = { ...fresh, last_seen: new Date(Date.now() - 60 * 60_000).toISOString() };
    expect(r.claimIsLiveCapacity(stale, "test", windowMs)).toBe(false);
    expect(r.claimIsLiveCapacity({ ...fresh, machine: "other-box" }, "test", windowMs)).toBe(false);
    expect(r.claimIsLiveCapacity({ ...fresh, holder: "gone@test#0000" }, "test", windowMs)).toBe(false);
  });
});
