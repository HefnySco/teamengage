import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { planImport } from "./import.js";
import { scanFolder } from "./scan.js";
import { PlansStore } from "../daemon/store/store.js";
import { resolveWorkspace } from "../core/config/config.js";
import type { Actor } from "../core/state/machine.js";

const human: Actor = { kind: "human", session: "human", machine: "test" };

/**
 * Golden fixture mimicking a de_code/Tasks-style folder: status folders,
 * TASK/PLAN/REVIEW prefixes, Depends on: lines, X.simple.md companions.
 */
let src: string;
let home: string;
let plans: string;
let store: PlansStore;

beforeAll(async () => {
  src = mkdtempSync(join(tmpdir(), "te-import-src-"));
  for (const d of ["todo", "done", "partially-done", "mystery"]) {
    mkdirSync(join(src, d), { recursive: true });
  }
  writeFileSync(
    join(src, "done", "TASK-01 setup auth.md"),
    "# Set up auth\n\nOAuth flow with refresh tokens.\n",
  );
  writeFileSync(
    join(src, "done", "TASK-01 setup auth.simple.md"),
    "Users can log in.",
  );
  writeFileSync(
    join(src, "todo", "TASK-02 add scopes.md"),
    "# Add scopes\n\nDepends on: TASK-01 setup auth\n\nMore granular permissions.\n",
  );
  writeFileSync(
    join(src, "partially-done", "PLAN-10 mobile app.md"),
    "# Mobile app epic\n\nOrder: after TASK-02 add scopes, TASK-99 missing\n",
  );
  writeFileSync(join(src, "mystery", "TASK-03 odd.md"), "# Odd one\n");
  writeFileSync(join(src, "todo", "notitle.md"), "no heading here\n");

  home = mkdtempSync(join(tmpdir(), "te-import-home-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  const ws = resolveWorkspace(root, { home });
  store = new PlansStore(ws, "test");
  await store.init();
});

afterAll(() => {
  rmSync(src, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("import planning (IM-0001)", () => {
  it("maps folders→status, prefixes→type, deps, simple companions", async () => {
    const files = await scanFolder(src);
    const plan = planImport(files, { prefix: "WS", existingIds: [] });
    const byLegacy = new Map(plan.items.map((i) => [i.legacy_id, i]));

    expect(byLegacy.get("TASK-01 setup auth")!.status).toBe("done");
    expect(byLegacy.get("TASK-01 setup auth")!.simple).toContain("log in");
    expect(byLegacy.get("TASK-02 add scopes")!.status).toBe("ready");
    expect(byLegacy.get("TASK-02 add scopes")!.depends_on).toEqual([
      byLegacy.get("TASK-01 setup auth")!.suggestedId,
    ]);
    expect(byLegacy.get("PLAN-10 mobile app")!.type).toBe("epic");
    expect(byLegacy.get("PLAN-10 mobile app")!.status).toBe("in_progress");
    // unresolved dep + unknown folder + no title = 3+ ambiguities
    const kinds = plan.ambiguities.map((a) => a.kind);
    expect(kinds).toContain("unresolved_dep");
    expect(kinds).toContain("unknown_status");
    expect(kinds).toContain("no_title");
    // mystery folder → draft
    expect(byLegacy.get("TASK-03 odd")!.status).toBe("draft");
    // ids allocated sequentially
    const ids = plan.items.map((i) => i.suggestedId).sort();
    expect(ids[0]).toBe("WS-0001");
  });

  it("status comes from ANY path segment; duplicate names get unique ids; **Depends on:** parses", async () => {
    const f2 = mkdtempSync(join(tmpdir(), "te-import2-"));
    mkdirSync(join(f2, "Phase-1", "DONE"), { recursive: true });
    mkdirSync(join(f2, "Phase-4-Fixes"), { recursive: true });
    mkdirSync(join(f2, "Redesigned", "B1"), { recursive: true });
    writeFileSync(join(f2, "Phase-1", "DONE", "TASK-P1F-01 cloud store.md"), "# Cloud store\n\nDone work.\n");
    writeFileSync(
      join(f2, "Phase-1", "DONE", "TASK-P1F-02 op ui.md"),
      "# Op UI\n\n**Depends on:** P1F-01. **Unblocks:** P4A-09.\n",
    );
    // same basename under two different dirs — both must get their own id
    writeFileSync(join(f2, "Phase-4-Fixes", "TASK-P4F-04 schema.md"), "# Schema v1\n");
    writeFileSync(join(f2, "Redesigned", "B1", "TASK-P4F-04 schema.md"), "# Schema v2\n");
    writeFileSync(join(f2, "Phase-4-Fixes", "TASK-P4F-05 auth.md"), "# Auth\n\n**Depends on:** nothing.\n");

    const files = await scanFolder(f2);
    const plan = planImport(files, { prefix: "WS", existingIds: [] });

    // nested DONE/ anywhere in the path → done
    const items = plan.items;
    expect(items.find((i) => i.legacy_id === "TASK-P1F-01 cloud store")!.status).toBe("done");
    expect(items.find((i) => i.legacy_id === "TASK-P1F-02 op ui")!.status).toBe("done");

    // **Depends on:** P1F-01 resolves to the TASK-P1F-01 item's new id
    const p1f01 = items.find((i) => i.legacy_id === "TASK-P1F-01 cloud store")!;
    const p1f02 = items.find((i) => i.legacy_id === "TASK-P1F-02 op ui")!;
    expect(p1f02.depends_on).toEqual([p1f01.suggestedId]);

    // both copies of the duplicate name get unique ids + an ambiguity
    const dupes = items.filter((i) => i.legacy_id === "TASK-P4F-04 schema");
    expect(dupes).toHaveLength(2);
    expect(new Set(dupes.map((d) => d.suggestedId)).size).toBe(2);
    const ids = new Set(plan.items.map((i) => i.suggestedId));
    expect(ids.size).toBe(plan.items.length);
    expect(plan.ambiguities.some((a) => a.kind === "duplicate_legacy")).toBe(true);

    // "**Depends on:** nothing." is not an ambiguity
    const p4f05 = items.find((i) => i.legacy_id === "TASK-P4F-05 auth")!;
    expect(p4f05.depends_on).toEqual([]);
    expect(
      plan.ambiguities.filter((a) => a.file.includes("P4F-05")).map((a) => a.kind),
    ).not.toContain("unresolved_dep");
    rmSync(f2, { recursive: true, force: true });
  });

  it("a second import dedups by source path — same-name files elsewhere still import", async () => {
    // 'seed/TASK-02 add scopes.md' was already imported; a different file
    // that happens to share the basename must NOT be silently dropped
    await store.importItems(
      [
        {
          id: "WS-0901",
          legacy_id: "TASK-02 add scopes",
          type: "task",
          title: "Add scopes",
          status: "ready",
          depends_on: [],
          summary: "s",
          source: "seed/TASK-02 add scopes.md",
        },
      ],
      human,
    );
    const files = [
      { path: "seed/TASK-02 add scopes.md", content: "# Add scopes\n" },
      { path: "other/TASK-02 add scopes.md", content: "# Add scopes — second doc\n" },
      { path: "other/NEW-99 thing.md", content: "# Thing\n" },
    ];
    const existing = new Set(
      [...store.idx.items.values()]
        .map((i) => (i.meta as { imported_from?: string }).imported_from)
        .filter((x): x is string => Boolean(x)),
    );
    expect(existing.has("seed/TASK-02 add scopes.md")).toBe(true); // imported_from persisted
    const plan = planImport(files, {
      prefix: "WS",
      existingIds: store.idx.items.keys(),
      existingSources: existing,
    });
    // 'seed/TASK-02…' skipped by path; the same-named 'other/' copy and the
    // new file still produce items
    expect(plan.items.map((i) => i.sources[0]).sort()).toEqual([
      "other/NEW-99 thing.md",
      "other/TASK-02 add scopes.md",
    ]);
    const ids = new Set(plan.items.map((i) => i.suggestedId));
    expect(ids.size).toBe(plan.items.length);
  });

  it("dep lists skip prose and expand ranges/shorthand (P6-01…03, P1F-01/02)", async () => {
    const mk = (name: string) => ({ path: `todo/${name}.md`, content: `# ${name}\n` });
    const files = [
      mk("TASK-P4B-10-sar"),
      mk("TASK-P6-01-a"),
      mk("TASK-P6-02-b"),
      mk("TASK-P6-03-c"),
      mk("TASK-P1F-01-d"),
      mk("TASK-P1F-02-e"),
      {
        path: "todo/TASK-Z-01-main.md",
        content:
          "# Main\n\n**Depends on:** Phase 4A (roster, world model), P4B-10 (SAR), this, (all done), P6-01…P6-03, P1F-01/02\n",
      },
    ];
    const plan = planImport(files, { prefix: "WS", existingIds: [] });
    const main = plan.items.find((i) => i.legacy_id === "TASK-Z-01-main")!;
    const idOf = (l: string) => plan.items.find((i) => i.legacy_id === l)!.suggestedId;
    expect(main.depends_on.sort()).toEqual(
      [
        "TASK-P4B-10-sar",
        "TASK-P6-01-a",
        "TASK-P6-02-b",
        "TASK-P6-03-c",
        "TASK-P1F-01-d",
        "TASK-P1F-02-e",
      ]
        .map(idOf)
        .sort(),
    );
    // prose entries are not ambiguities; genuinely missing refs still are
    const unresolved = plan.ambiguities.filter((a) => a.kind === "unresolved_dep");
    expect(unresolved).toEqual([]);

    const files2 = [
      {
        path: "todo/TASK-Z-02-x.md",
        content: "# X\n\n**Depends on:** ZZ-99 (missing)\n",
      },
    ];
    const plan2 = planImport(files2, { prefix: "WS", existingIds: [] });
    expect(
      plan2.ambiguities.some(
        (a) => a.kind === "unresolved_dep" && a.message.includes("ZZ-99"),
      ),
    ).toBe(true);
  });

  it("'nothing …' lines and trailing prose sentences add no deps (no false cycles)", async () => {
    const mk = (name: string, dep: string) => ({
      path: `done/${name}.md`,
      content: `# ${name}\n\n**Depends on:** ${dep}\n`,
    });
    // real-world dep lines that produced P4B-02⇄03 and VG-01⇄02 cycles
    const files = [
      mk("TASK-P4B-02-expr", "nothing (the geo functions come from P4B-03; stub them until then)."),
      mk("TASK-P4B-03-geo", "P4B-02 (the expression geo functions call into this core)."),
      mk("TASK-VG-01-live", "nothing. It is the first B6 task. Do it before VG-02 so"),
      mk("TASK-VG-02-geom", "VG-01 committed. The owner answers OD-3, OD-4 and OD-5"),
    ];
    const plan = planImport(files, { prefix: "WS", existingIds: [] });
    const by = (l: string) => plan.items.find((i) => i.legacy_id === l)!;
    expect(by("TASK-P4B-02-expr").depends_on).toEqual([]);
    expect(by("TASK-VG-01-live").depends_on).toEqual([]);
    expect(by("TASK-P4B-03-geo").depends_on).toEqual([by("TASK-P4B-02-expr").suggestedId]);
    expect(by("TASK-VG-02-geom").depends_on).toEqual([by("TASK-VG-01-live").suggestedId]);
    // OD-3… sit in a prose sentence — not reported as missing deps
    expect(plan.ambiguities.filter((a) => a.kind === "unresolved_dep")).toEqual([]);
  });

  it("apply creates items idempotently (imported_from dedup)", async () => {
    const files = await scanFolder(src);
    const plan = planImport(files, { prefix: "WS", existingIds: [] });
    const mk = () =>
      plan.items.map((i) => ({
        id: i.suggestedId,
        legacy_id: i.legacy_id,
        type: i.type,
        title: i.title,
        status: i.status,
        depends_on: i.depends_on,
        summary: i.summary,
        simple: i.simple,
        source: i.sources[0],
      }));
    const before = store.idx.items.size;
    const r1 = await store.importItems(mk(), human);
    expect(r1.created).toHaveLength(plan.items.length);
    expect(store.idx.items.size).toBe(before + plan.items.length);
    // re-run: everything skipped
    const r2 = await store.importItems(mk(), human);
    expect(r2.created).toHaveLength(0);
    expect(r2.skipped).toHaveLength(plan.items.length);
    // item file has legacy_id + status preserved
    const f = join(plans, "items", "WS", `${r1.created[0]}.md`);
    const text = readFileSync(f, "utf8");
    expect(text).toContain("legacy_id:");
    // dep edge imported
    const depItem = [...store.idx.items.values()].find((i) => i.meta.depends_on.length > 0);
    expect(depItem).toBeDefined();
  });

  it("end-to-end apply: hostile titles re-parse cleanly", async () => {
    // titles carry `:` `()` `` ` `` `#` `"` `[]` and other YAML-hostile
    // characters — every created file must re-parse after the round-trip
    const src2 = mkdtempSync(join(tmpdir(), "te-import-hostile-"));
    mkdirSync(join(src2, "done"), { recursive: true });
    mkdirSync(join(src2, "todo"), { recursive: true });
    writeFileSync(
      join(src2, "done", "TASK-X-01 hostile.md"),
      '# TASK-X-01: Foo (bar) — `baz` #qux "zap" [wip]\n\nBody.\n',
    );
    writeFileSync(
      join(src2, "done", "TASK-X-01 hostile.simple.md"),
      'Plain words, no "markup".',
    );
    writeFileSync(
      join(src2, "todo", "TASK-X-02 dep.md"),
      "# TASK-X-02: depends\n\nDepends on: X-01\n",
    );
    const files = await scanFolder(src2);
    const plan = planImport(files, { prefix: "WS", existingIds: [] });
    expect(plan.items).toHaveLength(2);
    const idSet = new Set(plan.items.map((i) => i.suggestedId));
    expect(idSet.size).toBe(plan.items.length);
    for (const i of plan.items) for (const d of i.depends_on) expect(idSet.has(d)).toBe(true);

    // apply into a fresh store — every created file must re-parse
    const root2 = mkdtempSync(join(tmpdir(), "te-import-real-"));
    const plans2 = join(root2, ".teamengage");
    mkdirSync(join(plans2, "items"), { recursive: true });
    writeFileSync(
      join(plans2, "workspace.yaml"),
      "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: plans2 });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans2 });
    execFileSync("git", ["config", "user.name", "t"], { cwd: plans2 });
    const store2 = new PlansStore(resolveWorkspace(root2, { home }), "test");
    await store2.init();
    const r = await store2.importItems(
      plan.items.map((i) => ({
        id: i.suggestedId,
        legacy_id: i.legacy_id,
        type: i.type,
        title: i.title,
        status: i.status,
        depends_on: i.depends_on,
        summary: i.summary,
        simple: i.simple,
        source: i.sources[0],
      })),
      human,
    );
    expect(r.created).toHaveLength(plan.items.length);
    // reload the index from disk: zero invalid files
    const { Index } = await import("../core/index/index.js");
    const idx2 = await Index.load(plans2);
    expect(idx2.invalidFiles.size).toBe(0);
    expect(idx2.items.size).toBe(plan.items.length);
    rmSync(root2, { recursive: true, force: true });
    rmSync(src2, { recursive: true, force: true });
  });
});
