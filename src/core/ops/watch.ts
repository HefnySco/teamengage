import { dueProbes, type ProbeResult } from "./probe.js";

/**
 * `te ops watch` (GL-0334): a long-running loop on the runner machine —
 * each tick asks which targets are due (probe_every passed since the
 * last stored result), runs those probes itself and posts the results
 * to the daemon. The daemon never runs them (DESIGN §14.5): it only
 * stores what the runner posts, stamped by: "watch" + the machine name.
 * Every dependency is injected so a test can run the same loop at
 * millisecond scale.
 */
export interface WatchDeps {
  /** workspace targets (id → {probe, probe_every}) — re-read every sweep */
  targets(): Promise<Record<string, { probe?: string; probe_every?: string }>>;
  /** the stored last result per target — re-read every sweep so a human "probe now" resets the clock */
  last(): Promise<Record<string, ProbeResult | undefined>>;
  /**
   * Targets the runner cannot reach in the selected env (GL-0337) —
   * re-read every sweep; a due target in this list is skipped with one
   * log line, never run.
   */
  unreachable?(): Promise<{ env?: string; targets: string[] }>;
  /** run one probe command — the real impl is runProbe */
  run(command: string): Promise<Omit<ProbeResult, "target" | "by" | "machine">>;
  /** post one result to the daemon */
  post(target: string, run: Omit<ProbeResult, "target" | "by" | "machine">): Promise<unknown>;
  /** pause between sweeps (default 1s) */
  tickMs?: number;
  /** one output line per posted result */
  log?(line: string): void;
  /** stop after the current sweep (tests / clean shutdown) */
  signal?: AbortSignal;
}

export async function runProbeWatch(deps: WatchDeps): Promise<void> {
  const tickMs = deps.tickMs ?? 1_000;
  for (;;) {
    const targets = await deps.targets();
    const last = await deps.last();
    const unreach = await deps.unreachable?.();
    const unreachSet = new Set(unreach?.targets ?? []);
    for (const id of dueProbes(targets, last)) {
      if (unreachSet.has(id)) {
        deps.log?.(`${id}: skipped — not reachable in env '${unreach?.env ?? "?"}'`);
        continue;
      }
      const run = await deps.run(targets[id].probe!);
      await deps.post(id, run);
      last[id] = { target: id, by: "watch", ...run };
      deps.log?.(
        `${id}: ${run.ok ? `ok — ${run.version ?? "no version line"}` : run.timeout ? "timeout" : `exit ${run.exit_code ?? "?"}`}`,
      );
    }
    if (deps.signal?.aborted) return;
    await new Promise((r) => setTimeout(r, tickMs));
    if (deps.signal?.aborted) return;
  }
}
