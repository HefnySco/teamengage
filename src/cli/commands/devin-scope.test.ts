import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mergeScope, scopeGrants } from "./devin-scope.js";
import type { LoadedWorkspace } from "../../core/config/config.js";

let root: string;
let wsRoot: string;
let repoA: string;
let repoLink: string;

/** a fake workspace: task folder + two repos (one reached through a symlink) */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "te-devin-scope-"));
  wsRoot = join(root, "Tasks");
  repoA = join(root, "repo-a");
  const repoReal = join(root, "real", "teamengage");
  repoLink = join(root, "out", "teamengage");
  for (const d of [wsRoot, repoA, repoReal, join(root, "out")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(wsRoot, "TASK-1.md"), "# t\n");
  symlinkSync(repoReal, repoLink, "dir");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const fakeWs = (): LoadedWorkspace =>
  ({
    name: "w",
    root: wsRoot,
    plansDir: join(wsRoot, ".teamengage"),
    config: { repos: [repoA, repoLink] },
    resources: new Map(),
    prefixToProject: new Map(),
  }) as unknown as LoadedWorkspace;

describe("scopeGrants", () => {
  it("covers the workspace root and every repo dir, with realpath for symlinks", () => {
    const grants = scopeGrants(fakeWs());
    expect(grants).toContain(`Write(${resolve(wsRoot)}/**)`);
    expect(grants).toContain(`Write(${resolve(repoA)}/**)`);
    // the symlinked repo yields both paths — an agent may write through either
    expect(grants).toContain(`Write(${resolve(repoLink)}/**)`);
    expect(grants).toContain(`Write(${resolve(root, "real", "teamengage")}/**)`);
  });
});

describe("mergeScope", () => {
  const grants = ["Write(/a/**)", "Write(/b/**)"];

  it("adds grants and keeps foreign entries", () => {
    const cur = { permissions: { allow: ["Exec(git)", "Write(~/mine/**)"] } };
    const next = mergeScope(cur, grants);
    expect(next.permissions?.allow).toEqual(["Exec(git)", "Write(~/mine/**)", "Write(/a/**)", "Write(/b/**)"]);
  });

  it("is idempotent — installing twice does not duplicate", () => {
    const once = mergeScope({ permissions: { allow: grants } }, grants);
    expect(once.permissions?.allow).toEqual(grants);
  });

  it("remove: true drops only our grants and empty sections", () => {
    const next = mergeScope({ permissions: { allow: grants } }, grants, true);
    expect(next.permissions).toBeUndefined();
    const kept = mergeScope({ permissions: { allow: [...grants, "Exec(git)"] } }, grants, true);
    expect(kept.permissions?.allow).toEqual(["Exec(git)"]);
  });
});
