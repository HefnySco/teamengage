import { describe, it, expect } from "vitest";
import { pickNext, agentName, promptFor, inboxEntries, parseDispatchFilter, runCmd, type RunState, type RunItem } from "./run.js";
import { RunConfig } from "../../core/model/workspace.js";
import type { AdmissionContext } from "../../core/dispatch/selector.js";

const cfg = (over: Partial<RunConfig> = {}) => RunConfig.parse({ coder: "devin -p --", reviewer: "claude -p", ...over });
const st = (over: Partial<RunState> = {}): RunState => ({
  running: new Map(),
  fixes: new Map(),
  tried: new Set(),
  started: 0,
  ...over,
});
const here = { holder: "devin", machine: "work" };
const item = (id: string, status: string, over: Partial<RunItem> = {}): RunItem => ({ id, status, title: id, ...over });

describe("pickNext", () => {
  it("reviews a fresh submission before starting new work", () => {
    const items = [item("A-1", "in_review", { claim: here }), item("A-2", "ready")];
    expect(pickNext(cfg(), st(), items, ["A-2"], "work")).toEqual({ id: "A-1", mode: "review" });
  });

  it("leaves review to the human when no reviewer is configured", () => {
    const items = [item("A-1", "in_review", { claim: here })];
    expect(pickNext(cfg({ reviewer: undefined }), st(), items, [], "work")).toBeUndefined();
  });

  it("never reviews work whose branch is on another machine", () => {
    const items = [item("A-1", "in_review", { claim: { holder: "x", machine: "home" } })];
    expect(pickNext(cfg(), st(), items, [], "work")).toBeUndefined();
  });

  it("sends an issues review back for a fix, up to fix_rounds", () => {
    const items = [item("A-1", "in_review", { claim: here, ai_review: { verdict: "issues" } })];
    expect(pickNext(cfg(), st(), items, [], "work")).toEqual({ id: "A-1", mode: "fix" });
    expect(pickNext(cfg(), st({ fixes: new Map([["A-1", 1]]) }), items, [], "work")).toBeUndefined();
  });

  it("an ok review is the human's (accept), not the run's", () => {
    const items = [item("A-1", "in_review", { claim: here, ai_review: { verdict: "ok" } })];
    expect(pickNext(cfg(), st(), items, [], "work")).toBeUndefined();
  });

  it("takes over an in_progress item whose holder session died", () => {
    const dead = { holder: "claude@work#aa11", machine: "work", dead: true };
    const items = [item("A-1", "in_progress", { claim: dead })];
    expect(pickNext(cfg(), st(), items, [], "work")).toEqual({ id: "A-1", mode: "takeover" });
    // a dead claim already rebound by hello (same agent name) stays a resume
    const same = { holder: "devin@work#bb22", machine: "work", dead: true };
    expect(pickNext(cfg(), st(), [item("A-2", "in_progress", { claim: same })], [], "work")).toEqual({ id: "A-2", mode: "resume" });
    // live holder, dead claim on another machine, tried — not picked
    expect(pickNext(cfg(), st(), [item("A-3", "in_progress", { claim: { ...dead, dead: false } })], [], "work")).toBeUndefined();
    expect(pickNext(cfg(), st(), [item("A-3b", "in_progress", { claim: { ...same, dead: false } })], [], "work")).toBeUndefined();
    expect(pickNext(cfg(), st(), [item("A-4", "in_progress", { claim: { ...dead, machine: "home" } })], [], "work")).toBeUndefined();
    expect(pickNext(cfg(), st({ tried: new Set(["A-1"]) }), items, [], "work")).toBeUndefined();
  });

  it("respects concurrency, running items, tried items, --max and a pending claim", () => {
    const ready = ["A-1", "A-2"];
    expect(pickNext(cfg(), st({ running: new Map([["A-1", "work"]]) }), [], ready, "work")).toBeUndefined();
    expect(pickNext(cfg({ concurrency: 2 }), st({ running: new Map([["A-1", "work"]]) }), [], ready, "work")).toEqual({ id: "A-2", mode: "work" });
    expect(pickNext(cfg(), st({ tried: new Set(["A-1"]) }), [], ready, "work")).toEqual({ id: "A-2", mode: "work" });
    expect(pickNext(cfg(), st({ started: 1 }), [], ready, "work", 1)).toBeUndefined();
    expect(pickNext(cfg({ concurrency: 3 }), st({ pendingClaim: "A-9" }), [], ready, "work")).toBeUndefined();
  });

  it("filters candidates by ID wildcard, plan subtree, and status suffix", () => {
    const plan = item("PL-1032", "ready", { type: "epic" });
    const planTask = item("MP-0005", "ready", { type: "task", parent: "PL-1032" });
    const seReview = item("SE-0102", "in_review", { claim: here });
    const seFix = item("SE-0103", "in_review", { claim: here, ai_review: { verdict: "issues" } });
    const otherReview = item("GL-0099", "in_review", { claim: here });
    const all = [plan, planTask, otherReview, seReview, seFix];
    const ready = ["GL-0001", "MP-0005"];

    const reviewFilter = parseDispatchFilter("SE-01xx:inreview");
    expect(pickNext(cfg(), st(), all, ready, "work", Infinity, undefined, reviewFilter)).toEqual({
      id: "SE-0102",
      mode: "review",
    });
    expect(
      pickNext(
        cfg({ concurrency: 2 }),
        st({ running: new Map([["SE-0102", "review"]]) }),
        [plan, planTask, otherReview, seFix],
        ready,
        "work",
        Infinity,
        undefined,
        reviewFilter,
      ),
    ).toEqual({
      id: "SE-0103",
      mode: "fix",
    });

    const planFilter = parseDispatchFilter("Plan PL-1032:ready");
    expect(pickNext(cfg(), st(), all, ready, "work", Infinity, undefined, planFilter)).toEqual({
      id: "MP-0005",
      mode: "work",
    });
  });

  it("applies admission gates: dispatch_blocked, max_attempts, takeover grace, minted resume, reviewer model", () => {
    const adm = (over: Partial<AdmissionContext> = {}): AdmissionContext => ({
      machine: "work",
      now: Date.now(),
      maxAttempts: 5,
      fixRounds: 1,
      fixes: new Map(),
      coderNames: ["devin"],
      mintedSessions: new Set(),
      isLive: () => false,
      takeoverGraceMs: 15 * 60_000,
      ...over,
    });
    // reviewerModels comes from the configured command, as run.ts builds it
    const modelOf = (cmd?: string) => cmd && /(?:^|\s)--?model(?:=|\s+)(\S+)/.exec(cmd)?.[1];
    const pick = (
      items: RunItem[],
      ready: string[],
      context = adm(),
      config = cfg(),
    ) =>
      pickNext(config, st(), items, ready, "work", Infinity, undefined, undefined, {
        ...context,
        reviewerModels: config.reviewer ? [modelOf(config.reviewer)] : [],
      });

    // a blocked item and an item at the attempt cap are skipped, not picked
    const gated = [
      item("A-1", "ready", { dispatch_blocked: { reason: "two failed runs", at: "2026-01-01T00:00:00Z" } }),
      item("A-2", "ready", { attempts: 5 }),
      item("A-3", "ready"),
    ];
    expect(pick(gated, ["A-1", "A-2", "A-3"])).toMatchObject({ id: "A-3", mode: "work" });
    // and every candidate is refused when all are gated
    expect(pick(gated.slice(0, 2), ["A-1", "A-2"])).toBeUndefined();

    // a just-dead claim waits out takeover_grace_after, an old one takes over
    const freshDead = {
      holder: "claude@work#aa11",
      machine: "work",
      dead: true,
      dead_since: new Date().toISOString(),
    };
    expect(pick([item("A-4", "in_progress", { claim: freshDead })], [])).toBeUndefined();
    const staleDead = { ...freshDead, dead_since: new Date(Date.now() - 60 * 60_000).toISOString() };
    expect(pick([item("A-4", "in_progress", { claim: staleDead })], [])).toMatchObject({
      id: "A-4",
      mode: "takeover",
    });

    // resume admits only holders this run minted; an unminted dead claim is takeover
    const mine = { holder: "devin@work#bb22", machine: "work", dead: true, dead_since: staleDead.dead_since };
    expect(pick([item("A-5", "in_progress", { claim: mine })], [])).toMatchObject({
      id: "A-5",
      mode: "takeover",
    });
    expect(
      pick([item("A-5", "in_progress", { claim: mine })], [], adm({ mintedSessions: new Set(["devin@work#bb22"]) })),
    ).toMatchObject({ id: "A-5", mode: "resume" });

    // a reviewer declaring the submitter's model is refused; another model passes
    const review = [item("A-6", "in_review", { claim: here, submitted_model: "swe-2-high" })];
    expect(pick(review, [], adm(), cfg({ reviewer: "claude -p --model swe-2-high" }))).toBeUndefined();
    expect(pick(review, [], adm(), cfg({ reviewer: "claude -p --model sonnet" }))).toMatchObject({
      id: "A-6",
      mode: "review",
    });
  });

  it("runCmd rejects invalid --filter syntax with exit code 2", async () => {
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tempHome = mkdtempSync(join(tmpdir(), "te-run-filter-"));
    try {
      mkdirSync(join(tempHome, ".teamengage"), { recursive: true });
      writeFileSync(
        join(tempHome, ".teamengage", "machine.yaml"),
        'name: test\nrun:\n  coder: "echo"\n',
      );
      const code = await runCmd(["--dry-run", "--filter", "SE-01*:done"], tempHome);
      expect(code).toBe(2);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  it("names the agent after its command", () => {
    expect(agentName("devin -p --model swe-2-high --")).toBe("devin");
    expect(agentName("/usr/local/bin/claude -p")).toBe("claude");
    expect(agentName("~/bin/swift.sh 1")).toBe("swift");
    // a configured name carrying @<machine> or #hex is cut, not merged (TE-0193)
    expect(agentName("devin@mhefnyDT")).toBe("devin");
    expect(agentName("devin@mhefnyDT#828f -p")).toBe("devin");
  });

  it("prompts carry the id, the protocol url and the one-line reply", () => {
    const p = promptFor("fix", "GL-7", "devin", "http://127.0.0.1:4747");
    expect(p).toContain("te-work");
    expect(p).toContain("takeover");
    expect(p).toContain("http://127.0.0.1:4747/agent");
    expect(promptFor("review", "GL-7", "claude", "http://x")).toContain('"GL-7 ok"');
  });

  it("inbox entries are keyed by kind and id", () => {
    const m = inboxEntries({
      drafts: ["A-3"],
      questions: [{ id: "A-1", question: { text: "which port?" } }],
      reviews: ["A-2"],
      claims: [],
      drop_flags: [],
    });
    expect([...m.keys()]).toEqual(["q:A-1", "r:A-2", "d:A-3"]);
    expect(m.get("q:A-1")).toBe("A-1 asks: which port?");
  });
});
