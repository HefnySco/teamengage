import { describe, it, expect } from "vitest";
import { planImport } from "./import.js";

/** `X-simplified.md` (webclient/) pairs with `X.md` exactly like `X.simple.md`. */
describe("import: -simplified.md companions", () => {
  it("merges X-simplified.md into X, and strips the suffix from dep refs", () => {
    const plan = planImport(
      [
        { path: "TASK-01-view-objects.md", content: "# TASK-01: View objects\n\nTech.\n" },
        { path: "TASK-01-view-objects-simplified.md", content: "# TASK-01 (simple)\n\nPlain words.\n" },
        { path: "TASK-02-parser.simple.md", content: "Also plain.\n" },
        { path: "TASK-02-parser.md", content: "# TASK-02: Parser\n\n**Depends on:** TASK-01-view-objects-simplified.md\n" },
        { path: "TASK-03-lonely-simplified.md", content: "# TASK-03 only simple\n" },
      ],
      { prefix: "WC" },
    );
    expect(plan.items.map((i) => [i.legacy_id, i.sources])).toEqual([
      ["TASK-01-view-objects", ["TASK-01-view-objects.md", "TASK-01-view-objects-simplified.md"]],
      ["TASK-02-parser", ["TASK-02-parser.md", "TASK-02-parser.simple.md"]],
      ["TASK-03-lonely", ["TASK-03-lonely-simplified.md"]],
    ]);
    const [t1, t2] = plan.items;
    expect(t1.title).toBe("TASK-01: View objects");
    expect(t1.simple).toContain("Plain words.");
    expect(t2.depends_on).toEqual([t1.suggestedId]);
  });
});
