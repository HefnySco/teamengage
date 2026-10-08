import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMachineConfig,
  loadRegistry,
  resolveWorkspace,
  expandTilde,
  findPlansDir,
} from "./config.js";
import { NotFoundError, ValidationError } from "../model/errors.js";

let home: string;
let root: string;
let plans: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "te-home-"));
  root = join(home, "de_code");
  plans = join(root, ".teamengage");
  mkdirSync(plans, { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    `name: droneengage
prefix: DE
sync: manual
projects:
  global: { prefix: GL }
  mp: { prefix: MP }
resources:
  mavlink: { kind: git, path: droneengage_mavlink, base: master }
  outside: { kind: git, path: ~/other/repo, base: main }
  rpi: { kind: ssh, host: pi@rpi.local, path: /home/pi/de }
  docs: { kind: folder, path: ../shared_docs }
links:
  mcp: ~/code/mcp
`,
  );
  mkdirSync(join(home, ".teamengage"), { recursive: true });
  writeFileSync(join(home, ".teamengage", "machine.yaml"), "name: laptop\n");
  writeFileSync(
    join(home, ".teamengage", "workspaces.yaml"),
    `workspaces:
  droneengage:
    root: ${root}
    overrides:
      mavlink: { path: /mnt/bigdisk/mavlink }
`,
  );
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("machine + registry", () => {
  it("loads machine.yaml", () => {
    expect(loadMachineConfig(home).name).toBe("laptop");
  });
  it("loads registry", () => {
    expect(loadRegistry(home).workspaces.droneengage.root).toBe(root);
  });
  it("expandTilde uses given home", () => {
    expect(expandTilde("~/x/y", home)).toBe(join(home, "x/y"));
    expect(expandTilde("/abs/p", home)).toBe("/abs/p");
  });
});

describe("resolveWorkspace", () => {
  it("resolves absolute paths for every local resource", () => {
    const ws = resolveWorkspace(root, { home });
    expect(ws.root).toBe(root);
    expect(ws.plansDir).toBe(plans);
    expect(ws.resources.get("mavlink")?.path).toBe("/mnt/bigdisk/mavlink"); // override wins
    expect(ws.resources.get("outside")?.path).toBe(join(home, "other/repo")); // ~ expanded
    expect(ws.resources.get("docs")?.path).toBe(join(home, "shared_docs")); // relative to root
    expect(ws.resources.get("rpi")?.path).toBe("/home/pi/de"); // ssh untouched
  });
  it("maps prefixes to projects", () => {
    const ws = resolveWorkspace(root, { home });
    expect(ws.prefixToProject.get("DE")).toBeNull();
    expect(ws.prefixToProject.get("GL")).toBe("global");
    expect(ws.prefixToProject.get("MP")).toBe("mp");
  });
  it("rejects duplicate prefixes", () => {
    writeFileSync(
      join(plans, "workspace.yaml"),
      "name: x\nprefix: GL\nprojects:\n  global: { prefix: GL }\n",
    );
    expect(() => resolveWorkspace(root, { home })).toThrow(ValidationError);
  });
  it("rejects unknown resource kind via schema", () => {
    writeFileSync(
      join(plans, "workspace.yaml"),
      "name: x\nprefix: X\nresources:\n  bad: { kind: ftp, path: y }\n",
    );
    expect(() => resolveWorkspace(root, { home })).toThrow(ValidationError);
  });
  it("finds a plans dir that is not .teamengage", () => {
    const alt = mkdtempSync(join(tmpdir(), "te-ws-"));
    mkdirSync(join(alt, "Tasks"), { recursive: true });
    writeFileSync(join(alt, "Tasks", "workspace.yaml"), "name: a\nprefix: A\nplans: Tasks\n");
    const ws = resolveWorkspace(alt, { home });
    expect(ws.plansDir).toBe(join(alt, "Tasks"));
    rmSync(alt, { recursive: true, force: true });
  });
  it("throws NotFound when no plans repo exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "te-empty-"));
    expect(() => findPlansDir(empty)).toThrow(NotFoundError);
    rmSync(empty, { recursive: true, force: true });
  });
});
