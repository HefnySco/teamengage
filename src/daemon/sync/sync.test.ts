import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "../api/ops.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { reconcile, syncStatus, remoteClaims } from "./sync.js";
import { claimToYaml } from "../../core/claims/claims.js";
import type { Claim } from "../../core/model/claim.js";
import { ClaimRefusedError } from "../../core/model/errors.js";

/**
 * SY-0001/2: fetch-before-claim and post-pull reconciliation.
 * Two plans repos sharing one bare remote simulate two machines.
 */

let home: string;
let remote: string;
let plansA: string; // "machine A" plans clone
let plansB: string; // "machine B" plans clone
let wsrA: WorkspaceRuntime;
let wsrB: WorkspaceRuntime;
let opsA: WorkspaceOps;


function seedPlans(dir: string) {
  mkdirSync(join(dir, "items", "WS"), { recursive: true });
  mkdirSync(join(dir, "claims"), { recursive: true });
  writeFileSync(
    join(dir, "workspace.yaml"),
    "name: ws\nprefix: WS\nsync: manual\nresources:\n  self: { kind: git, path: . }\n",
  );
  writeFileSync(
    join(dir, "items", "WS", "WS-0001.md"),
    "---\nid: WS-0001\ntype: task\ntitle: one\nstatus: ready\nversion: 1\ntargets: [\"@self:src/a.ts\"]\n---\n\n## Summary\nx\n",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
}

const claim = (over: Partial<Claim>): Claim => ({
  item: "WS-0001",
  holder: "a@m#1",
  actor: "agent",
  machine: "m1",
  targets: ["@self:src/a.ts"],
  claimed_at: "2026-01-01T00:00:00Z",
  last_seen: "2026-01-01T00:00:00Z",
  ...over,
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-sync-"));
  remote = join(home, "remote.git");
  const seed = join(home, "seed");
  seedPlans(seed);
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: seed });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: seed });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });

  plansA = join(home, "a", ".teamengage");
  plansB = join(home, "b", ".teamengage");
  mkdirSync(join(home, "a"), { recursive: true });
  mkdirSync(join(home, "b"), { recursive: true });
  execFileSync("git", ["clone", remote, plansA]);
  execFileSync("git", ["clone", remote, plansB]);
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plansA });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plansA });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plansB });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plansB });

  const mkWsr = async (plans: string, machine: string) => {
    const ws = resolveWorkspace(join(plans, ".."), { home });
    const store = new PlansStore(ws, machine);
    await store.init();
    const sessions = new SessionRegistry(machine);
    return { wsr: { ws, store } as WorkspaceRuntime, ops: new WorkspaceOps({ ws, store }, sessions, undefined, home), sessions };
  };
  const a = await mkWsr(plansA, "machine-a");
  const b = await mkWsr(plansB, "machine-b");
  wsrA = a.wsr; opsA = a.ops;
  wsrB = b.wsr;
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("fetch-before-claim (SY-0001)", () => {
  it("refuses a claim that exists on the remote: 'pull first'", async () => {
    // machine B pushes a claim for WS-0001
    mkdirSync(join(plansB, "claims"), { recursive: true });
    writeFileSync(
      join(plansB, "claims", "WS-0001.yaml"),
      claimToYaml(claim({ holder: "gemini@laptop#b2", machine: "laptop" })),
    );
    execFileSync("git", ["add", "-A"], { cwd: plansB });
    execFileSync("git", ["commit", "-m", "claim"], { cwd: plansB });
    execFileSync("git", ["push"], { cwd: plansB });

    const { fetchPlansRepo } = await import("./sync.js");
    await fetchPlansRepo(plansA);
    const remote = await remoteClaims(plansA);
    expect(remote.map((c) => c.item)).toContain("WS-0001");

    // machine A (stale) tries to claim the same item
    const session = opsA.hello("claude").session;
    await expect(opsA.claim("WS-0001", session)).rejects.toThrow(/pull first/);
    // and the local index was never touched
    expect(wsrA.store.idx.claims.has("WS-0001")).toBe(false);
  });

  it("offline (no remote) → claim proceeds marked unsynced", async () => {
    const local = join(home, "c", ".teamengage");
    seedPlans(local);
    const ws = resolveWorkspace(join(local, ".."), { home });
    const store = new PlansStore(ws, "machine-c");
    await store.init();
    const sessions = new SessionRegistry("machine-c");
    const ops = new WorkspaceOps({ ws, store }, sessions, undefined, home);
    const session = ops.hello("claude").session;
    const { claim: c } = await ops.claim("WS-0001", session);
    expect(c.unsynced).toBe(true);
  });
});

describe("post-pull reconciliation (SY-0002)", () => {
  it("overlapping claims keep the earlier one; loser is marked conflicted", async () => {
    // two items with overlapping targets, claimed independently
    writeFileSync(
      join(plansA, "items", "WS", "WS-0002.md"),
      "---\nid: WS-0002\ntype: task\ntitle: two\nstatus: in_progress\nversion: 1\ntargets: [\"@self:src/a.ts\"]\n---\n",
    );
    mkdirSync(join(plansA, "claims"), { recursive: true });
    const early = claim({ item: "WS-0001", holder: "a@mA#1", machine: "A", claimed_at: "2026-01-01T00:00:00Z" });
    const late = claim({ item: "WS-0002", holder: "b@mB#2", machine: "B", claimed_at: "2026-01-02T00:00:00Z" });
    writeFileSync(join(plansA, "claims", "WS-0001.yaml"), claimToYaml(early));
    writeFileSync(join(plansA, "claims", "WS-0002.yaml"), claimToYaml(late));
    await wsrA.store.idx.upsertFile(join(plansA, "items", "WS", "WS-0002.md"));
    wsrA.store.idx.setClaim(early);
    wsrA.store.idx.setClaim(late);

    const notified: string[] = [];
    const marked = await reconcile(wsrA, (m) => notified.push(m));
    expect(marked).toEqual(["WS-0002"]);
    const file = readFileSync(join(plansA, "claims", "WS-0002.yaml"), "utf8");
    expect(file).toContain("conflicted: true");
    expect(wsrA.store.idx.claims.get("WS-0002")!.conflicted).toBe(true);
    expect(wsrA.store.idx.claims.get("WS-0001")!.conflicted).toBeUndefined();
    expect(notified[0]).toContain("WS-0002");
  });

  it("a conflicted claim tells the agent to stop on its next call", async () => {
    const session = { id: "b@mB#2", agent: "b", machine: "mB", connected_at: "", last_seen: "" };
    await expect(opsA.log("WS-0002", session, "still working")).rejects.toThrow(ClaimRefusedError);
  });
});

describe("sync status (RS-0004)", () => {
  it("reports ahead/behind vs upstream", async () => {
    const s = await syncStatus(wsrB);
    expect(s.repo.remote).toBe(true);
    expect(s.repo.ahead).toBe(0); // B pushed everything
    const sa = await syncStatus(wsrA);
    expect(sa.repo.behind).toBeGreaterThan(0); // A hasn't pulled B's claim commit
  });
});
