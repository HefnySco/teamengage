import { describe, it, expect } from "vitest";
import {
  parseItemFile,
  serializeMarkdown,
  appendLog,
  getSection,
  setSection,
  emitFrontmatter,
} from "./markdown.js";
import { ConflictMarkersError, ParseError } from "../model/errors.js";

const SAMPLE = `---
id: GL-0013
type: task
title: "Mission re-run resets sequence tracking"
status: in_progress
project: global
targets: ["@mavlink:src/mission/**", "@comm:src/**"]
depends_on: [GL-0012]
parent: DE-0003
priority: 2
version: 7
created: 2026-09-20
updated: 2026-10-08
---

## Summary
...technical description...

## Simple
plain english

## Acceptance
- [ ] second AUTO run fires

## Log
- 2026-10-08T09:12Z claude-code@desktop#a1f3 claimed
`;

describe("parse/serialize round-trip", () => {
  it("is byte-identical for an unmodified file", () => {
    const doc = parseItemFile(SAMPLE);
    expect(doc.meta.id).toBe("GL-0013");
    expect(doc.sections.map((s) => s.heading)).toEqual([
      "Summary",
      "Simple",
      "Acceptance",
      "Log",
    ]);
    expect(serializeMarkdown(doc)).toBe(SAMPLE);
  });

  it("round-trips CRLF files byte-identically", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const doc = parseItemFile(crlf);
    expect(serializeMarkdown(doc)).toBe(crlf);
    appendLog(doc, "- 2026-10-08T10:00Z devin log line");
    const out = serializeMarkdown(doc);
    expect(out).toContain("\r\n");
    expect(out).not.toMatch(/(?<!\r)\n/);
    expect(out).toContain("devin log line\r\n");
  });

  it("round-trips empty body and unicode", () => {
    const text = "---\nid: TE-0001\ntype: epic\ntitle: \"café — ünïcodé 日本語\"\nstatus: draft\nversion: 1\n---\n";
    const doc = parseItemFile(text);
    expect(doc.sections).toEqual([]);
    expect(serializeMarkdown(doc)).toBe(text);
    expect(doc.meta.title).toContain("日本語");
  });

  it("rejects missing frontmatter and unterminated frontmatter", () => {
    expect(() => parseItemFile("no frontmatter\n")).toThrow(ParseError);
    expect(() => parseItemFile("---\nid: X\n")).toThrow(ParseError);
  });

  it("rejects files with conflict markers, never parses them", () => {
    const conflicted = SAMPLE.replace(
      "## Summary\n",
      "## Summary\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n",
    );
    expect(() => parseItemFile(conflicted, "x.md")).toThrow(ConflictMarkersError);
  });
});

describe("sections", () => {
  it("getSection / setSection / appendLog", () => {
    const doc = parseItemFile(SAMPLE);
    expect(getSection(doc, "summary")!.trimEnd()).toBe("...technical description...");
    setSection(doc, "Summary", "new body\n");
    expect(getSection(doc, "Summary")).toBe("new body\n");
    appendLog(doc, "- 2026-10-08T10:00Z devin submitted");
    expect(getSection(doc, "Log")).toContain("claimed\n- 2026-10-08T10:00Z devin submitted\n");
    // untouched sections serialize verbatim
    const out = serializeMarkdown(doc);
    expect(out).toContain("## Simple\nplain english\n");
  });

  it("appendLog creates the Log section when missing", () => {
    const text = "---\nid: TE-0002\ntype: task\ntitle: t\nstatus: draft\nversion: 1\n---\n\n## Summary\nx\n";
    const doc = parseItemFile(text);
    appendLog(doc, "- first");
    const out = serializeMarkdown(doc);
    expect(out).toContain("## Log\n- first\n");
    expect(out.indexOf("## Summary")).toBeLessThan(out.indexOf("## Log"));
  });

  it("appendLog only adds lines at the end of ## Log", () => {
    const doc = parseItemFile(SAMPLE);
    const before = getSection(doc, "Log")!;
    appendLog(doc, "- tail");
    expect(getSection(doc, "Log")).toBe(before + "- tail\n");
  });
});

describe("artifacts", () => {
  const WITH_ARTIFACTS = SAMPLE.replace(
    "## Log\n",
    `## Artifacts
- andruav/an0133-v2-sms.png — SMS tab mockup
- webclient/wc0001-map.png — map view, 3d #webclient #map3d
- andruav/an0133-phone.png — real phone number shot !sensitive

## Log\n`,
  );

  it("parses plain, #tagged and !sensitive lines into item.artifacts", () => {
    const doc = parseItemFile(WITH_ARTIFACTS);
    expect(doc.artifacts).toEqual([
      {
        path: "andruav/an0133-v2-sms.png",
        caption: "SMS tab mockup",
        domains: [],
        sensitive: false,
      },
      {
        path: "webclient/wc0001-map.png",
        caption: "map view, 3d",
        domains: ["webclient", "map3d"],
        sensitive: false,
      },
      {
        path: "andruav/an0133-phone.png",
        caption: "real phone number shot",
        domains: [],
        sensitive: true,
      },
    ]);
  });

  it("a line with no #tags inherits the item's domains", () => {
    const text = WITH_ARTIFACTS.replace(
      "depends_on: [GL-0012]",
      "domains: [android, comm]\ndepends_on: [GL-0012]",
    );
    const doc = parseItemFile(text);
    expect(doc.artifacts[0].domains).toEqual(["android", "comm"]);
    expect(doc.artifacts[2].domains).toEqual(["android", "comm"]);
    // own #tags still win over the item's
    expect(doc.artifacts[1].domains).toEqual(["webclient", "map3d"]);
  });

  it("skips lines that do not match the format; no section → []", () => {
    const text = SAMPLE.replace(
      "## Log\n",
      "## Artifacts\nnot a list line\n- missingcaption.png\n- p/x.png — real line\n\n## Log\n",
    );
    const doc = parseItemFile(text);
    expect(doc.artifacts).toEqual([
      { path: "p/x.png", caption: "real line", domains: [], sensitive: false },
    ]);
    expect(parseItemFile(SAMPLE).artifacts).toEqual([]);
  });
});

describe("meta changes", () => {
  it("changed meta re-emits canonically with fixed key order and flow arrays", () => {
    const doc = parseItemFile(SAMPLE);
    doc.meta.status = "done";
    const out = serializeMarkdown(doc);
    const fm = out.slice(0, out.indexOf("\n## "));
    const keys = [...fm.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      "id",
      "type",
      "title",
      "status",
      "project",
      "targets",
      "depends_on",
      "parent",
      "priority",
      "version",
      "created",
      "updated",
    ]);
    expect(fm).toContain('targets: ["@mavlink:src/mission/**", "@comm:src/**"]');
    expect(fm).toContain("status: done");
  });

  it("emitFrontmatter keeps unknown fields after known ones", () => {
    const fm = emitFrontmatter({ title: "t", id: "X-1", extra_z: 1, extra_a: 2 });
    expect(fm.indexOf("id:")).toBeLessThan(fm.indexOf("title:"));
    expect(fm.indexOf("extra_z")).toBeLessThan(fm.indexOf("extra_a"));
  });
});
