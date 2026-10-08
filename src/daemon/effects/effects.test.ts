import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "../api/ops.js";
import type { WorkspaceRuntime } from "../server/context.js";
import type { Session } from "../../core/model/session.js";
import { worktreePath, claimBranch } from "./effects.js";
import { git } from "../../resources/git/git.js";

/**
 * RS-0002/0003: worktree-per-claim and auto-merge on accept.
 * Fixture: a `self` git resource pointing at a real code repo in the ws root.
 */

let home: string;
let root: string;
let plans: string;
let codeRepo: string;
let wsr: WorkspaceRuntime;
let ops: WorkspaceOps;
let sessions: SessionRegistry;

function item(id: string, status = "ready", extra = "") {
  return `---\nid: ${id}\ntype: task\ntitle: ${id}\nstatus: ${status}\nversion: 1\n${extra}---\n\n## Summary\n${id}\n`;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-fx-"));
  root = join(home, "ws");
  plans = join(root, ".teamengage");
  codeRepo = join(root, "code");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  mkdirSync(codeRepo, { recursive: true });

  execFileSync("git", ["init", "-b", "main"], { cwd: codeRepo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: codeRepo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: codeRepo });
  writeFileSync(join(codeRepo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(codeRepo, "b.ts"), "export const b = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: codeRepo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: codeRepo });

  writeFileSync(
    join(plans, "workspace.yaml"),
    `name: ws\nprefix: WS\nresources:\n  code: { kind: git, path: ${codeRepo}, base: main }\n`,
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  writeFileSync(join(plans, "items", "WS", "WS-0001.md"), item("WS-0001", "ready", 'targets: ["@code:a.ts"]\n'));
  writeFileSync(join(plans, "items", "WS", "WS-0002.md"), item("WS-0002", "ready", 'targets: ["@code:b.ts"]\n'));
  writeFileSync(join(plans, "items", "WS", "WS-0003.md"), item("WS-0003", "ready", 'targets: ["@code:a.ts"]\n'));
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  wsr = { ws, store };
  sessions = new SessionRegistry("test");
  ops = new WorkspaceOps(wsr, sessions, undefined, home);
  sClaude = ops.hello("claude").session;
  sCodex = ops.hello("codex").session;
});

let sClaude: Session;
let sCodex: Session;

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("worktree per claim (RS-0002)", () => {
  it("claim creates a worktree on te/<id>-<holder> and records the path", async () => {
    const { claim } = await ops.claim("WS-0001", sClaude);
    const wt = worktreePath(wsr.ws, "WS-0001", "code");
    expect(claim.paths?.code).toBe(wt);
    expect(existsSync(wt)).toBe(true);
    const branches = await git(codeRepo, ["branch", "--list", "te/WS-0001-*"]);
    expect(branches).toContain(claimBranch("WS-0001", sClaude.id));
    // claim file on disk carries the path too
    const claimFile = readFileSync(join(plans, "claims", "WS-0001.yaml"), "utf8");
    expect(claimFile).toContain(wt);
  });

  it("agent commits in the worktree; accept merges --no-ff, cleans up, records delivery", async () => {
    const wt = worktreePath(wsr.ws, "WS-0001", "code");
    writeFileSync(join(wt, "a.ts"), "export const a = 2;\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["commit", "-m", "work"], { cwd: wt });

    await ops.submit("WS-0001", sClaude, { commits: ["work"], tests: "ok" });
    const r = (await ops.accept("WS-0001")) as { merged: Array<{ mergeCommit: string }>; bounced?: string[] };
    expect(r.bounced).toBeUndefined();
    expect(r.merged).toHaveLength(1);
    // merged into main of the code repo
    const content = readFileSync(join(codeRepo, "a.ts"), "utf8");
    expect(content).toContain("a = 2");
    const log = await git(codeRepo, ["log", "--oneline", "-3"]);
    expect(log).toContain("te: WS-0001 merge");
    // worktree removed, branch deleted
    expect(existsSync(wt)).toBe(false);
    const branches = await git(codeRepo, ["branch", "--list", "te/WS-0001-*"]);
    expect(branches.trim()).toBe("");
    // delivery recorded on the item (push tracking source, RS-0004)
    const meta = wsr.store.idx.get("WS-0001")!.meta as { deliveries?: Array<{ merge_commit: string }> };
    expect(meta.deliveries?.[0].merge_commit).toBe(r.merged[0].mergeCommit);
    expect(wsr.store.idx.get("WS-0001")!.meta.status).toBe("done");
  });

  it("conflicting merges bounce the item back to in_progress (agent rebases)", async () => {
    await ops.claim("WS-0002", sCodex);
    const wt2 = worktreePath(wsr.ws, "WS-0002", "code");
    writeFileSync(join(wt2, "a.ts"), "export const a = 999;\n");
    execFileSync("git", ["add", "-A"], { cwd: wt2 });
    execFileSync("git", ["commit", "-m", "conflicting work"], { cwd: wt2 });
    // main moves after the branch point (another item's merge) → conflict
    writeFileSync(join(codeRepo, "a.ts"), "export const a = 3;\n");
    execFileSync("git", ["add", "-A"], { cwd: codeRepo });
    execFileSync("git", ["commit", "-m", "other work"], { cwd: codeRepo });
    await ops.submit("WS-0002", sCodex, {});

    const r = (await ops.accept("WS-0002")) as { bounced?: string[] };
    expect(r.bounced).toBeDefined();
    expect(wsr.store.idx.get("WS-0002")!.meta.status).toBe("in_progress");
    // worktree kept so no work is lost
    expect(existsSync(wt2)).toBe(true);
  });

  it("release removes the worktree but keeps the branch", async () => {
    // WS-0002 is still held (bounced); the human releases it to free b.ts... but
    // WS-0003 only targets a.ts, which is free after WS-0001 merged.
    const { claim } = await ops.claim("WS-0003", sClaude);
    const wt = worktreePath(wsr.ws, "WS-0003", "code");
    expect(existsSync(wt)).toBe(true);
    await ops.release("WS-0003", sClaude, "done for now");
    expect(existsSync(wt)).toBe(false);
    const branches = await git(codeRepo, ["branch", "--list", "te/WS-0003-*"]);
    expect(branches).toContain(claimBranch("WS-0003", claim.holder));
  });

  it("folder resources snapshot locally; url resources clone at claim (RS-0005)", async () => {
    const folderSrc = mkdtempSync(join(tmpdir(), "te-fsrc-"));
    writeFileSync(join(folderSrc, "data.txt"), "payload");
    const urlSrc = mkdtempSync(join(tmpdir(), "te-usrc-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: urlSrc });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: urlSrc });
    execFileSync("git", ["config", "user.name", "t"], { cwd: urlSrc });
    writeFileSync(join(urlSrc, "f"), "1");
    execFileSync("git", ["add", "-A"], { cwd: urlSrc });
    execFileSync("git", ["commit", "-m", "1"], { cwd: urlSrc });
    mkdirSync(join(plans, "items", "WS"), { recursive: true });
    writeFileSync(
      join(plans, "items", "WS", "WS-0004.md"),
      item("WS-0004", "ready", 'targets: ["@docs", "@lib"]\n'),
    );
    wsr.ws.config.resources = {
      ...wsr.ws.config.resources,
      docs: { kind: "folder", path: folderSrc, snapshot: true },
      lib: { kind: "git", url: `file://${urlSrc}`, base: "main" },
    };
    wsr.ws.resources.set("docs", { name: "docs", config: wsr.ws.config.resources.docs, path: folderSrc });
    wsr.ws.resources.set("lib", { name: "lib", config: wsr.ws.config.resources.lib, path: undefined });
    const store2 = new PlansStore(wsr.ws, "test");
    await store2.init();
    const ops2 = new WorkspaceOps({ ws: wsr.ws, store: store2 }, sessions, undefined, home);
    await ops2.claim("WS-0004", sClaude);
    expect(existsSync(join(home, ".teamengage", "snapshots", "ws", "WS-0004", "docs", "data.txt"))).toBe(true);
    expect(existsSync(join(plans, "worktrees", "WS-0004", "lib", "f"))).toBe(true);
    await ops2.release("WS-0004", sClaude, "done");
    rmSync(folderSrc, { recursive: true, force: true });
    rmSync(urlSrc, { recursive: true, force: true });
  });
});
