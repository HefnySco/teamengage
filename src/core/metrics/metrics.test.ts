import { describe, it, expect } from "vitest";
import { deriveMetrics, rollUp, median, agentName, agentKind, deriveReviewers } from "./metrics.js";
import type { Event } from "../model/event.js";

const ev = (
  ts: string,
  action: string,
  item: string,
  actor = "devin@dt#aa",
  extra: Partial<Event> = {},
): Event => ({ ts, machine: "dt", actor, item, action, ...extra }) as Event;

describe("deriveMetrics", () => {
  it("counts claims, submits, bounces, handoffs and done", () => {
    const events = [
      ev("2026-11-01T00:00:00Z", "claim", "GL-1"),
      ev("2026-11-01T01:00:00Z", "submit", "GL-1"),
      ev("2026-11-01T02:00:00Z", "bounce", "GL-1", "reviewer@dt#bb"),
      ev("2026-11-01T03:00:00Z", "submit", "GL-1"),
      ev("2026-11-01T05:00:00Z", "accept", "GL-1", "human", { to: "done" }),
      ev("2026-11-01T06:00:00Z", "handoff", "GL-2"),
    ];
    const per = deriveMetrics(events);
    const m = per.get("GL-1")!;
    expect(m.claims).toBe(1);
    expect(m.review_rounds).toBe(2); // an item with two submits = two review rounds
    expect(m.bounces).toBe(1);
    expect(m.done).toBe(1);
    expect(m.worker).toBe("devin");
    expect(m.claim_to_submit_ms).toHaveLength(2);
    expect(m.claim_to_submit_ms[0]).toBe(3_600_000);
    expect(m.submit_to_accept_ms[0]).toBe(2 * 3_600_000);
    expect(per.get("GL-2")!.handoffs).toBe(1);
  });

  it("measures claim→submit per round from the last claim", () => {
    const events = [
      ev("2026-11-01T00:00:00Z", "claim", "GL-1"),
      ev("2026-11-01T01:00:00Z", "release", "GL-1"),
      ev("2026-11-02T00:00:00Z", "claim", "GL-1"),
      ev("2026-11-02T02:00:00Z", "submit", "GL-1"),
      ev("2026-11-02T06:00:00Z", "accept", "GL-1", "human", { to: "done" }),
    ];
    const m = deriveMetrics(events).get("GL-1")!;
    expect(m.claim_to_submit_ms).toEqual([2 * 3_600_000]); // second claim → submit
    expect(m.claim_to_accept_ms).toEqual([6 * 3_600_000]);
  });

  it("ignores human/daemon actors for the worker credit", () => {
    const events = [
      ev("2026-11-01T00:00:00Z", "submit", "GL-1", "daemon"),
      ev("2026-11-01T01:00:00Z", "accept", "GL-1", "daemon", { to: "done" }),
    ];
    const m = deriveMetrics(events).get("GL-1")!;
    expect(m.worker).toBeUndefined();
    expect(m.done).toBe(1);
  });
});

describe("rollUp / median / agentName", () => {
  it("aggregates counts, medians and bounce rate", () => {
    const per = deriveMetrics([
      ev("2026-11-01T00:00:00Z", "submit", "A"),
      ev("2026-11-01T01:00:00Z", "submit", "A"),
      ev("2026-11-01T02:00:00Z", "bounce", "A", "rev@dt#x"),
      ev("2026-11-01T03:00:00Z", "submit", "B"),
      ev("2026-11-01T04:00:00Z", "accept", "B", "human", { to: "done" }),
    ]);
    const r = rollUp([...per.values()]);
    expect(r.items).toBe(2);
    expect(r.review_rounds).toBe(3);
    expect(r.bounces).toBe(1);
    expect(r.bounce_rate).toBeCloseTo(1 / 3);
    expect(r.done).toBe(1);
  });

  it("sums reported cost over an item's submits", () => {
    const per = deriveMetrics([
      ev("2026-11-01T00:00:00Z", "submit", "A", "devin@dt#aa", {
        data: { cost: { model: "x", tokens_in: 100, tokens_out: 10, usd: 0.01 } },
      }),
      ev("2026-11-01T01:00:00Z", "submit", "A", "devin@dt#aa", {
        data: { cost: { tokens_in: 50, usd: 0.005 } },
      }),
      ev("2026-11-01T02:00:00Z", "submit", "B"), // no cost — contributes zeros
    ]);
    const a = per.get("A")!;
    expect(a.tokens_in).toBe(150);
    expect(a.tokens_out).toBe(10);
    expect(a.usd).toBeCloseTo(0.015);
    const r = rollUp([...per.values()]);
    expect(r.tokens_in).toBe(150);
    expect(r.tokens_out).toBe(10);
    expect(r.usd).toBeCloseTo(0.015);
  });

  it("median of even and odd lists", () => {
    expect(median([1, 3, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });

  it("agentName strips machine and session, skips human/daemon", () => {
    expect(agentName("devin-desktop@mhefnyDT#1419")).toBe("devin-desktop");
    expect(agentName("claude")).toBe("claude");
    expect(agentName("human")).toBeUndefined();
    expect(agentName("daemon")).toBeUndefined();
  });
});

describe("agentKind (GL-0364)", () => {
  it("per-task names roll up to the kind prefix", () => {
    expect(agentKind("devin-sl0005")).toBe("devin");
    expect(agentKind("devin-fix-de0040")).toBe("devin");
    expect(agentKind("devin_sub-sl0015")).toBe("devin");
  });

  it("compares in lowercase — Forge and forge are one", () => {
    expect(agentKind("Forge")).toBe("forge");
    expect(agentKind("forge")).toBe("forge");
  });

  it("agent_kinds patterns win over the prefix fallback, first match wins", () => {
    const kinds = { devin: ["devin*"], forge: ["forge*", "devin-forge-*"] };
    // first match wins: devin* matches before forge's devin-forge-*
    expect(agentKind("devin-forge-mv0018", kinds)).toBe("devin");
    expect(agentKind("Forge-mv0018", kinds)).toBe("forge");
    // forge first → devin-forge-* counts as forge, not devin
    const forgeFirst = { forge: ["forge*", "devin-forge-*"], devin: ["devin*"] };
    expect(agentKind("devin-forge-mv0018", forgeFirst)).toBe("forge");
    expect(agentKind("devin-sl0005", forgeFirst)).toBe("devin");
  });

  it("a name with no separator keeps itself", () => {
    expect(agentKind("devin")).toBe("devin");
  });
});

describe("model scorecard + reviewer table (GL-0365)", () => {
  it("buckets items by submit model; a submit with no model lands in unknown", () => {
    const events = [
      ev("2026-11-01T00:00:00Z", "claim", "GL-1"),
      ev("2026-11-01T01:00:00Z", "submit", "GL-1", "devin@dt#aa", { data: { model: "opus" } }),
      ev("2026-11-01T00:00:00Z", "claim", "GL-2"),
      ev("2026-11-01T01:00:00Z", "submit", "GL-2"),
    ];
    const per = deriveMetrics(events);
    expect([...per.get("GL-1")!.models]).toEqual(["opus"]);
    expect([...per.get("GL-2")!.models]).toEqual(["unknown"]);
  });

  it("an ok review the human rejects counts as one wrong ok for that model", () => {
    const events = [
      ev("2026-11-01T00:00:00Z", "submit", "GL-1"),
      ev("2026-11-01T01:00:00Z", "review", "GL-1", "rev@dt#bb", { note: "ok", data: { model: "sonnet" } }),
      ev("2026-11-01T02:00:00Z", "reject", "GL-1", "human"),
      ev("2026-11-01T03:00:00Z", "submit", "GL-1"),
      ev("2026-11-01T04:00:00Z", "review", "GL-1", "rev@dt#bb", { note: "issues: broken", data: { model: "sonnet" } }),
      // a review without a model lands in unknown
      ev("2026-11-01T00:00:00Z", "submit", "GL-2"),
      ev("2026-11-01T01:00:00Z", "review", "GL-2", "rev@dt#cc", { note: "ok" }),
      ev("2026-11-01T02:00:00Z", "accept", "GL-2", "human"),
    ];
    const rows = deriveReviewers(events);
    const sonnet = rows.find((r) => r.model === "sonnet")!;
    expect(sonnet).toMatchObject({ ok: 1, issues: 1, wrong_ok: 1 });
    const unknown = rows.find((r) => r.model === "unknown")!;
    expect(unknown).toMatchObject({ ok: 1, issues: 0, wrong_ok: 0 });
  });
});
