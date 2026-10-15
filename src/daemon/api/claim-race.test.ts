import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "./ops.js";
import type { WorkspaceRuntime } from "../server/context.js";

/**
 * CR-0008/MC-0003 regression: the target-overlap check must run inside the
 * store's serialized write queue. Two concurrent claims on different items
 * sharing a target must not both succeed.
 */

let home: string;
let plans: string;
let wsr: WorkspaceRuntime;
let ops: WorkspaceOps;
let sessions: SessionRegistry;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-race-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  mkdirSync(join(plans, "claims"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nsync: manual\nresources:\n  self: { kind: git, path: ., worktree: false }\n",
  );
  for (const [id, tgt] of [
    ["WS-0001", "@self:src/a.ts"],
    ["WS-0002", "@self:src/a.ts"],
    ["WS-0003", "@self:src/b.ts"],
  ] as const) {
    writeFileSync(
      join(plans, "items", "WS", `${id}.md`),
      `---\nid: ${id}\ntype: task\ntitle: ${id}\nstatus: ready\nversion: 1\ntargets: ["${tgt}"]\n---\n\n## Summary\nx\n`,
    );
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  wsr = { ws, store };
  sessions = new SessionRegistry("test");
  ops = new WorkspaceOps(wsr, sessions, undefined, home);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("claim serialization (MC-0003)", () => {
  it("two concurrent claims on overlapping targets: exactly one wins", async () => {
    const s1 = (await ops.hello("a1")).session;
    const s2 = (await ops.hello("a2")).session;
    const [r1, r2] = await Promise.allSettled([
      ops.claim("WS-0001", s1),
      ops.claim("WS-0002", s2),
    ]);
    const wins = [r1, r2].filter((r) => r.status === "fulfilled");
    expect(wins).toHaveLength(1);
    // the loser was refused, not silently double-claimed
    const loser = [r1, r2].find((r) => r.status === "rejected");
    expect((loser as PromiseRejectedResult).reason.message).toMatch(/overlap|claimed/i);
  });

  it("the surviving claim holds; a second try on the same item is refused", async () => {
    const held = [...wsr.store.idx.claims.keys()];
    expect(held).toHaveLength(1);
    const s3 = (await ops.hello("a3")).session;
    await expect(ops.claim(held[0], s3)).rejects.toThrow(/claimed/i);
  });
});

describe("takeover of an AI-flagged submission", () => {
  it("claim on in_review+issues moves the claim to another local session", async () => {
    const holder = (await ops.hello("holder")).session;
    const reviewer = (await ops.hello("rev")).session;
    const fixer = (await ops.hello("fix")).session;

    await ops.claim("WS-0003", holder);
    await ops.submit("WS-0003", holder);
    await ops.review("WS-0003", reviewer, "issues", "acceptance unmet");

    // a session from another machine may not take over — worktrees are local
    const remote = {
      id: "other@laptop#0001",
      agent: "other",
      machine: "laptop",
      connected_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    };
    await expect(ops.claim("WS-0003", remote)).rejects.toThrow(/claimed|cannot claim/i);

    // a fresh session on the same machine takes the claim and the worktree
    const { claim } = await ops.claim("WS-0003", fixer);
    expect(claim.holder).toBe(fixer.id);
    const idx = wsr.store.idx;
    expect(idx.items.get("WS-0003")!.meta.status).toBe("in_progress");
    expect(idx.claims.get("WS-0003")!.holder).toBe(fixer.id);
    // the AI verdict stays visible until the fix is resubmitted
    expect(idx.items.get("WS-0003")!.meta.ai_review?.verdict).toBe("issues");

    // fix → resubmit → in_review again, marker cleared
    await ops.submit("WS-0003", fixer);
    expect(idx.items.get("WS-0003")!.meta.status).toBe("in_review");
    expect(idx.items.get("WS-0003")!.meta.ai_review).toBeUndefined();
  });

  it("an ok verdict is not takeable", async () => {
    const reviewer = (await ops.hello("rev2")).session;
    const third = (await ops.hello("third")).session;
    await ops.review("WS-0003", reviewer, "ok", "verified");
    await expect(ops.claim("WS-0003", third)).rejects.toThrow(/claimed|cannot claim/i);
  });
});
