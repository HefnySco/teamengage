import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderTaskBody,
  renderTaskFile,
  slugify,
  nextTaskNumber,
  taskFileName,
  filePrefix,
  TEMPLATE_EXAMPLE,
} from "./template.js";
import { readTeTag } from "./source.js";
import { planImport } from "../../import/import.js";

describe("task template", () => {
  it("renders every required part, with honest defaults", () => {
    const body = renderTaskBody({ id: "GL-0001", type: "task", title: "Do the thing" });
    expect(body).toBe(
      [
        "# Do the thing",
        "",
        "**Depends on:** nothing",
        "**Touches:** TBD",
        "",
        "## Summary",
        "Do the thing",
        "",
        "## Acceptance",
        "- [ ] TBD — the human or the planner fills this in before approval",
        "",
        "## Notes",
        "",
      ].join("\n"),
    );
  });

  it("normalises acceptance items that already carry - [ ]", () => {
    const body = renderTaskBody({
      id: "GL-0001",
      type: "task",
      title: "T",
      acceptance: ["- [ ] already boxed", "- plain dash", "bare"],
    });
    expect(body).toContain("- [ ] already boxed\n- [ ] plain dash\n- [ ] bare\n");
  });

  it("tags the file and round-trips through the importer (title, deps, parent)", () => {
    const text = renderTaskFile({
      id: "GL-0002",
      type: "task",
      title: "TASK-02 — Second",
      depends_on: ["TASK-01"],
      parent: "GL-0009",
    });
    expect(readTeTag(text)).toBe("GL-0002");
    const plan = planImport(
      [
        { path: "TASK-01-first.md", content: renderTaskBody({ id: "x", type: "task", title: "TASK-01 — First" }) },
        { path: "TASK-02-second.md", content: text },
      ],
      { prefix: "GL" },
    );
    const [first, second] = plan.items;
    expect(second.title).toBe("TASK-02 — Second");
    expect(second.depends_on).toEqual([first.suggestedId]);
    expect(first.depends_on).toEqual([]); // "nothing" means none
    expect(plan.ambiguities.filter((a) => a.kind === "unresolved_dep")).toEqual([]);
  });

  it("te template example uses the same renderer", () => {
    expect(TEMPLATE_EXAMPLE).toContain("## Acceptance\n- [ ] a second AUTO run");
    expect(TEMPLATE_EXAMPLE).toContain("**Touches:** droneengage_mavlink: src/mission/**");
  });
});

describe("file naming", () => {
  it("slugify: lowercase words, ascii, ≤48 chars on a word boundary", () => {
    expect(slugify("Mission re-run: reset seq!")).toBe("mission-re-run-reset-seq");
    expect(slugify("Ünïcode — café")).toBe("unicode-cafe");
    expect(slugify("!!!")).toBe("task");
    const long = slugify("a very long title that keeps going well past the forty eight character limit");
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("-")).toBe(false);
    expect(long).toBe("a-very-long-title-that-keeps-going-well-past-the");
  });

  it("epics are PHASE, everything else TASK; two-digit numbers", () => {
    expect(filePrefix("epic")).toBe("PHASE");
    expect(filePrefix("bug")).toBe("TASK");
    expect(taskFileName("TASK", 7, "Fix it")).toBe("TASK-07-fix-it.md");
    expect(taskFileName("TASK", 123, "Fix it")).toBe("TASK-123-fix-it.md");
    // a numbered title doesn't repeat its number in the slug
    expect(taskFileName("TASK", 14, "TASK-14 — Clear latched events when a mission restarts")).toBe(
      "TASK-14-clear-latched-events-when-a-mission-restarts.md",
    );
    expect(taskFileName("PHASE", 2, "PHASE-2: Onboard supervisor")).toBe("PHASE-02-onboard-supervisor.md");
    expect(taskFileName("TASK", 3, "TASK-02.1 geofence")).toBe("TASK-03-geofence.md");
    expect(taskFileName("TASK", 4, "Task list cleanup")).toBe("TASK-04-task-list-cleanup.md");
  });

  it("nextTaskNumber: highest anywhere under the folder (done/ too) + batch numbers", () => {
    const dir = mkdtempSync(join(tmpdir(), "te-tpl-"));
    try {
      expect(nextTaskNumber(join(dir, "missing"), "TASK")).toBe(1);
      mkdirSync(join(dir, "done"), { recursive: true });
      writeFileSync(join(dir, "TASK-03-a.md"), "");
      writeFileSync(join(dir, "TASK-02.1-sub.md"), "");
      writeFileSync(join(dir, "done", "TASK-11-old.md"), "");
      writeFileSync(join(dir, "PHASE-04-x.md"), "");
      writeFileSync(join(dir, "task-01-lower.md"), "");
      expect(nextTaskNumber(dir, "TASK")).toBe(12);
      expect(nextTaskNumber(dir, "TASK", [12, 13])).toBe(14);
      expect(nextTaskNumber(dir, "PHASE")).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
