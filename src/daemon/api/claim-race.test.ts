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

describe("issues verdicts and the claim (TE-0175)", () => {
  const AH = { problem: "the change is not verified end to end", recommendation: "read the diff and accept or send it back", options: ["accept", "send back"] };

  it("issues on a live local holder sends it back in_progress — nobody else takes it", async () => {
    const holder = (await ops.hello("holder")).session;
    const reviewer = (await ops.hello("rev")).session;
    const fixer = (await ops.hello("fix")).session;

    await ops.claim("WS-0003", holder);
    await ops.submit("WS-0003", holder, { what: "task done", how: "ran the steps" });
    await ops.review("WS-0003", reviewer, "issues", "acceptance unmet", "goes back for fixes", undefined, undefined, undefined, AH);

    // a live local holder keeps the claim and fixes — in_progress, not stranded
    const idx = wsr.store.idx;
    expect(idx.items.get("WS-0003")!.meta.status).toBe("in_progress");
    expect(idx.claims.get("WS-0003")!.holder).toBe(holder.id);

    // nobody else takes a live claim — not from another machine, not locally
    const remote = {
      id: "other@laptop#0001",
      agent: "other",
      machine: "laptop",
      connected_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    };
    await expect(ops.claim("WS-0003", remote)).rejects.toThrow(/claimed|cannot claim/i);
    await expect(ops.claim("WS-0003", fixer)).rejects.toThrow(/claimed|cannot claim/i);

    // the holder resubmits, then its session ends while the item is in
    // review — the next issues verdict frees the item instead of stranding it
    await ops.submit("WS-0003", holder, { what: "task done", how: "ran the steps" });
    expect(idx.items.get("WS-0003")!.meta.status).toBe("in_review");
    sessions.disconnect(holder.id);
    await ops.review("WS-0003", reviewer, "issues", "still unmet", "still unmet — goes back", undefined, undefined, undefined, AH);
    expect(idx.items.get("WS-0003")!.meta.status).toBe("ready");
    expect(idx.claims.has("WS-0003")).toBe(false);

    // a fresh session on this machine claims the freed item, fixes, resubmits
    // (the two issues verdicts escalated the tier — a walkthrough is required)
    const { claim } = await ops.claim("WS-0003", fixer);
    expect(claim.holder).toBe(fixer.id);
    expect(idx.items.get("WS-0003")!.meta.status).toBe("in_progress");
    await ops.submit("WS-0003", fixer, { what: "task done", how: "ran the steps", walkthrough: "fixed and re-ran" });
    expect(idx.items.get("WS-0003")!.meta.status).toBe("in_review");
    expect(idx.items.get("WS-0003")!.meta.ai_review).toBeUndefined();
  });

  it("an ok verdict is not takeable", async () => {
    const reviewer = (await ops.hello("rev2")).session;
    const third = (await ops.hello("third")).session;
    await ops.review("WS-0003", reviewer, "ok", "verified", "verified the fix");
    await expect(ops.claim("WS-0003", third)).rejects.toThrow(/claimed|cannot claim/i);
  });
});
