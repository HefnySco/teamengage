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

  it("apply creates items idempotently (legacy_id dedup)", async () => {
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
      }));
    const r1 = await store.importItems(mk(), human);
    expect(r1.created).toHaveLength(plan.items.length);
    expect(store.idx.items.size).toBe(plan.items.length);
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
});
