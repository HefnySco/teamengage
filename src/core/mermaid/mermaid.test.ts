import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "../index/index.js";
import { renderMermaid, type MermaidOpts } from "./mermaid.js";

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

  it("scoped cap keeps BFS order — the root survives, the periphery folds", () => {
    // GL-0003 <- GL-0002 <- {GL-0001, TE-0001}: alphabetical order would cut the
    // searched root itself; BFS order drops the two furthest nodes instead
    const out = renderMermaid(idx, { roots: ["GL-0003"], maxNodes: 2 });
    expect(out).toContain("GL_0003");
    expect(out).toContain("GL_0002");
    expect(out).toContain("+2 more");
    expect(out).not.toContain("GL_0001[");
    expect(out).not.toContain("TE_0001");
  });

  it("filters by status", () => {
    const out = renderMermaid(idx, { filter: { status: "done" } });
    expect(out).toContain("GL_0001");
    expect(out).not.toContain("GL_0002");
  });

  it("output parses as a real mermaid flowchart (CR-0010)", async () => {
    // node exposes dompurify's factory, not the browser instance mermaid
    // expects — stub the sanitize surface so grammar parsing runs headless
    const { default: dompurify } = await import("dompurify");
    Object.assign(dompurify, {
      sanitize: (t: string) => t,
      addHook: () => {},
      removeHook: () => {},
      removeHooks: () => {},
      removeAllHooks: () => {},
    });
    const { default: mermaid } = await import("mermaid");
    for (const opts of [
      {},
      { roots: ["TE-0001"] },
      { filter: { status: "in_progress" } },
      { maxNodes: 2 },
    ] satisfies MermaidOpts[]) {
      const parsed = await mermaid.parse(renderMermaid(idx, opts));
      expect(parsed.diagramType).toBe("flowchart-v2");
    }
  });
});
