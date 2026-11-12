import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachines, machineFindings, targetMachineFindings } from "./machine.js";

let root: string;
let dir: string;

const write = (name: string, fm: Record<string, unknown>, body = "") => {
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");
  writeFileSync(join(dir, name), `---\n${yaml}\n---\n${body}`);
};

const findings = () => machineFindings(loadMachines(root));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "te-machines-"));
  dir = join(root, "machines");
  mkdirSync(dir, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("machine files", () => {
  it("loads a machine with apps, rules and edges; the body is free notes", () => {
    write("cloud.machine.md", {
      id: "cloud",
      title: "cloud.ardupilot.org VPS",
      host: "cloud.ardupilot.org",
      tier: "prod",
      ssh: { user: "root", key: "~/.ssh/ardupilot_cloud_key" },
      roles: ["auth-server"],
      apps: [{ name: "de_auth_2026", port: 19408, env: "prod" }],
      rules: ["never touch /home/ap_cloud/de_server"],
      edges: [{ kind: "shadow_of", to: "rpi5" }],
    }, "the auth VPS — see de-cloud-deploy\n");
    const [m] = loadMachines(root);
    expect(m.error).toBeUndefined();
    expect(m.machine!.id).toBe("cloud");
    expect(m.machine!.ssh.user).toBe("root");
    expect(m.machine!.apps[0].name).toBe("de_auth_2026");
    expect(m.body).toContain("de-cloud-deploy");
  });

  it("converts 'Cloud-ArduPilot' to 'cloud-ardupilot' with no warning", () => {
    write("ca.machine.md", { id: "Cloud-ArduPilot", host: "h" });
    const [m] = loadMachines(root).filter((l) => l.file === "machines/ca.machine.md");
    expect(m.machine!.id).toBe("cloud-ardupilot");
  });

  it("a machines/<id>.machine.local override replaces the shared file's paths", () => {
    write("dt.machine.md", { id: "dt", ssh: { key: "~/.ssh/dt_key" }, folders: [{ path: "/opt/de" }] });
    writeFileSync(
      join(dir, "dt.machine.local"),
      "ssh:\n  key: /home/mhefny/.ssh/dt_key\nfolders:\n  - path: /mnt/de\n",
    );
    const [m] = loadMachines(root).filter((l) => l.file === "machines/dt.machine.md");
    expect(m.machine!.ssh.key).toBe("/home/mhefny/.ssh/dt_key");
    expect(m.machine!.folders[0].path).toBe("/mnt/de");
  });

  it("the .machine.local file is git-ignored by the *.local rule", () => {
    const repo = mkdtempSync(join(tmpdir(), "te-mi-"));
    try {
      execFileSync("git", ["init", "-q", repo]);
      writeFileSync(join(repo, ".gitignore"), "*.local\n");
      writeFileSync(join(repo, "x.machine.local"), "ssh:\n  key: /k\n");
      execFileSync("git", ["-C", repo, "check-ignore", "x.machine.local"]); // exits 0 → ignored
      expect(existsSync(join(repo, "x.machine.local"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports duplicate machine ids", () => {
    write("dup1.machine.md", { id: "twin" });
    write("dup2.machine.md", { id: "twin" });
    const f = findings().filter((x) => x.message.includes("twin"));
    expect(f.length).toBe(1);
    expect(f[0].message).toContain("also declared");
  });

  it("reports an ssh field that holds a password", () => {
    write("secret1.machine.md", { id: "s1", ssh: { user: "root", password: "hunter2" } });
    const f = findings().filter((x) => x.path === "machines/secret1.machine.md");
    expect(f.some((x) => x.message.includes("'password'"))).toBe(true);
  });

  it("reports an ssh field that holds private key text", () => {
    write("secret2.machine.md", { id: "s2", ssh: { key: "-----BEGIN OPENSSH PRIVATE KEY-----" } });
    const f = findings().filter((x) => x.path === "machines/secret2.machine.md");
    expect(f.some((x) => x.message.includes("key text"))).toBe(true);
  });

  it("reports an edge kind outside the list and an edge to an unknown machine", () => {
    write("edge.machine.md", { id: "e1", edges: [{ kind: "teleport", to: "nowhere" }] });
    const f = findings().filter((x) => x.path === "machines/edge.machine.md");
    expect(f.some((x) => x.message.includes("'teleport'"))).toBe(true);
    expect(f.some((x) => x.message.includes("unknown machine 'nowhere'"))).toBe(true);
  });

  it("targetMachineFindings (GL-0287): reports a target whose machine or app is not in machines/", () => {
    write("web.machine.md", { id: "web", apps: [{ name: "site" }] });
    const f = targetMachineFindings(
      { ok: { machine: "web", app: "site" }, ghost: { machine: "ghost" }, badapp: { machine: "web", app: "nope" } },
      loadMachines(root),
    );
    expect(f.filter((x) => x.message.startsWith("target 'ok'"))).toEqual([]);
    expect(f.some((x) => x.message.includes("target 'ghost'") && x.message.includes("no machines/ghost.machine.md"))).toBe(true);
    expect(f.some((x) => x.message.includes("target 'badapp'") && x.message.includes("not in machine web's apps list"))).toBe(true);
  });
});
