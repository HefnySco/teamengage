import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvs, envFindings } from "./env.js";
import { loadMachines } from "./machine.js";

let root: string;
let envDir: string;
let mDir: string;

const writeEnv = (name: string, fm: Record<string, unknown>, body = "") => {
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");
  writeFileSync(join(envDir, name), `---\n${yaml}\n---\n${body}`);
};

const writeMachine = (id: string) =>
  writeFileSync(join(mDir, `${id}.machine.md`), `---\nid: ${id}\n---\n`);

const ids = () => new Set(loadMachines(root).flatMap((l) => (l.machine ? [l.machine.id] : [])));
const findings = () => envFindings(loadEnvs(root), ids());

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "te-envs-"));
  envDir = join(root, "envs");
  mDir = join(root, "machines");
  mkdirSync(envDir, { recursive: true });
  mkdirSync(mDir, { recursive: true });
  writeMachine("laptop");
  writeMachine("cloud");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("env files", () => {
  it("one machine in two envs loads with no findings", () => {
    writeEnv("home.env.md", {
      id: "home",
      network: ["MHEFNY4G"],
      machines: [
        { id: "laptop", row: 0, col: 0 },
        { id: "cloud", row: 0, col: 2 },
      ],
      reach: [{ from: "laptop", to: "cloud", via: "ssh" }],
    }, "the home network\n");
    writeEnv("work.env.md", {
      id: "work",
      network: ["mashariq_staff"],
      machines: [{ id: "laptop", row: 0, col: 0 }],
    });
    const loaded = loadEnvs(root);
    expect(loaded.every((l) => l.env)).toBe(true);
    const cloud = loaded.find((l) => l.env!.id === "home")!;
    expect(cloud.env!.machines.map((m) => m.id)).toContain("cloud");
    expect(findings()).toHaveLength(0);
  });

  it("reports an env that names an unknown machine id, with the file and the id", () => {
    writeEnv("bad.env.md", { id: "bad", machines: [{ id: "ghost" }] });
    const f = findings().filter((x) => x.path === "envs/bad.env.md");
    expect(f.some((x) => x.message.includes("ghost"))).toBe(true);
  });

  it("reports unknown machines in reach and a via outside the list", () => {
    writeEnv("badreach.env.md", {
      id: "badreach",
      reach: [{ from: "laptop", to: "mars", via: "pigeon" }],
    });
    const f = findings().filter((x) => x.path === "envs/badreach.env.md");
    expect(f.some((x) => x.message.includes("unknown machine 'mars'"))).toBe(true);
    expect(f.some((x) => x.message.includes("'pigeon'"))).toBe(true);
  });

  it("reports duplicate env ids and a parse error", () => {
    writeEnv("d1.env.md", { id: "same" });
    writeEnv("d2.env.md", { id: "same" });
    writeFileSync(join(envDir, "broken.env.md"), "not frontmatter\n");
    const f = findings();
    expect(f.some((x) => x.message.includes("'same' is also declared"))).toBe(true);
    expect(f.some((x) => x.message.includes("broken.env.md does not parse"))).toBe(true);
  });
});
