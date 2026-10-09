import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseItemRef,
  formatItemRef,
  parseTargetRef,
  formatTargetRef,
  allocateId,
  resolveRef,
  idPrefix,
  idNumber,
} from "./refs.js";
import { renumber, rewriteText } from "./renumber.js";
import { ValidationError, NotFoundError } from "../model/errors.js";

describe("reference parsing round-trips (DESIGN §4.1)", () => {
  it.each([
    ["MP-0042", { workspace: undefined, id: "MP-0042" }],
    ["mcp:SL-0007", { workspace: "mcp", id: "SL-0007" }],
  ])("%s", (s, want) => {
    expect(parseItemRef(s)).toEqual(want);
    expect(formatItemRef(parseItemRef(s))).toBe(s);
  });
  it.each([
    ["@mavlink", { resource: "mavlink", pattern: undefined, absolute: undefined }],
    ["@mavlink:src/mission/**", { resource: "mavlink", pattern: "src/mission/**", absolute: false }],
    ["@rpi-field:/home/pi/de/config", { resource: "rpi-field", pattern: "/home/pi/de/config", absolute: true }],
  ])("%s", (s, want) => {
    expect(parseTargetRef(s)).toEqual(want);
    expect(formatTargetRef(parseTargetRef(s))).toBe(s);
  });
  it("rejects malformed refs", () => {
    expect(() => parseItemRef("GL0013")).toThrow(ValidationError);
    expect(() => parseTargetRef("mavlink:x")).toThrow(ValidationError);
  });
});

describe("id helpers", () => {
  it("prefix/number", () => {
    expect(idPrefix("GL-0013")).toBe("GL");
    expect(idNumber("GL-0013")).toBe(13);
  });
  it("allocateId is max+1 zero-padded and never reuses", () => {
    expect(allocateId("GL", ["GL-0001", "GL-0013", "MP-0002"])).toBe("GL-0014");
    expect(allocateId("GL", [])).toBe("GL-0001");
    expect(allocateId("GL", ["GL-0100"])).toBe("GL-0101");
  });
});

describe("resolveRef", () => {
  const ctx = { currentWorkspace: "de", linkedWorkspaces: new Set(["mcp"]) };
  it("resolves local and linked refs", () => {
    expect(resolveRef("GL-0001", ctx).workspace).toBe("de");
    expect(resolveRef("mcp:SL-0007", ctx).workspace).toBe("mcp");
  });
  it("unknown workspace → NotFound", () => {
    expect(() => resolveRef("nope:X-1", ctx)).toThrow(NotFoundError);
  });
});

describe("renumber", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "te-renum-"));
    mkdirSync(join(dir, "items", "GL"), { recursive: true });
    mkdirSync(join(dir, "claims"), { recursive: true });
    writeFileSync(
      join(dir, "items", "GL", "GL-0002.md"),
      `---\nid: GL-0002\ntype: task\ntitle: "second GL-0001 followup"\nstatus: ready\ndepends_on: [GL-0001]\nversion: 1\n---\n\n## Summary\nFinishes GL-0001 work.\n`,
    );
    writeFileSync(
      join(dir, "items", "GL", "GL-0001.md"),
      `---\nid: GL-0001\ntype: task\ntitle: "first"\nstatus: in_progress\nversion: 1\n---\n\n## Log\n- claimed\n`,
    );
    writeFileSync(
      join(dir, "claims", "GL-0001.yaml"),
      "item: GL-0001\nholder: a@b#1\nactor: agent\nmachine: m\nclaimed_at: t\nlast_seen: t\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("rewriteText updates meta refs and body mentions", () => {
    const text = `---\nid: GL-0009\ndepends_on: [GL-0001, MP-0001]\nparent: GL-0001\n---\nbody GL-0001 end`;
    const out = rewriteText(text, "GL-0001", "GL-0042")!;
    expect(out).toContain("depends_on: [GL-0042, MP-0001]");
    expect(out).toContain("parent: GL-0042");
    expect(out).toContain("body GL-0042 end");
  });

  it("renumber rewrites refs and renames files", async () => {
    const r = await renumber(dir, "GL-0001", "GL-0042");
    expect(r.changedFiles.length).toBeGreaterThanOrEqual(3);
    const dep = readFileSync(join(dir, "items", "GL", "GL-0002.md"), "utf8");
    expect(dep).toContain("depends_on: [GL-0042]");
    expect(dep).toContain("GL-0042 followup");
    expect(dep).toContain("GL-0042 work");
    expect(existsSync(join(dir, "items", "GL", "GL-0042.md"))).toBe(true);
    expect(existsSync(join(dir, "claims", "GL-0042.yaml"))).toBe(true);
    expect(readFileSync(join(dir, "claims", "GL-0042.yaml"), "utf8")).toContain("item: GL-0042");
    // idempotent-ish: second run finds nothing to change
    const r2 = await renumber(dir, "GL-0001", "GL-0043");
    expect(r2.changedFiles).toHaveLength(0);
  });

  it("rejects cross-prefix renumber", async () => {
    await expect(renumber(dir, "GL-0002", "MP-0002")).rejects.toThrow(ValidationError);
  });
});

describe("compareIds", () => {
  it("prefix first, then the number numerically", async () => {
    const { compareIds } = await import("./refs.js");
    expect(["MP-0210", "AN-0002", "MP-0199", "MP-1000", "MP-0205", "GL-0019"].sort(compareIds)).toEqual([
      "AN-0002",
      "GL-0019",
      "MP-0199",
      "MP-0205",
      "MP-0210",
      "MP-1000",
    ]);
  });
});
