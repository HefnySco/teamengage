import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { syncCode, commitWip, itemOfBranch } from "./code.js";

/**
 * Code travels between the human's machines: two code clones sharing one
 * bare remote stand in for home and work.
 */

let home: string;
let remote: string;
let wsrA: WorkspaceRuntime;
let wsrB: WorkspaceRuntime;
let codeA: string;
let codeB: string;
let wtA: string;

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ident = (cwd: string) => {
  g(cwd, "config", "user.email", "t@t");
  g(cwd, "config", "user.name", "t");
};
const commitFile = (cwd: string, file: string, body: string) => {
  writeFileSync(join(cwd, file), body);
  g(cwd, "add", "-A");
  g(cwd, "commit", "-q", "-m", `edit ${file}`);
};

function item(id: string, status: string) {
  return `---\nid: ${id}\ntype: task\ntitle: t\nstatus: ${status}\nversion: 1\ntargets: ["@app:src/**"]\n---\n\n## Summary\nx\n`;
}

async function machine(root: string, name: string): Promise<WorkspaceRuntime> {
  const plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  mkdirSync(join(plans, "claims"), { recursive: true });
  writeFileSync(join(plans, "workspace.yaml"), "name: ws\nprefix: WS\nresources:\n  app: { kind: git, path: code, base: main }\n");
  writeFileSync(join(plans, "items", "WS", "WS-0001.md"), item("WS-0001", "in_progress"));
  writeFileSync(join(plans, "items", "WS", "WS-0002.md"), item("WS-0002", "done"));
  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, name);
  await store.init();
  return { ws, store };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-code-"));
  remote = join(home, "code.git");
  const seed = join(home, "seed");
  mkdirSync(seed);
  g(seed, "init", "-q", "-b", "main");
  ident(seed);
  commitFile(seed, "README", "hi\n");
  g(home, "init", "-q", "--bare", remote);
  g(seed, "remote", "add", "origin", remote);
  g(seed, "push", "-q", "-u", "origin", "main");
  g(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  for (const m of ["a", "b"]) {
    mkdirSync(join(home, m));
    g(join(home, m), "clone", "-q", remote, "code");
    ident(join(home, m, "code"));
  }
  codeA = join(home, "a", "code");
  codeB = join(home, "b", "code");
  wsrA = await machine(join(home, "a"), "work");
  wsrB = await machine(join(home, "b"), "home");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("itemOfBranch", () => {
  it("reads the item id from a claim branch", () => {
    expect(itemOfBranch("te/WS-0001-swift")).toBe("WS-0001");
    expect(itemOfBranch("te/GL-12")).toBe("GL-12");
    expect(itemOfBranch("feature/x")).toBeUndefined();
  });
});

describe("syncCode between two machines", () => {
  it("work machine pushes open work and accepted merges, prunes finished branches", async () => {
    // finished work already on the remote and merged into main
    g(codeA, "checkout", "-q", "-b", "te/WS-0002-forge");
    commitFile(codeA, "done.txt", "d\n");
    g(codeA, "push", "-q", "origin", "te/WS-0002-forge");
    g(codeA, "checkout", "-q", "main");
    g(codeA, "merge", "-q", "--no-ff", "-m", "te: WS-0002 merge", "te/WS-0002-forge");
    g(codeA, "branch", "-q", "-D", "te/WS-0002-forge");
    // open work in a worktree, as a claim makes it
    wtA = join(wsrA.ws.plansDir, "worktrees", "WS-0001", "app");
    g(codeA, "worktree", "add", "-q", "-b", "te/WS-0001-swift", wtA, "main");
    ident(wtA);
    commitFile(wtA, "feature.txt", "v1\n");

    const [r] = await syncCode(wsrA, { home });
    expect(r.problems).toEqual([]);
    expect(r.done).toContain("pushed main (+2)");
    expect(r.done).toContain("pushed te/WS-0001-swift (new on origin)");
    expect(r.done).toContain("pruned te/WS-0002-forge on origin (merged)");
    expect(g(remote, "branch", "--list", "te/*")).toContain("te/WS-0001-swift");
    expect(g(remote, "branch", "--list", "te/WS-0002-forge")).toBe("");
  });

  it("home machine pulls main and the open branch, so a claim there resumes on it", async () => {
    const [r] = await syncCode(wsrB, { home });
    expect(r.problems).toEqual([]);
    expect(r.done).toContain("pulled main (+2)"); // main is checked out and clean → ff in place
    expect(r.done).toContain("pulled te/WS-0001-swift (new here)");
    expect(g(codeB, "show", "te/WS-0001-swift:feature.txt")).toBe("v1");
    expect(g(codeB, "log", "-1", "--format=%s")).toBe("te: WS-0002 merge");
  });

  it("work continued at home comes back to the worktree at work", async () => {
    g(codeB, "checkout", "-q", "te/WS-0001-swift");
    commitFile(codeB, "feature.txt", "v2\n");
    g(codeB, "checkout", "-q", "main");
    expect((await syncCode(wsrB, { home }))[0].done).toContain("pushed te/WS-0001-swift (+1)");

    writeFileSync(join(wtA, "scratch.txt"), "x\n"); // untracked only — not in the way
    writeFileSync(join(wtA, "feature.txt"), "local edit\n");
    const blocked = (await syncCode(wsrA, { home }))[0];
    expect(blocked.problems.join("\n")).toMatch(/uncommitted changes/);
    g(wtA, "checkout", "--", "feature.txt");
    const [r] = await syncCode(wsrA, { home });
    expect(r.done).toContain("pulled te/WS-0001-swift (+1)");
    expect(g(wtA, "show", "HEAD:feature.txt")).toBe("v2");
  });

  it("a branch worked on both machines is reported, never merged", async () => {
    rmSync(join(wtA, "scratch.txt"));
    commitFile(wtA, "a.txt", "a\n");
    g(codeB, "checkout", "-q", "te/WS-0001-swift");
    commitFile(codeB, "b.txt", "b\n");
    g(codeB, "checkout", "-q", "main");
    await syncCode(wsrB, { home }); // home pushes first
    const [r] = await syncCode(wsrA, { home });
    expect(r.problems.join("\n")).toMatch(/te\/WS-0001-swift: diverged/);
    expect(g(wtA, "log", "-1", "--format=%s")).toBe("edit a.txt"); // untouched
  });

  it("commitWip saves a dirty worktree onto its branch", async () => {
    writeFileSync(join(wtA, "wip.txt"), "half done\n");
    const saved = await commitWip(wsrA, {
      item: "WS-0001",
      holder: "swift",
      actor: "agent",
      machine: "work",
      targets: ["@app:src/**"],
      claimed_at: "2026-01-01T00:00:00Z",
      last_seen: "2026-01-01T00:00:00Z",
    });
    expect(saved).toEqual(["WS-0001:app"]);
    expect(g(wtA, "status", "--porcelain")).toBe("");
  });

  it("no remote: says the code stays on this machine", async () => {
    g(codeA, "remote", "remove", "origin");
    const [r] = await syncCode(wsrA, { home });
    expect(r.problems[0]).toMatch(/no git remote/);
  });
});
