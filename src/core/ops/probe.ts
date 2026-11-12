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

interface Captured {
  /** combined stdout+stderr tail */
  out: string;
  /** stdout tail only — reach probes read the https status code from it */
  stdout: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

/** Spawn file+args with no shell — probe fields never reach a command line as text. */
function capture(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number }): Promise<Captured> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let out = "";
    let stdout = "";
    let timedOut = false;
    const child = execFile(file, args, { cwd: opts.cwd }, () => {});
    const kill = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      const s = String(d);
      out += s;
      stdout = (stdout + s).slice(-OUTPUT_TAIL);
    });
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => {
      clearTimeout(kill);
      resolve({ out: out.slice(-OUTPUT_TAIL), stdout, code: null, timedOut: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ out: out.slice(-OUTPUT_TAIL), stdout, code, timedOut });
    });
  });
}

function toProbeResult(c: Captured): Omit<ProbeResult, "target" | "by"> {
  return {
    ts: new Date().toISOString(),
    ok: !c.timedOut && !c.error && c.code === 0,
    timeout: c.timedOut,
    exit_code: c.code ?? undefined,
    version: versionFromTail(c.out),
    output: c.out,
    error: c.error,
  };
}

/** Run a probe command under bash; resolves even on non-zero exit / timeout — the result record carries the failure. */
export function runProbe(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<Omit<ProbeResult, "target" | "by">> {
  return capture("bash", ["-c", command], opts).then(toProbeResult);
}

/** argv variant of runProbe — the result also carries the stdout tail. */
export function runProbeArgv(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<Omit<ProbeResult, "target" | "by"> & { stdout: string }> {
  return capture(file, args, opts).then((c) => ({ ...toProbeResult(c), stdout: c.stdout }));
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

/**
 * Reach probes (GL-0289): prove one env reach edge is true right now —
 * ssh BatchMode with a short timeout for `ssh`/`git` edges, an https GET
 * for `https` edges. Read-only, same rules as target probes: human-only,
 * results machine-local under <teHome>/ops-probes/reach/<env>.json.
 * An edge whose env does not expect the current wifi answers
 * 'not expected: needs network X' and no command runs.
 */

export const REACH_PROBE_TIMEOUT_MS = 8_000;

export const ReachProbeResult = z.object({
  env: z.string(),
  from: z.string(),
  to: z.string(),
  via: z.string(),
  by: z.string(),
  ts: z.string(),
  /** ok | fail | not_expected | not_probed — a precondition answered before any command ran */
  status: z.enum(["ok", "fail", "not_expected", "not_probed"]),
  /** short reason on fail/not_expected/not_probed: timeout, DNS, auth refused, refused, unreachable, exit N, needs network X, not probed from here */
  reason: z.string().optional(),
  output: z.string().default(""),
});
export type ReachProbeResult = z.infer<typeof ReachProbeResult>;

/** The read-only argv that proves a machine is reachable by `via` — undefined when the record lacks what it needs. */
export interface ReachProbeCmd {
  file: string;
  args: string[];
}

export function reachCommand(m: { host?: string; ssh: Record<string, string> }, via: string): ReachProbeCmd | undefined {
  if (!m.host) return undefined;
  if (via === "ssh" || via === "git") {
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
    if (m.ssh.key) args.push("-i", m.ssh.key);
    if (m.ssh.port) args.push("-p", m.ssh.port);
    args.push(`${m.ssh.user ? `${m.ssh.user}@` : ""}${m.host}`, "true");
    return { file: "ssh", args };
  }
  // curl prints the http_code on stdout; '000' means the request never got an answer.
  // -S keeps error text on stderr — plain -s silences it, which hid the DNS reason.
  if (via === "https") return { file: "curl", args: ["-s", "-S", "-o", "/dev/null", "-w", "%{http_code}", "-m", "5", `https://${m.host}/`] };
  return undefined;
}

/** The short reason a failed probe keeps — maps the noise to one word the human reads. */
export function probeReason(output: string, timeout: boolean, code: number | undefined): string {
  if (timeout) return "timeout";
  if (/Could not resolve|Name or service not known|Temporary failure in name resolution/i.test(output)) return "DNS";
  if (/Permission denied/i.test(output)) return "auth refused";
  if (/Connection refused/i.test(output)) return "refused";
  if (/No route to host|Network is unreachable|connect timed out/i.test(output)) return "unreachable";
  return `exit ${code ?? "?"}`;
}

/**
 * Run one reach edge. `edge.expected === false` answers 'not expected'
 * and an edge whose `from` is not `opts.runner` answers 'not probed from
 * here' — both before any command runs. `wifi` is the current network
 * name — when the env names networks and this wifi is not one of them,
 * nothing runs.
 */
export async function runReachProbe(
  env: { id: string; network: string[] },
  edge: { from: string; to: string; via: string; expected?: boolean; note?: string },
  machines: ReadonlyMap<string, { host?: string; ssh: Record<string, string> }>,
  opts: { wifi?: string; cwd?: string; timeoutMs?: number; runner?: string } = {},
): Promise<Omit<ReachProbeResult, "env" | "from" | "to" | "via" | "by">> {
  if (edge.expected === false) {
    return { ts: new Date().toISOString(), status: "not_expected", reason: edge.note ? `not expected — ${edge.note}` : "not expected", output: "" };
  }
  if (opts.runner !== undefined && edge.from !== opts.runner) {
    const reason = opts.runner ? `not probed from here — runs on ${edge.from}` : "runner machine unknown — not probed";
    return { ts: new Date().toISOString(), status: "not_probed", reason, output: "" };
  }
  if (env.network.length && !(opts.wifi && env.network.includes(opts.wifi))) {
    return { ts: new Date().toISOString(), status: "not_expected", reason: `needs network ${env.network.join(" or ")}`, output: "" };
  }
  const m = machines.get(edge.to);
  const cmd = m ? reachCommand(m, edge.via) : undefined;
  if (!cmd) {
    return { ts: new Date().toISOString(), status: "fail", reason: m ? `no '${edge.via}' probe for ${edge.to}` : `no machine '${edge.to}'`, output: "" };
  }
  const r = await runProbeArgv(cmd.file, cmd.args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? REACH_PROBE_TIMEOUT_MS });
  // an https probe is ok only when curl printed a real http_code — '000' means no answer
  const httpCode = edge.via === "https" ? r.stdout.trim() : "";
  const ok = r.ok && (edge.via !== "https" || (/^[1-5]\d\d$/.test(httpCode)));
  return {
    ts: r.ts,
    status: ok ? "ok" : "fail",
    reason: ok ? undefined : probeReason(r.output, r.timeout, r.exit_code),
    output: r.output,
  };
}

function reachDir(home?: string): string {
  return join(probesDir(home), "reach");
}

/** stored reach results for one env — one file, results keyed by edge */
export function saveReachProbes(envId: string, results: ReachProbeResult[], home?: string): void {
  const dir = reachDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${envId}.json`);
  let all: ReachProbeResult[] = [];
  try {
    all = z.array(ReachProbeResult).parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    /* missing or corrupt — start over */
  }
  const key = (r: ReachProbeResult) => `${r.from}>${r.to}>${r.via}`;
  const fresh = new Set(results.map(key));
  writeFileSync(file, JSON.stringify([...all.filter((r) => !fresh.has(key(r))), ...results], null, 2) + "\n");
}

export function loadReachProbes(envId: string, home?: string): ReachProbeResult[] {
  try {
    return z.array(ReachProbeResult).parse(JSON.parse(readFileSync(join(reachDir(home), `${envId}.json`), "utf8")));
  } catch {
    return [];
  }
}
