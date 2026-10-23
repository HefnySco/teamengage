import { describe, it, expect } from "vitest";
import { turnOf } from "../model/item.js";
import { transition, type Actor, type TransitionCtx, MAX_AI_BOUNCES } from "./machine.js";
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
    ["in_review →review→ in_review", "in_review", agent2, { type: "review", verdict: "ok" }, "in_review", { claim: claimOf() }],
    ["in_review →bounce→ in_progress", "in_review", agent2, { type: "bounce", reason: "tests fail" }, "in_progress", { claim: claimOf() }],
    ["in_review →accept→ done", "in_review", human, { type: "accept" }, "done", {}],
    ["in_review →reject→ in_progress", "in_review", human, { type: "reject", reason: "no" }, "in_progress", {}],
    ["in_review →reject --release→ ready", "in_review", human, { type: "reject", reason: "no", release: true }, "ready", { claim: claimOf() }],
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
    ["done →to_draft→ draft", "done", human, { type: "to_draft", reason: "marked by mistake" }, "draft", {}],
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
    ["in_progress", agent2, { type: "review", verdict: "ok" }, { claim: claimOf() }], // only a submission is reviewable
    ["in_review", agent, { type: "review", verdict: "ok" }, { claim: claimOf() }], // never your own submission
    ["in_review", human, { type: "review", verdict: "ok" }, {}], // agent-only
    ["in_review", daemon, { type: "bounce", reason: "x" }, {}], // agent-only
    ["in_progress", agent2, { type: "bounce", reason: "x" }, { claim: claimOf() }],
    ["in_review", agent, { type: "bounce", reason: "x" }, { claim: claimOf() }], // never your own submission
    ["in_review", agent2, { type: "bounce", reason: "x" }, { claim: claimOf(), priorBounces: 2 }], // cap
    ["in_review", agent, { type: "accept" }, {}], // human-only
    ["in_progress", agent, { type: "approve_plan" }, { claim: claimOf() }],
    ["draft", human, { type: "submit" }, {}],
    ["ready", daemon, { type: "claim", claim: claimOf() }, { depsDone: true }],
  ];
  it.each(cases)("%s + %o → error", (from, actor, action, extra) => {
    expect(() => transition(item(from), action, actor, ctx(extra))).toThrow(
      /human-only|agent-only|cannot|held by|own submission|AI bounces/i,
    );
  });
});

describe("ideas are sources, never work", () => {
  const idea = (status: Status) => ItemMeta.parse({ id: "GL-0044", type: "idea", title: "i", status });
  const ideaClaim = { ...claimOf(), item: "GL-0044" };

  it("claim is refused — plan from them instead", () => {
    expect(() =>
      transition(idea("ready"), { type: "claim", claim: ideaClaim }, agent, ctx({ depsDone: true })),
    ).toThrow(/ideas are sources/);
  });

  it("the normal lifecycle minus execution still applies", () => {
    expect(transition(idea("draft"), { type: "approve_plan" }, human, ctx()).meta.status).toBe("ready");
    expect(transition(idea("draft"), { type: "complete" }, human, ctx()).meta.status).toBe("done");
    expect(transition(idea("ready"), { type: "drop" }, human, ctx()).meta.status).toBe("dropped");
  });
});

describe("claim takeover of an AI-flagged submission", () => {
  const flagged = (): ItemMeta => ({
    ...item("in_review"),
    ai_review: { verdict: "issues", reviewed_by: agent2.session, reviewed_at: NOW, note: "x" },
  });
  const takeoverClaim = claimOf(agent2.session);
  const reviewCtx = (c: Partial<TransitionCtx> = {}) =>
    ctx({ claim: claimOf(), depsDone: true, ...c });

  it("another session on the same machine takes the claim over", () => {
    const r = transition(flagged(), { type: "claim", claim: takeoverClaim }, agent2, reviewCtx());
    expect(r.meta.status).toBe("in_progress");
    expect(r.effects).toEqual([
      { type: "write_claim", claim: takeoverClaim },
      { type: "setup_work" },
    ]);
    expect(r.log[0]).toMatch(/took over the fix \(was claude-code@desktop#a1f3\)$/);
  });

  it("the holder itself re-claims to fix the findings", () => {
    const r = transition(flagged(), { type: "claim", claim: claimOf() }, agent, reviewCtx());
    expect(r.meta.status).toBe("in_progress");
    expect(r.log[0]).toMatch(/took over the fix$/);
  });

  it("the AI review marker stays until resubmit", () => {
    const r = transition(flagged(), { type: "claim", claim: takeoverClaim }, agent2, reviewCtx());
    expect(r.meta.ai_review?.verdict).toBe("issues");
  });

  it("refused across machines — the worktree is local", () => {
    const remote: Actor = { kind: "agent", session: "claude-code@laptop#b2c4", machine: "laptop" };
    const remoteClaim = { ...takeoverClaim, holder: remote.session, machine: "laptop" };
    expect(() =>
      transition(flagged(), { type: "claim", claim: remoteClaim }, remote, reviewCtx()),
    ).toThrow(InvalidTransitionError);
  });

  it("an ok verdict is not takeable — nothing to fix", () => {
    const ok: ItemMeta = {
      ...flagged(),
      ai_review: { verdict: "ok", reviewed_by: agent2.session, reviewed_at: NOW },
    };
    expect(() =>
      transition(ok, { type: "claim", claim: takeoverClaim }, agent2, reviewCtx()),
    ).toThrow(InvalidTransitionError);
  });

  it("no AI review → in_review stays unclaimable", () => {
    expect(() =>
      transition(item("in_review"), { type: "claim", claim: takeoverClaim }, agent2, reviewCtx()),
    ).toThrow(InvalidTransitionError);
  });

  it("no claim → nothing to take over", () => {
    expect(() =>
      transition(flagged(), { type: "claim", claim: takeoverClaim }, agent2, ctx({ depsDone: true })),
    ).toThrow(InvalidTransitionError);
  });

  it("claim takeover is agent-only", () => {
    expect(() =>
      transition(flagged(), { type: "claim", claim: claimOf("human") }, human, reviewCtx()),
    ).toThrow(InvalidTransitionError);
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
      question: { text: "?", asked_by: agent.session, asked_at: NOW },
    });
  });
  it("change_answer updates the decision in place until the item is closed", () => {
    const a = { type: "change_answer", decisionId: "D-0007", decisionTitle: "use Y", previous: "use X" } as const;
    const r = transition(item("in_progress"), a, human, ctx({ claim: claimOf() }));
    expect(r.meta.status).toBe("in_progress");
    expect(r.effects).toEqual([{ type: "update_decision", decisionId: "D-0007", title: "use Y" }]);
    expect(r.log[0]).toContain('changed answer D-0007: "use X" → "use Y"');
    for (const s of ["ready", "waiting", "in_review", "hold"] as const) {
      expect(transition(item(s), a, human, ctx({ claim: claimOf() })).meta.status).toBe(s);
    }
    for (const s of ["done", "dropped"] as const) {
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

describe("review / bounce (AI peer review of a submission)", () => {
  it("review records the marker without touching status or turn; latest wins", () => {
    const r = transition(
      item("in_review"),
      { type: "review", verdict: "issues", note: "acceptance 2 fails locally" },
      agent2,
      ctx({ claim: claimOf() }),
    );
    expect(r.meta.status).toBe("in_review");
    expect(turnOf(r.meta.status)).toBe("human");
    expect(r.effects).toEqual([]); // advisory: nothing to merge or clean up
    expect(r.meta.ai_review).toEqual({
      verdict: "issues",
      reviewed_by: agent2.session,
      reviewed_at: NOW,
      note: "acceptance 2 fails locally",
    });
    expect(r.sectionWrites).toEqual([
      { heading: "Review", text: `- ${NOW} ${agent2.session} issues: acceptance 2 fails locally\n` },
    ]);
    const again = transition(
      r.meta,
      { type: "review", verdict: "ok", note: "fixed and rerun" },
      agent2,
      ctx({ claim: claimOf() }),
    );
    expect(again.meta.ai_review.verdict).toBe("ok");
  });

  it("review with summary: human line first, technical note kept for the fixer", () => {
    const r = transition(
      item("in_review"),
      {
        type: "review",
        verdict: "issues",
        summary: "The restart flag is ignored — it goes back for fixes.",
        note: "acceptance 2 fails locally",
      },
      agent2,
      ctx({ claim: claimOf() }),
    );
    expect(r.meta.ai_review).toEqual({
      verdict: "issues",
      reviewed_by: agent2.session,
      reviewed_at: NOW,
      note: "acceptance 2 fails locally",
      summary: "The restart flag is ignored — it goes back for fixes.",
    });
    expect(r.sectionWrites).toEqual([
      {
        heading: "Review",
        text: `- ${NOW} ${agent2.session} issues — The restart flag is ignored — it goes back for fixes. (acceptance 2 fails locally)\n`,
      },
    ]);
  });

  it("bounce with summary stores it on the marker", () => {
    const r = transition(
      item("in_review"),
      { type: "bounce", reason: "tests red", summary: "The tests are failing." },
      agent2,
      ctx({ claim: claimOf() }),
    );
    expect(r.meta.ai_review?.summary).toBe("The tests are failing.");
    expect(r.sectionWrites[0].text).toContain("bounced — The tests are failing. (tests red)");
  });

  it("submit clears a stale review — a fresh submission starts unreviewed", () => {
    const meta = { ...item("in_progress"), ai_review: { verdict: "ok", reviewed_by: agent2.session, reviewed_at: NOW } };
    const r = transition(meta, { type: "submit" }, agent, ctx({ claim: claimOf() }));
    expect(r.meta.ai_review).toBeUndefined();
  });

  it("bounce keeps the claim with the holder, flags issues, logs the reason", () => {
    const r = transition(
      item("in_review"),
      { type: "bounce", reason: "tests red" },
      agent2,
      ctx({ claim: claimOf() }),
    );
    expect(r.meta.status).toBe("in_progress");
    expect(r.effects).toEqual([]); // no claim delete — the holder keeps fixing
    expect(r.meta.ai_review).toEqual({
      verdict: "issues",
      reviewed_by: agent2.session,
      reviewed_at: NOW,
      note: "tests red",
    });
    expect(r.log[0]).toContain("ai-bounced submission: tests red");
    expect(r.events[0]).toMatchObject({ action: "bounce", from: "in_review", to: "in_progress", note: "tests red" });
  });

  it("bounces are capped: MAX_AI_BOUNCES allowed, the next one is refused", () => {
    const at = (priorBounces: number) =>
      transition(item("in_review"), { type: "bounce", reason: "again" }, agent2, ctx({ claim: claimOf(), priorBounces }));
    for (let n = 0; n < MAX_AI_BOUNCES; n++) expect(at(n).meta.status).toBe("in_progress");
    expect(() => at(MAX_AI_BOUNCES)).toThrow(/AI bounces/);
  });

  it("an issues verdict on a holder that can't act here records the review and keeps the claim", () => {
    const r = transition(
      item("in_review"),
      { type: "review", verdict: "issues", note: "acceptance 2 fails" },
      agent2,
      ctx({ claim: claimOf(), holderAway: true }),
    );
    expect(r.meta.status).toBe("in_review");
    expect(r.meta.ai_review?.verdict).toBe("issues");
    expect(r.effects).toEqual([]);
    expect(r.events[0]).toMatchObject({ action: "review", from: "in_review", to: "in_review" });
  });

  it("an issues verdict with no claim, or an ok verdict, never releases", () => {
    const noClaim = transition(
      item("in_review"),
      { type: "review", verdict: "issues" },
      agent2,
      ctx({ holderAway: true }),
    );
    expect(noClaim.meta.status).toBe("in_review");
    expect(noClaim.effects).toEqual([]);
    const ok = transition(
      item("in_review"),
      { type: "review", verdict: "ok" },
      agent2,
      ctx({ claim: claimOf(), holderAway: true }),
    );
    expect(ok.meta.status).toBe("in_review");
    expect(ok.effects).toEqual([]);
  });

  it("a bounce on a holder that can't act here releases the claim to ready", () => {
    const r = transition(
      item("in_review"),
      { type: "bounce", reason: "tests red" },
      agent2,
      ctx({ claim: claimOf(), holderAway: true }),
    );
    expect(r.meta.status).toBe("ready");
    expect(r.effects).toEqual([{ type: "delete_claim" }, { type: "cleanup_work", keepBranches: true }]);
    expect(r.events[0]).toMatchObject({ action: "bounce", from: "in_review", to: "ready", note: "tests red" });
    expect(r.log.some((l) => l.includes("claim released"))).toBe(true);
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

describe("drop flags (agent asks, human decides)", () => {
  it("flag_drop works on any non-terminal status, keeps the status, records the flag", () => {
    for (const s of ["draft", "ready", "hold", "in_progress", "waiting", "in_review"] as Status[]) {
      const r = transition(
        item(s),
        { type: "flag_drop", reason: "superseded" },
        agent,
        ctx({ claim: claimOf() }),
      );
      expect(r.meta.status).toBe(s);
      expect(r.meta.drop_request).toEqual({ by: agent.session, reason: "superseded", at: NOW });
      expect(r.effects).toEqual([]); // advisory — claims stay put
      expect(r.log[0]).toContain("flagged for drop: superseded");
    }
  });

  it("refused on terminal items and for humans; a re-flag replaces the reason", () => {
    for (const s of ["done", "dropped"] as Status[]) {
      expect(() => transition(item(s), { type: "flag_drop" }, agent, ctx())).toThrow(
        InvalidTransitionError,
      );
    }
    expect(() => transition(item("draft"), { type: "flag_drop" }, human, ctx())).toThrow(
      ForbiddenError,
    );
    const first = transition(item("draft"), { type: "flag_drop", reason: "old" }, agent, ctx());
    const again = transition(first.meta, { type: "flag_drop", reason: "better reason" }, agent2, ctx());
    expect(again.meta.drop_request?.by).toBe(agent2.session);
    expect(again.meta.drop_request?.reason).toBe("better reason");
  });

  it("unflag_drop clears the flag (human-only); drop clears it too", () => {
    const flagged = transition(item("ready"), { type: "flag_drop", reason: "x" }, agent, ctx());
    expect(() =>
      transition(flagged.meta, { type: "unflag_drop" }, agent, ctx()),
    ).toThrow(ForbiddenError);
    const kept = transition(flagged.meta, { type: "unflag_drop" }, human, ctx());
    expect(kept.meta.status).toBe("ready");
    expect(kept.meta.drop_request).toBeUndefined();
    // nothing to unflag → refused
    expect(() => transition(item("ready"), { type: "unflag_drop" }, human, ctx())).toThrow(
      InvalidTransitionError,
    );
    // approving the flag = drop; the flag doesn't survive on the dropped item
    const flaggedIp = transition(
      item("in_progress"),
      { type: "flag_drop", reason: "obsolete" },
      agent,
      ctx({ claim: claimOf() }),
    );
    const dropped = transition(flaggedIp.meta, { type: "drop" }, human, ctx({ claim: claimOf() }));
    expect(dropped.meta.status).toBe("dropped");
    expect(dropped.meta.drop_request).toBeUndefined();
    expect(dropped.effects).toEqual([{ type: "delete_claim" }, { type: "cleanup_work" }]);
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

describe("close_plan / reopen_plan (epics)", () => {
  const epic = (status: Status, closed = false) =>
    ItemMeta.parse({
      id: "EP-0001",
      type: "epic",
      title: "p",
      status,
      plan_closed: closed || undefined,
    });

  it("toggles plan_closed without touching the status", () => {
    for (const s of ["draft", "ready", "in_progress", "waiting", "in_review", "done"] as Status[]) {
      const r = transition(epic(s), { type: "close_plan" }, human, ctx());
      expect(r.meta.status).toBe(s);
      expect(r.meta.plan_closed).toBe(true);
      const back = transition(r.meta, { type: "reopen_plan" }, human, ctx());
      expect(back.meta.status).toBe(s);
      expect(back.meta.plan_closed).toBe(false);
    }
  });

  it("agents, non-epics, and wrong flag states are refused", () => {
    expect(() => transition(epic("ready"), { type: "close_plan" }, agent, ctx())).toThrow(
      ForbiddenError,
    );
    expect(() => transition(epic("ready", true), { type: "reopen_plan" }, agent, ctx())).toThrow(
      ForbiddenError,
    );
    expect(() => transition(item("ready"), { type: "close_plan" }, human, ctx())).toThrow(
      /not an epic/,
    );
    expect(() => transition(item("ready"), { type: "reopen_plan" }, human, ctx())).toThrow(
      /not an epic/,
    );
    expect(() => transition(epic("ready", true), { type: "close_plan" }, human, ctx())).toThrow(
      /already closed/,
    );
    expect(() => transition(epic("ready"), { type: "reopen_plan" }, human, ctx())).toThrow(
      /not closed/,
    );
  });

  it("an epic can never be claimed — epics are plans", () => {
    for (const a of [agent, human] as Actor[]) {
      expect(() =>
        transition(epic("ready"), { type: "claim", claim: claimOf() }, a, ctx({ depsDone: true })),
      ).toThrow(/epics are plans/);
    }
  });
});

describe("star", () => {
  it("bookmarks any status without touching it — even claimed items", () => {
    for (const s of ["draft", "ready", "hold", "in_progress", "waiting", "in_review", "done", "dropped"] as Status[]) {
      const it = item(s);
      it.updated = "2026-10-01";
      const r = transition(it, { type: "star" }, human, ctx(s === "in_progress" ? { claim: claimOf() } : {}));
      expect(r.meta.status).toBe(s);
      expect(r.meta.star_color).toBe("yellow");
      expect(r.meta.starred_at).toBe(NOW);
      expect(r.meta.updated).toBe("2026-10-01"); // bookmarking isn't an edit
      const back = transition(r.meta, { type: "unstar" }, human, ctx());
      expect(back.meta.status).toBe(s);
      expect(back.meta.star_color).toBeUndefined();
      expect(back.meta.starred_at).toBeUndefined();
      expect(back.meta.updated).toBe("2026-10-01");
    }
  });

  it("a different colour re-stars; the same colour, agents and unstar-when-clear refuse", () => {
    const starred = transition(item("ready"), { type: "star" }, human, ctx()).meta;
    expect(() => transition(starred, { type: "star", color: "yellow" }, human, ctx())).toThrow(/already starred/);
    const red = transition(starred, { type: "star", color: "red" }, human, ctx());
    expect(red.meta.star_color).toBe("red");
    expect(red.meta.status).toBe("ready");
    expect(red.log[0]).toMatch(/starred red \(status ready\)/);
    expect(() => transition(item("ready"), { type: "star" }, agent, ctx())).toThrow(/human-only/);
    expect(() => transition(item("ready"), { type: "unstar" }, human, ctx())).toThrow(/not starred/);
  });
});

describe("model tiers, attempts and handoff", () => {
  const light: Actor = { ...agent, tier: "light" };
  const heavy: Actor = { ...agent2, tier: "heavy" };
  const withMeta = (status: Status, extra: Partial<ItemMeta>) => ({ ...item(status), ...extra });
  const esc = { after: 2, max: 5 };

  it("refuses a claim below the item's tier", () => {
    expect(() =>
      transition(withMeta("ready", { tier: "standard" }), { type: "claim", claim: claimOf() }, light, ctx({ depsDone: true })),
    ).toThrow(ClaimRefusedError);
    const r = transition(withMeta("ready", { tier: "standard" }), { type: "claim", claim: claimOf() }, heavy, ctx({ depsDone: true }));
    expect(r.meta.status).toBe("in_progress");
  });

  it("handoff releases the claim, writes ## Handoff and counts an attempt", () => {
    const r = transition(
      item("in_progress"),
      { type: "handoff", problem: "TypeError at x.ts:3", tried: "a, b", next: "try c" },
      light,
      ctx({ claim: { ...claimOf(), tier: "light" }, escalation: esc }),
    );
    expect(r.meta.status).toBe("ready");
    expect(r.meta.attempts).toBe(1);
    expect(r.meta.tier).toBeUndefined();
    expect(r.effects.map((e) => e.type)).toEqual(["delete_claim", "cleanup_work"]);
    expect(r.sectionWrites[0].heading).toBe("Handoff");
    expect(r.sectionWrites[0].text).toContain("**Next:** try c");
  });

  it("the second failed attempt escalates the tier one step past the holder", () => {
    const r = transition(
      withMeta("in_progress", { attempts: 1 }),
      { type: "handoff", problem: "p", tried: "t" },
      light,
      ctx({ claim: { ...claimOf(), tier: "light" }, escalation: esc }),
    );
    expect(r.meta.tier).toBe("standard");
    const r2 = transition(
      withMeta("in_progress", { attempts: 3, tier: "standard" }),
      { type: "handoff", problem: "p", tried: "t" },
      agent,
      ctx({ claim: claimOf(), escalation: esc }),
    );
    expect(r2.meta.tier).toBe("heavy");
  });

  it("at max_attempts the item is held for the human", () => {
    const r = transition(
      withMeta("in_progress", { attempts: 4 }),
      { type: "handoff", problem: "p", tried: "t" },
      agent,
      ctx({ claim: claimOf(), escalation: esc }),
    );
    expect(r.meta.status).toBe("hold");
  });

  it("an escalating bounce releases a holder that is now under-tier", () => {
    const r = transition(
      withMeta("in_review", { attempts: 1 }),
      { type: "bounce", reason: "wrong logic" },
      heavy,
      ctx({ claim: { ...claimOf(), tier: "light" }, escalation: esc }),
    );
    expect(r.meta.status).toBe("ready");
    expect(r.meta.tier).toBe("standard");
    expect(r.effects.map((e) => e.type)).toContain("delete_claim");
    const keep = transition(item("in_review"), { type: "bounce", reason: "x" }, heavy, ctx({ claim: claimOf(), escalation: esc }));
    expect(keep.meta.status).toBe("in_progress");
    expect(keep.effects).toEqual([]);
  });

  it("vet needs a session above the draft's author tier", () => {
    const d = withMeta("draft", { authored_tier: "light" });
    expect(() => transition(d, { type: "vet", verdict: "ok" }, light, ctx())).toThrow(ForbiddenError);
    const r = transition(d, { type: "vet", verdict: "ok" }, heavy, ctx());
    expect(r.meta.vetted_by).toBe(heavy.session);
    expect(r.meta.status).toBe("draft");
  });

  it("set_tier is human-only and can reset attempts", () => {
    expect(() => transition(item("ready"), { type: "set_tier", tier: "heavy" }, agent, ctx())).toThrow(ForbiddenError);
    const r = transition(withMeta("hold", { attempts: 5 }), { type: "set_tier", tier: "heavy", reset: true }, human, ctx());
    expect(r.meta.tier).toBe("heavy");
    expect(r.meta.attempts).toBeUndefined();
  });
});

describe("reject --release sends a submission back to the pool", () => {
  it("in_review → ready: claim deleted, worktree cleaned, branches kept", () => {
    const r = transition(
      item("in_review"),
      { type: "reject", reason: "wrong approach", release: true },
      human,
      ctx({ claim: claimOf() }),
    );
    expect(r.meta.status).toBe("ready");
    expect(r.effects).toEqual([
      { type: "delete_claim" },
      { type: "cleanup_work", keepBranches: true },
    ]);
    expect(r.log[0]).toMatch(/rejected submission and released the claim: wrong approach$/);
    expect(r.events[0]).toMatchObject({ action: "reject", from: "in_review", to: "ready" });
  });

  it("without a claim it still lands ready — nothing to free", () => {
    const r = transition(item("in_review"), { type: "reject", release: true }, human, ctx());
    expect(r.meta.status).toBe("ready");
    expect(r.effects).toEqual([]);
  });

  it("plain reject keeps the claim and lands in_progress (unchanged)", () => {
    const r = transition(item("in_review"), { type: "reject", reason: "fix" }, human, ctx({ claim: claimOf() }));
    expect(r.meta.status).toBe("in_progress");
    expect(r.effects).toEqual([]);
  });

  it("--release on a ready item is still the un-approve path → draft", () => {
    const r = transition(item("ready"), { type: "reject", release: true }, human, ctx());
    expect(r.meta.status).toBe("draft");
  });
});

describe("claim takeover of an item whose holder can't act", () => {
  // in_progress + dead holder on the same machine: the item would strand
  const deadCtx = (c: Partial<TransitionCtx> = {}) =>
    ctx({ claim: claimOf(), depsDone: true, holderAway: true, ...c });

  it("another session on the same machine takes claim and work over", () => {
    const r = transition(
      item("in_progress"),
      { type: "claim", claim: claimOf(agent2.session) },
      agent2,
      deadCtx(),
    );
    expect(r.meta.status).toBe("in_progress");
    expect(r.effects).toEqual([
      { type: "write_claim", claim: claimOf(agent2.session) },
      { type: "setup_work" },
    ]);
    expect(r.log[0]).toMatch(/took over from claude-code@desktop#a1f3 — its session can't act here$/);
    expect(r.meta.attempts).toBe(1); // a stranded claim counts as a failed attempt
  });

  it("a live holder's in_progress claim stays untouchable", () => {
    expect(() =>
      transition(
        item("in_progress"),
        { type: "claim", claim: claimOf(agent2.session) },
        agent2,
        ctx({ claim: claimOf(), depsDone: true, holderAway: false }),
      ),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      transition(
        item("in_progress"),
        { type: "claim", claim: claimOf(agent2.session) },
        agent2,
        ctx({ claim: claimOf(), depsDone: true }),
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("refused across machines — the worktree is local", () => {
    const remote: Actor = { kind: "agent", session: "gemini-cli@laptop#b2c4", machine: "laptop" };
    const remoteClaim = { ...claimOf(agent2.session), holder: remote.session, machine: "laptop" };
    expect(() =>
      transition(item("in_progress"), { type: "claim", claim: remoteClaim }, remote, deadCtx()),
    ).toThrow(InvalidTransitionError);
  });

  it("agent-only: the human releases instead", () => {
    expect(() =>
      transition(
        item("in_progress"),
        { type: "claim", claim: { ...claimOf("human"), actor: "human" as const } },
        human,
        deadCtx(),
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("a takeover that runs out of attempts waits for the human", () => {
    const meta = { ...item("in_progress"), attempts: 4 };
    expect(() =>
      transition(
        meta,
        { type: "claim", claim: claimOf(agent2.session) },
        agent2,
        deadCtx({ escalation: { after: 2, max: 5 } }),
      ),
    ).toThrow(/out of attempts/);
  });
});

describe("takeover counts as an attempt", () => {
  const flagged = (attempts?: number): ItemMeta => ({
    ...item("in_review"),
    ai_review: { verdict: "issues", reviewed_by: "lens@desktop#1", reviewed_at: NOW },
    ...(attempts ? { attempts } : {}),
  });
  const forge: Actor = { ...agent2, tier: "standard" };
  const swiftClaim = { ...claimOf(), tier: "standard" as const };

  it("increments attempts on takeover", () => {
    const r = transition(flagged(), { type: "claim", claim: claimOf(forge.session) }, forge, ctx({ claim: swiftClaim, escalation: { after: 2, max: 5 } }));
    expect(r.meta.status).toBe("in_progress");
    expect(r.meta.attempts).toBe(1);
  });

  it("refuses a takeover that runs out of attempts", () => {
    expect(() =>
      transition(flagged(4), { type: "claim", claim: claimOf(forge.session) }, forge, ctx({ claim: swiftClaim, escalation: { after: 2, max: 5 } })),
    ).toThrow(/out of attempts/);
  });
});
