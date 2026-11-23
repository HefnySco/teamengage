import { describe, it, expect } from "vitest";
import { ValidationError } from "../model/errors.js";
import { RunConfig } from "../model/workspace.js";
import {
  listDispatchCandidates,
  matchesDispatchFilter,
  parseDispatchFilter,
  pickNext,
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
