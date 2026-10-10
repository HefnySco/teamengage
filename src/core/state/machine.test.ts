import { describe, it, expect } from "vitest";
import { turnOf } from "../model/item.js";
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
    ["dropped →undrop→ draft", "dropped", human, { type: "undrop" }, "draft", {}],
    ["draft →complete→ done", "draft", human, { type: "complete" }, "done", {}],
    ["ready →hold→ hold", "ready", human, { type: "hold", reason: "after the release" }, "hold", {}],
    ["draft →hold→ hold", "draft", human, { type: "hold" }, "hold", {}],
    ["hold →unhold→ ready", "hold", human, { type: "unhold" }, "ready", {}],
    ["ready →to_draft→ draft", "ready", human, { type: "to_draft" }, "draft", {}],
    ["hold →to_draft→ draft", "hold", human, { type: "to_draft", reason: "rethink" }, "draft", {}],
    ["hold →complete→ done", "hold", human, { type: "complete" }, "done", {}],
    ["hold →drop→ dropped", "hold", human, { type: "drop" }, "dropped", {}],
    ["ready →complete→ done", "ready", human, { type: "complete", note: "did it by hand" }, "done", {}],
    ["in_progress →complete→ done", "in_progress", human, { type: "complete" }, "done", { claim: claimOf() }],
    ["waiting →complete→ done", "waiting", human, { type: "complete" }, "done", { claim: claimOf() }],
    ["in_review →complete→ done", "in_review", human, { type: "complete" }, "done", { claim: claimOf() }],
    ["dropped →complete→ done", "dropped", human, { type: "complete" }, "done", {}],
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
    ["done", human, { type: "undrop" }, {}], // only dropped items restore
    ["ready", human, { type: "undrop" }, {}],
    ["dropped", agent, { type: "undrop" }, {}], // human-only
    ["done", human, { type: "complete" }, {}], // already done
    ["ready", agent, { type: "hold" }, {}], // human-only
    ["hold", agent, { type: "unhold" }, {}], // human-only
    ["ready", agent, { type: "to_draft" }, {}], // human-only
    ["hold", agent, { type: "claim", claim: claimOf() }, { depsDone: true }], // agents can't take held items
    ["in_progress", human, { type: "hold" }, { claim: claimOf() }], // release first
    ["ready", human, { type: "unhold" }, {}],
    ["draft", human, { type: "to_draft" }, {}],
    ["in_review", human, { type: "to_draft" }, {}],
    ["in_progress", agent, { type: "complete" }, { claim: claimOf() }], // human-only
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

describe("complete (human marks done from any status)", () => {
  it("releases a claim but keeps branches, never merges, clears the question", () => {
    const meta = { ...item("waiting"), question: { text: "?", asked_by: agent.session, asked_at: NOW } };
    const r = transition(meta, { type: "complete", note: "shipped" }, human, ctx({ claim: claimOf() }));
    expect(r.meta.question).toBeUndefined();
    expect(r.effects).toEqual([{ type: "delete_claim" }, { type: "cleanup_work", keepBranches: true }]);
    expect(r.log[0]).toMatch(/marked done \(from waiting\): shipped$/);
  });

  it("no claim → no effects", () => {
    expect(transition(item("draft"), { type: "complete" }, human, ctx()).effects).toEqual([]);
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
      [{ type: "change_answer", decisionId: "D-1", decisionTitle: "t", previous: "p" }, "in_progress"],
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
  it("change_answer updates the decision in place, only while in progress", () => {
    const a = { type: "change_answer", decisionId: "D-0007", decisionTitle: "use Y", previous: "use X" } as const;
    const r = transition(item("in_progress"), a, human, ctx({ claim: claimOf() }));
    expect(r.meta.status).toBe("in_progress");
    expect(r.effects).toEqual([{ type: "update_decision", decisionId: "D-0007", title: "use Y" }]);
    expect(r.log[0]).toContain('changed answer D-0007: "use X" → "use Y"');
    for (const s of ["waiting", "in_review", "done", "ready"] as const) {
      expect(() => transition(item(s), a, human, ctx({ claim: claimOf() }))).toThrow(InvalidTransitionError);
    }
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

describe("hold", () => {
  it("is the human's turn, logs the reason", () => {
    const r = transition(item("ready"), { type: "hold", reason: "after the release" }, human, ctx());
    expect(turnOf(r.meta.status)).toBe("human");
    expect(r.log[0]).toMatch(/put on hold \(from ready\): after the release$/);
    expect(r.events[0]).toMatchObject({ action: "hold", from: "ready", to: "hold", note: "after the release" });
  });
});

describe("archive", () => {
  it("hides any unclaimed item without touching its status; unarchive restores", () => {
    for (const s of ["draft", "ready", "hold", "done", "dropped", "in_review"] as Status[]) {
      const r = transition(item(s), { type: "archive", reason: "old" }, human, ctx());
      expect(r.meta.status).toBe(s);
      expect(r.meta.archived).toBe(true);
      expect(r.meta.archived_at).toBe(NOW);
      const back = transition(r.meta, { type: "unarchive" }, human, ctx());
      expect(back.meta.status).toBe(s);
      expect(back.meta.archived).toBeUndefined();
    }
  });

  it("refuses claimed items, agents, and double archive/unarchive", () => {
    expect(() => transition(item("in_progress"), { type: "archive" }, human, ctx({ claim: claimOf() }))).toThrow(/release first/);
    expect(() => transition(item("done"), { type: "archive" }, agent, ctx())).toThrow(/human-only/);
    const a = transition(item("done"), { type: "archive" }, human, ctx()).meta;
    expect(() => transition(a, { type: "archive" }, human, ctx())).toThrow(/already archived/);
    expect(() => transition(item("done"), { type: "unarchive" }, human, ctx())).toThrow(/not archived/);
    const archivedReady = transition(item("ready"), { type: "archive" }, human, ctx()).meta;
    expect(() =>
      transition(archivedReady, { type: "claim", claim: claimOf() }, agent, ctx({ depsDone: true })),
    ).toThrow(/archived/);
  });
});
