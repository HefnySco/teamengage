import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadPlaybooks, playbookFindings, Playbook } from "./playbook.js";
import { scanTaskTree } from "../files/source.js";

let root: string;
let opsDir: string;

const write = (name: string, data: unknown) =>
  writeFileSync(join(opsDir, name), typeof data === "string" ? data : YAML.stringify(data));

const valid = (over: Record<string, unknown> = {}) => ({
  name: "deploy",
  title: "Deploy",
  target: "cloud",
  steps: [
    { id: "build", kind: "cmd", run: "npm run build" },
    { id: "push", kind: "check", run: "curl -fsS host/health" },
    { id: "review", kind: "agent", instruction: "check the logs" },
    { id: "confirm", kind: "gate", instruction: "open the page" },
  ],
  version_from: "push",
  ...over,
});

/** valid() minus the version_from key (a `null` in YAML is a parse error, not the fault under test) */
const noVersion = (o: Record<string, unknown>) => {
  const { version_from: _omit, ...rest } = o;
  return rest;
};

const findings = (targets: Record<string, unknown> = { cloud: {} }) =>
  playbookFindings(loadPlaybooks(root), targets);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "te-ops-"));
  opsDir = join(root, "ops");
  mkdirSync(opsDir, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("playbook schema", () => {
  it("parses a valid playbook with all four step kinds and defaults", () => {
    const pb = Playbook.parse(valid());
    expect(pb.start).toBe("human");
    expect(pb.steps.map((s) => s.kind)).toEqual(["cmd", "check", "agent", "gate"]);
    expect(pb.steps[0].expect_exit).toBe(0);
    expect(pb.steps[0].timeout).toBe("10m");
    expect(pb.steps[0].on_fail).toBe("fail");
    expect(pb.steps[3].kind).toBe("gate");
    expect(pb.version_from).toBe("push");
  });
});

describe("playbook findings (te validate)", () => {
  it("reports no findings for a clean playbook", () => {
    write("deploy.playbook.yaml", valid());
    expect(findings()).toEqual([]);
  });

  it("reports an unknown target", () => {
    write("deploy.playbook.yaml", valid({ target: "mars" }));
    const f = findings();
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("unknown target 'mars'");
  });

  it("reports duplicate step ids", () => {
    write("deploy.playbook.yaml", noVersion(valid({ steps: [
      { id: "a", kind: "cmd", run: "x" },
      { id: "a", kind: "check", run: "y" },
    ] })));
    const f = findings();
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("duplicate step id 'a'");
  });

  it("reports a gate step with run (agent too)", () => {
    write("deploy.playbook.yaml", noVersion(valid({ steps: [
      { id: "g", kind: "gate", run: "echo hi" },
      { id: "a", kind: "agent", run: "echo hi" },
    ] })));
    const f = findings();
    expect(f).toHaveLength(2);
    expect(f[0].message).toContain("gate step 'g' has run");
    expect(f[1].message).toContain("agent step 'a' has run");
  });

  it("reports a cmd or check step without run", () => {
    write("deploy.playbook.yaml", noVersion(valid({ steps: [
      { id: "c", kind: "cmd" },
      { id: "k", kind: "check" },
    ] })));
    const f = findings();
    expect(f).toHaveLength(2);
    expect(f[0].message).toContain("cmd step 'c' has no run");
    expect(f[1].message).toContain("check step 'k' has no run");
  });

  it("reports an unknown version_from", () => {
    write("deploy.playbook.yaml", valid({ version_from: "nope" }));
    const f = findings();
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("version_from 'nope' names no step");
  });
});

describe("playbook files in the task tree", () => {
  it("a .playbook.yaml under ops/ is not an untracked task file", async () => {
    write("deploy.playbook.yaml", valid());
    const scan = await scanTaskTree(root);
    expect(scan.untracked).toEqual([]);
  });
});
