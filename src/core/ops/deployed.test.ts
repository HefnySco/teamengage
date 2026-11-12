import { describe, it, expect } from "vitest";
import { deployedForMachine, deployedAppLine, type DeployedApp } from "./deployed.js";
import { Job } from "./job.js";
import type { ProbeResult } from "./probe.js";
import type { TargetConfig } from "../model/workspace.js";

/**
 * The deployed join (GL-0305): machine apps × workspace targets × last
 * succeeded job × stored probe → one entry per app with a state.
 */

const machine = {
  id: "cloud",
  apps: [
    { name: "de_web_server", port: 8001, env: "prod" as const },
    { name: "de_auth_2026", port: 19408, env: "prod" as const },
    { name: "de_orphan", port: 1 },
  ],
};

const targets: Record<string, TargetConfig> = {
  "web-prod": { machine: "cloud", app: "de_web_server", probe: "x" },
  "auth-prod": { machine: "cloud", app: "de_auth_2026" },
  "web-shadow": { machine: "cloud", app: "de_web_shadow" }, // app not in the machine's list — ignored
  "other-box": { machine: "box", app: "de_web_server" }, // other machine — ignored
};

function job(id: string, target: string | undefined, status: Job["status"], version: string | undefined, ts: string, machine = "runner-1"): Job {
  return Job.parse({
    id,
    machine,
    playbook: "deploy-x",
    playbook_sha256: "x",
    target,
    status,
    version,
    started: { ts, by: "human" },
    steps: [{ id: "deploy", status: status === "succeeded" ? "passed" : "failed", ended: ts }],
  });
}

function probe(target: string, version: string | undefined, ok = true, ts = "2026-01-02T00:00:00Z"): ProbeResult {
  return { target, by: "human", ts, ok, timeout: false, version, output: version ? `${version}\n` : "" };
}

const apps = (jobs: Job[] = [], probes: Record<string, ProbeResult> = {}, tgts = targets) =>
  deployedForMachine(machine, tgts, jobs, probes);
const byName = (list: DeployedApp[], name: string) => list.find((a) => a.name === name)!;

describe("deployedForMachine (GL-0305)", () => {
  it("no_target: an app no target names", () => {
    const a = byName(apps(), "de_orphan");
    expect(a.state).toBe("no_target");
    expect(a.targets).toEqual([]);
  });

  it("unknown: a target exists but no job and no probe", () => {
    const a = byName(apps(), "de_auth_2026");
    expect(a.state).toBe("unknown");
    expect(a.targets.map((t) => t.target)).toEqual(["auth-prod"]);
  });

  it("deployed: a succeeded job and an agreeing probe", () => {
    const a = byName(
      apps(
        [job("runner-1-0001", "web-prod", "succeeded", "v2.0.0", "2026-01-01T00:00:00Z")],
        { "web-prod": probe("web-prod", "v2.0.0") },
      ),
      "de_web_server",
    );
    expect(a.state).toBe("deployed");
    expect(a.targets[0].drift).toBe(false);
    expect(a.targets[0].job).toMatchObject({ id: "runner-1-0001", version: "v2.0.0", machine: "runner-1" });
    expect(a.targets[0].probe?.ok).toBe(true);
  });

  it("deployed: a job and no probe at all", () => {
    const a = byName(apps([job("runner-1-0001", "web-prod", "succeeded", "v2.0.0", "2026-01-01T00:00:00Z")]), "de_web_server");
    expect(a.state).toBe("deployed");
    expect(a.targets[0].probe).toBeUndefined();
  });

  it("drift: the probe version is not the job version", () => {
    const a = byName(
      apps(
        [job("runner-1-0001", "web-prod", "succeeded", "v2.0.0", "2026-01-01T00:00:00Z")],
        { "web-prod": probe("web-prod", "v1.0.0") },
      ),
      "de_web_server",
    );
    expect(a.state).toBe("drift");
    expect(a.targets[0].drift).toBe(true);
  });

  it("a failed or aborted job does not count as deployed", () => {
    for (const status of ["failed", "aborted", "stopped"] as const) {
      const a = byName(apps([job("runner-1-0001", "web-prod", status, "v2.0.0", "2026-01-01T00:00:00Z")]), "de_web_server");
      expect(a.state).toBe("unknown");
      expect(a.targets[0].job).toBeUndefined();
    }
    // a failed job plus a probe still shows the probe — deployed, no drift
    const b = byName(
      apps(
        [job("runner-1-0001", "web-prod", "failed", "v2.0.0", "2026-01-01T00:00:00Z")],
        { "web-prod": probe("web-prod", "v9.9.9") },
      ),
      "de_web_server",
    );
    expect(b.state).toBe("deployed");
    expect(b.targets[0].drift).toBe(false);
  });

  it("the last succeeded job wins; a newer failed job does not replace it", () => {
    const a = byName(
      apps(
        [
          job("runner-1-0001", "web-prod", "succeeded", "v1.0.0", "2026-01-01T00:00:00Z"),
          job("runner-1-0002", "web-prod", "succeeded", "v2.0.0", "2026-01-02T00:00:00Z"),
          job("runner-1-0003", "web-prod", "failed", "v3.0.0", "2026-01-03T00:00:00Z"),
        ],
        {},
      ),
      "de_web_server",
    );
    expect(a.targets[0].job?.id).toBe("runner-1-0002");
    expect(a.targets[0].job?.version).toBe("v2.0.0");
  });

  it("an app with two targets lists both", () => {
    const tgts: Record<string, TargetConfig> = {
      "web-a": { machine: "cloud", app: "de_web_server" },
      "web-b": { machine: "cloud", app: "de_web_server" },
    };
    const a = byName(
      apps(
        [job("runner-1-0001", "web-a", "succeeded", "v1", "2026-01-01T00:00:00Z")],
        { "web-b": probe("web-b", "v7") },
        tgts,
      ),
      "de_web_server",
    );
    expect(a.targets.map((t) => t.target)).toEqual(["web-a", "web-b"]);
    expect(a.state).toBe("deployed");
  });

  it("app and machine match case-insensitively; a target with no app names none", () => {
    const tgts: Record<string, TargetConfig> = {
      "web-prod": { machine: "Cloud", app: "DE_WEB_SERVER" },
      "machine-only": { machine: "cloud" },
    };
    const a = byName(apps([], {}, tgts), "de_web_server");
    expect(a.targets.map((t) => t.target)).toEqual(["web-prod"]);
    expect(byName(apps([], {}, tgts), "de_auth_2026").state).toBe("no_target");
  });

  it("the probe version falls back to the last output line", () => {
    const p = probe("web-prod", undefined);
    p.version = undefined;
    p.output = "noise\nv4.5.6\n";
    const a = byName(
      apps([job("runner-1-0001", "web-prod", "succeeded", "v4.5.6", "2026-01-01T00:00:00Z")], { "web-prod": p }),
      "de_web_server",
    );
    expect(a.targets[0].probe?.version).toBe("v4.5.6");
    expect(a.state).toBe("deployed");
  });
});

describe("deployedAppLine (GL-0305)", () => {
  it("prints name, port, env, version, age and the state", () => {
    const a = byName(
      apps([job("runner-1-0007", "web-prod", "succeeded", "v2.0.0", "2026-01-01T00:00:00Z")]),
      "de_web_server",
    );
    const line = deployedAppLine(a, Date.parse("2026-01-01T01:00:00Z"));
    expect(line).toContain("de_web_server :8001 [prod]");
    expect(line).toContain("v2.0.0");
    expect(line).toContain("1h ago");
    expect(line).toContain("job runner-1-0007 on runner-1");
    expect(line).toContain("deployed");
  });

  it("names the missing pieces for unknown and no_target", () => {
    const list = apps();
    expect(deployedAppLine(byName(list, "de_orphan"))).toContain("no target");
    expect(deployedAppLine(byName(list, "de_auth_2026"))).toContain("unknown");
    expect(deployedAppLine(byName(list, "de_auth_2026"))).toContain("auth-prod");
  });
});
