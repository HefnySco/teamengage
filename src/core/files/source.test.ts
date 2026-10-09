import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTeTag,
  withTeTag,
  stripFrontmatter,
  resolveSource,
  overlayReport,
  scanTaskTree,
  globToRegExp,
} from "./source.js";

describe("overlay task-file tags", () => {
  it("adds a two-line block to a file without frontmatter", () => {
    const out = withTeTag("# Title\n\nBody.\n", "GL-0013");
    expect(out).toBe("---\nte: GL-0013\n---\n# Title\n\nBody.\n");
    expect(readTeTag(out)).toBe("GL-0013");
    expect(stripFrontmatter(out)).toBe("# Title\n\nBody.\n");
  });

  it("keeps other frontmatter keys verbatim and rewrites only te", () => {
    const src = "---\nowner: me # mine\nte: GL-0001\n---\n# T\n";
    expect(withTeTag(src, "GL-0002")).toBe("---\nowner: me # mine\nte: GL-0002\n---\n# T\n");
    const untagged = "---\nowner: me\n---\n# T\n";
    expect(withTeTag(untagged, "GL-0003")).toBe("---\nte: GL-0003\nowner: me\n---\n# T\n");
  });

  it("is idempotent and keeps CRLF files CRLF", () => {
    const once = withTeTag("# T\r\nx\r\n", "GL-0001");
    expect(once).toBe("---\r\nte: GL-0001\r\n---\r\n# T\r\nx\r\n");
    expect(withTeTag(once, "GL-0001")).toBe(once);
    expect(readTeTag(once)).toBe("GL-0001");
  });

  it("does not treat a leading horizontal rule as frontmatter", () => {
    const text = "---\n\n# T\n\nsome prose here.\n\n---\n";
    expect(readTeTag(text)).toBeUndefined();
    expect(withTeTag(text, "GL-0001").startsWith("---\nte: GL-0001\n---\n---\n")).toBe(true);
  });
});

describe("resolveSource", () => {
  it("uses the recorded path, else finds the moved file by its tag", async () => {
    const root = mkdtempSync(join(tmpdir(), "te-src-"));
    try {
      mkdirSync(join(root, "global", "done"), { recursive: true });
      mkdirSync(join(root, ".teamengage"), { recursive: true });
      writeFileSync(join(root, "global", "a.md"), "---\nte: GL-0001\n---\n# A\n");
      expect(await resolveSource(root, "GL-0001", "global/a.md")).toMatchObject({
        path: "global/a.md",
        moved: false,
      });

      // moved into done/ and another item's file now sits at the old path
      writeFileSync(join(root, "global", "done", "a.md"), "---\nte: GL-0001\n---\n# A\n");
      writeFileSync(join(root, "global", "done", "a.simple.md"), "---\nte: GL-0001\n---\nplain\n");
      writeFileSync(join(root, "global", "a.md"), "---\nte: GL-0009\n---\n# other\n");
      writeFileSync(join(root, ".teamengage", "x.md"), "---\nte: GL-0001\n---\n");
      expect(await resolveSource(root, "GL-0001", "global/a.md")).toMatchObject({
        path: "global/done/a.md",
        moved: true,
      });
      expect(
        await resolveSource(root, "GL-0001", "global/a.simple.md", { simple: true }),
      ).toMatchObject({ path: "global/done/a.simple.md" });
      expect(await resolveSource(root, "GL-0404", "nope.md")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("overlayReport", () => {
  const scan = (tagged: Record<string, string[]>, untracked: string[] = []) => ({
    tagged: new Map(Object.entries(tagged)),
    untracked,
  });

  it("moves a source to where its tag now is; the tag beats a new file at the old path", () => {
    const r = overlayReport(
      scan({ "GL-0001": ["g/done/a.md", "g/done/a.simple.md"] }, ["g/a.md"]),
      [{ id: "GL-0001", source: "g/a.md", simple_source: "g/a.simple.md" }],
    );
    expect(r.moves).toEqual([{ id: "GL-0001", source: "g/done/a.md", simple_source: "g/done/a.simple.md" }]);
    expect(r.findings.map((f) => f.kind)).toEqual(["untracked_task_file"]);
  });

  it("keeps an untagged file at its recorded path, flags a vanished one", () => {
    const r = overlayReport(scan({}, ["g/a.md"]), [
      { id: "GL-0001", source: "g/a.md" },
      { id: "GL-0002", source: "g/b.md" },
    ]);
    expect(r.moves).toEqual([]);
    expect(r.findings).toEqual([
      expect.objectContaining({ kind: "missing_source", item: "GL-0002", path: "g/b.md" }),
    ]);
  });

  it("flags a copied task file, unknown tags and untracked files", () => {
    const r = overlayReport(
      scan({ "GL-0001": ["g/a.md", "g/a-copy.md"], "GL-0999": ["g/x.md"] }, ["g/new.md"]),
      [{ id: "GL-0001", source: "g/a.md" }],
    );
    expect(r.moves).toEqual([]);
    expect(r.findings.map((f) => [f.kind, f.path])).toEqual([
      ["duplicate_tag", "g/a-copy.md"],
      ["unknown_tag", "g/x.md"],
      ["untracked_task_file", "g/new.md"],
    ]);
  });

  it("a .simple.md-only item moves via its source", () => {
    const r = overlayReport(scan({ "GL-0001": ["g/done/a.simple.md"] }), [
      { id: "GL-0001", source: "g/a.simple.md" },
    ]);
    expect(r.moves).toEqual([{ id: "GL-0001", source: "g/done/a.simple.md" }]);
  });
});

describe("scanTaskTree", () => {
  it("splits tagged/untracked, skips dot-dirs, applies ignore globs", async () => {
    const root = mkdtempSync(join(tmpdir(), "te-scan-"));
    try {
      mkdirSync(join(root, "g", "deep"), { recursive: true });
      mkdirSync(join(root, ".teamengage", "items"), { recursive: true });
      writeFileSync(join(root, "g", "a.md"), "---\nte: GL-0001\n---\n# A\n");
      writeFileSync(join(root, "g", "deep", "b.md"), "# B\n");
      writeFileSync(join(root, "g", "README.md"), "# readme\n");
      writeFileSync(join(root, "README.md"), "# readme\n");
      writeFileSync(join(root, "g", "notes.txt"), "x");
      writeFileSync(join(root, ".teamengage", "items", "GL-0001.md"), "---\nid: GL-0001\n---\n");
      const s = await scanTaskTree(root, ["**/README.md"]);
      expect([...s.tagged]).toEqual([["GL-0001", ["g/a.md"]]]);
      expect(s.untracked).toEqual(["g/deep/b.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("globToRegExp: * stays in one segment, **/ spans zero or more", () => {
    expect(globToRegExp("*.md").test("a.md")).toBe(true);
    expect(globToRegExp("*.md").test("g/a.md")).toBe(false);
    expect(globToRegExp("**/README.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/README.md").test("a/b/README.md")).toBe(true);
    expect(globToRegExp("mission_planner/**").test("mission_planner/x/y.md")).toBe(true);
  });
});

describe("-simplified.md companions", () => {
  it("count as the simple slot in overlay reports", () => {
    const r = overlayReport(
      { tagged: new Map([["WC-0001", ["w/done/a.md", "w/done/a-simplified.md"]]]), untracked: [] },
      [{ id: "WC-0001", source: "w/a.md", simple_source: "w/a-simplified.md" }],
    );
    expect(r.moves).toEqual([{ id: "WC-0001", source: "w/done/a.md", simple_source: "w/done/a-simplified.md" }]);
  });
});

describe("withoutTeTag", () => {
  it("removes only te:, drops an emptied block, ignores other ids", async () => {
    const { withoutTeTag } = await import("./source.js");
    expect(withoutTeTag("---\nte: GL-0001\n---\n# A\n", "GL-0001")).toBe("# A\n");
    expect(withoutTeTag("---\nowner: me\nte: GL-0001\n---\n# A\n", "GL-0001")).toBe("---\nowner: me\n---\n# A\n");
    expect(withoutTeTag("---\nte: GL-0002\n---\n# A\n", "GL-0001")).toBe("---\nte: GL-0002\n---\n# A\n");
    expect(withoutTeTag("# plain\n", "GL-0001")).toBe("# plain\n");
  });
});

describe("overlayReport: companions added later", () => {
  it("adopts a newly tagged .simple.md as simple_source", () => {
    const r = overlayReport(
      { tagged: new Map([["AN-0004", ["andruav/04-final.md", "andruav/04-final.simple.md"]]]), untracked: [] },
      [{ id: "AN-0004", source: "andruav/04-final.md" }],
    );
    expect(r.moves).toEqual([{ id: "AN-0004", simple_source: "andruav/04-final.simple.md" }]);
    expect(r.findings).toEqual([]);
  });

  it("two companions → a finding, nothing adopted", () => {
    const r = overlayReport(
      { tagged: new Map([["AN-0004", ["a.md", "a.simple.md", "a-simplified.md"]]]), untracked: [] },
      [{ id: "AN-0004", source: "a.md" }],
    );
    expect(r.moves).toEqual([]);
    expect(r.findings.map((f) => f.kind)).toEqual(["duplicate_tag"]);
  });
});

describe("appendNote", () => {
  it("appends at the end of ## Notes, before the next section, never touching other lines", async () => {
    const { appendNote } = await import("./source.js");
    const B = "**t · human**\n\nline one\nline two\n";
    expect(appendNote("# T\n\n## Notes\n- old\n\n## Log\nx\n", B)).toBe(
      "# T\n\n## Notes\n- old\n\n**t · human**\n\nline one\nline two\n\n## Log\nx\n",
    );
    // last section, empty
    expect(appendNote("# T\n\n## Notes\n\n", B)).toBe("# T\n\n## Notes\n\n**t · human**\n\nline one\nline two\n");
    // no Notes section → added at the end
    expect(appendNote("# T\nbody\n", B)).toBe("# T\nbody\n\n## Notes\n\n**t · human**\n\nline one\nline two\n");
    // a '## Notes' inside a code fence is not the section
    expect(appendNote("# T\n```\n## Notes\n```\n", "n")).toBe("# T\n```\n## Notes\n```\n\n## Notes\n\nn\n");
    // CRLF kept
    expect(appendNote("# T\r\n## Notes\r\n", "n")).toBe("# T\r\n## Notes\r\n\r\nn\r\n");
  });
});
