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

describe("repos: plain code repos next to the task folder", () => {
  it("carries each repo's checked-out branch, skipping the plans repo and resources", async () => {
    const top = join(home, "plain");
    const bare = join(home, "lib.git");
    g(home, "init", "-q", "--bare", bare);
    for (const m of ["w", "h"]) mkdirSync(join(top, m), { recursive: true });
    // work machine: Tasks/ (the task folder) + lib/ side by side
    const libW = join(top, "w", "lib");
    mkdirSync(libW);
    g(libW, "init", "-q", "-b", "dev");
    ident(libW);
    commitFile(libW, "x.c", "1\n");
    g(libW, "remote", "add", "origin", bare);
    g(libW, "push", "-q", "-u", "origin", "dev");
    commitFile(libW, "x.c", "2\n"); // unpushed work
    const tasks = join(top, "w", "Tasks");
    mkdirSync(join(tasks, ".teamengage", "items"), { recursive: true });
    writeFileSync(join(tasks, ".teamengage", "workspace.yaml"), 'name: p\nprefix: P\nrepos: ["../*"]\n');
    g(tasks, "init", "-q", "-b", "main"); // the task folder's own repo — synced as plans, not here
    const ws = resolveWorkspace(tasks, { home });
    const store = new PlansStore(ws, "w");
    await store.init();
    const reps = await syncCode({ ws, store }, { home });
    expect(reps.map((r) => r.resource)).toEqual(["lib"]);
    expect(reps[0].done).toEqual(["pushed dev (+1)"]);

    // home machine: an older clone fast-forwards
    g(join(top, "h"), "clone", "-q", "-b", "dev", bare, "lib");
    g(libW, "commit", "-q", "--allow-empty", "-m", "3");
    await syncCode({ ws, store }, { home });
    const tasksH = join(top, "h", "Tasks");
    mkdirSync(join(tasksH, ".teamengage", "items"), { recursive: true });
    writeFileSync(join(tasksH, ".teamengage", "workspace.yaml"), 'name: p\nprefix: P\nrepos: ["../lib"]\n');
    const wsH = resolveWorkspace(tasksH, { home });
    const storeH = new PlansStore(wsH, "h");
    await storeH.init();
    g(join(top, "h", "lib"), "reset", "-q", "--hard", "HEAD~1");
    const [r] = await syncCode({ ws: wsH, store: storeH }, { home });
    expect(r.done).toEqual(["pulled dev (+2)"]); // the reset one + "3"
  });
});

describe("sync_remotes and submodules", () => {
  async function wsWith(top: string, yaml: string) {
    const tasks = join(top, "Tasks");
    mkdirSync(join(tasks, ".teamengage", "items"), { recursive: true });
    writeFileSync(join(tasks, ".teamengage", "workspace.yaml"), yaml);
    const ws = resolveWorkspace(tasks, { home });
    const store = new PlansStore(ws, "w");
    await store.init();
    return { ws, store } as WorkspaceRuntime;
  }
  const repoWith = (dir: string, remotesTo: Record<string, string>) => {
    mkdirSync(dir, { recursive: true });
    g(dir, "init", "-q", "-b", "master");
    ident(dir);
    commitFile(dir, "a", "1\n");
    for (const [name, url] of Object.entries(remotesTo)) {
      g(home, "init", "-q", "--bare", url);
      g(dir, "remote", "add", name, url);
    }
  };

  it("never pushes a remote outside the allow-list (a public upstream stays untouched)", async () => {
    const top = join(home, "allow");
    repoWith(join(top, "pub"), { upstream: join(home, "pub-up.git") });
    repoWith(join(top, "prv"), { upstream: join(home, "prv-up.git"), origin_local: join(home, "prv-local.git") });
    g(join(top, "prv"), "push", "-q", "-u", "upstream", "master"); // tracks the public one
    commitFile(join(top, "prv"), "a", "2\n"); // private work, ahead of upstream
    const wsr = await wsWith(top, 'name: a\nprefix: A\nrepos: ["../*"]\nsync_remotes: [origin_local, origin]\n');
    const reps = await syncCode(wsr, { home });
    const by = Object.fromEntries(reps.map((r) => [r.resource, r]));
    expect(by.pub.problems).toEqual([]);
    expect(by.pub.skipped).toBe("no origin_local/origin remote");
    expect(by.prv.remote).toBe("origin_local");
    expect(by.prv.done).toEqual(["pushed master (new on origin_local)"]);
    expect(g(home, "--git-dir", join(home, "prv-up.git"), "rev-list", "--count", "master")).toBe("1"); // upstream got nothing
    expect(g(home, "--git-dir", join(home, "pub-up.git"), "branch")).toBe("");
  });

  it("holds a parent's push while a submodule commit exists only here", async () => {
    const top = join(home, "subs");
    const libBare = join(home, "sublib.git");
    const seed = join(home, "sublib-seed");
    repoWith(seed, { origin: libBare });
    g(seed, "push", "-q", "origin", "master");
    repoWith(join(top, "app"), { origin: join(home, "subapp.git") });
    const app = join(top, "app");
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", libBare, "lib"], { cwd: app });
    g(app, "commit", "-q", "-m", "add lib");
    ident(join(app, "lib"));
    commitFile(join(app, "lib"), "b", "local only\n"); // never pushed
    g(app, "add", "lib");
    g(app, "commit", "-q", "-m", "bump lib");
    const wsr = await wsWith(top, 'name: s\nprefix: S\nrepos: ["../app"]\n');
    const [r] = await syncCode(wsr, { home });
    expect(r.problems.join("\n")).toMatch(/submodule lib has commits no remote has/);
    expect(r.done).toEqual([]);
    expect(g(home, "--git-dir", join(home, "subapp.git"), "branch")).toBe("");
  });
  it("dry run reports and changes nothing", async () => {
    const top = join(home, "dry");
    repoWith(join(top, "r"), { origin: join(home, "dry.git") });
    const wsr = await wsWith(top, 'name: d\nprefix: D\nrepos: ["../r"]\n');
    const [r] = await syncCode(wsr, { home, dryRun: true });
    expect(r.done).toEqual(["[dry run] pushed master (new on origin)"]);
    expect(g(home, "--git-dir", join(home, "dry.git"), "branch")).toBe("");
  });
});
