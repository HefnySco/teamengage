import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "./store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { ConflictError, InvalidTransitionError } from "../../core/model/errors.js";
import type { Actor } from "../../core/state/machine.js";
import type { Claim } from "../../core/model/claim.js";

const agent: Actor = { kind: "agent", session: "claude-code@test#aa01", machine: "test" };
const human: Actor = { kind: "human", session: "human", machine: "test" };

let home: string;
let root: string;
let plans: string;
let store: PlansStore;

function claimFor(id: string, holder = agent.session): Claim {
  return {
    item: id,
    holder,
    actor: "agent",
    machine: "test",
    targets: ["@self:src/**"],
    claimed_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-store-home-"));
  root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "GL"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  writeFileSync(
    join(plans, "items", "GL", "GL-0001.md"),
    "---\nid: GL-0001\ntype: task\ntitle: one\nstatus: draft\nversion: 1\n---\n\n## Summary\nx\n",
  );
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });
  const ws = resolveWorkspace(root, { home });
  store = new PlansStore(ws, "test");
  await store.init();
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("PlansStore", () => {
  it("mutations are serialized, version-bumped, committed", async () => {
    const r1 = await store.perform("GL-0001", 1, human, { type: "approve_plan" });
    expect(r1.meta.status).toBe("ready");
    expect(r1.meta.version).toBe(2);
    const log = execFileSync("git", ["log", "--oneline"], { cwd: plans }).toString();
    expect(log).toContain("te: GL-0001 approve_plan by human");
    expect(store.idx.get("GL-0001")!.meta.version).toBe(2);
    const claim = claimFor("GL-0001");
    const r2 = await store.perform("GL-0001", 2, agent, { type: "claim", claim });
    expect(r2.meta.status).toBe("in_progress");
    expect(r2.external.some((e) => e.type === "setup_work")).toBe(true);
    expect(existsSync(join(plans, "claims", "GL-0001.yaml"))).toBe(true);
    expect(store.idx.get("GL-0001")!.claim?.holder).toBe(agent.session);
  });

  it("CAS: 100 concurrent mutations — exactly one wins per version", async () => {
    writeFileSync(
      join(plans, "items", "GL", "GL-0002.md"),
      "---\nid: GL-0002\ntype: task\ntitle: race\nstatus: ready\nversion: 1\n---\n",
    );
    execFileSync("git", ["add", "-A"], { cwd: plans });
    execFileSync("git", ["commit", "-m", "add GL-0002"], { cwd: plans });
    await store.idx.upsertFile(join(plans, "items", "GL", "GL-0002.md"));

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        store.perform(
          "GL-0002",
          1, // everyone has version 1
          { kind: "agent", session: `agent-${i}@test#x`, machine: "test" },
          { type: "claim", claim: claimFor("GL-0002", `agent-${i}@test#x`) },
        ),
      ),
    );
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(99);
    for (const l of losses) {
      expect((l as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    }
    // item state is consistent with exactly one claimant
    const claimFiles = readdirSync(join(plans, "claims")).filter((f) => f === "GL-0002.yaml");
    expect(claimFiles).toHaveLength(1);
    const item = store.idx.get("GL-0001");
    expect(item).toBeDefined();
  });

  it("atomic write leaves no partial file or stray tmp", async () => {
    writeFileSync(
      join(plans, "items", "GL", "GL-0003.md"),
      "---\nid: GL-0003\ntype: task\ntitle: t\nstatus: ready\nversion: 1\n---\n",
    );
    await store.idx.upsertFile(join(plans, "items", "GL", "GL-0003.md"));
    await expect(
      store.perform("GL-0003", 1, agent, { type: "submit" }),
    ).rejects.toThrow(InvalidTransitionError);
    // failed mutation changed nothing
    expect(readFileSync(join(plans, "items", "GL", "GL-0003.md"), "utf8")).toContain("status: ready");
    const tmpFiles = readdirSync(join(plans, "items", "GL")).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("a mutation deleting a never-committed claim file still commits cleanly", async () => {
    writeFileSync(
      join(plans, "items", "GL", "GL-0004.md"),
      "---\nid: GL-0004\ntype: task\ntitle: t\nstatus: in_review\nversion: 1\n---\n",
    );
    execFileSync("git", ["add", "-A"], { cwd: plans });
    execFileSync("git", ["commit", "-m", "add GL-0004"], { cwd: plans });
    await store.idx.upsertFile(join(plans, "items", "GL", "GL-0004.md"));
    // claim exists on disk but was never committed — e.g. a writer that
    // crashed between add and commit left it staged-or-untracked
    mkdirSync(join(plans, "claims"), { recursive: true });
    writeFileSync(
      join(plans, "claims", "GL-0004.yaml"),
      "item: GL-0004\nholder: claude-code@test#aa01\nactor: agent\nmachine: test\nclaimed_at: '2026-01-01T00:00:00Z'\nlast_seen: '2026-01-01T00:00:00Z'\n",
    );
    store.idx.setClaim(claimFor("GL-0004"));
    const r = await store.perform("GL-0004", 1, human, { type: "accept" });
    expect(r.meta.status).toBe("done");
    // nothing half-staged, nothing left dirty
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: plans, encoding: "utf8" }).trim(),
    ).toBe("");
  });

  it("refuses to write while the plans repo has a merge in progress", async () => {
    mkdirSync(join(plans, ".git"), { recursive: true });
    writeFileSync(join(plans, ".git", "MERGE_HEAD"), "deadbeef\n");
    await expect(store.perform("GL-0001", 4, human, { type: "drop" })).rejects.toThrow(
      ConflictError,
    );
    rmSync(join(plans, ".git", "MERGE_HEAD"));
  });

  it("no git push exists anywhere in src", async () => {
    // all git access goes through resources/git, which rejects 'push'
    const { git } = await import("../../resources/git/git.js");
    await expect(git(plans, ["push"])).rejects.toThrow(/forbidden/);
  });
});
