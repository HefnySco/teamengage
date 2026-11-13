import { describe, it, expect } from "vitest";
import { parseTouches, pathOverlap, touchesOverlap } from "./overlap.js";

describe("parseTouches", () => {
  it("reads the **Touches:** line — semicolon-separated repo: path entries", () => {
    const text =
      "# T\n\n**Touches:** teamengage: web/app.js; teamengage: src/core/index/**\n\n## Summary\nx";
    expect(parseTouches(text)).toEqual([
      { repo: "teamengage", path: "web/app.js" },
      { repo: "teamengage", path: "src/core/index/**" },
    ]);
  });

  it("TBD and a missing line give no entries; a bare path has an empty repo", () => {
    expect(parseTouches("**Touches:** TBD")).toEqual([]);
    expect(parseTouches("## Summary\nx")).toEqual([]);
    expect(parseTouches("**Touches:** src/a.ts")).toEqual([{ repo: "", path: "src/a.ts" }]);
  });
});

describe("pathOverlap", () => {
  it("same file overlaps; a glob covers paths under its literal prefix", () => {
    expect(pathOverlap("web/app.js", "web/app.js")).toBe(true);
    expect(pathOverlap("src/**", "src/core/index/x.ts")).toBe(true);
    expect(pathOverlap("src/core/index/**", "src/**")).toBe(true); // either side covers
    expect(pathOverlap("web/app.js", "web/other.js")).toBe(false); // same dir, different file
    expect(pathOverlap("src/a.ts", "src/sub/b.ts")).toBe(false);
  });
});

describe("touchesOverlap", () => {
  it("warns on the same repo only — different repos never warn", () => {
    const mine = [{ repo: "a", path: "src/x.ts" }];
    expect(touchesOverlap(mine, [{ repo: "a", path: "src/x.ts" }])).toEqual(["a: src/x.ts"]);
    expect(touchesOverlap(mine, [{ repo: "b", path: "src/x.ts" }])).toEqual([]);
  });

  it("reports the other's overlapping paths, de-duplicated", () => {
    const mine = [
      { repo: "r", path: "src/**" },
      { repo: "r", path: "src/deep/**" },
    ];
    const theirs = [
      { repo: "r", path: "src/deep/f.ts" },
      { repo: "r", path: "lib/g.ts" },
    ];
    expect(touchesOverlap(mine, theirs)).toEqual(["r: src/deep/f.ts"]);
  });
});
