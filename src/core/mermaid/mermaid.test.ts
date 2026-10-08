import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "../index/index.js";
import { renderMermaid } from "./mermaid.js";

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
      .join("\n")}\n---\n`,
  );
}

let idx: Index;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "te-mm-"));
  plans = join(dir, ".teamengage");
  item("TE-0001", { type: "epic", status: "draft" });
  item("GL-0001", { parent: "TE-0001", status: "done" });
  item("GL-0002", { depends_on: "[GL-0001]", parent: "TE-0001", title: '\'q "uote" [x] {y}\'' });
  item("GL-0003", { depends_on: "[GL-0002]", status: "in_progress" });
  idx = await Index.load(plans);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("renderMermaid", () => {
  it("is deterministic — same input, byte-identical output", () => {
    expect(renderMermaid(idx)).toBe(renderMermaid(idx));
  });

  it("renders nodes, dep edges solid, parent edges dotted, classDefs", () => {
    const out = renderMermaid(idx);
    expect(out).toContain("flowchart LR");
    expect(out).toContain("GL_0001 --> GL_0002");
    expect(out).toContain("TE_0001 -.-> GL_0002");
    expect(out).toContain("classDef done");
    expect(out).toContain(":::done");
    expect(out).toContain(":::active");
  });

  it("escapes quotes and brackets in labels", () => {
    const out = renderMermaid(idx);
    expect(out).not.toContain('"quotey [brackets]"');
    expect(out).toContain("#quot;");
    expect(out).toContain("#91;");
  });

  it("scopes to roots with depth", () => {
    const out = renderMermaid(idx, { roots: ["GL-0002"], depth: 0 });
    expect(out).toContain("GL_0002");
    expect(out).not.toContain("GL_0001[");
  });

  it("caps nodes and adds '+N more'", () => {
    const out = renderMermaid(idx, { maxNodes: 2 });
    expect(out).toContain('+2 more');
  });

  it("filters by status", () => {
    const out = renderMermaid(idx, { filter: { status: "done" } });
    expect(out).toContain("GL_0001");
    expect(out).not.toContain("GL_0002");
  });
});
