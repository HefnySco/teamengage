import { describe, it, expect } from "vitest";
import { runProbeWatch } from "./watch.js";
import { dueProbes, type ProbeResult } from "./probe.js";

/**
 * GL-0334: `te ops watch` runs each due probe itself and posts the result —
 * the same loop runs here at millisecond scale instead of probe_every: 1m.
 */

const run = (ok = true) =>
  Promise.resolve({ ts: new Date().toISOString(), ok, timeout: false, output: "", exit_code: 0, version: "v1" });

describe("te ops watch (GL-0334)", () => {
  it("posts a result per due probe on every probe_every; targets without it are never probed", async () => {
    const posts: string[] = [];
    const ac = new AbortController();
    const last: Record<string, ProbeResult | undefined> = {};
    const done = runProbeWatch({
      targets: async () => ({ a: { probe: "true", probe_every: "20ms" }, b: { probe: "true" } }),
      last: async () => last,
      run: () => run(),
      post: async (t, r) => {
        posts.push(t);
        last[t] = { target: t, by: "watch", ...r };
      },
      tickMs: 5,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 85));
    ac.abort();
    await done;
    // ~4 sweeps of 'a' in 85 ms at a 20 ms interval — two or more proves the cadence
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(posts)).toEqual(new Set(["a"]));
  });

  it("a stored result inside the interval keeps the target out of the sweep until it ages", () => {
    const now = Date.now();
    const last = {
      fresh: { target: "fresh", by: "watch", ts: new Date(now - 5_000).toISOString(), ok: true, timeout: false, output: "" },
      old: { target: "old", by: "watch", ts: new Date(now - 120_000).toISOString(), ok: true, timeout: false, output: "" },
    };
    const targets = {
      fresh: { probe: "x", probe_every: "1m" },
      old: { probe: "x", probe_every: "1m" },
      manual: { probe: "x" },
      nocommand: { probe_every: "1m" },
      bad: { probe: "x", probe_every: "soon" },
    };
    expect(dueProbes(targets, last, now)).toEqual(["old"]);
  });
});
