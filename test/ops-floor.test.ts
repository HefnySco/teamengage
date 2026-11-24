import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// web/ops-floor.js is a plain ES module (no types) — vitest imports it as-is
import { derive, feed, isReviewerSession } from "../web/ops-floor.js";

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
      { id: "WC-0118", mode: "ask", label: "question", title: "Which tile server?" },
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
      { at: "2026-11-24T09:03:00.000Z", kind: "dispatch_start", id: "GL-0213", mode: "review", room: "rev" },
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
