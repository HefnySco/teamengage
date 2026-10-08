import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readAllEvents, eventFilePath } from "./log.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "te-events-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("EventLog", () => {
  it("writes one stream per machine, monthly files, increasing seq", async () => {
    const log = new EventLog(dir, "desktop");
    const e1 = await log.append({ ts: "2026-09-30T23:59Z", actor: "a", action: "claim", item: "GL-1" });
    const e2 = await log.append({ ts: "2026-10-01T00:01Z", actor: "a", action: "log", item: "GL-1" });
    const e3 = await log.append({ ts: "2026-10-01T00:02Z", actor: "a", action: "submit", item: "GL-1" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(1); // new month → new file → seq restarts
    expect(e3.seq).toBe(2);
    expect(eventFilePath(dir, "desktop", e1.ts)).toContain("2026-09.jsonl");
    expect(eventFilePath(dir, "desktop", e2.ts)).toContain("2026-10.jsonl");
  });

  it("merged read across machines is ts-ordered", async () => {
    const laptop = new EventLog(dir, "laptop");
    await laptop.append({ ts: "2026-10-01T00:00:30Z", actor: "b", action: "claim", item: "MP-1" });
    await laptop.append({ ts: "2026-10-01T00:03:00Z", actor: "b", action: "log", item: "MP-1" });
    const all = await readAllEvents(dir);
    const ts = all.events.map((e) => `${e.machine}:${e.action}`);
    expect(ts).toEqual([
      "desktop:claim", // 2026-09-30
      "laptop:claim", // 2026-10-01T00:00:30
      "desktop:log", // 00:01
      "desktop:submit", // 00:02
      "laptop:log", // 00:03
    ]);
  });

  it("skips a truncated trailing line with a warning", async () => {
    const mdir = join(dir, "broken");
    mkdirSync(mdir, { recursive: true });
    const f = join(mdir, "2026-10.jsonl");
    writeFileSync(f, '{"ts":"2026-10-01T00:00Z","machine":"broken","actor":"x","action":"a","seq":1}\n');
    appendFileSync(f, '{"ts":"2026-10-01T00:01Z","machin'); // torn write
    const r = await new EventLog(dir, "broken").read();
    expect(r.events).toHaveLength(1);
    expect(r.warnings[0]).toContain("truncated");
  });

  it("seq survives reopening the log", async () => {
    const log1 = new EventLog(dir, "persist");
    await log1.append({ ts: "2026-10-02T00:00Z", actor: "a", action: "x" });
    const log2 = new EventLog(dir, "persist"); // new instance, same dir
    const e = await log2.append({ ts: "2026-10-02T00:01Z", actor: "a", action: "y" });
    expect(e.seq).toBe(2);
  });
});
