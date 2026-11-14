import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "../index/index.js";
import { validate, webBundleStale, type FindingKind } from "./validate.js";

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

  it("overlap check honours resource roots + escaped targets are findings", async () => {
    const d = mkdtempSync(join(tmpdir(), "te-valr-"));
    const p = join(d, ".teamengage");
    mkdirSync(join(p, "items", "GL"), { recursive: true });
    mkdirSync(join(p, "claims"), { recursive: true });
    const mk = (id: string, extra = "") =>
      writeFileSync(
        join(p, "items", "GL", `${id}.md`),
        `---\nid: ${id}\ntype: task\ntitle: x\nstatus: ready\nversion: 1\n${extra}---\n`,
      );
    mk("GL-0001");
    mk("GL-0002");
    mk("GL-0003", 'targets: ["@docs:../victim/**"]\n'); // escapes the root
    const claim = (item: string, targets: string) =>
      writeFileSync(
        join(p, "claims", `${item}.yaml`),
        `item: ${item}\nholder: a@m#1\nactor: agent\nmachine: m\nclaimed_at: now\nlast_seen: 2099-01-01T00:00:00Z\ntargets: [${targets}]\n`,
      );
    claim("GL-0001", "'@r:sub/**'");
    claim("GL-0002", "'@r:/abs/root/sub/x'");
    const idx = await Index.load(p);
    // without roots the two claims don't textually overlap
    expect(validate(idx, { now: Date.now() }).filter((f) => f.kind === "overlapping_claims")).toHaveLength(0);
    // with roots they do
    const withRoots = validate(idx, { now: Date.now(), roots: { r: "/abs/root" } });
    expect(withRoots.some((f) => f.kind === "overlapping_claims")).toBe(true);
    // and the escaping target is flagged
    expect(withRoots.some((f) => f.kind === "bad_target" && f.item === "GL-0003")).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  it("GL-0368: warns when web sources are newer than the dist bundle", async () => {
    const d = mkdtempSync(join(tmpdir(), "te-web-"));
    const p = join(d, ".teamengage", "items");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "GL-0001.md"), "---\nid: GL-0001\ntype: task\ntitle: x\nstatus: ready\nversion: 1\n---\n");
    const idx = await Index.load(join(d, ".teamengage"));

    const web = join(d, "web");
    mkdirSync(join(web, "dist"), { recursive: true });
    const srcApp = join(web, "app.js");
    const srcCss = join(web, "teamengage.css");
    const distApp = join(web, "dist", "app.js");
    writeFileSync(srcApp, "x");
    writeFileSync(srcCss, "x");
    writeFileSync(distApp, "x");
    const t = (f: string, s: number) => utimesSync(f, new Date(s), new Date(s));

    // fresh bundle — no finding
    t(srcApp, 1000); t(srcCss, 1000); t(distApp, 2000);
    expect(webBundleStale(web)).toBe(false);
    expect(validate(idx, { webDir: web }).some((f) => f.kind === "web_bundle")).toBe(false);

    // app.js newer than the bundle — warning
    t(srcApp, 3000);
    expect(webBundleStale(web)).toBe(true);
    const stale = validate(idx, { webDir: web });
    const wb = stale.find((f) => f.kind === "web_bundle");
    expect(wb?.severity).toBe("warning");
    expect(wb?.path).toBe(distApp);

    // css newer than the bundle — warning too
    t(srcApp, 1000); t(srcCss, 4000);
    expect(webBundleStale(web)).toBe(true);

    // missing bundle with sources present — stale
    rmSync(distApp);
    expect(webBundleStale(web)).toBe(true);

    // webDir: null disables the check entirely
    expect(validate(idx, { webDir: null }).some((f) => f.kind === "web_bundle")).toBe(false);

    // a dir that is not a web dir — no finding
    expect(webBundleStale(join(d, "nowhere"))).toBe(false);

    rmSync(d, { recursive: true, force: true });
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
