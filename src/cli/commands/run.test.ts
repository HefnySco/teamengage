import { describe, it, expect } from "vitest";
import { pickNext, agentName, promptFor, inboxEntries, type RunState, type RunItem } from "./run.js";
import { RunConfig } from "../../core/model/workspace.js";

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

  it("respects concurrency, running items, tried items, --max and a pending claim", () => {
    const ready = ["A-1", "A-2"];
    expect(pickNext(cfg(), st({ running: new Map([["A-1", "work"]]) }), [], ready, "work")).toBeUndefined();
    expect(pickNext(cfg({ concurrency: 2 }), st({ running: new Map([["A-1", "work"]]) }), [], ready, "work")).toEqual({ id: "A-2", mode: "work" });
    expect(pickNext(cfg(), st({ tried: new Set(["A-1"]) }), [], ready, "work")).toEqual({ id: "A-2", mode: "work" });
    expect(pickNext(cfg(), st({ started: 1 }), [], ready, "work", 1)).toBeUndefined();
    expect(pickNext(cfg({ concurrency: 3 }), st({ pendingClaim: "A-9" }), [], ready, "work")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("names the agent after its command", () => {
    expect(agentName("devin -p --model swe-2-high --")).toBe("devin");
    expect(agentName("/usr/local/bin/claude -p")).toBe("claude");
    expect(agentName("~/bin/swift.sh 1")).toBe("swift");
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
