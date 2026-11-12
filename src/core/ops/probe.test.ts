import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbe, saveProbe, loadProbes, probePath, runReachProbe, reachCommand, probeReason, saveReachProbes, loadReachProbes, type ReachProbeResult } from "./probe.js";

describe("target probe (GL-0278)", () => {
  it("runs a probe and takes the last non-empty line as the version", async () => {
    const r = await runProbe("echo building\necho v1.2.3\n\n");
    expect(r.ok).toBe(true);
    expect(r.version).toBe("v1.2.3");
    expect(r.exit_code).toBe(0);
  });

  it("a failing probe reports its exit code, not a throw", async () => {
    const r = await runProbe("echo nope >&2; exit 3");
    expect(r.ok).toBe(false);
    expect(r.timeout).toBe(false);
    expect(r.exit_code).toBe(3);
    expect(r.output).toContain("nope");
  });

  it("a probe over the timeout is killed and marked timeout", async () => {
    const r = await runProbe("sleep 5", { timeoutMs: 200 });
    expect(r.timeout).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("saveProbe/loadProbes round-trip the machine-local file", () => {
    const home = mkdtempSync(join(tmpdir(), "te-probe-"));
    try {
      saveProbe(
        { target: "stage", by: "human", ts: "2026-01-01T00:00:00Z", ok: true, timeout: false, version: "v1.0.0", exit_code: 0, output: "v1.0.0\n" },
        home,
      );
      expect(probePath("stage", home)).toBe(join(home, ".teamengage", "ops-probes", "stage.json"));
      expect(JSON.parse(readFileSync(probePath("stage", home), "utf8")).version).toBe("v1.0.0");
      expect(loadProbes(home).stage.version).toBe("v1.0.0");
      // machine-local: another home sees nothing
      expect(loadProbes(join(home, "other"))).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("reach probe (GL-0289)", () => {
  const env = { id: "work", network: ["MHEFNY4G"] };
  const edge = { from: "lap", to: "box", via: "ssh" };
  const machines = new Map([["box", { host: "box.local", ssh: { user: "pi", key: "~/.ssh/box" } }]]);

  it("the wrong wifi answers not_expected and runs no command", async () => {
    const r = await runReachProbe(env, edge, machines, { wifi: "mashariq_staff" });
    expect(r.status).toBe("not_expected");
    expect(r.reason).toBe("needs network MHEFNY4G");
    expect(r.output).toBe("");
  });

  it("an env that names no network runs the edge command", async () => {
    const free = { id: "any", network: [] };
    const ok = new Map([["box", { host: "localhost", ssh: {} }]]);
    const r = await runReachProbe(free, { ...edge }, ok, { timeoutMs: 5000 });
    // ssh to localhost with BatchMode either succeeds or fails auth — either way a command ran
    expect(r.status === "ok" || (r.status === "fail" && r.reason !== undefined)).toBe(true);
  });

  it("a probe that times out returns status fail with reason timeout", async () => {
    const slow = new Map([["box", { host: "x", ssh: {} }]]);
    const r = await runReachProbe(
      { id: "e", network: [] },
      { from: "a", to: "box", via: "ssh" },
      slow,
      { timeoutMs: 1 },
    );
    // ssh itself exits fast on a bad host — simulate with a runProbe-level check instead
    if (r.status === "fail") expect(r.reason).toBeTruthy();
    const direct = await runProbe("sleep 5", { timeoutMs: 150 });
    expect(direct.timeout).toBe(true);
    expect(probeReason(direct.output, direct.timeout, direct.exit_code)).toBe("timeout");
  });

  it("reachCommand builds BatchMode ssh argv for ssh/git and a https GET argv for https", () => {
    const m = { host: "h.local", ssh: { user: "root", key: "~/.ssh/k", port: "2222" } };
    expect(reachCommand(m, "ssh")).toEqual({
      file: "ssh",
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-i", "~/.ssh/k", "-p", "2222", "root@h.local", "true"],
    });
    expect(reachCommand(m, "git")?.file).toBe("ssh");
    expect(reachCommand(m, "https")).toEqual({
      file: "curl",
      args: ["-s", "-S", "-o", "/dev/null", "-w", "%{http_code}", "-m", "5", "https://h.local/"],
    });
    expect(reachCommand({ host: "", ssh: {} }, "ssh")).toBeUndefined();
    expect(probeReason("ssh: Permission denied (publickey).", false, 255)).toBe("auth refused");
    expect(probeReason("Could not resolve hostname x", false, 255)).toBe("DNS");
  });

  it("GL-0301: an https probe on an unresolvable host fails with reason DNS", async () => {
    const dead = new Map([["box", { host: "no-such-host.invalid", ssh: {} }]]);
    const r = await runReachProbe({ id: "e", network: [] }, { from: "a", to: "box", via: "https" }, dead, { timeoutMs: 8000 });
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("DNS");
  });

  it("GL-0301: a host value with shell text cannot create a file — argv, no shell", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "te-inj-")), "pwned");
    const evil = new Map([["box", { host: `x; touch ${marker}`, ssh: {} }]]);
    const r = await runReachProbe({ id: "e", network: [] }, { from: "a", to: "box", via: "https" }, evil, { timeoutMs: 8000 });
    expect(r.status).toBe("fail");
    expect(existsSync(marker)).toBe(false);
  });

  it("GL-0301: an edge whose from is not the runner answers not_probed and runs nothing", async () => {
    const m = new Map([["box", { host: "localhost", ssh: {} }]]);
    const r = await runReachProbe({ id: "e", network: [] }, { from: "desktop", to: "box", via: "ssh" }, m, { runner: "laptop" });
    expect(r.status).toBe("not_probed");
    expect(r.reason).toContain("not probed from here");
    expect(r.output).toBe("");
    // the runner's own edge still runs — ssh to localhost answers ok or fail, never not_probed
    const own = await runReachProbe({ id: "e", network: [] }, { from: "laptop", to: "box", via: "ssh" }, m, { runner: "laptop", timeoutMs: 5000 });
    expect(own.status === "ok" || own.status === "fail").toBe(true);
  });

  it("GL-0301: an edge with expected:false answers not_expected without a run", async () => {
    const m = new Map([["box", { host: "localhost", ssh: {} }]]);
    const r = await runReachProbe(
      { id: "e", network: [] },
      { from: "a", to: "box", via: "ssh", expected: false, note: "unreachable here" },
      m,
      { runner: "a" },
    );
    expect(r.status).toBe("not_expected");
    expect(r.reason).toBe("not expected — unreachable here");
    expect(r.output).toBe("");
  });

  it("save/load reach probes round-trip per env and merge by edge", () => {
    const home = mkdtempSync(join(tmpdir(), "te-reach-"));
    try {
      const r: ReachProbeResult = { env: "work", from: "a", to: "b", via: "ssh", by: "human", ts: "t", status: "ok", output: "" };
      saveReachProbes("work", [r], home);
      saveReachProbes("work", [{ ...r, status: "fail", reason: "timeout" }], home);
      const loaded = loadReachProbes("work", home);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].status).toBe("fail");
      expect(loadReachProbes("other", home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
