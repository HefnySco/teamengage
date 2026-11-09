import { describe, it, expect } from "vitest";
import { runOriginBackfill } from "./backfill.js";

type M = Record<string, unknown> & { id: string };
const bank = (): M[] => [
  { id: "T-1", status: "done", title: "origin", type: "task", domains: [] },
  { id: "T-2", status: "ready", title: "other", type: "task", domains: [] },
  { id: "T-3", status: "ready", title: "Bug: a", type: "bug", domains: [], depends_on: ["T-1"] },
  { id: "T-4", status: "ready", title: "Bug: b", type: "task", domains: ["bug"], depends_on: ["T-1", "T-2"] },
  { id: "T-5", status: "ready", title: "Bug: c", type: "bug", domains: [] },
  { id: "T-6", status: "ready", title: "Bug: d", type: "bug", domains: [], depends_on: ["T-1"], found_by: ["T-2"] },
];
const fake = (items: M[]) => async (method: string, path: string, body?: unknown) => {
  if (method === "GET") return structuredClone(items);
  const m = /\/api\/items\/([^/]+)\/(found-by|deps)/.exec(path)!;
  const it = items.find((i) => i.id === m[1])!;
  const b = body as { found_by?: string[]; depends_on?: string[] };
  if (m[2] === "found-by") it.found_by = b.found_by;
  else if (b.depends_on?.length) it.depends_on = b.depends_on;
  else delete it.depends_on;
  return {};
};

describe("te origin-backfill", () => {
  it("dry run lists candidates and changes nothing", async () => {
    const items = bank();
    const before = JSON.stringify(items);
    const [code, out] = await runOriginBackfill([], fake(items), {});
    expect(code).toBe(0);
    expect(out).toContain("2 problem item(s)");
    expect(out).toContain("T-3");
    expect(out).toContain("T-4");
    expect(JSON.stringify(items)).toBe(before);
  });

  it("refuses --apply for an agent session with FORBIDDEN", async () => {
    const items = bank();
    const before = JSON.stringify(items);
    const [code, out] = await runOriginBackfill(["--apply"], fake(items), { TE_SESSION: "tok" });
    expect(code).toBe(1);
    expect(out).toContain("FORBIDDEN");
    expect(JSON.stringify(items)).toBe(before);
  });

  it("--apply moves ids to found_by and keeps the ids named by --keep", async () => {
    const items = bank();
    const [code] = await runOriginBackfill(["--apply", "--keep", "T-2"], fake(items), {});
    expect(code).toBe(0);
    const g = (id: string) => items.find((i) => i.id === id)!;
    expect(g("T-3").found_by).toEqual(["T-1"]);
    expect(g("T-3").depends_on).toBeUndefined();
    expect(g("T-4").found_by).toEqual(["T-1"]);
    expect(g("T-4").depends_on).toEqual(["T-2"]);
    expect(g("T-6").found_by).toEqual(["T-2"]); // already linked: untouched
  });

  it("prints problem items with no link at all", async () => {
    const [, out] = await runOriginBackfill([], fake(bank()), {});
    expect(out).toMatch(/1 problem item\(s\) with no link at all[\s\S]*T-5/);
  });
});
