import { describe, it, expect } from "vitest";
import { transition, type Actor, type TransitionCtx } from "./machine.js";
import { ItemMeta, type Status } from "../model/item.js";
import type { Claim } from "../model/claim.js";
import {
  ForbiddenError,
  InvalidTransitionError,
  ClaimRefusedError,
} from "../model/errors.js";

const NOW = "2026-10-08T12:00:00Z";
const agent: Actor = { kind: "agent", session: "claude-code@desktop#a1f3", machine: "desktop" };
const agent2: Actor = { kind: "agent", session: "gemini-cli@desktop#77b0", machine: "desktop" };
const human: Actor = { kind: "human", session: "human", machine: "desktop" };
const daemon: Actor = { kind: "daemon", session: "daemon", machine: "desktop" };

function item(status: Status): ItemMeta {
  return ItemMeta.parse({ id: "GL-0013", type: "task", title: "t", status });
}
function claimOf(holder = agent.session): Claim {
  return {
    item: "GL-0013",
    holder,
    actor: "agent",
    machine: "desktop",
    targets: [],
    claimed_at: NOW,
    last_seen: NOW,
  };
}
const ctx = (c: Partial<TransitionCtx> = {}): TransitionCtx => ({ now: NOW, ...c });

describe("every arrow in DESIGN §5", () => {
  const cases: Array<[string, Status, Actor, Parameters<typeof transition>[1], Status, Partial<TransitionCtx>]> = [
    ["draft →approve_plan→ ready", "draft", human, { type: "approve_plan" }, "ready", {}],
    ["ready →claim→ in_progress", "ready", agent, { type: "claim", claim: claimOf() }, "in_progress", { depsDone: true }],
    ["in_progress →submit→ in_review", "in_progress", agent, { type: "submit" }, "in_review", { claim: claimOf() }],
    ["in_review →accept→ done", "in_review", human, { type: "accept" }, "done", {}],
    ["in_review →reject→ in_progress", "in_review", human, { type: "reject", reason: "no" }, "in_progress", {}],
    ["in_progress →ask→ waiting", "in_progress", agent, { type: "ask", question: { text: "?", asked_by: agent.session, asked_at: NOW } }, "waiting", { claim: claimOf() }],
    ["waiting →answer→ in_progress", "waiting", human, { type: "answer", decisionId: "D-0001", decisionTitle: "t" }, "in_progress", { claim: claimOf() }],
    ["in_progress →release→ ready", "in_progress", agent, { type: "release" }, "ready", { claim: claimOf() }],
    ["ready →reject→ draft", "ready", human, { type: "reject" }, "draft", {}],
    ["in_progress →drop→ dropped", "in_progress", human, { type: "drop" }, "dropped", { claim: claimOf() }],
    ["in_review →merge_conflict→ in_progress", "in_review", daemon, { type: "merge_conflict", conflicts: ["a.ts"] }, "in_progress", {}],
  ];
  it.each(cases)("%s", (_name, from, actor, action, to, extra) => {
    const r = transition(item(from), action, actor, ctx(extra));
    expect(r.meta.status).toBe(to);
    expect(r.events.length).toBeGreaterThan(0);
  });
});

describe("every non-arrow is rejected", () => {
  const cases: Array<[Status, Actor, Parameters<typeof transition>[1], Partial<TransitionCtx>]> = [
    ["draft", agent, { type: "approve_plan" }, {}], // human-only
    ["draft", human, { type: "claim", claim: claimOf() }, {}], // not ready
    ["ready", agent, { type: "submit" }, { claim: claimOf() }],
    ["ready", agent, { type: "accept" }, {}],
    ["done", human, { type: "drop" }, {}], // terminal
    ["done", human, { type: "reject" }, {}],
    ["dropped", agent, { type: "claim", claim: claimOf() }, {}],
    ["waiting", agent, { type: "submit" }, { claim: claimOf() }],
    ["in_review", agent, { type: "accept" }, {}], // human-only
    ["in_progress", agent, { type: "approve_plan" }, { claim: claimOf() }],
    ["draft", human, { type: "submit" }, {}],
    ["ready", daemon, { type: "claim", claim: claimOf() }, { depsDone: true }],
  ];
  it.each(cases)("%s + %o → error", (from, actor, action, extra) => {
    expect(() => transition(item(from), action, actor, ctx(extra))).toThrow(
      /human-only|cannot|held by/i,
    );
  });
});

describe("actor rules", () => {
  it("agent attempting human-only action → Forbidden", () => {
    const attempts: Array<[Parameters<typeof transition>[1], Status]> = [
      [{ type: "approve_plan" }, "draft"],
      [{ type: "accept" }, "in_review"],
      [{ type: "reject" }, "in_review"],
      [{ type: "drop" }, "ready"],
      [{ type: "answer", decisionId: "D-1", decisionTitle: "t" }, "waiting"],
    ];
    for (const [a, status] of attempts) {
      expect(() => transition(item(status), a, agent, ctx({ claim: claimOf() }))).toThrow(
        ForbiddenError,
      );
    }
  });

  it("only the holder or the human may release", () => {
    const meta = item("in_progress");
    const c = claimOf();
    expect(() => transition(meta, { type: "release" }, agent2, ctx({ claim: c }))).toThrow(
      ForbiddenError,
    );
    expect(transition(meta, { type: "release" }, agent, ctx({ claim: c })).meta.status).toBe("ready");
    expect(transition(meta, { type: "release" }, human, ctx({ claim: c })).meta.status).toBe("ready");
  });

  it("claim refuses when already claimed", () => {
    expect(() =>
      transition(item("ready"), { type: "claim", claim: claimOf() }, agent, ctx({ claim: claimOf() })),
    ).toThrow(ClaimRefusedError);
  });

  it("claim requires deps done", () => {
    expect(() =>
      transition(item("ready"), { type: "claim", claim: claimOf() }, agent, ctx({ depsDone: false })),
    ).toThrow(InvalidTransitionError);
  });
});

describe("effects", () => {
  it("accept returns merge_required + cleanup, never does git itself", () => {
    const r = transition(item("in_review"), { type: "accept" }, human, ctx({}));
    expect(r.effects.map((e) => e.type)).toEqual(["merge_required", "delete_claim", "cleanup_work"]);
  });
  it("claim writes the claim file and sets up work", () => {
    const claim = claimOf();
    const r = transition(item("ready"), { type: "claim", claim }, agent, ctx({}));
    expect(r.effects[0]).toEqual({ type: "write_claim", claim });
    expect(r.effects[1].type).toBe("setup_work");
  });
  it("answer creates a decision effect and clears the question", () => {
    const meta = item("waiting");
    meta.question = { text: "?", asked_by: agent.session, asked_at: NOW };
    const r = transition(
      meta,
      { type: "answer", decisionId: "D-0007", decisionTitle: "use X" },
      human,
      ctx({ claim: claimOf() }),
    );
    expect(r.meta.question).toBeUndefined();
    expect(r.effects).toContainEqual({
      type: "create_decision",
      decisionId: "D-0007",
      title: "use X",
    });
  });
  it("ask records the question on the item", () => {
    const q = { text: "which db?", options: ["a", "b"], asked_by: agent.session, asked_at: NOW };
    const r = transition(item("in_progress"), { type: "ask", question: q }, agent, ctx({ claim: claimOf() }));
    expect(r.meta.question).toEqual(q);
    expect(r.meta.status).toBe("waiting");
  });
  it("human releasing someone else's claim logs the takeover", () => {
    const r = transition(item("in_progress"), { type: "release", note: "stale" }, human, ctx({ claim: claimOf() }));
    expect(r.log[0]).toContain("was claude-code@desktop#a1f3");
  });
});
