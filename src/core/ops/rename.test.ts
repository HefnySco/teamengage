import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachines } from "./machine.js";
import { loadEnvs } from "./env.js";
import { renameMachine } from "./rename.js";

const dirs: string[] = [];
function ws() {
  const root = mkdtempSync(join(tmpdir(), "te-rename-"));
  const home = mkdtempSync(join(tmpdir(), "te-rename-home-"));
  dirs.push(root, home);
  mkdirSync(join(root, "machines"), { recursive: true });
  mkdirSync(join(root, "envs"), { recursive: true });
  const plansDir = join(root, ".teamengage");
  mkdirSync(join(plansDir, "ops", "jobs"), { recursive: true });
  mkdirSync(join(plansDir, "ops", "locks"), { recursive: true });
  mkdirSync(join(plansDir, "events"), { recursive: true });
  return { root, plansDir, home };
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const read = (p: string) => readFileSync(p, "utf8");

function fixture() {
  const { root, plansDir, home } = ws();
  writeFileSync(
    join(root, "machines", "dt.machine.md"),
    `---\nid: dt\nhost: dt.local\nedges:\n  - { kind: deploy, to: pi/web }\n  - { kind: sync, to: usb }\n---\ndesktop notes\n`,
  );
  writeFileSync(join(root, "machines", "dt.machine.local"), `runner: true\nssh:\n  user: mhefny\n`);
  writeFileSync(
    join(root, "machines", "pi.machine.md"),
    `---\nid: pi\nhost: pi.local\napps:\n  - { name: web, paths: { dt: /home/dt/x, pi: /home/pi/x } }\nedges:\n  - { kind: sync, to: dt }\n---\n`,
  );
  // partial-id guard: dt-extra must not move when dt is renamed
  writeFileSync(join(root, "machines", "dt-extra.machine.md"), `---\nid: dt-extra\nedges:\n  - { kind: sync, to: dt }\n---\n`);
  writeFileSync(join(root, "machines", "usb.machine.md"), `---\nid: usb\nmount: /mnt/usb\n---\n`);
  writeFileSync(
    join(root, "envs", "home.env.md"),
    `---\nid: home\nmachines:\n  - { id: dt, row: 0, col: 0 }\n  - { id: pi, row: 0, col: 1 }\n  - { id: dt-extra, row: 1, col: 0 }\nreach:\n  - { from: dt, to: pi, via: ssh }\n  - { from: pi, to: dt, via: ssh }\n  - { from: dt, to: dt-extra, via: ssh }\n---\n`,
  );
  writeFileSync(
    join(plansDir, "workspace.yaml"),
    `name: t\nprefix: T\ntargets:\n  t1: { machine: dt, app: web }\n  t2:\n    machine: dt # the desktop\n  t3: { machine: pi }\n`,
  );
  mkdirSync(join(home, ".teamengage", "ops-probes", "reach"), { recursive: true });
  writeFileSync(
    join(home, ".teamengage", "ops-probes", "reach", "home.json"),
    JSON.stringify([
      { env: "home", from: "dt", to: "pi", via: "ssh", by: "human", ts: "t", status: "ok", output: "" },
      { env: "home", from: "pi", to: "dt", via: "ssh", by: "human", ts: "t", status: "fail", output: "" },
    ]) + "\n",
  );
  mkdirSync(join(plansDir, "ops", "jobs", "dt"), { recursive: true });
  writeFileSync(
    join(plansDir, "ops", "jobs", "dt", "dt-0001.yaml"),
    `id: dt-0001\nplaybook: dep\ntarget: t1\nmachine: dt\nstatus: succeeded\n`,
  );
  mkdirSync(join(plansDir, "events", "dt"), { recursive: true });
  writeFileSync(join(plansDir, "events", "dt", "2026-11.jsonl"), `{"seq":1,"ts":"t","machine":"dt","kind":"k"}\n`);
  writeFileSync(join(plansDir, "ops", "locks", "t1.yaml"), `target: t1\njob: dt-0001\nmachine: dt\nts: t\n`);
  return { root, plansDir, home };
}

describe("renameMachine", () => {
  it("moves the file, rewrites every reference and migrates runner state", () => {
    const { root, plansDir, home } = fixture();
    const rep = renameMachine(root, plansDir, home, "dt", "desktop");

    // the file moved; id field + own edges rewritten
    expect(existsSync(join(root, "machines", "dt.machine.md"))).toBe(false);
    const fm = read(join(root, "machines", "desktop.machine.md"));
    expect(fm).toContain("id: desktop");
    expect(fm).toContain("to: pi/web");
    expect(fm).toContain("to: usb");
    expect(read(join(root, "machines", "desktop.machine.local"))).toContain("runner: true");

    // pi's edge and per-runner paths key moved; pi's own key untouched
    const pi = read(join(root, "machines", "pi.machine.md"));
    expect(pi).toContain("to: desktop");
    expect(pi).toContain("desktop: /home/dt/x");
    expect(pi).toContain("pi: /home/pi/x");

    // partial id: dt-extra stays, but its edge to dt moved
    const extra = read(join(root, "machines", "dt-extra.machine.md"));
    expect(extra).toContain("id: dt-extra");
    expect(extra).toContain("to: desktop");

    // env: machines entry, reach from and to — the env's own id untouched
    const env = loadEnvs(root)[0].env!;
    expect(env.id).toBe("home");
    expect(env.machines.map((m) => m.id)).toEqual(["desktop", "pi", "dt-extra"]);
    expect(env.reach.map((r) => `${r.from}>${r.to}`)).toEqual(["desktop>pi", "pi>desktop", "desktop>dt-extra"]);

    // workspace targets
    const wsYaml = read(join(plansDir, "workspace.yaml"));
    expect(wsYaml).toContain("machine: desktop");
    expect(wsYaml).toContain("machine: desktop # the desktop");
    expect(wsYaml).toContain("machine: pi");

    // stored reach probes follow the new id — no orphaned old>to keys
    const probes = JSON.parse(read(join(home, ".teamengage", "ops-probes", "reach", "home.json")));
    expect(probes.map((p: { from: string; to: string }) => `${p.from}>${p.to}`)).toEqual(["desktop>pi", "pi>desktop"]);

    // runner-keyed state: job dir, job file name, job/machine fields
    expect(read(join(plansDir, "ops", "jobs", "desktop", "desktop-0001.yaml"))).toContain("machine: desktop");
    expect(read(join(plansDir, "ops", "jobs", "desktop", "desktop-0001.yaml"))).toContain("id: desktop-0001");
    expect(existsSync(join(plansDir, "ops", "jobs", "dt"))).toBe(false);
    expect(read(join(plansDir, "events", "desktop", "2026-11.jsonl"))).toContain('"machine":"desktop"');
    const lock = read(join(plansDir, "ops", "locks", "t1.yaml"));
    expect(lock).toContain("machine: desktop");
    expect(lock).toContain("job: desktop-0001");

    // the renamed machine still parses and its .local override still merges
    const m = loadMachines(root).find((l) => l.machine?.id === "desktop")!;
    expect(m.machine!.runner).toBe(true);
    expect(m.machine!.ssh.user).toBe("mhefny");
    expect(rep.renamed.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses unknown, duplicate and same-id renames", () => {
    const { root, plansDir, home } = fixture();
    expect(() => renameMachine(root, plansDir, home, "ghost", "x")).toThrow("no machine 'ghost'");
    expect(() => renameMachine(root, plansDir, home, "dt", "pi")).toThrow("already exists");
    expect(() => renameMachine(root, plansDir, home, "dt", "dt")).toThrow("nothing to do");
    // a failed rename touched nothing
    expect(existsSync(join(root, "machines", "dt.machine.md"))).toBe(true);
  });
});
