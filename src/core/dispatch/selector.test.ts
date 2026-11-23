import { describe, it, expect } from "vitest";
import { ValidationError } from "../model/errors.js";
import { RunConfig } from "../model/workspace.js";
import {
  admit,
  listDispatchCandidates,
  matchesDispatchFilter,
  parseDispatchFilter,
  pickNext,
  type AdmissionContext,
  type Mode,
  type RunItem,
  type RunState,
} from "./selector.js";

const ALL_MODES: Mode[] = ["review", "fix", "resume", "takeover", "work"];

const makeItem = (id: string, status: string, overrides: Partial<RunItem> = {}): RunItem => ({
  id,
  status,
  title: id,
  type: "task",
  ...overrides,
});

const makeMap = (items: RunItem[]): Map<string, RunItem> =>
  new Map(items.map((entry) => [entry.id.toUpperCase(), entry]));

const makeConfig = (overrides: Partial<RunConfig> = {}) =>
  RunConfig.parse({ coder: "devin -p --", reviewer: "claude -p", ...overrides });

const makeState = (overrides: Partial<RunState> = {}): RunState => ({
  running: new Map(),
  fixes: new Map(),
  tried: new Set(),
  started: 0,
  ...overrides,
});

describe("parseDispatchFilter and matchesDispatchFilter", () => {
  it("matches every actionable item and mode when empty or '*'", () => {
    const sample = makeItem("SE-0105", "ready");
    const itemsById = makeMap([sample]);
    for (const expr of ["", "   ", "*"]) {
      const parsed = parseDispatchFilter(expr);
      for (const mode of ALL_MODES) {
        expect(matchesDispatchFilter(parsed, sample, mode, itemsById)).toBe(true);
      }
    }
  });

  it("matches *, ?, and digit placeholder x after '-'", () => {
    const filter = parseDispatchFilter("SE-01xx");
    const items = [
      makeItem("SE-0100", "ready"),
      makeItem("SE-0199", "ready"),
      makeItem("SE-0200", "ready"),
      makeItem("SE-01ab", "ready"),
      makeItem("XX-0142", "ready"),
    ];
    const itemsById = makeMap(items);
    expect(matchesDispatchFilter(filter, items[0], "work", itemsById)).toBe(true);
    expect(matchesDispatchFilter(filter, items[1], "work", itemsById)).toBe(true);
    expect(matchesDispatchFilter(filter, items[2], "work", itemsById)).toBe(false);
    expect(matchesDispatchFilter(filter, items[3], "work", itemsById)).toBe(false);

    const prefixWithX = parseDispatchFilter("XX-01x?");
    expect(matchesDispatchFilter(prefixWithX, items[4], "work", itemsById)).toBe(true);

    const starFilter = parseDispatchFilter("SE-01*");
    expect(matchesDispatchFilter(starFilter, items[0], "work", itemsById)).toBe(true);
    expect(matchesDispatchFilter(starFilter, items[2], "work", itemsById)).toBe(false);
  });

  it("matches descendant tasks under a plan across nested sub-epics and guards against cycles", () => {
    const rootPlan = makeItem("PL-1032", "ready", { type: "epic" });
    const subPlan = makeItem("PL-1033", "ready", { type: "epic", parent: "PL-1032" });
    const directChild = makeItem("SE-0010", "ready", { parent: "PL-1032" });
    const nestedChild = makeItem("SE-0011", "ready", { parent: "PL-1033" });
    const unrelated = makeItem("SE-0099", "ready");
    const cycleA = makeItem("CY-0001", "ready", { type: "epic", parent: "CY-0002" });
    const cycleB = makeItem("CY-0002", "ready", { type: "epic", parent: "CY-0001" });
    const cycleTask = makeItem("CY-0003", "ready", { parent: "CY-0001" });
    const itemsById = makeMap([
      rootPlan,
      subPlan,
      directChild,
      nestedChild,
      unrelated,
      cycleA,
      cycleB,
      cycleTask,
    ]);

    for (const expr of ["Plan PL-1032:ready", "plan:PL-1032:ready", "in:PL-1032:ready"]) {
      const filter = parseDispatchFilter(expr);
      expect(matchesDispatchFilter(filter, rootPlan, "work", itemsById)).toBe(false);
      expect(matchesDispatchFilter(filter, subPlan, "work", itemsById)).toBe(false);
      expect(matchesDispatchFilter(filter, directChild, "work", itemsById)).toBe(true);
      expect(matchesDispatchFilter(filter, nestedChild, "work", itemsById)).toBe(true);
      expect(matchesDispatchFilter(filter, unrelated, "work", itemsById)).toBe(false);
      expect(matchesDispatchFilter(filter, cycleTask, "work", itemsById)).toBe(false);
    }
  });

  it("converts lowercase and mixed-case input cleanly with no error", () => {
    const rootPlan = makeItem("PL-1032", "ready", { type: "epic" });
    const planTask = makeItem("MP-0007", "ready", { parent: "PL-1032" });
    const reviewTask = makeItem("SE-0108", "in_review");
    const domainTask = makeItem("WC-0012", "ready", { domains: ["web-client"] });
    const itemsById = makeMap([rootPlan, planTask, reviewTask, domainTask]);

    expect(
      matchesDispatchFilter(parseDispatchFilter("se-01xx:inreview"), reviewTask, "review", itemsById),
    ).toBe(true);
    expect(
      matchesDispatchFilter(parseDispatchFilter("plan pl-1032:READY"), planTask, "work", itemsById),
    ).toBe(true);
    expect(
      matchesDispatchFilter(parseDispatchFilter("#Web-Client:ready"), domainTask, "work", itemsById),
    ).toBe(true);
  });

  it("enforces mode mapping for :inreview, :ready, and :inprogress", () => {
    const item = makeItem("SE-0120", "in_review");
    const itemsById = makeMap([item]);

    for (const expr of ["SE-01xx:inreview", "SE-01xx:in_review"]) {
      const filter = parseDispatchFilter(expr);
      expect(matchesDispatchFilter(filter, item, "review", itemsById)).toBe(true);
      expect(matchesDispatchFilter(filter, item, "fix", itemsById)).toBe(true);
      expect(matchesDispatchFilter(filter, item, "work", itemsById)).toBe(false);
      expect(matchesDispatchFilter(filter, item, "resume", itemsById)).toBe(false);
      expect(matchesDispatchFilter(filter, item, "takeover", itemsById)).toBe(false);
    }

    const readyFilter = parseDispatchFilter("SE-01xx:ready");
    expect(matchesDispatchFilter(readyFilter, item, "work", itemsById)).toBe(true);
    expect(matchesDispatchFilter(readyFilter, item, "review", itemsById)).toBe(false);
    expect(matchesDispatchFilter(readyFilter, item, "fix", itemsById)).toBe(false);

    for (const expr of ["SE-01xx:inprogress", "SE-01xx:in_progress"]) {
      const progFilter = parseDispatchFilter(expr);
      expect(matchesDispatchFilter(progFilter, item, "resume", itemsById)).toBe(true);
      expect(matchesDispatchFilter(progFilter, item, "takeover", itemsById)).toBe(true);
      expect(matchesDispatchFilter(progFilter, item, "work", itemsById)).toBe(false);
      expect(matchesDispatchFilter(progFilter, item, "review", itemsById)).toBe(false);
    }
  });

  it("combines multiple clauses with OR", () => {
    const filter = parseDispatchFilter("SE-01xx:inreview, Plan PL-1032:ready");
    const plan = makeItem("PL-1032", "ready", { type: "epic" });
    const planChild = makeItem("GL-0050", "ready", { parent: "PL-1032" });
    const seReview = makeItem("SE-0144", "in_review", { claim: { holder: "devin", machine: "box" } });
    const otherReady = makeItem("AN-0001", "ready");
    const items = [plan, planChild, seReview, otherReady];

    const candidates = listDispatchCandidates(
      makeConfig(),
      makeState(),
      items,
      ["GL-0050", "AN-0001"],
      "box",
      "devin",
      filter,
    );
    expect(candidates.map((entry) => `${entry.id}:${entry.mode}`)).toEqual([
      "SE-0144:review",
      "GL-0050:work",
    ]);
    expect(
      pickNext(makeConfig(), makeState(), items, ["GL-0050", "AN-0001"], "box", Infinity, "devin", filter),
    ).toEqual({ id: "SE-0144", mode: "review" });
  });

  it("throws ValidationError on unknown status suffixes or empty targets", () => {
    for (const bad of [
      "SE-01*:done",
      "SE-01*:bad",
      "SE-01*:",
      ":ready",
      "plan:",
      "Plan",
      "#",
      "#:ready",
      "SE-01*:ready:extra",
    ]) {
      expect(() => parseDispatchFilter(bad)).toThrow(ValidationError);
    }
  });
});

describe("admit — admission checks before a pick (TE-0208)", () => {
  const makeAdmission = (overrides: Partial<AdmissionContext> = {}): AdmissionContext => ({
    machine: "box",
    now: Date.now(),
    maxAttempts: 5,
    fixRounds: 3,
    fixes: new Map(),
    coderName: "devin",
    mintedSessions: new Set(),
    isLive: () => true,
    takeoverGraceMs: 15 * 60_000,
    ...overrides,
  });

  it("pickNext skips an item whose attempts reached max_attempts", () => {
    const ctx = makeAdmission();
    const spent = makeItem("WS-0001", "ready", { attempts: 5 });
    const fresh = makeItem("WS-0002", "ready", { attempts: 4 });
    const pick = pickNext(
      makeConfig(),
      makeState(),
      [spent, fresh],
      ["WS-0001", "WS-0002"],
      "box",
      Infinity,
      "devin",
      undefined,
      ctx,
    );
    expect(pick?.id).toBe("WS-0002");
    expect(pick?.mode).toBe("work");
    expect(pick?.reasons?.length).toBeGreaterThan(0);
    expect(admit(spent, "work", ctx).ok).toBe(false);
    expect(admit(spent, "work", ctx).reasons.join(" ")).toContain("max_attempts");
  });

  it("dispatch_blocked is refused with its reason until the flag clears", () => {
    const ctx = makeAdmission();
    const blocked = makeItem("WS-0001", "ready", {
      dispatch_blocked: { reason: "two failed dispatch runs", at: "2026-11-24T00:00:00Z" },
    });
    const a = admit(blocked, "work", ctx);
    expect(a.ok).toBe(false);
    expect(a.reasons.join(" ")).toContain("two failed dispatch runs");
    const cleared = makeItem("WS-0001", "ready");
    expect(admit(cleared, "work", ctx).ok).toBe(true);
  });

  it("fix needs fix_rounds left and an issues note or findings", () => {
    const ctx = makeAdmission();
    const bare = makeItem("WS-0001", "in_review", {
      claim: { holder: "a@box#1", machine: "box" },
      ai_review: { verdict: "issues", summary: "broken" },
    });
    expect(admit(bare, "fix", ctx).ok).toBe(false);
    const noted = makeItem("WS-0001", "in_review", {
      claim: { holder: "a@box#1", machine: "box" },
      ai_review: { verdict: "issues", summary: "broken", note: "x.ts:1" },
    });
    expect(admit(noted, "fix", ctx).ok).toBe(true);
    const spent = makeItem("WS-0001", "in_review", {
      claim: { holder: "a@box#1", machine: "box" },
      ai_review: { verdict: "issues", note: "x" },
    });
    expect(admit(spent, "fix", makeAdmission({ fixes: new Map([["WS-0001", 3]]) })).ok).toBe(false);
  });

  it("resume needs a holder session this dispatcher minted and still live", () => {
    const claimedBy = (holder: string) =>
      makeItem("WS-0001", "in_progress", { claim: { holder, machine: "box" } });
    const ctx = makeAdmission({ mintedSessions: new Set(["devin@box#aaaa"]) });
    // same name, never minted — the phantom-resume hole
    expect(admit(claimedBy("devin@box#zzzz"), "resume", ctx).ok).toBe(false);
    // minted and live
    expect(admit(claimedBy("devin@box#aaaa"), "resume", ctx).ok).toBe(true);
    // minted but its process is gone
    const dead = makeAdmission({
      mintedSessions: new Set(["devin@box#aaaa"]),
      isLive: () => false,
    });
    expect(admit(claimedBy("devin@box#aaaa"), "resume", dead).ok).toBe(false);
  });

  it("takeover waits out takeover_grace_after on a fresh dead claim", () => {
    const now = Date.now();
    const ctx = makeAdmission({ now });
    const freshDead = makeItem("WS-0001", "in_progress", {
      claim: { holder: "other@box#1", machine: "box", dead: true, last_seen: new Date(now - 60_000).toISOString() },
    });
    expect(admit(freshDead, "takeover", ctx).ok).toBe(false);
    const oldDead = makeItem("WS-0001", "in_progress", {
      claim: { holder: "other@box#1", machine: "box", dead: true, last_seen: new Date(now - 20 * 60_000).toISOString() },
    });
    expect(admit(oldDead, "takeover", ctx).ok).toBe(true);
  });

  it("review admits only a reviewer command whose declared model satisfies review_models", () => {
    const ctx = makeAdmission({
      reviewModels: { deep: "deep-model", quick: "quick-model", deep_from_tier: "heavy" },
    });
    const lightItem = makeItem("WS-0001", "in_review", { claim: { holder: "a@box#1", machine: "box" }, tier: "standard" });
    const heavyItem = makeItem("WS-0002", "in_review", { claim: { holder: "a@box#1", machine: "box" }, tier: "heavy" });
    expect(admit(lightItem, "review", ctx).ok).toBe(false); // no declared model
    expect(admit(lightItem, "review", { ...ctx, reviewerModel: "quick-model" }).ok).toBe(true);
    expect(admit(heavyItem, "review", { ...ctx, reviewerModel: "quick-model" }).ok).toBe(false);
    expect(admit(heavyItem, "review", { ...ctx, reviewerModel: "deep-model" }).ok).toBe(true);
  });
});
