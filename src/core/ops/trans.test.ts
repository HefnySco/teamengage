import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { appendTrans, loadTrans, parseTrans, transFile, transFindings } from "./trans.js";
import { JobStore } from "./job.js";
import { EventLog } from "../events/log.js";
import { Playbook } from "./playbook.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "te-trans-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("trans file", () => {
  it("appendTrans creates the file with a title and entries parse back", () => {
    appendTrans(root, "cloud", { kind: "adhoc", actor: "laptop", text: "edited config.local.json — DISABLE_DE_PILOT: true" });
    const file = join(root, transFile("cloud"));
    expect(file).toBe(join(root, "machines/cloud.machine.trans.md"));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# cloud — activity log");
    const entries = loadTrans(root, "cloud");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("adhoc");
    expect(entries[0].actor).toBe("laptop");
    expect(entries[0].job).toBeUndefined();
    expect(entries[0].text).toContain("DISABLE_DE_PILOT");
    expect(entries[0].ts).toMatch(/^\d{4}-/);
  });

  it("a job entry keeps its job id and second append lands after the first", () => {
    appendTrans(root, "cloud", { kind: "adhoc", actor: "laptop", text: "first" });
    appendTrans(root, "cloud", { kind: "job", actor: "laptop", job: "laptop-0007", text: "webclient-deploy on web — succeeded" });
    const entries = loadTrans(root, "cloud");
    expect(entries).toHaveLength(2);
    expect(entries[1].kind).toBe("job");
    expect(entries[1].job).toBe("laptop-0007");
    expect(parseTrans(readFileSync(join(root, transFile("cloud")), "utf8"))).toEqual(entries);
  });

  it("refuses an empty text and a '### ' line inside the text", () => {
    expect(() => appendTrans(root, "cloud", { kind: "adhoc", actor: "laptop", text: "  " })).toThrow(/text/);
    expect(() => appendTrans(root, "cloud", { kind: "adhoc", actor: "laptop", text: "ok\n### not a header" })).toThrow(/###/);
  });

  it("loadTrans returns [] for a machine with no file", () => {
    expect(loadTrans(root, "ghost")).toEqual([]);
  });
});

describe("transFindings", () => {
  it("warns on a trans file for an unknown machine", () => {
    appendTrans(root, "ghost", { kind: "adhoc", actor: "laptop", text: "x" });
    const f = transFindings(root, new Set(["cloud"]));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warning");
    expect(f[0].message).toContain("ghost");
    expect(transFindings(root, new Set(["ghost"]))).toHaveLength(0);
  });
});

describe("job hook", () => {
  const writeWs = (machine = "cloud") => {
    const teDir = join(root, ".teamengage");
    mkdirSync(teDir, { recursive: true });
    writeFileSync(
      join(teDir, "workspace.yaml"),
      YAML.stringify({ name: "test", prefix: "TS", targets: { "web-shadow": { machine } } }),
    );
    return teDir;
  };

  const writePb = (playbook: unknown, name = "deploy") => {
    mkdirSync(join(root, "ops"), { recursive: true });
    writeFileSync(join(root, "ops", `${name}.playbook.yaml`), YAML.stringify(playbook));
  };

  it("a job on a target appends a line to the target machine's trans file", async () => {
    const teDir = writeWs();
    const store = new JobStore(root, teDir, "laptop", { events: new EventLog(join(teDir, "events"), "laptop") });
    const playbook = Playbook.parse({
      name: "deploy",
      target: "web-shadow",
      version_from: "version",
      steps: [{ id: "version", kind: "check", run: "ver" }],
    });
    writePb(playbook);
    let job = await store.start(playbook, { by: "tester" });
    job = await store.stepResult(job, playbook, "version", { exit_code: 0, output: "v1.2.3\n" }, "tester");
    expect(job.status).toBe("succeeded");
    const entries = loadTrans(root, "cloud");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("job");
    expect(entries[0].job).toBe(job.id);
    expect(entries[0].actor).toBe("laptop");
    expect(entries[0].text).toContain("deploy on web-shadow — succeeded");
    expect(entries[0].text).toContain("version v1.2.3");
  });

  it("a job with no target or an unknown target machine writes nothing", async () => {
    const teDir = writeWs();
    const store = new JobStore(root, teDir, "laptop", { events: new EventLog(join(teDir, "events"), "laptop") });
    const playbook = Playbook.parse({ name: "local", steps: [{ id: "one", kind: "cmd", run: "x" }] });
    writePb(playbook, "local");
    const job = await store.stepResult(await store.start(playbook, { by: "tester" }), playbook, "one", { exit_code: 0 }, "tester");
    expect(job.status).toBe("succeeded");
    expect(loadTrans(root, "cloud")).toEqual([]);
  });
});
