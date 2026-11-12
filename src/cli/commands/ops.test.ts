import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { PlansStore } from "../../daemon/store/store.js";
import { PlansWatcher } from "../../daemon/watch/watch.js";
import { resolveWorkspace, teHome } from "../../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../../daemon/server/server.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import { SessionRegistry } from "../../daemon/sessions/sessions.js";
import { EventBus } from "../../daemon/api/events.js";
import { registerApiRoutes } from "../../daemon/api/api.js";
import type { Job } from "../../core/ops/job.js";
import { opsCmd } from "./ops.js";

/**
 * `te ops` (GL-0272): the runner drives a real daemon over /api/ops/* —
 * a 3-step echo playbook ends succeeded, a failed step exits 1, a gate
 * exits 2 with its instruction, secret_env values are masked in the
 * posted tail, and the full log lands under ~/.teamengage/ops-logs/.
 */

let home: string;
let root: string;
let daemon: DaemonHandle;
let watcher: PlansWatcher;

const pb = (name: string, extra: Record<string, unknown>, steps: Record<string, unknown>[]) =>
  YAML.stringify({ name, ...extra, steps });

const daemonJson = () => JSON.parse(readFileSync(join(teHome(home), "daemon.json"), "utf8"));

const job = async (id: string): Promise<Job> => {
  const { port, token } = daemonJson();
  const res = await fetch(`http://127.0.0.1:${port}/api/ops/job/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as Job;
};

/** capture console.log + stdout writes; returns the joined text */
async function capture(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  process.stdout.write = ((c: unknown) => (lines.push(String(c)), true)) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, text: lines.join("\n") };
  } finally {
    console.log = origLog;
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
}

async function startJob(playbook: string): Promise<string> {
  const { code, text } = await capture(() => opsCmd(["start", playbook], home));
  expect(code).toBe(0);
  return /started (\S+)/.exec(text)![1];
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-cli-ops-"));
  root = join(home, "ws");
  const plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(join(plans, "workspace.yaml"), "name: ws\nprefix: WS\n");
  mkdirSync(join(root, "ops"), { recursive: true });
  writeFileSync(
    join(root, "ops", "three.playbook.yaml"),
    pb("three", {}, [
      { id: "a", kind: "cmd", run: "echo one" },
      { id: "b", kind: "cmd", run: "echo two" },
      { id: "c", kind: "cmd", run: "echo three" },
    ]),
  );
  writeFileSync(
    join(root, "ops", "fail.playbook.yaml"),
    pb("fail", {}, [
      { id: "a", kind: "cmd", run: "echo hi" },
      { id: "b", kind: "cmd", run: "echo boom >&2; exit 1" },
    ]),
  );
  writeFileSync(
    join(root, "ops", "flaky.playbook.yaml"),
    pb("flaky", {}, [
      { id: "a", kind: "cmd", run: "test -f flaky-marker || { touch flaky-marker; echo boom; exit 1; }" },
      { id: "b", kind: "cmd", run: "echo done" },
    ]),
  );
  writeFileSync(
    join(root, "ops", "deploy.playbook.yaml"),
    pb("deploy", {}, [
      { id: "s1", kind: "cmd", run: "echo s1 >> order.txt; echo ok", rollback: "echo r1 >> order.txt" },
      { id: "s2", kind: "cmd", run: "echo s2 >> order.txt; echo ok" },
      { id: "s3", kind: "cmd", run: "echo s3 >> order.txt; echo ok", rollback: "echo r3 >> order.txt" },
    ]),
  );
  writeFileSync(
    join(root, "ops", "gated.playbook.yaml"),
    pb("gated", {}, [
      { id: "a", kind: "cmd", run: "echo hi" },
      { id: "gate", kind: "gate", instruction: "confirm on the ops page" },
    ]),
  );
  writeFileSync(
    join(root, "ops", "secret.playbook.yaml"),
    pb("secret", { secret_env: ["MY_SECRET"] }, [
      { id: "a", kind: "cmd", run: "echo token=$MY_SECRET" },
    ]),
  );
  for (const a of [
    ["init", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "-m", "init"],
  ]) {
    execFileSync("git", a, { cwd: plans });
  }
  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  watcher = new PlansWatcher(store, { debounceMs: 50 });
  const ctx: DaemonCtx = {
    home,
    machine: "test",
    workspaces: new Map([["ws", { ws, store, watcher }]]),
    sessions: new SessionRegistry("test"),
    bus: new EventBus(),
  };
  await watcher.start();
  daemon = await startDaemon({ home, register: (app) => registerApiRoutes(app, ctx) });
}, 30_000);

afterAll(async () => {
  await watcher.close();
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("te ops", () => {
  it("list shows the playbooks", async () => {
    const { code, text } = await capture(() => opsCmd(["list"], home));
    expect(code).toBe(0);
    for (const n of ["three", "fail", "flaky", "gated", "secret"]) expect(text).toContain(n);
  });

  it("a 3-step echo playbook ends succeeded — 3 results in order", async () => {
    const id = await startJob("three");
    const { code } = await capture(() => opsCmd(["exec", id], home));
    expect(code).toBe(0);
    const j = await job(id);
    expect(j.status).toBe("succeeded");
    expect(j.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed"]);
    for (const s of j.steps) {
      expect(s.output_sha256).toBeTruthy();
      expect(s.exit_code).toBe(0);
    }
    expect(j.steps[0].output_tail).toContain("one");
    expect(j.steps[2].output_tail).toContain("three");
  });

  it("a step that exits 1 fails the job and exec exits 1", async () => {
    const id = await startJob("fail");
    const { code, text } = await capture(() => opsCmd(["exec", id], home));
    expect(code).toBe(1);
    expect(text).toContain("boom");
    const j = await job(id);
    expect(j.status).toBe("failed");
    expect(j.steps[1].exit_code).toBe(1);
  });

  it("a gate step makes exec exit 2 and print the instruction", async () => {
    const id = await startJob("gated");
    const { code, text } = await capture(() => opsCmd(["exec", id], home));
    expect(code).toBe(2);
    expect(text).toContain("confirm on the ops page");
    expect(text).toContain(`te ops approve ${id}`);
    const j = await job(id);
    expect(j.status).toBe("waiting");

    // the human approves → the job runs to the end
    const ap = await capture(() => opsCmd(["approve", id], home));
    expect(ap.code).toBe(0);
    expect((await job(id)).status).toBe("succeeded");
  });

  it("a secret_env value never reaches the posted output_tail", async () => {
    process.env.MY_SECRET = "s3cr3t-token-zzz";
    try {
      const id = await startJob("secret");
      const { code, text } = await capture(() => opsCmd(["exec", id], home));
      expect(code).toBe(0);
      expect(text).toContain("s3cr3t-token-zzz"); // the terminal sees the real output
      const j = await job(id);
      expect(j.status).toBe("succeeded");
      expect(j.steps[0].output_tail).not.toContain("s3cr3t-token-zzz");
      expect(j.steps[0].output_tail).toContain("***");
      // the full local log still has it (per-machine, never synced)
      const log = readFileSync(join(teHome(home), "ops-logs", id, "a.log"), "utf8");
      expect(log).toContain("s3cr3t-token-zzz");
    } finally {
      delete process.env.MY_SECRET;
    }
  });

  it("resume resets the failed cursor step so exec can finish the job", async () => {
    const id = await startJob("flaky");
    const first = await capture(() => opsCmd(["exec", id], home));
    expect(first.code).toBe(1);
    expect((await job(id)).status).toBe("failed");

    const re = await capture(() => opsCmd(["resume", id], home));
    expect(re.code).toBe(0);
    expect((await job(id)).status).toBe("running");

    const second = await capture(() => opsCmd(["exec", id], home));
    expect(second.code).toBe(0);
    expect((await job(id)).status).toBe("succeeded");
  });

  it("abort ends a live job", async () => {
    const id = await startJob("three");
    const ab = await capture(() => opsCmd(["abort", id], home));
    expect(ab.code).toBe(0);
    expect((await job(id)).status).toBe("aborted");
  });

  it("rollback runs the passed steps in reverse; steps without rollback show skipped", async () => {
    const id = await startJob("deploy");
    const ex = await capture(() => opsCmd(["exec", id], home));
    expect(ex.code).toBe(0);
    expect((await job(id)).status).toBe("succeeded");

    // rolling back a live job is refused
    const live = await startJob("deploy");
    const refuse = await capture(() => opsCmd(["rollback", live], home));
    expect(refuse.code).toBe(3);
    expect(refuse.text).toContain("OPS_STATE");
    await capture(() => opsCmd(["abort", live], home));

    const rb = await capture(() => opsCmd(["rollback", id], home));
    expect(rb.code).toBe(0);
    const rbId = /rollback job (\S+)/.exec(rb.text)![1];
    expect(rbId).not.toBe(id);

    const rbJob = await job(rbId);
    expect(rbJob.kind).toBe("rollback");
    expect(rbJob.rollback_of).toBe(id);
    // reversed order: s3, s2 (skipped — no rollback), s1
    expect(rbJob.steps.map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
    expect(rbJob.steps[1].status).toBe("skipped");
    expect(rbJob.steps[1].reason).toBe("no rollback command");
    // the source job names the rollback job
    expect((await job(id)).rollback_job).toBe(rbId);

    const exRb = await capture(() => opsCmd(["exec", rbId], home));
    expect(exRb.code).toBe(0);
    expect((await job(rbId)).status).toBe("succeeded");
    // the rollback commands ran in reverse order — s2 had none
    const order = readFileSync(join(root, "order.txt"), "utf8").trim().split("\n");
    expect(order).toEqual(["s1", "s2", "s3", "r3", "r1"]);
  });
});
