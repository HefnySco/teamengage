import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { handoffStatus, handoffLines } from "./sync.js";
import { claimToYaml } from "../../core/claims/claims.js";

/**
 * Machine handoff report for `hello`. The plans dir sits BELOW the repo root
 * (overlay: drone_engage/Tasks/.teamengage) — remote claims must still be
 * read from the right path.
 */

let home: string;
let remote: string;
let repoA: string;
let repoB: string;
let wsrA: WorkspaceRuntime;

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
const plansOf = (repo: string) => join(repo, "Tasks", ".teamengage");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-handoff-"));
  remote = join(home, "remote.git");
  repoA = join(home, "desktop");
  repoB = join(home, "laptop");
  g(home, "init", "--bare", "-b", "main", remote);
  mkdirSync(join(plansOf(repoA), "items"), { recursive: true });
  writeFileSync(
    join(plansOf(repoA), "workspace.yaml"),
    "name: tasks\nprefix: GL\nmode: overlay\ncommit: false\n",
  );
  writeFileSync(join(repoA, "Tasks", "a.md"), "---\nte: GL-0001\n---\n# A\n");
  writeFileSync(
    join(plansOf(repoA), "items", "GL-0001.md"),
    "---\nid: GL-0001\ntype: task\ntitle: A\nstatus: ready\nversion: 1\nsource: a.md\n---\n",
  );
  g(repoA, "init", "-b", "main");
  for (const r of [repoA]) {
    g(r, "config", "user.email", "t@t");
    g(r, "config", "user.name", "t");
  }
  g(repoA, "add", "-A");
  g(repoA, "commit", "-m", "init");
  g(repoA, "remote", "add", "origin", remote);
  g(repoA, "push", "-u", "origin", "main");
  g(home, "clone", remote, repoB);
  g(repoB, "config", "user.email", "t@t");
  g(repoB, "config", "user.name", "t");

  const ws = resolveWorkspace(join(repoA, "Tasks"), { home });
  const store = new PlansStore(ws, "desktop");
  await store.init();
  wsrA = { ws, store };
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("handoffStatus", () => {
  it("in sync and clean → nothing to report", async () => {
    const h = await handoffStatus(wsrA);
    expect(h).toMatchObject({ fetched: true, ahead: 0, behind: 0, uncommitted: 0, foreign: [] });
    expect(handoffLines(h)).toEqual([]);
  });

  it("reports a claim pushed from the laptop that the desktop has not pulled", async () => {
    mkdirSync(join(plansOf(repoB), "claims"), { recursive: true });
    writeFileSync(
      join(plansOf(repoB), "claims", "GL-0001.yaml"),
      claimToYaml({
        item: "GL-0001",
        holder: "gemini-cli@laptop#77b0",
        actor: "agent",
        machine: "laptop",
        targets: [],
        claimed_at: "2026-10-09T08:00:00Z",
        last_seen: "2026-10-09T08:00:00Z",
      }),
    );
    g(repoB, "add", "-A");
    g(repoB, "commit", "-m", "claim on laptop");
    g(repoB, "push");

    // and the desktop has an uncommitted plans change (commit: false)
    writeFileSync(join(plansOf(repoA), "items", "GL-0002.md"), "---\nid: GL-0002\ntype: task\ntitle: B\n---\n");

    const h = await handoffStatus(wsrA);
    expect(h).toMatchObject({ fetched: true, behind: 1, ahead: 0, uncommitted: 1, upstream: "origin/main" });
    expect(h.foreign.map((c) => `${c.item}@${c.machine}`)).toEqual(["GL-0001@laptop"]);
    const lines = handoffLines(h).join("\n");
    expect(lines).toContain("plans behind origin/main by 1 — STOP");
    expect(lines).toContain("1 uncommitted file(s)");
    expect(lines).toContain("held on laptop: GL-0001 by gemini-cli@laptop#77b0");
  });

  it("offline: last-known state, flagged", async () => {
    g(repoA, "remote", "set-url", "origin", join(home, "gone.git"));
    const h = await handoffStatus(wsrA, { fetchTimeoutMs: 2000 });
    expect(h.fetched).toBe(false);
    expect(handoffLines(h)).toContain("plans remote unreachable — sync state is last-known");
  });
});
