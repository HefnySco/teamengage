import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "../index/index.js";
import { validate, type FindingKind } from "./validate.js";

let dir: string;
let plans: string;

function item(id: string, fields: Record<string, string> = {}) {
  const prefix = id.split("-")[0];
  mkdirSync(join(plans, "items", prefix), { recursive: true });
  const meta = { status: "ready", type: "task", title: `"${id}"`, version: "1", ...fields };
  writeFileSync(
    join(plans, "items", prefix, `${id}.md`),
    `---\n${Object.entries({ id, ...meta })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n---\n\n## Summary\nx\n`,
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "te-val-"));
  plans = join(dir, ".teamengage");
  item("GL-0001", { status: "done" });
  item("GL-0002", { depends_on: "[GL-0001, GL-9999]" }); // dangling
  item("GL-0003", { status: "done", depends_on: "[GL-0002]" }); // done w/ open dep
  item("CY-0001", { depends_on: "[CY-0002]" });
  item("CY-0002", { depends_on: "[CY-0001]" });
  // duplicate id in a second file
  mkdirSync(join(plans, "items", "XX"), { recursive: true });
  writeFileSync(
    join(plans, "items", "XX", "XX-0001.md"),
    "---\nid: GL-0001\ntype: task\ntitle: dup\nstatus: done\nversion: 1\n---\n",
  );
  // invalid frontmatter
  writeFileSync(join(plans, "items", "XX", "XX-0002.md"), "---\nbad: [x\n---\n");
  // conflict markers
  writeFileSync(
    join(plans, "items", "XX", "XX-0003.md"),
    "---\nid: XX-0003\n---\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n",
  );
  mkdirSync(join(plans, "claims"), { recursive: true });
  // claim on missing item + stale + overlapping
  writeFileSync(
    join(plans, "claims", "GHOST-1.yaml"),
    "item: GHOST-1\nholder: a@m#1\nactor: agent\nmachine: m\nclaimed_at: old\nlast_seen: 2020-01-01T00:00:00Z\ntargets: ['@r:src/**']\n",
  );
  writeFileSync(
    join(plans, "claims", "GL-0002.yaml"),
    "item: GL-0002\nholder: a@m#1\nactor: agent\nmachine: m\nclaimed_at: old\nlast_seen: 2020-01-01T00:00:00Z\ntargets: ['@r:src/a/**']\n",
  );
  writeFileSync(
    join(plans, "claims", "GL-0001.yaml"),
    "item: GL-0001\nholder: b@m#2\nactor: agent\nmachine: m\nclaimed_at: old\nlast_seen: 2020-01-01T00:00:00Z\ntargets: ['@r:src/**']\n",
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("validate", () => {
  it("reports every finding kind", async () => {
    const idx = await Index.load(plans);
    const kinds = new Set(validate(idx, { now: Date.now() }).map((f) => f.kind));
    const want: FindingKind[] = [
      "dangling_ref",
      "cycle",
      "done_with_open_deps",
      "duplicate_id",
      "invalid_frontmatter",
      "conflict_markers",
      "claim_on_missing",
      "claim_on_done",
      "overlapping_claims",
      "stale_claim",
    ];
    for (const k of want) expect(kinds, `missing ${k}`).toContain(k);
  });

  it("findings carry severity, item id, path, message", async () => {
    const idx = await Index.load(plans);
    for (const f of validate(idx)) {
      expect(f.severity).toMatch(/error|warning|info/);
      expect(f.message.length).toBeGreaterThan(0);
    }
  });

  it("runs on 500 items in < 200ms", async () => {
    const big = mkdtempSync(join(tmpdir(), "te-bigv-"));
    const bp = join(big, ".teamengage", "items", "GL");
    mkdirSync(bp, { recursive: true });
    for (let i = 1; i <= 500; i++) {
      writeFileSync(
        join(bp, `GL-${String(i).padStart(4, "0")}.md`),
        `---\nid: GL-${String(i).padStart(4, "0")}\ntype: task\ntitle: x\nstatus: ready\nversion: 1\n---\n`,
      );
    }
    const idx = await Index.load(join(big, ".teamengage"));
    const t0 = performance.now();
    validate(idx);
    expect(performance.now() - t0).toBeLessThan(200);
    rmSync(big, { recursive: true, force: true });
  });
});
