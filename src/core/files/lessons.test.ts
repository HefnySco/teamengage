import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLesson, readLessons, removeLesson } from "./lessons.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "te-lessons-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("shared lessons per domain (GL-0322)", () => {
  it("lesson with domain simulation adds one line to lessons/simulation.md", async () => {
    await appendLesson(
      dir,
      "simulation",
      "agent-x@host#1a2b",
      "the sim needs TE_HOME set",
      "2026-11-14T01:00:00Z",
    );
    const file = readFileSync(join(dir, "lessons", "simulation.md"), "utf8");
    expect(file).toContain("# lessons — #simulation");
    expect(file).toContain("- 2026-11-14 agent-x@host#1a2b — the sim needs TE_HOME set");
    expect(await readLessons(dir, "simulation")).toEqual([
      "2026-11-14 agent-x@host#1a2b — the sim needs TE_HOME set",
    ]);
  });

  it("appends keep order and fold multi-line text to one line", async () => {
    await appendLesson(
      dir,
      "simulation",
      "agent-y@host#9c",
      "line one\nline two",
      "2026-11-14T02:00:00Z",
    );
    const ls = await readLessons(dir, "simulation");
    expect(ls).toHaveLength(2);
    expect(ls[1]).toBe("2026-11-14 agent-y@host#9c — line one line two");
  });

  it("a missing domain file reads as empty", async () => {
    expect(await readLessons(dir, "nothing")).toEqual([]);
  });

  it("removeLesson drops the nth - line and returns it", async () => {
    expect(await removeLesson(dir, "simulation", 2)).toBe(
      "2026-11-14 agent-y@host#9c — line one line two",
    );
    expect(await readLessons(dir, "simulation")).toEqual([
      "2026-11-14 agent-x@host#1a2b — the sim needs TE_HOME set",
    ]);
    expect(await removeLesson(dir, "simulation", 5)).toBeNull();
    expect(await removeLesson(dir, "nothing", 1)).toBeNull();
  });
});
