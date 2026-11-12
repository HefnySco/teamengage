import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { Playbook } from "./playbook.js";
import { JobStore } from "./job.js";
import { readLockFile, lockFilePath } from "./lock.js";
import { checkRemoteTargetLock, fetchPlansRepo, remoteOpsLocks } from "../../daemon/sync/sync.js";
import type { WorkspaceRuntime } from "../../daemon/server/context.js";

/**
 * Target locks (GL-0270): one live job per target across sessions and
 * machines. The local half lives in JobStore; the remote half —
 * fetch the plans repo, read the pushed locks — in sync.ts.
 */

let dir: string;
let root: string;
let teDir: string;
let store: JobStore;

const playbook = () =>
  Playbook.parse({
    name: "deploy",
    target: "cloud",
    steps: [{ id: "one", kind: "cmd", run: "x" }],
  });

const locksDir = () => join(teDir, "ops", "locks");

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "te-lock-"));
  root = join(dir, "ws");
  teDir = join(root, ".teamengage");
  mkdirSync(join(root, "ops"), { recursive: true });
  writeFileSync(join(root, "ops", "deploy.playbook.yaml"), YAML.stringify(playbook()));
  store = new JobStore(root, teDir, "laptop");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("local lock", () => {
  it("a second start on the same target is refused while a job runs", async () => {
    const j = await store.start(playbook(), { by: "tester" });
    const lock = readLockFile(locksDir(), "cloud");
    expect(lock?.job).toBe(j.id);
    expect(lock?.machine).toBe("laptop");
    await expect(store.start(playbook(), { by: "tester" })).rejects.toMatchObject({
      code: "OPS_TARGET_BUSY",
      message: `target busy: job ${j.id} on laptop`,
    });
  });

  it("a succeeded job releases the lock", async () => {
    // the live lock from the test above blocks a new start — finish that job first
    const j = store.list().find((x) => x.status === "running")!;
    let done = await store.stepResult(j, playbook(), "one", { exit_code: 0 }, "tester");
    expect(done.status).toBe("succeeded");
    expect(existsSync(lockFilePath(locksDir(), "cloud"))).toBe(false);
  });

  it("a failed job keeps the lock; an abort releases it", async () => {
    const j = await store.start(playbook(), { by: "tester" });
    const failed = await store.stepResult(j, playbook(), "one", { exit_code: 1 }, "tester");
    expect(failed.status).toBe("failed");
    // still locked — a new start on the target is refused
    await expect(store.start(playbook(), { by: "tester" })).rejects.toMatchObject({
      code: "OPS_TARGET_BUSY",
    });
    const aborted = await store.abort(failed, "tester");
    expect(aborted.status).toBe("aborted");
    expect(existsSync(lockFilePath(locksDir(), "cloud"))).toBe(false);
  });

  it("a resume from another machine is refused", async () => {
    const j = await store.start(playbook(), { by: "tester" });
    const failed = await store.stepResult(j, playbook(), "one", { exit_code: 1 }, "tester");
    const desktop = new JobStore(root, teDir, "desktop");
    const foreign = desktop.listAll().find((x) => x.id === failed.id)!;
    await expect(desktop.resume(foreign, "tester")).rejects.toMatchObject({ code: "OPS_STATE" });
    // same machine — a session that took over the ended session's job — may resume
    const own = await store.resume(failed, "another-session");
    expect(own.status).toBe("running");
  });
});

describe("fetch-before-lock (remote)", () => {
  let plansA: string;
  let plansB: string;

  const wsr = (plansDir: string, machine: string) =>
    ({
      ws: { plansDir, config: { sync: "manual" } },
      store: { machine },
    }) as unknown as WorkspaceRuntime;

  beforeAll(() => {
    const seed = join(dir, "seed");
    mkdirSync(join(seed, "ops", "locks"), { recursive: true });
    writeFileSync(join(seed, "workspace.yaml"), "name: ws\nsync: manual\n");
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.email", "t@t"]);
    git(seed, ["config", "user.name", "t"]);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "init"]);
    const remote = join(dir, "remote.git");
    git(dir, ["init", "--bare", remote]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    plansA = join(dir, "a");
    plansB = join(dir, "b");
    git(dir, ["clone", remote, plansA]);
    git(dir, ["clone", remote, plansB]);
    for (const p of [plansA, plansB]) {
      git(p, ["config", "user.email", "t@t"]);
      git(p, ["config", "user.name", "t"]);
    }
  });

  it("a lock from another machine in the fetched plans refuses the start", async () => {
    // machine B pushes a lock for the target
    mkdirSync(join(plansB, "ops", "locks"), { recursive: true });
    writeFileSync(
      join(plansB, "ops", "locks", "cloud.yaml"),
      YAML.stringify({ target: "cloud", job: "desktop-0003", machine: "desktop", ts: "2026-01-01T00:00:00Z" }),
    );
    git(plansB, ["add", "-A"]);
    git(plansB, ["commit", "-m", "lock"]);
    git(plansB, ["push"]);

    await fetchPlansRepo(plansA);
    const remote = await remoteOpsLocks(plansA);
    expect(remote.map((l) => l.job)).toContain("desktop-0003");
    const p = checkRemoteTargetLock(wsr(plansA, "laptop"), "cloud");
    await expect(p).rejects.toMatchObject({ code: "OPS_TARGET_BUSY" });
    await expect(p).rejects.toThrow("target busy: job desktop-0003 on desktop");
    // a different target is free
    await expect(checkRemoteTargetLock(wsr(plansA, "laptop"), "other")).resolves.toEqual({ unsynced: false });
  });

  it("offline: the check proceeds and reports unsynced", async () => {
    git(plansA, ["remote", "set-url", "origin", join(dir, "gone.git")]);
    await expect(checkRemoteTargetLock(wsr(plansA, "laptop"), "cloud")).resolves.toEqual({ unsynced: true });
  });
});
