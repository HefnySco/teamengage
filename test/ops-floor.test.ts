import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// web/ops-floor.js is a plain ES module (no types) — vitest imports it as-is
import { derive, dispatchMood, feed, isReviewerSession, sessionKind, seatLoad, seatMood } from "../web/ops-floor.js";

const here = dirname(fileURLToPath(import.meta.url));

const session = (over: Record<string, unknown>) => ({
  id: "devin@desktop#41c2",
  agent: "devin",
  machine: "desktop",
  role: "coder",
  label: undefined,
  connected_at: "2026-11-24T09:00:00.000Z",
  last_seen: "2026-11-24T09:10:00.000Z",
  holding: [],
  ...over,
});

const emptyDispatch = { running: [], matched: [], events: [] };
const emptyInbox = { questions: [], reviews: [] };

describe("ops-floor module", () => {
  it("exports derive and feed and imports nothing from preact or the DOM", () => {
    expect(typeof derive).toBe("function");
    expect(typeof feed).toBe("function");
    const source = readFileSync(join(here, "../web/ops-floor.js"), "utf8");
    expect(source).not.toMatch(/from\s+["']preact/);
    expect(source).not.toMatch(/require\(["']preact/);
    for (const dom of ["document", "window", "HTMLElement"]) {
      expect(source).not.toMatch(new RegExp(`\\b${dom}\\b`));
    }
  });
});

describe("derive", () => {
  it("seats a card for each item in a session's holding", () => {
    const s = session({ label: "GL-0214", holding: ["GL-0214"] });
    const { seats } = derive([s], emptyDispatch, emptyInbox);
    expect(seats.get(s.id)).toEqual([{ id: "GL-0214", mode: "work" }]);
  });

  it("gives a reviewer session a card from dispatch.running although its holding is empty", () => {
    const s = session({ id: "claude-review@desktop#77d1", role: "reviewer", label: "GL-0213" });
    const dispatch = { ...emptyDispatch, running: [{ id: "GL-0213", mode: "review", role: "reviewer" }] };
    const { seats } = derive([s], dispatch, emptyInbox);
    expect(seats.get(s.id)).toEqual([{ id: "GL-0213", mode: "review" }]);
  });

  it("puts a waiting item on the human's desk, not on the session's desk", () => {
    const s = session({ id: "devin@laptop#09ae", label: "WC-0118" });
    const dispatch = { ...emptyDispatch, running: [{ id: "WC-0118", mode: "work", role: "coder" }] };
    const inbox = { ...emptyInbox, questions: [{ id: "WC-0118", question: { text: "Which tile server?" } }] };
    const { seats, you } = derive([s], dispatch, inbox);
    expect(seats.get(s.id)).toEqual([]);
    expect(you).toEqual([
      {
        id: "WC-0118",
        mode: "ask",
        label: "question",
        title: "Which tile server?",
        question: { text: "Which tile server?" },
      },
    ]);
  });

  it("attaches the full question — text, context, options — on an ask entry (TE-0231)", () => {
    const inbox = {
      ...emptyInbox,
      questions: [
        {
          id: "TE-0231",
          question: {
            text: "Which storage engine?",
            context: "the ledger outgrew the json file",
            options: ["sqlite", "jsonl"],
          },
        },
      ],
    };
    const { you } = derive([], emptyDispatch, inbox);
    expect(you[0].question).toEqual({
      text: "Which storage engine?",
      context: "the ledger outgrew the json file",
      options: ["sqlite", "jsonl"],
    });
  });

  it("attaches blocked dep ids from accept_waiting on accept entries (TE-0231)", () => {
    const inbox = {
      ...emptyInbox,
      reviews: ["TE-0231", "TE-0232"],
      accept_waiting: [{ id: "TE-0231", deps: ["TE-0224", "TE-0226"] }],
    };
    const { you } = derive([], emptyDispatch, inbox);
    expect(you).toEqual([
      {
        id: "TE-0231",
        mode: "accept",
        label: "accept",
        title: "in review — waits for your accept",
        deps: ["TE-0224", "TE-0226"],
      },
      {
        id: "TE-0232",
        mode: "accept",
        label: "accept",
        title: "in review — waits for your accept",
        deps: [],
      },
    ]);
  });

  it("keeps a waiting item off a desk even when holding lists it", () => {
    const s = session({ label: "WC-0118", holding: ["WC-0118"] });
    const inbox = { ...emptyInbox, questions: [{ id: "WC-0118", question: {} }] };
    const { seats, you } = derive([s], emptyDispatch, inbox);
    expect(seats.get(s.id)).toEqual([]);
    expect(you.map((d) => d.id)).toEqual(["WC-0118"]);
  });

  it("places an item once — matched wins over the human's review pile", () => {
    const dispatch = {
      ...emptyDispatch,
      matched: [{ id: "SE-0009", mode: "review", title: "Strategy cycle import" }],
    };
    const inbox = { ...emptyInbox, reviews: ["SE-0009"] };
    const { queue, you, placed } = derive([], dispatch, inbox);
    expect(queue.map((d) => d.id)).toEqual(["SE-0009"]);
    expect(you).toEqual([]);
    expect([...placed].filter((id) => id === "SE-0009")).toHaveLength(1);
  });

  it("passes started_at, has_log and last_line from dispatch.running onto the seat card (TE-0229)", () => {
    const s = session({ label: "TE-0229" });
    const dispatch = {
      ...emptyDispatch,
      running: [
        {
          id: "TE-0229",
          mode: "work",
          started_at: "2026-11-25T09:05:00.000Z",
          has_log: true,
          last_line: "writing the log drawer",
        },
      ],
    };
    const { seats } = derive([s], dispatch, emptyInbox);
    expect(seats.get(s.id)).toEqual([
      {
        id: "TE-0229",
        mode: "work",
        started_at: "2026-11-25T09:05:00.000Z",
        has_log: true,
        last_line: "writing the log drawer",
      },
    ]);
  });

  it("keeps the admission verdict on a matched queue entry (TE-0224)", () => {
    const dispatch = {
      ...emptyDispatch,
      matched: [
        {
          id: "TE-0224",
          mode: "work",
          title: "show refusal reasons",
          admission: { ok: false, reasons: ["max_attempts", "dispatch_blocked"] },
        },
      ],
    };
    const { queue } = derive([], dispatch, emptyInbox);
    expect(queue[0].admission).toEqual({
      ok: false,
      reasons: ["max_attempts", "dispatch_blocked"],
    });
  });
});

describe("dispatchMood (TE-0239)", () => {
  const dsp = (over: Record<string, unknown>) => ({
    enabled: true,
    paused: null,
    online_issues: 0,
    max_issues: 3,
    ...over,
  });

  it("is off whenever the dispatcher is disabled, whatever the rest says", () => {
    expect(dispatchMood({ enabled: false }, 0)).toBe("off");
    expect(dispatchMood({ enabled: false, paused: "freeze", online_issues: 3, max_issues: 3 }, 4)).toBe("off");
    expect(dispatchMood(undefined, 0)).toBe("off");
  });

  it("is paused when paused holds a value — an empty string still counts", () => {
    expect(dispatchMood(dsp({ paused: "deploy freeze", online_issues: 1 }), 1)).toBe("paused");
    expect(dispatchMood(dsp({ paused: "" }), 0)).toBe("paused");
  });

  it("is idle when nothing is online and the queue is empty — why_idle is its reason", () => {
    expect(dispatchMood(dsp(), 0)).toBe("idle");
    expect(dispatchMood(dsp({ why_idle: "no_match" }), 0)).toBe("idle");
    expect(dispatchMood(dsp({ why_idle: "no_agents" }), 0)).toBe("idle");
  });

  it("is steady under two-thirds — and while matched work waits for a live slot", () => {
    expect(dispatchMood(dsp({ online_issues: 1 }), 0)).toBe("steady");
    expect(dispatchMood(dsp({ online_issues: 1 }), 2)).toBe("steady");
    // nothing live yet but the queue is not empty — not idle, still calm
    expect(dispatchMood(dsp(), 2)).toBe("steady");
  });

  it("is busy at two-thirds of capacity and maxed at full", () => {
    expect(dispatchMood(dsp({ online_issues: 2 }), 0)).toBe("busy");
    expect(dispatchMood(dsp({ online_issues: 2 }), 4)).toBe("busy");
    expect(dispatchMood(dsp({ online_issues: 3 }), 0)).toBe("maxed");
    expect(dispatchMood(dsp({ online_issues: 5 }), 0)).toBe("maxed");
  });

  it("falls back to max_sessions when max_issues is absent, and never divides by zero", () => {
    expect(dispatchMood(dsp({ max_issues: undefined, max_sessions: 2, online_issues: 2 }), 0)).toBe("maxed");
    expect(dispatchMood(dsp({ max_issues: 0, online_issues: 0 }), 0)).toBe("idle");
  });
});

describe("seatLoad (TE-0240)", () => {
  it("reads an empty holding as free standby", () => {
    expect(seatLoad([])).toBe("free");
    expect(seatLoad(undefined)).toBe("free");
  });

  it("reads one light-tier item as light", () => {
    expect(seatLoad(["light"])).toBe("light");
    expect(seatLoad([{ tier: "light" }])).toBe("light");
  });

  it("reads standard-tier work as steady", () => {
    expect(seatLoad(["standard"])).toBe("steady");
    expect(seatLoad([{ tier: "standard" }])).toBe("steady");
  });

  it("reads a heavy tier — or two-plus items — as heavy", () => {
    expect(seatLoad(["heavy"])).toBe("heavy");
    expect(seatLoad(["light", "standard"])).toBe("heavy");
    expect(seatLoad(["light", "light"])).toBe("heavy");
    expect(seatLoad([{ tier: "light" }, { tier: "heavy" }])).toBe("heavy");
  });

  it("reads an unknown or missing tier as standard", () => {
    expect(seatLoad([undefined])).toBe("steady");
    expect(seatLoad([{ tier: undefined }])).toBe("steady");
    expect(seatLoad(["weird"])).toBe("steady");
  });
});

describe("seatMood (TE-0240)", () => {
  it("wears no mood on a gone or fading seat, whatever the tray held", () => {
    expect(seatMood("coder", true, false, ["heavy"])).toBe(null);
    expect(seatMood("coder", false, true, ["heavy", "light"])).toBe(null);
    expect(seatMood("coder", true, false, [])).toBe(null);
  });

  it("wears no mood on planner, ops and reviewer seats", () => {
    for (const kind of ["planner", "ops", "reviewer"]) {
      expect(seatMood(kind, false, false, ["heavy"])).toBe(null);
    }
  });

  it("keeps the mood on a live coder seat — quiet still composes on top", () => {
    expect(seatMood("coder", false, false, [])).toBe("free");
    expect(seatMood("coder", false, false, ["heavy"])).toBe("heavy");
  });
});

describe("mood styles compose with presence (TE-0240)", () => {
  it("guards every mood motion or opacity rule against of-quiet, of-gone and of-vanish", () => {
    const css = readFileSync(join(here, "../web/teamengage.css"), "utf8");
    const moodRules = css.match(/\.of-seat\.of-mood-[^{]+\{[^}]*\}/g) ?? [];
    const motion = moodRules.filter((r) => /animation|opacity|filter/.test(r));
    expect(motion.length).toBeGreaterThan(0);
    for (const rule of motion) {
      expect(rule).toContain(":not(.of-quiet)");
      expect(rule).toContain(":not(.of-gone)");
      expect(rule).toContain(":not(.of-vanish)");
    }
  });
});

describe("feed", () => {
  it("routes lines to rev, you or dev and sorts oldest first", () => {
    const dispatchEvents = [
      { kind: "dispatch_start", at: "2026-11-24T09:06:00.000Z", data: { id: "WC-0118", mode: "work", role: "coder" } },
    ];
    const historyEvents = [
      { ts: "2026-11-24T09:10:00.000Z", actor: "human", session: "human", item: "GL-0212", action: "accept", from: "in_review", to: "done" },
      { ts: "2026-11-24T09:00:00.000Z", actor: "devin-review@desktop#11aa", session: "devin-review@desktop#11aa", item: "GL-0212", action: "review", note: "ok: tests pass" },
    ];
    const sessions = [session({ id: "devin-review@desktop#11aa", role: "reviewer" })];
    const lines = feed(dispatchEvents, historyEvents, sessions);
    expect(lines.map((l) => [l.id, l.room])).toEqual([
      ["GL-0212", "rev"],
      ["WC-0118", "dev"],
      ["GL-0212", "you"],
    ]);
    expect(lines.map((l) => l.at)).toEqual([...lines.map((l) => l.at)].sort());
    expect(lines[0].note).toBe("ok");
    expect(lines[2].note).toBe("→ done");
  });

  it("routes a reviewer-role dispatch event to rev", () => {
    const dispatchEvents = [
      { kind: "dispatch_start", at: "2026-11-24T09:03:00.000Z", data: { id: "GL-0213", mode: "review", role: "reviewer" } },
    ];
    const lines = feed(dispatchEvents, [], []);
    expect(lines).toEqual([
      { at: "2026-11-24T09:03:00.000Z", kind: "dispatch_start", id: "GL-0213", mode: "review", room: "rev", role: "reviewer" },
    ]);
  });

  it("carries the resolved kind on each line — a planner stays in room dev (TE-0233)", () => {
    const sessions = [
      session({ id: "planner-1@m#1", role: "planner", agent: "planner-1" }),
      session({ id: "ops-1@m#2", role: undefined, agent: "ops-1" }),
    ];
    const historyEvents = [
      { ts: "2026-11-24T09:00:00.000Z", actor: "planner-1@m#1", session: "planner-1@m#1", item: "TE-0233", action: "log", note: "drafting" },
      { ts: "2026-11-24T09:01:00.000Z", actor: "ops-1@m#2", session: "ops-1@m#2", item: "TE-0233", action: "log", note: "deploying" },
      { ts: "2026-11-24T09:02:00.000Z", actor: "human", session: "human", item: "TE-0233", action: "accept", from: "in_review", to: "done" },
    ];
    const lines = feed([], historyEvents, sessions);
    expect(lines.map((l) => [l.room, l.role])).toEqual([
      ["dev", "planner"],
      ["dev", "ops"],
      ["you", undefined],
    ]);
  });
});

describe("isReviewerSession", () => {
  it("lets a set role decide", () => {
    expect(isReviewerSession(session({ role: "reviewer" }))).toBe(true);
    expect(isReviewerSession(session({ role: "coder", agent: "lens-review", label: "review" }))).toBe(false);
  });

  it("counts a session with no role as a reviewer by its label or agent name", () => {
    expect(isReviewerSession(session({ role: undefined, agent: "lens-quick-review", label: "review" }))).toBe(true);
    expect(isReviewerSession(session({ role: undefined, agent: "claude", label: "review" }))).toBe(true);
    expect(isReviewerSession(session({ role: undefined, agent: "lens-deep-review", label: "GL-0212" }))).toBe(true);
    expect(isReviewerSession(session({ role: undefined, agent: "forge", label: "GL-0212" }))).toBe(false);
    expect(isReviewerSession(undefined)).toBe(false);
  });

  it("puts the history events of a role-less reviewer in room rev", () => {
    const sessions = [session({ id: "lens-quick-review@m#1", role: undefined, agent: "lens-quick-review", label: "review" })];
    const lines = feed([], [{ ts: "2026-11-24T09:00:00.000Z", actor: "lens-quick-review@m#1", session: "lens-quick-review@m#1", item: "GL-0212", action: "log", note: "read the diff" }], sessions);
    expect(lines[0].room).toBe("rev");
  });
});

describe("sessionKind (TE-0233)", () => {
  it("lets a set role decide", () => {
    expect(sessionKind(session({ role: "reviewer" }))).toBe("reviewer");
    expect(sessionKind(session({ role: "planner" }))).toBe("planner");
    expect(sessionKind(session({ role: "ops" }))).toBe("ops");
    expect(sessionKind(session({ role: "coder", agent: "planner-1", label: "plan" }))).toBe("coder");
  });

  it("falls back to label, then agent, when no role is set", () => {
    expect(sessionKind(session({ role: undefined, label: "plan", agent: "claude" }))).toBe("planner");
    expect(sessionKind(session({ role: undefined, label: "TE-0233", agent: "planner-1" }))).toBe("planner");
    expect(sessionKind(session({ role: undefined, label: "ops", agent: "devin" }))).toBe("ops");
    expect(sessionKind(session({ role: undefined, label: "TE-0233", agent: "ops-runner" }))).toBe("ops");
    expect(sessionKind(session({ role: undefined, label: "review", agent: "claude" }))).toBe("reviewer");
    expect(sessionKind(session({ role: undefined, agent: "lens-quick-review", label: "GL-0212" }))).toBe("reviewer");
  });

  it("reads plain agents and words like devops as coders", () => {
    expect(sessionKind(session({ role: undefined, agent: "devops", label: "GL-0212" }))).toBe("coder");
    expect(sessionKind(session({ role: undefined, agent: "forge", label: "GL-0212" }))).toBe("coder");
    expect(sessionKind(undefined)).toBe("coder");
  });
});
