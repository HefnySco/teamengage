import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "../api/ops.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { pullBeforeMutation, pushPlansAuto, remotePlanIds, checkRemoteTargetLock } from "./sync.js";
import { claimToYaml } from "../../core/claims/claims.js";
import { readLockFile } from "../../core/ops/lock.js";
import { ClaimRefusedError } from "../../core/model/errors.js";
import { allocateId, idPrefix } from "../../core/address/refs.js";

/**
 * DE-0299 sync:auto — pull before claim/propose/ops-lock, push after, and
 * item ids another machine already took are never handed out again.
 * Two plans clones sharing one bare remote simulate two machines.
 */

let home: string;

/** each pair gets its own bare remote — they share nothing */
function mkRemote(tag: string): string {
  const remote = join(home, `remote-${tag}.git`);
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });
  return remote;
}

function seedPlans(dir: string, sync: "manual" | "auto", extra = "") {
  mkdirSync(join(dir, "items", "WS"), { recursive: true });
  mkdirSync(join(dir, "claims"), { recursive: true });
  writeFileSync(
    join(dir, "workspace.yaml"),
    `name: ws\nprefix: WS\nsync: ${sync}\n${extra}resources:\n  self: { kind: git, path: . }\n`,
  );
  writeFileSync(
    join(dir, "items", "WS", "WS-0001.md"),
    '---\nid: WS-0001\ntype: task\ntitle: one\nstatus: ready\nversion: 1\ntargets: ["@self:src/a.ts"]\n---\n\n## Summary\nx\n',
  );
  writeFileSync(
    join(dir, "items", "WS", "WS-0002.md"),
    '---\nid: WS-0002\ntype: task\ntitle: two\nstatus: ready\nversion: 1\ntargets: ["@self:src/b.ts"]\n---\n\n## Summary\nx\n',
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
}

function gitOk(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return `${r.stdout}`;
}

/** commit + push a machine's pending plans files, like a finished mutation. */
function pushAll(dir: string, msg: string) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", msg], { cwd: dir });
  execFileSync("git", ["push"], { cwd: dir });
}

async function mkWsr(plans: string, machine: string) {
  const ws = resolveWorkspace(join(plans, ".."), { home });
  const store = new PlansStore(ws, machine);
  await store.init();
  const sessions = new SessionRegistry(machine);
  const wsr = { ws, store } as WorkspaceRuntime;
  return { wsr, ops: new WorkspaceOps(wsr, sessions, undefined, home) };
}

/** a pair of auto-sync machines sharing one bare remote */
async function mkPair(tag: string, extra = "") {
  const remote = mkRemote(tag);
  const seed = join(home, `${tag}-seed`);
  seedPlans(seed, "auto", extra);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: seed });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: seed });
  const plansA = join(home, `${tag}-a`, ".teamengage");
  const plansB = join(home, `${tag}-b`, ".teamengage");
  mkdirSync(join(home, `${tag}-a`), { recursive: true });
  mkdirSync(join(home, `${tag}-b`), { recursive: true });
  execFileSync("git", ["clone", remote, plansA]);
  execFileSync("git", ["clone", remote, plansB]);
  for (const d of [plansA, plansB]) {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
    execFileSync("git", ["config", "user.name", "t"], { cwd: d });
  }
  const a = await mkWsr(plansA, `machine-${tag}-a`);
  const b = await mkWsr(plansB, `machine-${tag}-b`);
  return { remote, plansA, plansB, a, b };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "te-auto-"));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("sync:auto — pull before claim", () => {
  it("a claim pushed on the other machine refuses the local claim after the pull", async () => {
    const { plansB, a, b } = await mkPair("claim");
    // B claims WS-0001 and pushes
    mkdirSync(join(plansB, "claims"), { recursive: true });
    writeFileSync(
      join(plansB, "claims", "WS-0001.yaml"),
      claimToYaml({
        item: "WS-0001",
        holder: "gemini@b#1",
        actor: "agent",
        machine: "machine-b",
        targets: ["@self:src/a.ts"],
        claimed_at: "2026-01-01T00:00:00Z",
        last_seen: "2026-01-01T00:00:00Z",
      }),
    );
    pushAll(plansB, "claim ws-0001");

    const { session } = await a.ops.hello("claude");
    await expect(a.ops.claim("WS-0001", session)).rejects.toThrow(/claimed/);
    expect(a.wsr.store.idx.claims.has("WS-0001")).toBe(true); // pulled, not local
    expect(a.wsr.store.idx.claims.get("WS-0001")!.machine).toBe("machine-b");
    void b;
  });

  it("publishes the claim commit after a successful claim", async () => {
    const { remote, a } = await mkPair("push");
    const { session } = await a.ops.hello("claude");
    const { claim, warn } = await a.ops.claim("WS-0001", session);
    expect(warn).toBeUndefined();
    expect(claim.unsynced).toBeUndefined();
    // the remote now carries the claim file
    const remoteTree = gitOk(["ls-tree", "--name-only", "main", "claims/"], remote);
    expect(remoteTree).toContain("WS-0001.yaml");
  });
});

describe("sync:auto — propose", () => {
  it("a stale local counter cannot re-use an id the other machine took", async () => {
    const { remote, plansB, a, b } = await mkPair("prop");
    // B proposes and the auto push publishes it; A's local counter is stale
    const br = await b.ops.propose([{ title: "remote item", domains: ["sync"] }], "human");
    expect(br.ids).toEqual(["WS-0003"]);
    void plansB;

    // A proposes: pull first, allocate above the remote max, push out
    const ar = await a.ops.propose([{ title: "local item", domains: ["sync"] }], "human");
    expect(ar.warn).toBeUndefined();
    expect(ar.ids[0]).not.toBe("WS-0003");
    expect(ar.ids[0]).toBe("WS-0004");
    // both items are on the remote now — no collision, no conflict
    const tree = gitOk(["ls-tree", "-r", "--name-only", "main", "items/"], remote);
    expect(tree).toContain("WS-0003.md");
    expect(tree).toContain("WS-0004.md");
    expect(a.wsr.store.idx.items.has("WS-0004")).toBe(true);
  });

  it("manual mode: allocation still counts ids visible on the fetched upstream", async () => {
    // a manual-sync pair: B publishes WS-0003, A only fetches (never pulls)
    const remote = mkRemote("man");
    const seed = join(home, "man-seed");
    seedPlans(seed, "manual");
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: seed });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: seed });
    const plansA = join(home, "man-a", ".teamengage");
    execFileSync("git", ["clone", remote, plansA]);
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: plansA });
    execFileSync("git", ["config", "user.name", "t"], { cwd: plansA });
    // remote gains WS-0003 after A cloned — A's index stays stale
    const other = join(home, "man-other");
    execFileSync("git", ["clone", remote, other]);
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: other });
    execFileSync("git", ["config", "user.name", "t"], { cwd: other });
    writeFileSync(
      join(other, "items", "WS", "WS-0003.md"),
      "---\nid: WS-0003\ntype: task\ntitle: three\nstatus: draft\nversion: 1\n---\n",
    );
    pushAll(other, "propose ws-0003");

    const a = await mkWsr(plansA, "machine-man-a");
    const r = await a.ops.propose([{ title: "manual item", domains: ["sync"] }], "human");
    expect(r.ids[0]).toBe("WS-0004");
  });

  it("remaps the ready ids too when a refused push renumbers the items", async () => {
    // A pulls, allocates WS-0003 — then the remote moves (B pushes its own
    // WS-0003) before A's push. The collision repair renumbers A's item; the
    // ready list must name the new id, not the dead one.
    const { remote, plansB, a } = await mkPair("rdy", "autonomy: solo\n");
    writeFileSync(
      join(plansB, "items", "WS", "WS-0003.md"),
      "---\nid: WS-0003\ntype: task\ntitle: remote wins\nstatus: draft\nversion: 1\n---\n",
    );
    execFileSync("git", ["add", "-A"], { cwd: plansB });
    execFileSync("git", ["commit", "-m", "ws-0003"], { cwd: plansB });
    // inject B's push right after A's items are written — the pull inside
    // propose already ran, the push is still to come
    const createItems = a.wsr.store.createItems.bind(a.wsr.store);
    a.wsr.store.createItems = (async (
      ...args: Parameters<typeof createItems>
    ): Promise<Awaited<ReturnType<typeof createItems>>> => {
      const r = await createItems(...args);
      execFileSync("git", ["push"], { cwd: plansB });
      return r;
    }) as typeof createItems;
    // the bug names known work — under autonomy: solo it lands ready
    const { session } = await a.ops.hello("agent");
    const r = await a.ops.propose(
      [{ type: "bug", title: "bug in one", found_by: ["WS-0001"], domains: ["sync"] }],
      session,
    );
    expect(r.ids).toEqual(["WS-0004"]);
    expect(r.ready).toEqual(["WS-0004"]);
    expect(a.wsr.store.idx.items.get("WS-0004")!.meta.status).toBe("ready");
    // the remote keeps B's WS-0003 and A's renumbered item — nothing clashed
    const tree = gitOk(["ls-tree", "-r", "--name-only", "main", "items/"], remote);
    expect(tree).toContain("WS-0003.md");
    expect(tree).toContain("WS-0004.md");
  });
});

describe("sync:auto — divergence and repair", () => {
  it("a diverged plans repo is reported, never merged", async () => {
    const { plansA, plansB, a } = await mkPair("div");
    // B advances the remote
    writeFileSync(
      join(plansB, "items", "WS", "WS-0003.md"),
      "---\nid: WS-0003\ntype: task\ntitle: three\nstatus: draft\nversion: 1\n---\n",
    );
    pushAll(plansB, "ws-0003");
    // A makes its own local commit — now ahead AND behind
    writeFileSync(join(plansA, "notes.txt"), "local work\n");
    execFileSync("git", ["add", "-A"], { cwd: plansA });
    execFileSync("git", ["commit", "-m", "te: local note"], { cwd: plansA });
    const headBefore = gitOk(["rev-parse", "HEAD"], plansA).trim();

    await expect(pullBeforeMutation(a.wsr)).rejects.toThrow(ClaimRefusedError);
    await expect(pullBeforeMutation(a.wsr)).rejects.toThrow(/diverged/);
    expect(gitOk(["rev-parse", "HEAD"], plansA).trim()).toBe(headBefore); // untouched
  });

  it("renumbers the items whose ids the remote won, then pushes", async () => {
    const { remote, plansA, plansB, a } = await mkPair("race");
    // B takes WS-0003 first and pushes — A is about to allocate the same id
    writeFileSync(
      join(plansB, "items", "WS", "WS-0003.md"),
      "---\nid: WS-0003\ntype: task\ntitle: remote wins\nstatus: draft\nversion: 1\n---\n",
    );
    pushAll(plansB, "ws-0003");
    // A creates its item on stale state (no pull — its upstream ref is stale too)
    const r = await a.wsr.store.createItems(
      [{ type: "task", title: "local loses", domains: ["sync"] }],
      { kind: "agent", session: "a@test#1", machine: "machine-race-a" },
    );
    expect(r.ids).toEqual(["WS-0003"]); // stale counter handed the same id out
    // the push is refused — the remote moved
    const push1 = await pushPlansAuto(a.wsr);
    expect(push1.pushed).toBe(false);
    expect(push1.diverged).toBe(true);
    // the repair: the remote's ids are off-limits, ours get fresh ones
    const remoteTaken = await remotePlanIds(plansA);
    expect(remoteTaken.has("WS-0003")).toBe(true);
    const collided = r.ids.filter((id) => remoteTaken.has(id));
    const taken = new Set([...a.wsr.store.idx.items.keys(), ...remoteTaken]);
    const renames = new Map<string, string>();
    for (const oldId of collided) {
      const fresh = allocateId(idPrefix(oldId), taken);
      taken.add(fresh);
      renames.set(oldId, fresh);
    }
    await a.wsr.store.repairIdCollision(renames);
    const push2 = await pushPlansAuto(a.wsr);
    expect(push2.pushed).toBe(true);
    // remote now holds B's WS-0003 and A's renumbered item — nothing clashed
    const tree = gitOk(["ls-tree", "-r", "--name-only", "main", "items/"], remote);
    expect(tree).toContain("WS-0003.md");
    expect(tree).toContain("WS-0004.md");
    expect(a.wsr.store.idx.items.has("WS-0004")).toBe(true);
    expect(a.wsr.store.idx.items.has("WS-0003")).toBe(true); // remote's, pulled
    expect(a.wsr.store.idx.items.get("WS-0003")!.meta.title).toBe("remote wins");
    // nothing is left over: the repair folded its work into one child of the tip
    expect(gitOk(["status", "--porcelain"], plansA).trim()).toBe("");
  });
});

describe("sync:auto — ops locks", () => {
  it("a lock pushed on the other machine is pulled before the start", async () => {
    const { plansA, plansB, a } = await mkPair("lock");
    // B writes a target lock and pushes
    mkdirSync(join(plansB, "ops", "locks"), { recursive: true });
    writeFileSync(
      join(plansB, "ops", "locks", "rpi5.yaml"),
      "target: rpi5\njob: j-1\nmachine: machine-b\nts: 2026-01-01T00:00:00Z\n",
    );
    pushAll(plansB, "lock rpi5");

    const { unsynced } = await checkRemoteTargetLock(a.wsr, "rpi5");
    expect(unsynced).toBe(false);
    // the pull brought the lock file — the job's own lock check sees it
    expect(existsSync(join(plansA, "ops", "locks", "rpi5.yaml"))).toBe(true);
    expect(readLockFile(join(plansA, "ops", "locks"), "rpi5")?.machine).toBe("machine-b");
  });
});
