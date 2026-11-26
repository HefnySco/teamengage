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

  it("negated '-target' clauses exclude ids, plans and domains from the positive match", () => {
    const rootPlan = makeItem("PL-1032", "ready", { type: "epic" });
    const planTask = makeItem("SE-0010", "ready", { parent: "PL-1032" });
    const webTask = makeItem("WC-0001", "ready", { domains: ["webclient"] });
    const plainTask = makeItem("GL-0050", "ready");
    const itemsById = makeMap([rootPlan, planTask, webTask, plainTask]);

    // a positive clause plus an exclusion — negation wins over the OR
    const filter = parseDispatchFilter("SE-xxxx, WC-xxxx, GL-xxxx, -SE-0010");
    expect(matchesDispatchFilter(filter, planTask, "work", itemsById)).toBe(false);
    expect(matchesDispatchFilter(filter, webTask, "work", itemsById)).toBe(true);
    expect(matchesDispatchFilter(filter, plainTask, "work", itemsById)).toBe(true);

    // exclusions compose with domain and plan targets on both sides
    const mixed = parseDispatchFilter("#webclient, -plan:PL-1032");
    expect(matchesDispatchFilter(mixed, webTask, "work", itemsById)).toBe(true);
    expect(matchesDispatchFilter(mixed, planTask, "work", itemsById)).toBe(false);
    expect(matchesDispatchFilter(mixed, plainTask, "work", itemsById)).toBe(false);

    const domainOut = parseDispatchFilter("SE-xxxx, WC-xxxx, -#webclient");
    expect(matchesDispatchFilter(domainOut, webTask, "work", itemsById)).toBe(false);
    expect(matchesDispatchFilter(domainOut, plainTask, "work", itemsById)).toBe(false);
  });

  it("an exclusion-only filter matches everything but the excluded", () => {
    const webTask = makeItem("WC-0001", "ready", { domains: ["webclient"] });
    const other = makeItem("GL-0050", "ready");
    const itemsById = makeMap([webTask, other]);

    for (const mode of ALL_MODES) {
      expect(matchesDispatchFilter(parseDispatchFilter("-WC-0001"), webTask, mode, itemsById)).toBe(
        false,
      );
      expect(matchesDispatchFilter(parseDispatchFilter("-WC-0001"), other, mode, itemsById)).toBe(
        true,
      );
    }

    // a status-scoped exclusion only bars that mode's candidates
    const scoped = parseDispatchFilter("-#webclient:ready");
    expect(matchesDispatchFilter(scoped, webTask, "work", itemsById)).toBe(false);
    expect(matchesDispatchFilter(scoped, webTask, "review", itemsById)).toBe(true);

    expect(matchesDispatchFilter(parseDispatchFilter("-*"), webTask, "work", itemsById)).toBe(false);
    expect(matchesDispatchFilter(parseDispatchFilter("-*"), other, "work", itemsById)).toBe(false);
  });

  it("two-word 'plan' / 'in' forms negate with a leading dash", () => {
    const rootPlan = makeItem("PL-1032", "ready", { type: "epic" });
    const planTask = makeItem("SE-0010", "ready", { parent: "PL-1032" });
    const other = makeItem("SE-0099", "ready");
    const itemsById = makeMap([rootPlan, planTask, other]);

    for (const expr of ["SE-xxxx, -plan PL-1032", "SE-xxxx, -in:PL-1032"]) {
      const filter = parseDispatchFilter(expr);
      expect(matchesDispatchFilter(filter, planTask, "work", itemsById)).toBe(false);
      expect(matchesDispatchFilter(filter, other, "work", itemsById)).toBe(true);
    }
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
      "-",
      "--SE-0100",
      "-#",
      "-:ready",
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
    coderNames: ["devin"],
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

  it("resume needs an ended holder session that this dispatcher minted", () => {
    const claimedBy = (holder: string, dead = true) =>
      makeItem("WS-0001", "in_progress", { claim: { holder, machine: "box", dead } });
    const endedCtx = makeAdmission({
      mintedSessions: new Set(["devin@box#aaaa"]),
      isLive: () => false,
    });
    // same name, never minted — the phantom-resume hole
    expect(admit(claimedBy("devin@box#zzzz"), "resume", endedCtx).ok).toBe(false);
    // minted and ended — ready for hello adoption
    expect(admit(claimedBy("devin@box#aaaa"), "resume", endedCtx).ok).toBe(true);
    // minted and still live — cannot resume while its session is active
    const liveCtx = makeAdmission({
      mintedSessions: new Set(["devin@box#aaaa"]),
      isLive: () => true,
    });
    expect(admit(claimedBy("devin@box#aaaa", false), "resume", liveCtx).ok).toBe(false);
  });

  it("a dead un-minted same-name claim is a takeover, not a stuck resume", () => {
    // the GL-0217 hole: a manual 'claude' session claimed, then died; the
    // holder name matches the coder so only resume applied — and resume can
    // never admit a session this dispatcher did not mint
    const now = Date.now();
    const ctx = makeAdmission({ now, isLive: () => false });
    const item = makeItem("GL-0217", "in_progress", {
      claim: {
        holder: "devin@box#zzzz",
        machine: "box",
        dead: true,
        last_seen: new Date(now - 20 * 60_000).toISOString(),
      },
    });
    const items = [item];
    const candidates = listDispatchCandidates(
      makeConfig(),
      makeState(),
      items,
      [],
      "box",
      "devin",
      undefined,
      ctx,
    );
    expect(candidates.map((c) => `${c.id}:${c.mode}`)).toEqual(["GL-0217:takeover"]);
    const pick = pickNext(
      makeConfig(),
      makeState(),
      items,
      [],
      "box",
      Infinity,
      "devin",
      undefined,
      ctx,
    );
    expect(pick).toEqual({ id: "GL-0217", mode: "takeover", reasons: expect.any(Array) });
  });

  it("minted dead claims resume immediately, un-minted dead claims wait out grace, and live claims are untouched", () => {
    const now = Date.now();
    const liveItem = makeItem("GL-0218", "in_progress", {
      claim: { holder: "devin@box#live", machine: "box", dead: false },
    });
    const mintedDead = makeItem("GL-0219", "in_progress", {
      claim: {
        holder: "devin@box#aaaa",
        machine: "box",
        dead: true,
        last_seen: new Date(now - 60_000).toISOString(),
      },
    });
    const unmintedFreshDead = makeItem("GL-0220", "in_progress", {
      claim: {
        holder: "devin@box#bbbb",
        machine: "box",
        dead: true,
        last_seen: new Date(now - 60_000).toISOString(),
      },
    });
    const ctx = makeAdmission({
      now,
      mintedSessions: new Set(["devin@box#aaaa"]),
      isLive: (id) => id === "devin@box#live",
    });
    const candidates = listDispatchCandidates(
      makeConfig(),
      makeState(),
      [liveItem, mintedDead, unmintedFreshDead],
      [],
      "box",
      "devin",
      undefined,
      ctx,
    );
    expect(candidates.map((c) => `${c.id}:${c.mode}`)).toEqual([
      "GL-0219:resume",
      "GL-0220:takeover",
    ]);
    expect(candidates[0].admission?.ok).toBe(true);
    expect(candidates[1].admission?.ok).toBe(false);
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

  it("review admits only a configured reviewer model that satisfies review_models (TE-0225)", () => {
    const ctx = makeAdmission({
      reviewModels: { deep: "deep-model", quick: "quick-model", deep_from_tier: "heavy" },
    });
    const lightItem = makeItem("WS-0001", "in_review", { claim: { holder: "a@box#1", machine: "box" }, tier: "standard" });
    const heavyItem = makeItem("WS-0002", "in_review", { claim: { holder: "a@box#1", machine: "box" }, tier: "heavy" });
    expect(admit(lightItem, "review", ctx).ok).toBe(false); // no reviewer configured
    expect(admit(lightItem, "review", { ...ctx, reviewerModels: ["quick-model"] }).ok).toBe(true);
    expect(admit(heavyItem, "review", { ...ctx, reviewerModels: ["quick-model"] }).ok).toBe(false);
    expect(admit(heavyItem, "review", { ...ctx, reviewerModels: ["quick-model", "deep-model"] }).ok).toBe(true);
    // a reviewer command without --model cannot serve while review_models is set
    expect(admit(lightItem, "review", { ...ctx, reviewerModels: [undefined] }).ok).toBe(false);
  });

  it("review refuses when no configured reviewer differs from submitted_model (TE-0225)", () => {
    const ctx = makeAdmission({ reviewerModels: ["swe-2-high"] });
    const item = makeItem("WS-0001", "in_review", {
      claim: { holder: "a@box#1", machine: "box" },
      submitted_model: "swe-2-high",
    });
    expect(admit(item, "review", ctx).ok).toBe(false);
    expect(admit(item, "review", { ...ctx, reviewerModels: ["swe-2-high", "sonnet"] }).ok).toBe(true);
    // an undeclared reviewer model counts as different — the review layer decides
    expect(admit(item, "review", { ...ctx, reviewerModels: ["swe-2-high", undefined] }).ok).toBe(true);
    // a submission with no declared model is reviewable by any configured reviewer
    const unmarked = makeItem("WS-0002", "in_review", {
      claim: { holder: "a@box#1", machine: "box" },
    });
    expect(admit(unmarked, "review", { ...ctx, reviewerModels: [undefined] }).ok).toBe(true);
  });

  it("resume matches a dead claim held by any configured coder name (TE-0225)", () => {
    // a second coder command minted 'claude' sessions — the default coderName
    // ('devin') alone would route its dead claim to takeover
    const ctx = makeAdmission({
      coderNames: ["devin", "claude"],
      mintedSessions: new Set(["claude@box#dead"]),
      isLive: () => false,
    });
    const item = makeItem("WS-0001", "in_progress", {
      claim: { holder: "claude@box#dead", machine: "box", dead: true },
    });
    const pick = pickNext(
      makeConfig(),
      makeState(),
      [item],
      [],
      "box",
      Infinity,
      "devin",
      undefined,
      ctx,
    );
    expect(pick?.mode).toBe("resume");
    // without the extra coder name the same claim is a takeover candidate
    expect(
      pickNext(makeConfig(), makeState(), [item], [], "box", Infinity, "devin", undefined, {
        ...ctx,
        coderNames: ["devin"],
      })?.mode,
    ).toBe("takeover");
  });
});

describe("dispatch_push — the per-item queue lever (TE-0236)", () => {
  const pushed = (id: string, overrides: Partial<RunItem> = {}): RunItem =>
    makeItem(id, "ready", {
      dispatch_push: { at: "2026-11-25T00:00:00Z" },
      ...overrides,
    });
  const ctx: AdmissionContext = {
    machine: "box",
    now: Date.now(),
    maxAttempts: 5,
    fixRounds: 3,
    fixes: new Map(),
    coderNames: ["devin"],
    mintedSessions: new Set(),
    isLive: () => true,
    takeoverGraceMs: 15 * 60_000,
  };

  it("a pushed ready item is a work candidate and the pick even when no clause matches it", () => {
    const filter = parseDispatchFilter("SE-01xx");
    const items = [pushed("ZZ-0001"), makeItem("SE-0100", "ready")];
    const candidates = listDispatchCandidates(
      makeConfig(),
      makeState(),
      items,
      ["ZZ-0001", "SE-0100"],
      "box",
      "devin",
      filter,
      ctx,
    );
    expect(candidates.map((entry) => `${entry.id}:${entry.mode}`)).toEqual([
      "ZZ-0001:work",
      "SE-0100:work",
    ]);
    const pick = pickNext(
      makeConfig(),
      makeState(),
      items,
      ["ZZ-0001", "SE-0100"],
      "box",
      Infinity,
      "devin",
      filter,
      ctx,
    );
    expect(pick).toEqual({ id: "ZZ-0001", mode: "work", reasons: expect.any(Array) });
    expect(pick?.reasons?.join(" ")).toContain("dispatch_push");
  });

  it("push wins over a negated clause that names the item — for work only", () => {
    const filter = parseDispatchFilter("SE-xxxx, -ZZ-0001");
    const item = pushed("ZZ-0001");
    const itemsById = makeMap([item]);
    expect(matchesDispatchFilter(filter, item, "work", itemsById)).toBe(true);
    // the flag lifts the work gate only — every other mode still honors it
    expect(matchesDispatchFilter(filter, item, "review", itemsById)).toBe(false);
    expect(matchesDispatchFilter(filter, item, "fix", itemsById)).toBe(false);
    expect(matchesDispatchFilter(filter, item, "resume", itemsById)).toBe(false);
  });

  it("push never bypasses the other gates: claimed, non-ready, maxed and blocked stay refused", () => {
    for (const [id, item] of [
      ["claimed", pushed("WS-0001", { claim: { holder: "a@box#1", machine: "box" } })],
      ["non-ready", pushed("WS-0002", { status: "in_progress" })],
      ["maxed", pushed("WS-0003", { attempts: 5 })],
      ["blocked", pushed("WS-0004", { dispatch_blocked: { reason: "two failed runs", at: "x" } })],
    ] as const) {
      const a = admit(item, "work", ctx);
      expect(a.ok, id).toBe(false);
      expect(a.reasons.length, id).toBeGreaterThan(0);
    }
    expect(admit(pushed("WS-0005"), "work", ctx).ok).toBe(true);
  });
});

describe("human-wait gate — drop_request and open questions (TE-0246)", () => {
  const makeAdmission = (overrides: Partial<AdmissionContext> = {}): AdmissionContext => ({
    machine: "box",
    now: Date.now(),
    maxAttempts: 5,
    fixRounds: 3,
    fixes: new Map(),
    coderNames: ["devin"],
    mintedSessions: new Set(["devin@box#aaaa"]),
    isLive: () => false,
    takeoverGraceMs: 15 * 60_000,
    ...overrides,
  });
  const flagged = (id: string, overrides: Partial<RunItem> = {}): RunItem =>
    makeItem(id, "ready", {
      drop_request: { by: "devin@box#aaaa", reason: "stale — superseded", at: "2026-11-26T00:00:00Z" },
      ...overrides,
    });
  const asked = (id: string, overrides: Partial<RunItem> = {}): RunItem =>
    makeItem(id, "ready", {
      question: { text: "reset dedup on restart too?" },
      ...overrides,
    });

  it("refuses a work pick on a ready item flagged for drop — the reason names the drop request", () => {
    const ctx = makeAdmission();
    const a = admit(flagged("WS-0001"), "work", ctx);
    expect(a.ok).toBe(false);
    expect(a.reasons.join(" ")).toContain("drop_request");
    expect(a.reasons.join(" ")).toContain("stale — superseded");
    // the human unflags → the same item admits again
    expect(admit(makeItem("WS-0001", "ready"), "work", ctx).ok).toBe(true);
  });

  it("refuses a work pick on a ready item with an open question — the reason names the question", () => {
    const ctx = makeAdmission();
    const a = admit(asked("WS-0002"), "work", ctx);
    expect(a.ok).toBe(false);
    expect(a.reasons.join(" ")).toContain("open question");
    expect(a.reasons.join(" ")).toContain("reset dedup on restart too?");
    // the human answers → the question clears and the item admits again
    expect(admit(makeItem("WS-0002", "ready"), "work", ctx).ok).toBe(true);
  });

  it("refuses fix picks the same way — the human must act before another round", () => {
    const ctx = makeAdmission();
    const issuesNote = {
      claim: { holder: "devin@box#aaaa", machine: "box" },
      ai_review: { verdict: "issues" as const, note: "x.ts:1" },
    };
    expect(admit(flagged("WS-0001", { status: "in_review", ...issuesNote }), "fix", ctx).ok).toBe(
      false,
    );
    expect(admit(asked("WS-0002", { status: "in_review", ...issuesNote }), "fix", ctx).ok).toBe(
      false,
    );
    expect(admit(makeItem("WS-0003", "in_review", issuesNote), "fix", ctx).ok).toBe(true);
  });

  it("resume and takeover still admit flagged or asked items — in-flight work finishes", () => {
    const ctx = makeAdmission();
    const dead = {
      claim: { holder: "devin@box#aaaa", machine: "box", dead: true, last_seen: new Date(Date.now() - 20 * 60_000).toISOString() },
    };
    expect(admit(flagged("WS-0001", { status: "in_progress", ...dead }), "resume", ctx).ok).toBe(
      true,
    );
    expect(admit(asked("WS-0002", { status: "in_progress", ...dead }), "resume", ctx).ok).toBe(
      true,
    );
    const unminted = {
      claim: { holder: "other@box#zzzz", machine: "box", dead: true, last_seen: new Date(Date.now() - 20 * 60_000).toISOString() },
    };
    expect(admit(flagged("WS-0003", { status: "in_progress", ...unminted }), "takeover", ctx).ok).toBe(
      true,
    );
    expect(admit(asked("WS-0004", { status: "in_progress", ...unminted }), "takeover", ctx).ok).toBe(
      true,
    );
  });

  it("pickNext skips a flagged or asked ready item and takes the next clean one", () => {
    const ctx = makeAdmission();
    const items = [flagged("WS-0001"), asked("WS-0002"), makeItem("WS-0003", "ready")];
    const pick = pickNext(
      makeConfig(),
      makeState(),
      items,
      ["WS-0001", "WS-0002", "WS-0003"],
      "box",
      Infinity,
      "devin",
      undefined,
      ctx,
    );
    expect(pick).toEqual({ id: "WS-0003", mode: "work", reasons: expect.any(Array) });
    // the refused items still surface as candidates with their refusal reason
    const candidates = listDispatchCandidates(
      makeConfig(),
      makeState(),
      items,
      ["WS-0001", "WS-0002", "WS-0003"],
      "box",
      "devin",
      undefined,
      ctx,
    );
    expect(candidates.find((c) => c.id === "WS-0001")?.admission?.ok).toBe(false);
    expect(candidates.find((c) => c.id === "WS-0002")?.admission?.ok).toBe(false);
  });
});

describe("exclude_domains — the per-machine admission gate (TE-0248)", () => {
  const makeAdmission = (overrides: Partial<AdmissionContext> = {}): AdmissionContext => ({
    machine: "box",
    now: Date.now(),
    maxAttempts: 5,
    fixRounds: 3,
    fixes: new Map(),
    coderNames: ["devin"],
    mintedSessions: new Set(["devin@box#aaaa"]),
    isLive: () => false,
    takeoverGraceMs: 15 * 60_000,
    excludeDomains: ["android"],
    ...overrides,
  });

  it("refuses a work pick on an #android item even when the filter matches it, and names the domain", () => {
    const ctx = makeAdmission();
    const item = makeItem("WS-0001", "ready", { domains: ["android"] });
    const a = admit(item, "work", ctx);
    expect(a.ok).toBe(false);
    expect(a.reasons.join(" ")).toContain("android");
    // a filter clause that positively matches changes nothing — the gate wins
    const filter = parseDispatchFilter("WS-xxxx");
    const items = [item, makeItem("WS-0002", "ready")];
    const pick = pickNext(
      makeConfig(),
      makeState(),
      items,
      ["WS-0001", "WS-0002"],
      "box",
      Infinity,
      "devin",
      filter,
      ctx,
    );
    expect(pick).toEqual({ id: "WS-0002", mode: "work", reasons: expect.any(Array) });
    const refused = listDispatchCandidates(
      makeConfig(),
      makeState(),
      items,
      ["WS-0001", "WS-0002"],
      "box",
      "devin",
      filter,
      ctx,
    ).find((c) => c.id === "WS-0001");
    expect(refused?.admission?.ok).toBe(false);
    expect(refused?.admission?.reasons.join(" ")).toContain("android");
  });

  it("an item with no excluded domain admits as before", () => {
    const ctx = makeAdmission();
    expect(admit(makeItem("WS-0001", "ready", { domains: ["mavlink"] }), "work", ctx).ok).toBe(
      true,
    );
    expect(admit(makeItem("WS-0002", "ready"), "work", ctx).ok).toBe(true);
  });

  it("an unset or empty exclude_domains gates nothing — case-insensitive either way", () => {
    const item = makeItem("WS-0001", "ready", { domains: ["Android"] });
    expect(admit(item, "work", makeAdmission({ excludeDomains: undefined })).ok).toBe(true);
    expect(admit(item, "work", makeAdmission({ excludeDomains: [] })).ok).toBe(true);
    // configured 'ANDROID' still matches the item's 'Android' — both normalize
    const a = admit(item, "work", makeAdmission({ excludeDomains: ["ANDROID"] }));
    expect(a.ok).toBe(false);
    expect(a.reasons.join(" ")).toContain("#android");
  });

  it("gates every mode — an excluded domain never runs on this machine", () => {
    const ctx = makeAdmission();
    const dead = {
      claim: { holder: "devin@box#aaaa", machine: "box", dead: true, last_seen: new Date(Date.now() - 20 * 60_000).toISOString() },
    };
    const tagged = (status: string) => makeItem("WS-0001", status, { domains: ["android"] });
    expect(admit(tagged("ready"), "work", ctx).ok).toBe(false);
    expect(
      admit(tagged("in_review"), "review", { ...ctx, reviewerModels: ["sonnet"] }).ok,
    ).toBe(false);
    expect(
      admit(
        makeItem("WS-0001", "in_review", {
          domains: ["android"],
          claim: { holder: "a@box#1", machine: "box" },
          ai_review: { verdict: "issues", note: "x" },
        }),
        "fix",
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      admit(makeItem("WS-0001", "in_progress", { domains: ["android"], ...dead }), "resume", ctx)
        .ok,
    ).toBe(false);
    const unminted = {
      claim: { holder: "other@box#zzzz", machine: "box", dead: true, last_seen: new Date(Date.now() - 20 * 60_000).toISOString() },
    };
    expect(
      admit(makeItem("WS-0001", "in_progress", { domains: ["android"], ...unminted }), "takeover", ctx)
        .ok,
    ).toBe(false);
  });

  it("a pushed item is still refused — push beats the filter, never the machine gate", () => {
    const ctx = makeAdmission();
    const item = makeItem("WS-0001", "ready", {
      domains: ["android"],
      dispatch_push: { at: "2026-11-26T00:00:00Z" },
    });
    expect(matchesDispatchFilter(parseDispatchFilter("SE-xxxx"), item, "work", makeMap([item]))).toBe(
      true,
    );
    const a = admit(item, "work", ctx);
    expect(a.ok).toBe(false);
    expect(a.reasons.join(" ")).toContain("android");
  });
});
