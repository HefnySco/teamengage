import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "./index.js";

let dir: string;
let plans: string;

function writeItem(id: string, fields: Record<string, string> = {}, body = "## Summary\nx\n") {
  const prefix = id.split("-")[0];
  mkdirSync(join(plans, "items", prefix), { recursive: true });
  const p = join(plans, "items", prefix, `${id}.md`);
  const meta: Record<string, string> = {
    id,
    type: "task",
    title: `"${id} title"`,
    status: "ready",
    priority: "2",
    version: "1",
    created: "2026-10-01",
    ...fields,
  };
  const fm = Object.entries(meta)
    .map(([k, v]) => (v.includes("\n") ? v : `${k}: ${v}`))
    .join("\n")
    .replace(/^_multi_/gm, "");
  writeFileSync(p, `---\n${fm}\n---\n\n${body}`);
  return p;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "te-idx-"));
  plans = join(dir, ".teamengage");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Index", () => {
  it("derives blocked/blocks/ready/turn correctly (DESIGN §5)", async () => {
    writeItem("GL-0001", { status: "done" });
    writeItem("GL-0002", { depends_on: "[GL-0001]", parent: "TE-0001" }); // dep done → ready
    writeItem("GL-0003", { depends_on: "[GL-0002]" }); // dep ready → blocked
    writeItem("GL-0004", { status: "in_progress" });
    writeItem("TE-0001", { type: "epic", status: "draft" }, "## Children\n- GL-0002\n");
    const idx = await Index.load(plans);
    expect(idx.get("GL-0002")!.blocked).toBe(false);
    expect(idx.get("GL-0002")!.ready).toBe(true);
    expect(idx.get("GL-0003")!.blocked).toBe(true);
    expect(idx.get("GL-0003")!.ready).toBe(false);
    expect(idx.get("GL-0004")!.ready).toBe(false); // in_progress, not ready
    expect(idx.get("GL-0004")!.turn).toBe("agent");
    expect(idx.get("TE-0001")!.turn).toBe("human");
    expect(idx.get("GL-0001")!.blocks).toContain("GL-0002");
    expect(idx.get("TE-0001")!.children).toContain("GL-0002");
  });

  it("claimed items are not ready", async () => {
    mkdirSync(join(plans, "claims"), { recursive: true });
    writeFileSync(
      join(plans, "claims", "GL-0002.yaml"),
      "item: GL-0002\nholder: a@m#1\nactor: agent\nmachine: m\nclaimed_at: t\nlast_seen: t\n",
    );
    const idx = await Index.load(plans);
    expect(idx.get("GL-0002")!.ready).toBe(false);
    expect(idx.get("GL-0002")!.claim?.holder).toBe("a@m#1");
  });

  it("incremental upsertFile equals full reload", async () => {
    const idx = await Index.load(plans);
    const before = JSON.stringify([...idx.items.keys()].sort());
    const f = writeItem("GL-0009", { depends_on: "[GL-0003]" });
    await idx.upsertFile(f);
    expect(idx.get("GL-0009")!.blocked).toBe(true);
    // modify it → unblocked dep
    writeFileSync(f, readFileSync(f, "utf8").replace("GL-0003", "GL-0001"));
    await idx.upsertFile(f);
    expect(idx.get("GL-0009")!.blocked).toBe(false);
    const fresh = await Index.load(plans);
    expect(JSON.stringify([...fresh.items.keys()].sort())).toContain("GL-0009");
    expect(fresh.get("GL-0009")!.blocked).toBe(false);
    expect(before).toContain("GL-0003");
  });

  it("upsertFile on an already-indexed item is not a duplicate", async () => {
    const idx = await Index.load(plans);
    expect(idx.duplicates).toEqual([]);
    // store/watcher callers pass the ABSOLUTE path; entries store rel paths
    const f = join(plans, idx.get("GL-0001")!.path);
    await idx.upsertFile(f);
    expect(idx.duplicates).toEqual([]);
    // a second file with the same id IS a duplicate
    mkdirSync(join(plans, "items", "OT"), { recursive: true });
    const dupe = join(plans, "items", "OT", "GL-0001-copy.md");
    writeFileSync(
      dupe,
      `---\nid: GL-0001\ntype: task\ntitle: copy\nstatus: ready\nversion: 1\n---\n\n## Summary\nx\n`,
    );
    await idx.upsertFile(dupe);
    expect(idx.duplicates).toContain("GL-0001");
    rmSync(dupe);
  });

  it("removeFile drops the item", async () => {
    const idx = await Index.load(plans);
    const f = join(plans, "items", "GL", "GL-0009.md");
    idx.removeFile(f);
    expect(idx.get("GL-0009")).toBeUndefined();
  });

  it("cycles don't crash; they are recorded", async () => {
    writeItem("CY-0001", { depends_on: "[CY-0002]" });
    writeItem("CY-0002", { depends_on: "[CY-0001]" });
    const idx = await Index.load(plans);
    expect(idx.cycles.length).toBeGreaterThan(0);
    expect(idx.cycles.flat()).toContain("CY-0001");
  });

  it("invalid files are recorded, not fatal", async () => {
    const p = join(plans, "items", "GL", "BROKEN-1.md");
    writeFileSync(p, "---\nnot: [valid\n---\n");
    const idx = await Index.load(plans);
    expect([...idx.invalidFiles.keys()].some((k) => k.endsWith("BROKEN-1.md"))).toBe(true);
    rmSync(p);
  });

  it("query filters by status/project/resource/text", async () => {
    const idx = await Index.load(plans);
    expect(idx.query({ status: "ready" }).every((i) => i.meta.status === "ready")).toBe(true);
    expect(idx.query({ text: "gl-0002 title" }).map((i) => i.meta.id)).toEqual(["GL-0002"]);
  });
});

describe("500-item fixture", () => {
  it("loads in < 300ms", async () => {
    const big = mkdtempSync(join(tmpdir(), "te-big-"));
    const bp = join(big, ".teamengage", "items", "GL");
    mkdirSync(bp, { recursive: true });
    for (let i = 1; i <= 500; i++) {
      const id = `GL-${String(i).padStart(4, "0")}`;
      const dep = i > 1 ? `depends_on: [GL-${String(i - 1).padStart(4, "0")}]\n` : "";
      writeFileSync(
        join(bp, `${id}.md`),
        `---\nid: ${id}\ntype: task\ntitle: "item ${i}"\nstatus: ${i === 1 ? "done" : "ready"}\n${dep}priority: 2\nversion: 1\n---\n\n## Summary\nx\n`,
      );
    }
    // best-of-3: file-cache warm, less sensitive to parallel-suite CPU contention
    let ms = Infinity;
    let idx!: Index;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      idx = await Index.load(join(big, ".teamengage"));
      ms = Math.min(ms, performance.now() - t0);
    }
    expect(idx.items.size).toBe(500);
    expect(idx.get("GL-0002")!.blocked).toBe(false);
    expect(idx.get("GL-0500")!.blocked).toBe(true);
    expect(ms).toBeLessThan(300);
    rmSync(big, { recursive: true, force: true });
  });
});
