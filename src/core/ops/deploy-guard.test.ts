import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { deployGuard, jobRepoDirs, runnerMachine } from "./runner.js";
import { loadMachines, machineFindings } from "./machine.js";

/**
 * GL-0296: the deploy guard checks the app part of a deploy edge and its
 * repo, and te validate checks the app part.
 */

let root: string;
const machine = (id: string, fm: Record<string, unknown>) =>
  writeFileSync(join(root, "machines", `${id}.machine.md`), `---\n${YAML.stringify({ id, ...fm })}---\n`);
const repo = (rel: string) => {
  const d = join(root, rel);
  mkdirSync(join(d, ".git"), { recursive: true });
  return d;
};
const cloud = {
  host: "cloud.example.org",
  tier: "prod",
  apps: [{ name: "de_auth_shadow" }, { name: "de_web_shadow" }],
};
const webShadow = { machine: "cloud", app: "de_web_shadow" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "te-guard-"));
  mkdirSync(join(root, "machines"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("deploy guard — app part", () => {
  it("an edge to cloud/de_auth_shadow does not allow the de_web_shadow target, and names the allowed app", () => {
    machine("cloud", cloud);
    machine("desk", { host: "desk", edges: [{ kind: "deploy", to: "cloud/de_auth_shadow" }] });
    const r = deployGuard(root, webShadow, "desk", "cloud-web-shadow");
    expect(r).toMatch(/no deploy edge/);
    expect(r).toMatch(/de_auth_shadow/);
  });

  it("an edge to cloud/de_web_shadow allows the de_web_shadow target", () => {
    machine("cloud", cloud);
    machine("desk", { host: "desk", edges: [{ kind: "deploy", to: "cloud/De_Web_Shadow" }] });
    expect(deployGuard(root, webShadow, "desk", "cloud-web-shadow")).toBeUndefined();
  });

  it("an edge to the machine alone still allows every target on it, and validate warns", () => {
    machine("cloud", cloud);
    machine("desk", { host: "desk", edges: [{ kind: "deploy", to: "cloud" }] });
    expect(deployGuard(root, webShadow, "desk")).toBeUndefined();
    expect(deployGuard(root, { machine: "cloud", app: "de_auth_shadow" }, "desk")).toBeUndefined();
    const w = machineFindings(loadMachines(root)).filter((f) => f.severity === "warning");
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/names no app/);
  });

  it("the right edge on another machine still refuses this runner", () => {
    machine("cloud", cloud);
    machine("desk", { host: "desk", edges: [{ kind: "deploy", to: "cloud/de_web_shadow" }] });
    machine("lap", { host: "lap" });
    expect(deployGuard(root, webShadow, "lap")).toMatch(/is deployed from desk → de_web_shadow; this runner is lap/);
  });
});

describe("deploy guard — repo", () => {
  it("an edge with repo ~/a and a job that deploys from ~/b stops, and names ~/a", () => {
    const a = repo("a");
    const b = repo("b");
    machine("cloud", cloud);
    machine("desk", { host: "desk", edges: [{ kind: "deploy", to: "cloud/de_web_shadow", repo: a }] });
    const r = deployGuard(root, webShadow, "desk", "cloud-web-shadow", [b]);
    expect(r).toMatch(/deploys from/);
    expect(r).toContain(a);
    expect(deployGuard(root, webShadow, "desk", "cloud-web-shadow", [a])).toBeUndefined();
  });

  it("no local repo folder in the job skips the repo check", () => {
    machine("cloud", cloud);
    machine("desk", { host: "desk", edges: [{ kind: "deploy", to: "cloud/de_web_shadow", repo: "/nowhere" }] });
    expect(deployGuard(root, webShadow, "desk", "t", [])).toBeUndefined();
  });

  it("jobRepoDirs keeps local git work trees and skips remote server paths", () => {
    const web = repo("ws/web");
    const dirs = jobRepoDirs(join(root, "ws"), {
      webclient_dir: "web",
      scripts_dir: "/home/ap_cloud/de_server_shadow/scripts",
      ssh: "ssh root@x",
    });
    expect(dirs).toEqual([web]);
  });

  it("jobRepoDirs falls back to the cwd when it is a git work tree", () => {
    const cwd = repo("solo");
    expect(jobRepoDirs(cwd, {})).toEqual([cwd]);
    expect(jobRepoDirs(root, {})).toEqual([]);
  });
});

describe("deploy guard — runner host match", () => {
  it("hostname 'mhefnyDT' matches host 'mhefnyDT.local' — the seeded cloud deploy is allowed", () => {
    machine("cloud-ardupilot", { host: "cloud.ardupilot.org", apps: [{ name: "de_web_shadow" }] });
    machine("mhefny-dt", {
      host: "mhefnyDT.local",
      edges: [{ kind: "deploy", to: "cloud-ardupilot/de_web_shadow" }],
    });
    // no runner:true anywhere — the .machine.local override is not synced
    expect(
      deployGuard(root, { machine: "cloud-ardupilot", app: "de_web_shadow" }, "mhefnyDT", "cloud-web-shadow"),
    ).toBeUndefined();
  });

  it("a machine with hostnames: [box1, box1.lan] matches os hostname box1", () => {
    machine("box", { hostnames: ["box1", "box1.lan"] });
    expect(runnerMachine(root, "box1")?.id).toBe("box");
    expect(runnerMachine(root, "box1.lan")?.id).toBe("box");
    expect(runnerMachine(root, "box2")).toBeUndefined();
  });
});

describe("te validate — app part of an edge", () => {
  it("reports an edge to cloud/no-such-app with the file and the app name", () => {
    machine("cloud", cloud);
    machine("desk", { edges: [{ kind: "deploy", to: "cloud/no-such-app" }] });
    const e = machineFindings(loadMachines(root)).filter((f) => f.severity === "error");
    expect(e).toHaveLength(1);
    expect(e[0].path).toBe("machines/desk.machine.md");
    expect(e[0].message).toMatch(/no-such-app/);
  });
});
