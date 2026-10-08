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
