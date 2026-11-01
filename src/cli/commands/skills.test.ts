import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoSkills, skillState, survey, skillsCmd } from "./skills.js";

/** a fake repo skills/ + fake agent homes under one tmp root */
let root: string;
let skillsDir: string;
let home: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "te-skills-"));
  skillsDir = join(root, "skills");
  home = join(root, "home");
  for (const s of ["te-alpha", "te-beta"]) {
    mkdirSync(join(skillsDir, s), { recursive: true });
    writeFileSync(join(skillsDir, s, "SKILL.md"), `# ${s} v1\n`);
    writeFileSync(join(skillsDir, s, "README.md"), `${s} readme\n`);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("skillState / survey", () => {
  it("classifies linked, stale copy, synced copy, missing, broken", () => {
    const agent = join(root, "agent1");
    mkdirSync(agent, { recursive: true });
    symlinkSync(join(skillsDir, "te-alpha"), join(agent, "te-alpha"), "dir");
    expect(skillState(join(agent, "te-alpha"), join(skillsDir, "te-alpha"))).toBe("linked");
    expect(skillState(join(agent, "te-beta"), join(skillsDir, "te-beta"))).toBe("missing");

    mkdirSync(join(agent, "te-beta"), { recursive: true });
    writeFileSync(join(agent, "te-beta", "SKILL.md"), "old text\n");
    writeFileSync(join(agent, "te-beta", "README.md"), "te-beta readme\n");
    expect(skillState(join(agent, "te-beta"), join(skillsDir, "te-beta"))).toBe("stale");

    mkdirSync(join(agent, "te-copy"), { recursive: true });
    writeFileSync(join(agent, "te-copy", "SKILL.md"), "x\n");
    mkdirSync(join(skillsDir, "te-copy"), { recursive: true });
    writeFileSync(join(skillsDir, "te-copy", "SKILL.md"), "x\n");
    expect(skillState(join(agent, "te-copy"), join(skillsDir, "te-copy"))).toBe("copy");

    symlinkSync(join(root, "gone"), join(agent, "te-broken"), "dir");
    expect(skillState(join(agent, "te-broken"), join(skillsDir, "te-alpha"))).toBe("broken");

    expect(repoSkills(skillsDir)).toEqual(["te-alpha", "te-beta", "te-copy"]);
    const rows = survey([agent], skillsDir);
    expect(rows.find((r) => r.skill === "te-alpha")!.state).toBe("linked");
    expect(rows.find((r) => r.skill === "te-beta")!.state).toBe("stale");
  });
});

describe("skillsCmd --install/--uninstall (tmp home)", () => {
  it("links repo skills into the agent dir and moves real dirs aside", async () => {
    const agent = join(home, ".claude", "skills");
    mkdirSync(join(agent, "te-alpha"), { recursive: true });
    writeFileSync(join(agent, "te-alpha", "SKILL.md"), "stale\n");

    const code = await skillsCmd(["--install", "--dir", agent], home, skillsDir);
    expect(code).toBe(0);
    for (const s of ["te-alpha", "te-beta", "te-copy"]) {
      expect(lstatSync(join(agent, s)).isSymbolicLink()).toBe(true);
    }
    const baks = readdirSync(agent).filter((n) => n.startsWith("te-alpha.te-bak-"));
    expect(baks).toHaveLength(1);
    expect(readFileSyncSafe(join(agent, baks[0], "SKILL.md"))).toBe("stale\n");
  });

  it("is idempotent", async () => {
    const agent = join(home, ".claude", "skills");
    const first = readdirSync(agent).sort();
    expect(await skillsCmd(["--install", "--dir", agent], home, skillsDir)).toBe(0);
    expect(readdirSync(agent).sort()).toEqual(first);
  });

  it("--check fails on drift and passes when all linked", async () => {
    const agent = join(home, ".config", "devin", "skills");
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(agent, "te-alpha"), { recursive: true });
    expect(await skillsCmd(["--check", "--dir", agent], home, skillsDir)).toBe(1);
    expect(await skillsCmd(["--install", "--dir", agent], home, skillsDir)).toBe(0);
    expect(await skillsCmd(["--check", "--dir", agent], home, skillsDir)).toBe(0);
  });

  it("--uninstall removes only links into this repo", async () => {
    const agent = join(home, ".claude", "skills");
    const foreign = join(root, "other-repo", "te-foreign");
    mkdirSync(foreign, { recursive: true });
    symlinkSync(foreign, join(agent, "te-foreign"), "dir");
    const mine = mkdtempSync(join(tmpdir(), "te-own-"));
    mkdirSync(join(mine, "keepme"), { recursive: true });
    mkdirSync(join(agent, "te-own"), { recursive: true });

    expect(await skillsCmd(["--uninstall", "--dir", agent], home, skillsDir)).toBe(0);
    expect(existsSync(join(agent, "te-alpha"))).toBe(false);
    expect(existsSync(join(agent, "te-beta"))).toBe(false);
    expect(lstatSync(join(agent, "te-foreign")).isSymbolicLink()).toBe(true); // untouched
    expect(lstatSync(join(agent, "te-own")).isDirectory()).toBe(true); // real dir untouched
    rmSync(mine, { recursive: true, force: true });
  });
});

function readFileSyncSafe(p: string): string {
  return readFileSync(p, "utf8");
}
