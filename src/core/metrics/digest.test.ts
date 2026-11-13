import { describe, it, expect } from "vitest";
import { buildDigest, digestSince } from "./digest.js";
import type { Event } from "../model/event.js";
import type { IndexedItem } from "../index/index.js";

const ev = (ts: string, action: string, item: string, actor = "devin@dt#aa"): Event =>
  ({ ts, machine: "dt", actor, item, action }) as Event;

const mk = (
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
): IndexedItem =>
  ({
    meta: { id, title: `${id} title`, status, type: "task", ...extra },
    claim: extra.claim as IndexedItem["claim"],
  }) as IndexedItem;

const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY = 24 * 3600_000;
const opts = { staleAfterMs: DAY, maxAttempts: 5, now: NOW };

describe("digestSince", () => {
  it("starts at the last human event, falls back when there is none", () => {
    const events = [
      ev("2026-11-09T00:00:00Z", "claim", "A"),
      ev("2026-11-09T06:00:00Z", "accept", "A", "human"),
      ev("2026-11-10T00:00:00Z", "claim", "B"),
    ];
    expect(digestSince(events, "X")).toBe("2026-11-09T06:00:00Z");
    expect(digestSince([ev("2026-11-10T00:00:00Z", "claim", "B")], "X")).toBe("X");
  });
});

describe("buildDigest", () => {
  it("groups accepted items by their top-level plan", () => {
    const items = new Map<string, IndexedItem>([
      ["P1", mk("P1", "in_progress", { type: "epic" })],
      ["A", mk("A", "done", { parent: "P1" })],
      ["A1", mk("A1", "done", { parent: "A" })],
      ["B", mk("B", "done")],
    ]);
    const d = buildDigest(
      [
        ev("2026-11-09T00:00:00Z", "accept", "A1", "human"),
        ev("2026-11-09T01:00:00Z", "accept", "B", "human"),
        ev("2026-11-08T00:00:00Z", "accept", "OLD", "human"), // before the window
      ],
      items,
      { ...opts, since: "2026-11-08T12:00:00Z" },
    );
    expect(d.finished).toHaveLength(2);
    const p1 = d.finished.find((g) => g.plan === "P1")!;
    expect(p1.items.map((x) => x.id)).toEqual(["A1"]);
    const none = d.finished.find((g) => g.plan === undefined)!;
    expect(none.items.map((x) => x.id)).toEqual(["B"]);
  });

  it("lists stuck: hold, max attempts, stale claim, open question", () => {
    const items = new Map<string, IndexedItem>([
      ["H", mk("H", "hold")],
      ["M", mk("M", "in_progress", { attempts: 5 })],
      [
        "S",
        mk("S", "in_progress", {
          claim: { holder: "a@m#1", actor: "agent", machine: "m", targets: [], claimed_at: "2026-11-01T00:00:00Z", last_seen: "2026-11-01T00:00:00Z" },
        }),
      ],
      ["W", mk("W", "waiting")],
      ["L", mk("L", "in_progress", {
        claim: { holder: "a@m#1", actor: "agent", machine: "m", targets: [], claimed_at: "2026-11-10T00:00:00Z", last_seen: "2026-11-10T00:00:00Z" },
      })],
      ["D", mk("D", "done", { attempts: 9 })], // finished items are never stuck
    ]);
    const d = buildDigest([], items, { ...opts, since: "2026-11-09T00:00:00Z" });
    expect(d.stuck.map((x) => x.id)).toEqual(["H", "M", "S", "W"]);
    expect(d.stuck.find((x) => x.id === "S")!.why).toBe("stale claim");
    expect(d.stuck.find((x) => x.id === "W")!.why).toBe("question open");
  });

  it("waits for you: flagged reviews and drafts — plain submissions are not listed", () => {
    const items = new Map<string, IndexedItem>([
      ["NH", mk("NH", "in_review", { ai_review: { verdict: "ok", needs_human: true, reviewed_by: "x@m#1", reviewed_at: "t" } })],
      ["IS", mk("IS", "in_review", { ai_review: { verdict: "issues", reviewed_by: "x@m#1", reviewed_at: "t" } })],
      ["OK", mk("OK", "in_review")],
      ["DR", mk("DR", "draft")],
    ]);
    const d = buildDigest([], items, { ...opts, since: "2026-11-09T00:00:00Z" });
    expect(d.waits.map((x) => x.id)).toEqual(["DR", "IS", "NH"]);
  });
});
