import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbe, saveProbe, loadProbes, probePath } from "./probe.js";

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
