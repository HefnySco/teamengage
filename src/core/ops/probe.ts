import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { teHome } from "../config/config.js";
import { versionFromTail } from "./job.js";

/**
 * Target probes (GL-0278, DESIGN §14.5): a read-only shell a target
 * declares in workspace.yaml — it prints the deployed version. The probe
 * is the one command the daemon itself may run, and only for the human
 * (the UI's "probe now"). Results are stored machine-local under
 * <teHome>/ops-probes/<target>.json — they are a local observation, never
 * synced; the synced ledger is the last succeeded job's version.
 */

export const PROBE_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL = 8_000;

export const ProbeResult = z.object({
  target: z.string(),
  /** started-by marker: "human" for the UI/CLI probe */
  by: z.string(),
  ts: z.string(),
  ok: z.boolean(),
  /** true when the probe was killed at the timeout */
  timeout: z.boolean().default(false),
  exit_code: z.number().optional(),
  /** last non-empty stdout line — the version the probe printed */
  version: z.string().optional(),
  /** combined stdout+stderr tail */
  output: z.string().default(""),
  error: z.string().optional(),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

/** Run a probe command under bash; resolves even on non-zero exit / timeout — the result record carries the failure. */
export function runProbe(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<Omit<ProbeResult, "target" | "by">> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const child = execFile("bash", ["-c", command], { cwd: opts.cwd }, () => {});
    const kill = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => {
      clearTimeout(kill);
      resolve({ ts: new Date().toISOString(), ok: false, timeout: false, output: out.slice(-OUTPUT_TAIL), error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      const tail = out.slice(-OUTPUT_TAIL);
      resolve({
        ts: new Date().toISOString(),
        ok: !timedOut && code === 0,
        timeout: timedOut,
        exit_code: code ?? undefined,
        version: versionFromTail(tail),
        output: tail,
      });
    });
  });
}

function probesDir(home?: string): string {
  return join(teHome(home), "ops-probes");
}

export function probePath(target: string, home?: string): string {
  return join(probesDir(home), `${target}.json`);
}

export function saveProbe(result: ProbeResult, home?: string): void {
  mkdirSync(probesDir(home), { recursive: true });
  writeFileSync(probePath(result.target, home), JSON.stringify(result, null, 2) + "\n");
}

/** every stored probe result, keyed by target — corrupt files are skipped */
export function loadProbes(home?: string): Record<string, ProbeResult> {
  const dir = probesDir(home);
  if (!existsSync(dir)) return {};
  const out: Record<string, ProbeResult> = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      const r = ProbeResult.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (r.success) out[r.data.target] = r.data;
    } catch {
      /* corrupt probe file — skip it */
    }
  }
  return out;
}
