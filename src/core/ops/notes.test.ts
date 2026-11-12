import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNote, bodyWithoutNotes, linkNote, noteTaskDraft, parseNotes, readNotes } from "./notes.js";
import { loadMachines } from "./machine.js";
import { scanTaskTree } from "../files/source.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "te-notes-"));
  mkdirSync(join(root, "machines"));
  mkdirSync(join(root, "ops"));
  writeFileSync(join(root, "machines", "rpi5.machine.md"), "---\nid: rpi5\nhost: rpi5.local\n---\nThe build Pi.\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("human notes (GL-0297)", () => {
  it("appends a pending note to the machine body, keeps the words, and the machine still loads", () => {
    const ts = appendNote(root, "machine", "rpi5", "holds the IMX500 camera\nnever unplug it", new Date("2026-11-12T10:00:00Z"));
    appendNote(root, "machine", "rpi5", "second note", new Date("2026-11-12T11:00:00Z"));
    const text = readFileSync(join(root, "machines", "rpi5.machine.md"), "utf8");
    expect(text.match(/## Human notes/g)).toHaveLength(1);
    const notes = readNotes(root, "machine", "rpi5");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toEqual({ ts, state: "pending", item: undefined, text: "holds the IMX500 camera\nnever unplug it" });
    const m = loadMachines(root)[0];
    expect(m.machine?.host).toBe("rpi5.local");
    expect(bodyWithoutNotes(m.body ?? "")).toBe("The build Pi.");
  });

  it("links the item id and reads an applied note", () => {
    const ts = appendNote(root, "machine", "rpi5", "x");
    linkNote(root, "machine", "rpi5", ts, "DE-0150");
    expect(readNotes(root, "machine", "rpi5")[0]).toMatchObject({ state: "pending", item: "DE-0150" });
    const file = join(root, "machines", "rpi5.machine.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("· pending ·", "· applied ·"));
    expect(parseNotes(readFileSync(file, "utf8"))[0].state).toBe("applied");
  });

  it("a playbook note creates the ops/<name>.notes.md sidecar, and the task scan skips it", async () => {
    appendNote(root, "playbook", "deploy", "add a disk check");
    expect(existsSync(join(root, "ops", "deploy.notes.md"))).toBe(true);
    const scan = await scanTaskTree(root);
    expect(scan.untracked).not.toContain("ops/deploy.notes.md");
  });

  it("refuses empty text, a fake note header, and a missing machine file", () => {
    expect(() => appendNote(root, "machine", "rpi5", "  ")).toThrow(/needs text/);
    expect(() => appendNote(root, "machine", "rpi5", "a\n### note 2020 · applied")).toThrow(/### note/);
    expect(() => appendNote(root, "machine", "ghost", "x")).toThrow(/no machine file/);
  });

  it("the machine task touches only the machine file; the playbook task touches the playbook and its sidecar", () => {
    const m = noteTaskDraft("machine", "rpi5", "T", "note", "Tasks");
    expect(m.touches).toEqual(["Tasks: machines/rpi5.machine.md"]);
    expect(m.tier).toBe("light");
    const p = noteTaskDraft("playbook", "deploy", "T", "note", "Tasks");
    expect(p.touches).toEqual(["Tasks: ops/deploy.playbook.yaml", "Tasks: ops/deploy.notes.md"]);
    expect(p.tier).toBe("standard");
    expect(p.acceptance.join("\n")).toMatch(/gate step/);
  });
});
