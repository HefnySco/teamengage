import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "../api/ops.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { reconcile, syncStatus, remoteClaims } from "./sync.js";
import { claimToYaml, parseClaimFile } from "../../core/claims/claims.js";
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

/** git helper — returns {ok} rather than throwing on non-zero exit. */
const tryGit = (args: string[], cwd: string) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};

describe("two-machine integration (SY-0003)", () => {
  // A clean pair of machines sharing the same bare remote — isolated from the
  // polluted A/B state used by the unit tests above.
  let plansC: string;
  let plansD: string;
  let wsrC: WorkspaceRuntime;
  let wsrD: WorkspaceRuntime;
  let opsC: WorkspaceOps;
  let opsD: WorkspaceOps;

  const push = (dir: string) => {
    execFileSync("git", ["fetch"], { cwd: dir });
    execFileSync("git", ["merge", "origin/main", "-m", "sync"], { cwd: dir });
    execFileSync("git", ["push"], { cwd: dir });
  };

  beforeAll(async () => {
    plansC = join(home, "e", ".teamengage");
    plansD = join(home, "f", ".teamengage");
    mkdirSync(join(home, "e"), { recursive: true });
    mkdirSync(join(home, "f"), { recursive: true });
    execFileSync("git", ["clone", remote, plansC]);
    execFileSync("git", ["clone", remote, plansD]);
    for (const d of [plansC, plansD]) {
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
      execFileSync("git", ["config", "user.name", "t"], { cwd: d });
    }
    const mkWsr = async (plans: string, machine: string) => {
      const ws = resolveWorkspace(join(plans, ".."), { home });
      const store = new PlansStore(ws, machine);
      await store.init();
      const sessions = new SessionRegistry(machine);
      return {
        wsr: { ws, store } as WorkspaceRuntime,
        ops: new WorkspaceOps({ ws, store }, sessions, undefined, home),
      };
    };
    ({ wsr: wsrC, ops: opsC } = await mkWsr(plansC, "machine-c"));
    ({ wsr: wsrD, ops: opsD } = await mkWsr(plansD, "machine-d"));
  });

  it("sequential claims: after pull, the remote-held claim refuses a local claim", async () => {
    // C creates + claims WS-0005 via the real path and pushes
    writeFileSync(
      join(plansC, "items", "WS", "WS-0005.md"),
      "---\nid: WS-0005\ntype: task\ntitle: five\nstatus: ready\nversion: 1\ntargets: [\"@self:src/e.ts\"]\n---\n",
    );
    execFileSync("git", ["add", "-A"], { cwd: plansC });
    execFileSync("git", ["commit", "-m", "ws-0005 item"], { cwd: plansC });
    await wsrC.store.idx.upsertFile(join(plansC, "items", "WS", "WS-0005.md"));
    const sc = opsC.hello("claude");
    await opsC.claim("WS-0005", sc.session);
    push(plansC);
    // D pulls → the claim file is on disk; D's claim on the same item is refused
    execFileSync("git", ["fetch"], { cwd: plansD });
    execFileSync("git", ["merge", "origin/main", "-m", "pull"], { cwd: plansD });
    await wsrD.store.idx.upsertFile(join(plansD, "items", "WS", "WS-0005.md"));
    const yaml = readFileSync(join(plansD, "claims", "WS-0005.yaml"), "utf8");
    wsrD.store.idx.setClaim(parseClaimFile(yaml));
    const sd = opsD.hello("gemini");
    await expect(opsD.claim("WS-0005", sd.session)).rejects.toThrow(/claim/i);
  });

  it("same-item double-claim produces a real merge conflict — nothing silently overwritten", async () => {
    // C and D both claim WS-0006 offline, different holders, same file path
    for (const [dir, holder, machine, at] of [
      [plansC, "c@desktop#c1", "desktop", "2026-02-01T00:00:00Z"],
      [plansD, "d@laptop#d1", "laptop", "2026-02-02T00:00:00Z"],
    ] as const) {
      writeFileSync(
        join(dir, "claims", "WS-0006.yaml"),
        claimToYaml(claim({ item: "WS-0006", holder, machine, targets: ["@self:src/x.ts"], claimed_at: at })),
      );
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "claim ws-0006"], { cwd: dir });
    }
    execFileSync("git", ["push"], { cwd: plansC });
    // D's push rejected → pull → real conflict on the claim file
    const dpush = tryGit(["push"], plansD);
    expect(dpush.ok).toBe(false);
    tryGit(["fetch"], plansD);
    const merge = tryGit(["merge", "origin/main"], plansD);
    expect(merge.ok).toBe(false);
    const st = tryGit(["status", "--porcelain"], plansD);
    expect(st.out).toMatch(/(UU|AA) claims\/WS-0006.yaml/);
    // both versions recoverable — nothing was silently overwritten
    expect(tryGit(["show", "origin/main:claims/WS-0006.yaml"], plansD).out).toContain("c@desktop#c1");
    expect(readFileSync(join(plansD, "claims", "WS-0006.yaml"), "utf8")).toContain("d@laptop#d1");
    // human resolves: keep the earlier claim (C); D's claim file is gone
    execFileSync("git", ["checkout", "--theirs", "claims/WS-0006.yaml"], { cwd: plansD });
    execFileSync("git", ["add", "claims/WS-0006.yaml"], { cwd: plansD });
    execFileSync("git", ["commit", "-m", "resolve: keep earlier claim"], { cwd: plansD });
    push(plansD);
    const back = tryGit(["show", "origin/main:claims/WS-0006.yaml"], plansC);
    execFileSync("git", ["fetch"], { cwd: plansC });
    expect(back.out).toContain("c@desktop#c1");
  });

  it("concurrent edits to the same item surface as a conflict, both sides kept", async () => {
    const p = join("items", "WS", "WS-0001.md");
    // C edits title, D edits status — modify/modify on the same file
    writeFileSync(join(plansC, p), readFileSync(join(plansC, p), "utf8").replace("title: one", "title: one-by-C"));
    execFileSync("git", ["add", "-A"], { cwd: plansC });
    execFileSync("git", ["commit", "-m", "c edits"], { cwd: plansC });
    push(plansC);

    writeFileSync(join(plansD, p), readFileSync(join(plansD, p), "utf8").replace("status: ready", "status: in_progress"));
    execFileSync("git", ["add", "-A"], { cwd: plansD });
    execFileSync("git", ["commit", "-m", "d edits"], { cwd: plansD });
    tryGit(["fetch"], plansD);
    const merge = tryGit(["merge", "origin/main"], plansD);
    expect(merge.ok).toBe(false);
    expect(readFileSync(join(plansD, p), "utf8")).toContain("<<<<<<<");
    // resolve keeping C's edit; the file still parses as an item
    execFileSync("git", ["checkout", "--theirs", p], { cwd: plansD });
    execFileSync("git", ["add", p], { cwd: plansD });
    execFileSync("git", ["commit", "-m", "resolve"], { cwd: plansD });
    push(plansD);
    expect(readFileSync(join(plansD, p), "utf8")).toContain("one-by-C");
  });
});
