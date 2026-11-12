import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { Playbook } from "./playbook.js";
import { JobStore } from "./job.js";
import { EventLog } from "../events/log.js";

let root: string;
let teDir: string;
let store: JobStore;
let events: EventLog;

const pb = (over: Record<string, unknown> = {}) =>
  Playbook.parse({
    name: "deploy",
    steps: [
      { id: "build", kind: "cmd", run: "make" },
      { id: "version", kind: "check", run: "ver" },
    ],
    ...over,
  });

/** write the playbook file under ops/ so its sha256 is pinned at job start */
const writePb = (playbook: unknown, name = "deploy") => {
  mkdirSync(join(root, "ops"), { recursive: true });
  writeFileSync(join(root, "ops", `${name}.playbook.yaml`), YAML.stringify(playbook));
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "te-job-"));
  teDir = join(root, ".teamengage");
  events = new EventLog(join(teDir, "events"), "laptop");
  store = new JobStore(root, teDir, "laptop", { events });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const start = (playbook: Playbook, over: Record<string, unknown> = {}) =>
  store.start(playbook, { by: "tester", ...over });

describe("job lifecycle", () => {
  it("runs a two-step job to succeeded and records the version_from line", async () => {
    const playbook = pb({ version_from: "version" });
    writePb(playbook);
    const job = await start(playbook);
    expect(job.id).toBe("laptop-0001");
    expect(job.status).toBe("running");
    expect(job.playbook_sha256).toHaveLength(64);

    await store.startStep(job, playbook, "build", "tester");
    let j = await store.stepResult(job, playbook, "build", { exit_code: 0, output: "done" }, "tester");
    expect(j.cursor).toBe(1);
    expect(j.steps[0].status).toBe("passed");

    j = await store.stepResult(j, playbook, "version", { exit_code: 0, output: "checking\n\nv2.5.0\n" }, "tester");
    expect(j.status).toBe("succeeded");
    expect(j.version).toBe("v2.5.0");
    // the record on disk round-trips
    const onDisk = store.load(job.id)!;
    expect(onDisk.status).toBe("succeeded");
    expect(onDisk.version).toBe("v2.5.0");
  });

  it("parks the job as waiting while the cursor sits on an agent or gate step", async () => {
    const playbook = pb({
      steps: [
        { id: "build", kind: "cmd", run: "make" },
        { id: "review", kind: "agent", instruction: "check" },
      ],
    });
    writePb(playbook);
    let j = await start(playbook);
    j = await store.stepResult(j, playbook, "build", { exit_code: 0 }, "tester");
    expect(j.status).toBe("waiting"); // cursor auto-parks on the agent step
    j = await store.stepResult(j, playbook, "review", { evidence: "logs look fine" }, "tester");
    expect(j.status).toBe("succeeded");
    expect(j.steps[1].evidence).toBe("logs look fine");
  });
});

describe("strict order and pinning", () => {
  it("refuses a result for a step after the cursor with OPS_ORDER", async () => {
    const playbook = pb({
      steps: [
        { id: "one", kind: "cmd", run: "1" },
        { id: "two", kind: "cmd", run: "2" },
      ],
    });
    writePb(playbook);
    const j = await start(playbook);
    await expect(store.stepResult(j, playbook, "two", { exit_code: 0 }, "tester")).rejects.toMatchObject({
      code: "OPS_ORDER",
    });
  });

  it("refuses a result while the playbook file changed with OPS_PLAYBOOK_CHANGED", async () => {
    const playbook = pb();
    writePb(playbook);
    const j = await start(playbook);
    writeFileSync(join(root, "ops", "deploy.playbook.yaml"), YAML.stringify(pb()) + "# touched\n");
    await expect(store.stepResult(j, playbook, "build", { exit_code: 0 }, "tester")).rejects.toMatchObject({
      code: "OPS_PLAYBOOK_CHANGED",
    });
  });

  it("a failed check with on_fail: stop ends the job stopped, not failed", async () => {
    const playbook = pb({
      steps: [{ id: "probe", kind: "check", run: "test", on_fail: "stop" }],
    });
    writePb(playbook);
    let j = await start(playbook);
    j = await store.stepResult(j, playbook, "probe", { exit_code: 1, output: "absent" }, "tester");
    expect(j.steps[0].status).toBe("failed");
    expect(j.status).toBe("stopped");
    // a stopped job takes no more results
    await expect(store.stepResult(j, playbook, "probe", { exit_code: 0 }, "tester")).rejects.toMatchObject({
      code: "OPS_STATE",
    });
  });

  it("refuses to skip a step that is not optional", async () => {
    const playbook = pb({ steps: [{ id: "one", kind: "cmd", run: "1" }] });
    writePb(playbook);
    const j = await start(playbook);
    await expect(store.skipStep(j, playbook, "one", "not needed", "tester")).rejects.toMatchObject({
      code: "OPS_NOT_OPTIONAL",
    });
  });

  it("skips an optional step only with a reason", async () => {
    const playbook = pb({
      steps: [
        { id: "extra", kind: "cmd", run: "x", optional: true },
        { id: "last", kind: "cmd", run: "y" },
      ],
    });
    writePb(playbook);
    let j = await start(playbook);
    await expect(store.skipStep(j, playbook, "extra", "", "tester")).rejects.toThrow(/reason/);
    j = await store.skipStep(j, playbook, "extra", "not needed today", "tester");
    expect(j.steps[0].status).toBe("skipped");
    expect(j.steps[0].reason).toBe("not needed today");
    expect(j.cursor).toBe(1);
  });
});

describe("abort and resume", () => {
  it("a failed job resumes at the same cursor — the failed step retries", async () => {
    const playbook = pb({ steps: [{ id: "flaky", kind: "cmd", run: "x" }] });
    writePb(playbook);
    let j = await start(playbook);
    j = await store.stepResult(j, playbook, "flaky", { exit_code: 1, output: "boom" }, "tester");
    expect(j.status).toBe("failed");
    j = await store.resume(j, "tester");
    expect(j.status).toBe("running");
    expect(j.steps[0].status).toBe("pending");
    j = await store.stepResult(j, playbook, "flaky", { exit_code: 0 }, "tester");
    expect(j.status).toBe("succeeded");
    // a running job does not resume again
    await expect(store.resume(j, "tester")).rejects.toMatchObject({ code: "OPS_STATE" });
  });

  it("abort ends a live job and it takes no more results", async () => {
    const playbook = pb();
    writePb(playbook);
    const j = await start(playbook);
    const aborted = await store.abort(j, "tester");
    expect(aborted.status).toBe("aborted");
    await expect(store.stepResult(aborted, playbook, "build", { exit_code: 0 }, "tester")).rejects.toMatchObject({
      code: "OPS_STATE",
    });
  });
});

describe("storage and events", () => {
  it("two machines write job files to two folders", async () => {
    writePb(pb());
    const desktop = new JobStore(root, teDir, "desktop");
    const a = await store.start(pb(), { by: "tester" });
    const b = await desktop.start(pb(), { by: "tester" });
    expect(a.id).toMatch(/^laptop-\d{4}$/);
    expect(b.id).toBe("desktop-0001");
    expect(existsSync(join(teDir, "ops", "jobs", "laptop", `${a.id}.yaml`))).toBe(true);
    expect(existsSync(join(teDir, "ops", "jobs", "desktop", "desktop-0001.yaml"))).toBe(true);
  });

  it("appends an event for every job change", async () => {
    writePb(pb());
    const j = await start(pb());
    await store.stepResult(j, pb(), "build", { exit_code: 1 }, "tester");
    const { events: log } = await events.read();
    const mine = log.filter((e) => (e.data as { job?: string }).job === j.id);
    expect(mine.map((e) => e.action)).toEqual(["ops.job.start", "ops.step.result"]);
    expect((mine[1].data as { status: string }).status).toBe("failed");
  });
});
