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
import { worktreePath, claimBranch, snapshotDiff } from "./effects.js";
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

  it("folder resources snapshot locally; url resources clone at claim (RS-0005/7)", async () => {
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
    const snap = join(home, ".teamengage", "snapshots", "ws", "WS-0004", "docs", "data.txt");
    expect(existsSync(snap)).toBe(true);
    expect(existsSync(join(plans, "worktrees", "WS-0004", "lib", "f"))).toBe(true);


    // live change shows up in the submit evidence diff (RS-0007)
    writeFileSync(join(folderSrc, "data.txt"), "edited live");
    writeFileSync(join(folderSrc, "new.txt"), "new file");
    const diff = await snapshotDiff(wsr.ws, "WS-0004", "docs", home);
    expect(diff).toContain("data.txt");
    expect(diff).toContain("new.txt");

    // rollback restores exact bytes (RS-0006/7)
    const r = (await ops2.rollback("WS-0004")) as { restored: string[] };
    expect(r.restored).toContain("docs");
    expect(readFileSync(join(folderSrc, "data.txt"), "utf8")).toBe("payload");
    expect(existsSync(join(folderSrc, "new.txt"))).toBe(false);

    await ops2.release("WS-0004", sClaude, "done");
    rmSync(folderSrc, { recursive: true, force: true });
    rmSync(urlSrc, { recursive: true, force: true });
  });
});

describe("merge + cleanup safety (RS-0002/3)", () => {
  it("release on a dirty worktree preserves uncommitted work on the claim branch", async () => {
    writeFileSync(
      join(plans, "items", "WS", "WS-0005.md"),
      item("WS-0005", "ready", 'targets: ["@code:a.ts"]\n'),
    );
    const store3 = new PlansStore(wsr.ws, "test");
    await store3.init();
    const ops3 = new WorkspaceOps({ ws: wsr.ws, store: store3 }, sessions, undefined, home);
    await ops3.claim("WS-0005", sClaude);
    const wt = worktreePath(wsr.ws, "WS-0005", "code");
    writeFileSync(join(wt, "wip.ts"), "uncommitted work\n"); // never committed
    await ops3.release("WS-0005", sClaude, "abandoning");
    // work survives: either the worktree is kept or a WIP commit is on the branch
    if (!existsSync(join(wt, "wip.ts"))) {
      const content = execFileSync(
        "git",
        ["show", `${claimBranch("WS-0005", sClaude.id)}:wip.ts`],
        { cwd: codeRepo, encoding: "utf8" },
      );
      expect(content).toContain("uncommitted work");
    }
  });

  it("accept refuses non-in_review items BEFORE merging anything", async () => {
    // re-claim WS-0005 → in_progress; accept must refuse without merging
    const store3b = new PlansStore(wsr.ws, "test");
    await store3b.init();
    const ops3b = new WorkspaceOps({ ws: wsr.ws, store: store3b }, sessions, undefined, home);
    await ops3b.claim("WS-0005", sClaude);
    const wt = worktreePath(wsr.ws, "WS-0005", "code");
    writeFileSync(join(wt, "a.ts"), "export const a = 777;\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["commit", "-m", "wip"], { cwd: wt });
    const before = execFileSync("git", ["rev-parse", "main"], { cwd: codeRepo, encoding: "utf8" });
    await expect(ops3b.accept("WS-0005")).rejects.toThrow();
    const after = execFileSync("git", ["rev-parse", "main"], { cwd: codeRepo, encoding: "utf8" });
    expect(after).toBe(before);
    expect(readFileSync(join(codeRepo, "a.ts"), "utf8")).not.toContain("777");
    await ops3b.release("WS-0005", sClaude, "cleanup");
  });

  it("multi-resource merge is all-or-nothing: a conflict anywhere merges nothing", async () => {
    const code2 = join(root, "code2");
    mkdirSync(code2, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: code2 });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: code2 });
    execFileSync("git", ["config", "user.name", "t"], { cwd: code2 });
    writeFileSync(join(code2, "shared"), "v1\n");
    execFileSync("git", ["add", "-A"], { cwd: code2 });
    execFileSync("git", ["commit", "-m", "init"], { cwd: code2 });
    wsr.ws.resources.set("code2", {
      name: "code2",
      config: { kind: "git", path: code2, base: "main", worktree: true },
      path: code2,
    });
    writeFileSync(
      join(plans, "items", "WS", "WS-0006.md"),
      item("WS-0006", "ready", 'targets: ["@code:c.ts", "@code2:shared"]\n'),
    );
    const store4 = new PlansStore(wsr.ws, "test");
    await store4.init();
    const ops4 = new WorkspaceOps({ ws: wsr.ws, store: store4 }, sessions, undefined, home);
    await ops4.claim("WS-0006", sCodex);
    // agent commits non-conflicting work in code, conflicting work in code2
    const wt1 = worktreePath(wsr.ws, "WS-0006", "code");
    writeFileSync(join(wt1, "b.ts"), "export const b = 2;\n");
    execFileSync("git", ["add", "-A"], { cwd: wt1 });
    execFileSync("git", ["commit", "-m", "ok work"], { cwd: wt1 });
    const wt2 = worktreePath(wsr.ws, "WS-0006", "code2");
    writeFileSync(join(wt2, "shared"), "agent\n");
    execFileSync("git", ["add", "-A"], { cwd: wt2 });
    execFileSync("git", ["commit", "-m", "conflicting"], { cwd: wt2 });
    // code2 main moves after the branch point → merge will conflict
    writeFileSync(join(code2, "shared"), "main\n");
    execFileSync("git", ["add", "-A"], { cwd: code2 });
    execFileSync("git", ["commit", "-m", "concurrent"], { cwd: code2 });

    const codeBefore = execFileSync("git", ["rev-parse", "main"], { cwd: codeRepo, encoding: "utf8" }).trim();
    await ops4.submit("WS-0006", sCodex, {});
    const r = (await ops4.accept("WS-0006")) as { bounced?: string[] };
    expect(r.bounced).toBeDefined();
    // nothing merged — code's b.ts change must NOT have landed on main
    const codeAfter = execFileSync("git", ["rev-parse", "main"], { cwd: codeRepo, encoding: "utf8" }).trim();
    expect(codeAfter).toBe(codeBefore);
    expect(readFileSync(join(codeRepo, "b.ts"), "utf8")).toBe("export const b = 1;\n");
  });

  it("merge leaves the main checkout on its original branch", async () => {
    execFileSync("git", ["checkout", "-b", "feature-x"], { cwd: codeRepo });
    writeFileSync(
      join(plans, "items", "WS", "WS-0007.md"),
      item("WS-0007", "ready", 'targets: ["@code:other.ts"]\n'),
    );
    const store5 = new PlansStore(wsr.ws, "test");
    await store5.init();
    const ops5 = new WorkspaceOps({ ws: wsr.ws, store: store5 }, sessions, undefined, home);
    await ops5.claim("WS-0007", sClaude);
    const wt = worktreePath(wsr.ws, "WS-0007", "code");
    writeFileSync(join(wt, "other.ts"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["commit", "-m", "work"], { cwd: wt });
    await ops5.submit("WS-0007", sClaude, {});
    await ops5.accept("WS-0007");
    const cur = execFileSync("git", ["branch", "--show-current"], { cwd: codeRepo, encoding: "utf8" }).trim();
    expect(cur).toBe("feature-x");
    execFileSync("git", ["checkout", "main"], { cwd: codeRepo });
  });
});

describe("snapshot scoping + rollback safety (RS-0006/7)", () => {
  it("snapshot and rollback cover only the claimed subtrees", async () => {
    const folderSrc = mkdtempSync(join(tmpdir(), "te-fscope-"));
    mkdirSync(join(folderSrc, "sub"), { recursive: true });
    writeFileSync(join(folderSrc, "sub", "x.txt"), "sub-payload");
    writeFileSync(join(folderSrc, "other.txt"), "other-payload");
    writeFileSync(
      join(plans, "items", "WS", "WS-0008.md"),
      item("WS-0008", "ready", 'targets: ["@docs:sub/**"]\n'),
    );
    wsr.ws.config.resources = {
      ...wsr.ws.config.resources,
      docs: { kind: "folder", path: folderSrc, snapshot: true },
    };
    wsr.ws.resources.set("docs", { name: "docs", config: wsr.ws.config.resources.docs, path: folderSrc });
    const store6 = new PlansStore(wsr.ws, "test");
    await store6.init();
    const ops6 = new WorkspaceOps({ ws: wsr.ws, store: store6 }, sessions, undefined, home);
    await ops6.claim("WS-0008", sClaude);

    const snapRoot = join(home, ".teamengage", "snapshots", "ws", "WS-0008", "docs");
    expect(existsSync(join(snapRoot, "sub", "x.txt"))).toBe(true);
    expect(existsSync(join(snapRoot, "other.txt"))).toBe(false); // unclaimed subtree not snapshotted

    // concurrent work in a sibling path + the claimed subtree
    writeFileSync(join(folderSrc, "sub", "x.txt"), "edited by claim");
    writeFileSync(join(folderSrc, "other.txt"), "edited by someone else");
    writeFileSync(join(folderSrc, "new.txt"), "created since");

    const r = (await ops6.rollback("WS-0008")) as { restored: string[] };
    expect(r.restored).toContain("docs");
    expect(readFileSync(join(folderSrc, "sub", "x.txt"), "utf8")).toBe("sub-payload");
    // the old whole-dir --delete restore would have wiped these:
    expect(readFileSync(join(folderSrc, "other.txt"), "utf8")).toBe("edited by someone else");
    expect(existsSync(join(folderSrc, "new.txt"))).toBe(true);

    await ops6.release("WS-0008", sClaude, "done");
    rmSync(folderSrc, { recursive: true, force: true });
  });

  it("rollback on a done item is refused without --force", async () => {
    const folderSrc = mkdtempSync(join(tmpdir(), "te-fdone-"));
    writeFileSync(join(folderSrc, "d.txt"), "live");
    wsr.ws.resources.set("docs", { name: "docs", config: wsr.ws.config.resources.docs, path: folderSrc });
    const snapDir = join(home, ".teamengage", "snapshots", "ws", "WS-0009", "docs");
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, "d.txt"), "old-bytes");
    writeFileSync(join(plans, "items", "WS", "WS-0009.md"), item("WS-0009", "done"));
    const store7 = new PlansStore(wsr.ws, "test");
    await store7.init();
    const ops7 = new WorkspaceOps({ ws: wsr.ws, store: store7 }, sessions, undefined, home);

    await expect(ops7.rollback("WS-0009")).rejects.toThrow(/done/);
    expect(readFileSync(join(folderSrc, "d.txt"), "utf8")).toBe("live");

    const r = (await ops7.rollback("WS-0009", true)) as { restored: string[] };
    expect(r.restored).toContain("docs");
    expect(readFileSync(join(folderSrc, "d.txt"), "utf8")).toBe("old-bytes");
    rmSync(folderSrc, { recursive: true, force: true });
  });

  it("log() on a released item cannot recreate its claim file", async () => {
    writeFileSync(join(plans, "items", "WS", "WS-0010.md"), item("WS-0010", "ready"));
    const store8 = new PlansStore(wsr.ws, "test");
    await store8.init();
    const ops8 = new WorkspaceOps({ ws: wsr.ws, store: store8 }, sessions, undefined, home);
    await ops8.claim("WS-0010", sClaude);
    await ops8.release("WS-0010", sClaude, "off");
    const claimFile = join(plans, "claims", "WS-0010.yaml");
    expect(existsSync(claimFile)).toBe(false);
    await expect(ops8.log("WS-0010", sClaude, "stale")).rejects.toThrow();
    expect(existsSync(claimFile)).toBe(false); // the old out-of-queue write resurrected it
  });
});

describe("snapshot target shapes + claim safety", () => {
  function docsResource(folderSrc: string) {
    wsr.ws.config.resources = {
      ...wsr.ws.config.resources,
      docs: { kind: "folder", path: folderSrc, snapshot: true },
    };
    wsr.ws.resources.set("docs", { name: "docs", config: wsr.ws.config.resources.docs, path: folderSrc });
  }

  it("single-file targets snapshot and restore the file", async () => {
    const folderSrc = mkdtempSync(join(tmpdir(), "te-ffile-"));
    mkdirSync(join(folderSrc, "cfg"), { recursive: true });
    writeFileSync(join(folderSrc, "cfg", "app.yaml"), "v1\n");
    docsResource(folderSrc);
    writeFileSync(
      join(plans, "items", "WS", "WS-0011.md"),
      item("WS-0011", "ready", 'targets: ["@docs:cfg/app.yaml"]\n'),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await expect(o.claim("WS-0011", sClaude)).resolves.toBeDefined();
    const snap = join(home, ".teamengage", "snapshots", "ws", "WS-0011", "docs", "cfg", "app.yaml");
    expect(existsSync(snap)).toBe(true);
    writeFileSync(join(folderSrc, "cfg", "app.yaml"), "v2\n");
    await o.rollback("WS-0011");
    expect(readFileSync(join(folderSrc, "cfg", "app.yaml"), "utf8")).toBe("v1\n");
    await o.release("WS-0011", sClaude, "done");
    rmSync(folderSrc, { recursive: true, force: true });
  });

  it("absolute-path targets resolve against the resource root", async () => {
    const folderSrc = mkdtempSync(join(tmpdir(), "te-fabs-"));
    mkdirSync(join(folderSrc, "cfg"), { recursive: true });
    writeFileSync(join(folderSrc, "cfg", "a.conf"), "base\n");
    docsResource(folderSrc);
    writeFileSync(
      join(plans, "items", "WS", "WS-0012.md"),
      item("WS-0012", "ready", `targets: ["@docs:${join(folderSrc, "cfg")}/**"]\n`),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await expect(o.claim("WS-0012", sClaude)).resolves.toBeDefined();
    const snap = join(home, ".teamengage", "snapshots", "ws", "WS-0012", "docs", "cfg", "a.conf");
    expect(existsSync(snap)).toBe(true);
    await o.release("WS-0012", sClaude, "done");
    rmSync(folderSrc, { recursive: true, force: true });
  });

  it("missing target paths are claimed, recorded, and deleted by rollback", async () => {
    const folderSrc = mkdtempSync(join(tmpdir(), "te-fmiss-"));
    docsResource(folderSrc);
    writeFileSync(
      join(plans, "items", "WS", "WS-0013.md"),
      item("WS-0013", "ready", 'targets: ["@docs:feature/**"]\n'),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    // the dir doesn't exist yet — claim must not fail
    await expect(o.claim("WS-0013", sClaude)).resolves.toBeDefined();
    // the agent creates the feature dir; rollback must remove it
    mkdirSync(join(folderSrc, "feature"), { recursive: true });
    writeFileSync(join(folderSrc, "feature", "new.ts"), "new work\n");
    await o.rollback("WS-0013");
    expect(existsSync(join(folderSrc, "feature"))).toBe(false);
    await o.release("WS-0013", sClaude, "done");
    rmSync(folderSrc, { recursive: true, force: true });
  });

  it("merge conflict reports the conflicting file names", async () => {
    writeFileSync(join(codeRepo, "g.ts"), "export const g = 1;\n");
    execFileSync("git", ["add", "g.ts"], { cwd: codeRepo });
    execFileSync("git", ["commit", "-m", "g1"], { cwd: codeRepo });
    writeFileSync(
      join(plans, "items", "WS", "WS-0018.md"),
      item("WS-0018", "ready", 'targets: ["@code:g.ts"]\n'),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await o.claim("WS-0018", sCodex);
    const wt = worktreePath(wsr.ws, "WS-0018", "code");
    writeFileSync(join(wt, "g.ts"), "export const g = 999;\n");
    execFileSync("git", ["add", "g.ts"], { cwd: wt });
    execFileSync("git", ["commit", "-m", "g999"], { cwd: wt });
    // main moves the same file after the branch point
    writeFileSync(join(codeRepo, "g.ts"), "export const g = 2;\n");
    execFileSync("git", ["add", "g.ts"], { cwd: codeRepo });
    execFileSync("git", ["commit", "-m", "g2"], { cwd: codeRepo });
    await o.submit("WS-0018", sCodex, {});
    const r = (await o.accept("WS-0018")) as { bounced?: string[] };
    expect(r.bounced?.join(" ")).toContain("g.ts");
  });

  it("merge preflight failures that aren't conflicts propagate as errors", async () => {
    writeFileSync(
      join(plans, "items", "WS", "WS-0014.md"),
      item("WS-0014", "ready", 'targets: ["@code:h.ts"]\n'),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await o.claim("WS-0014", sClaude);
    // claim branch disappears before accept — a real error, not a "conflict"
    const wt = worktreePath(wsr.ws, "WS-0014", "code");
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: codeRepo });
    execFileSync("git", ["branch", "-D", claimBranch("WS-0014", sClaude.id)], { cwd: codeRepo });
    await o.submit("WS-0014", sClaude, {});
    await expect(o.accept("WS-0014")).rejects.toThrow(/h.ts|reference|branch|rev|GIT|fatal/i);
    await o.reject("WS-0014", "broken");
    await o.release("WS-0014", sClaude, "cleanup");
  });

  it("human claim is refused when it overlaps a live agent claim", async () => {
    writeFileSync(
      join(plans, "items", "WS", "WS-0015.md"),
      item("WS-0015", "ready", 'targets: ["@code:d.ts"]\n'),
    );
    writeFileSync(
      join(plans, "items", "WS", "WS-0016.md"),
      item("WS-0016", "ready", 'targets: ["@code:d.ts", "@code:e.ts"]\n'),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await o.claim("WS-0015", sClaude);
    await expect(o.humanClaim("WS-0016")).rejects.toThrow(/overlap|claim/i);
    await o.release("WS-0015", sClaude, "done");
  });

  it("a different agent resumes the released claim branch", async () => {
    writeFileSync(
      join(plans, "items", "WS", "WS-0017.md"),
      item("WS-0017", "ready", 'targets: ["@code:f.ts"]\n'),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await o.claim("WS-0017", sClaude);
    const wt = worktreePath(wsr.ws, "WS-0017", "code");
    writeFileSync(join(wt, "wip.ts"), "half-done work\n");
    execFileSync("git", ["add", "wip.ts"], { cwd: wt });
    execFileSync("git", ["commit", "-m", "wip"], { cwd: wt });
    await o.release("WS-0017", sClaude, "pausing");
    // a different agent re-claims: should land on the retained branch
    await o.claim("WS-0017", sCodex);
    const wt2 = worktreePath(wsr.ws, "WS-0017", "code");
    expect(existsSync(join(wt2, "wip.ts"))).toBe(true);
    // codex's resumed work must be mergeable — accept merges the ACTUAL
    // worktree branch (claude's), not a synthesized codex branch name
    writeFileSync(join(wt2, "more.ts"), "codex continuation\n");
    execFileSync("git", ["add", "-A"], { cwd: wt2 });
    execFileSync("git", ["commit", "-m", "codex part"], { cwd: wt2 });
    await o.submit("WS-0017", sCodex, {});
    const r = (await o.accept("WS-0017")) as { merged?: Array<{ mergeCommit: string }> };
    expect(r.merged?.length).toBe(1);
    expect(execFileSync("git", ["show", "main:wip.ts"], { cwd: codeRepo, encoding: "utf8" })).toContain("half-done");
    expect(execFileSync("git", ["show", "main:more.ts"], { cwd: codeRepo, encoding: "utf8" })).toContain("codex");
    rmSync(join(codeRepo, "wip.ts"), { force: true });
    rmSync(join(codeRepo, "more.ts"), { force: true });
    execFileSync("git", ["add", "-A"], { cwd: codeRepo });
    execFileSync("git", ["commit", "-m", "revert"], { cwd: codeRepo });
  });

  it("targets that escape the resource root via .. are rejected", async () => {
    writeFileSync(
      join(plans, "items", "WS", "WS-0019.md"),
      item("WS-0019", "ready", 'targets: ["@docs:../victim/**"]\n'),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await expect(o.claim("WS-0019", sClaude)).rejects.toThrow(/target|escap|\.\./i);
  });

  it("a directory target written without a glob still rolls back deletes", async () => {
    const folderSrc = mkdtempSync(join(tmpdir(), "te-fdir-"));
    mkdirSync(join(folderSrc, "cfg"), { recursive: true });
    writeFileSync(join(folderSrc, "cfg", "a.conf"), "base\n");
    docsResource(folderSrc);
    writeFileSync(
      join(plans, "items", "WS", "WS-0020.md"),
      item("WS-0020", "ready", `targets: ["@docs:cfg"]\n`), // dir, no glob
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await o.claim("WS-0020", sClaude);
    // a dir without a glob must behave like a dir: files created since are removed
    writeFileSync(join(folderSrc, "cfg", "created-since.conf"), "new\n");
    await o.rollback("WS-0020");
    expect(existsSync(join(folderSrc, "cfg", "created-since.conf"))).toBe(false);
    expect(readFileSync(join(folderSrc, "cfg", "a.conf"), "utf8")).toBe("base\n");
    await o.release("WS-0020", sClaude, "done");
    rmSync(folderSrc, { recursive: true, force: true });
  });

  it("an unreachable ssh host fails the claim — never recorded as 'missing'", async () => {
    // port 1 refuses instantly → ssh exits 255, not test -e's exit 1.
    // Any probe failure must abort the claim: treating it as "missing" would
    // let a later rollback rm -rf a real remote path.
    wsr.ws.config.resources = {
      ...wsr.ws.config.resources,
      dead: {
        kind: "ssh",
        host: "nobody@127.0.0.1",
        path: "/tmp/te-dead",
        snapshot: true,
        ssh_opts: [
          "-o", "ConnectTimeout=2",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "LogLevel=ERROR",
          "-p", "1",
        ],
      },
    };
    wsr.ws.resources.set("dead", {
      name: "dead",
      config: wsr.ws.config.resources.dead,
      path: undefined,
    });
    writeFileSync(
      join(plans, "items", "WS", "WS-0022.md"),
      item("WS-0022", "ready", 'targets: ["@dead:cfg/**"]\n'),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await expect(o.claim("WS-0022", sClaude)).rejects.toThrow(/probe|ssh|fail/i);
    expect(st.idx.claims.get("WS-0022")).toBeUndefined();
  });

  it("release preserves the worktree when the WIP safety commit fails", async () => {
    writeFileSync(
      join(plans, "items", "WS", "WS-0021.md"),
      item("WS-0021", "ready", 'targets: ["@code:i.ts"]\n'),
    );
    const st = new PlansStore(wsr.ws, "test");
    await st.init();
    const o = new WorkspaceOps({ ws: wsr.ws, store: st }, sessions, undefined, home);
    await o.claim("WS-0021", sClaude);
    const wt = worktreePath(wsr.ws, "WS-0021", "code");
    writeFileSync(join(wt, "uncommitted.ts"), "work\n");
    // force the safety commit to fail
    const hook = join(codeRepo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    execFileSync("chmod", ["+x", hook]);
    await o.release("WS-0021", sClaude, "pausing");
    execFileSync("rm", [hook]);
    // worktree must still be there with the uncommitted file intact
    expect(existsSync(join(wt, "uncommitted.ts"))).toBe(true);
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: codeRepo });
  });
});
