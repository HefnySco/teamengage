import { daemonApi, ensureDaemon } from "../client.js";

const DISPATCH_HELP = `te dispatch — the daemon's per-item agent launcher

  te dispatch on [--max <n>] [--filter <expr>]     start dispatching (human only)
  te dispatch set [--max <n>] [--filter <expr>]    update max issues or filter
  te dispatch off                                  stop starting new items
  te dispatch status                               live state — issues, filter, matches, runs

Options:
  --max <n>        max active local issues (dispatches + live local in_progress claims)
  --filter <expr>  item selector (e.g. "SE-01xx:inreview, Plan PL-1032:ready", "" clears)
  --ws <name>      workspace name

Configure defaults in workspace.yaml (falls back to ~/.teamengage/machine.yaml run:):

  dispatch:
    enabled: false
    max_issues: 2
    filter: "SE-01xx:inreview, Plan PL-1032:ready"

Logs: ~/.teamengage/runs/<workspace>/dispatch-<item>-<mode>-*.log
`;

interface DispatchStatusResponse {
  enabled: boolean;
  max_issues: number;
  max_sessions: number;
  online_issues: number;
  live_sessions: number;
  filter: string;
  matched: Array<{ id: string; mode: string; status: string; title: string }>;
  running: Array<{ id: string; mode: string; role: string; pid: number; started_at: string }>;
  agents: Array<{ role: string; tier?: string; command: string }>;
  agents_ready: boolean;
  failures: Record<string, number>;
}

function readOption(args: string[], flagName: string): { present: boolean; value?: string } {
  const index = args.indexOf(flagName);
  if (index === -1) return { present: false };
  return { present: true, value: args[index + 1] };
}

function formatStatusSummary(status: DispatchStatusResponse): string {
  const runningText = status.running.length
    ? ` · running: ${status.running.map((entry) => `${entry.id} (${entry.mode})`).join(", ")}`
    : "";
  const filterText = status.filter ? ` · filter: ${status.filter}` : "";
  return (
    `dispatch ${status.enabled ? "on" : "off"} · issues ${status.online_issues}/${status.max_issues}` +
    ` · sessions ${status.live_sessions}${filterText}${runningText}\n`
  );
}

export async function dispatchCmd(args: string[], home?: string): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(DISPATCH_HELP);
    return sub ? 0 : 2;
  }
  const wsOpt = readOption(args, "--ws");
  const wsQuery = wsOpt.present && wsOpt.value ? `?ws=${encodeURIComponent(wsOpt.value)}` : "";
  await ensureDaemon(home);

  if (sub === "status") {
    const status = (await daemonApi(
      "GET",
      `/api/dispatch${wsQuery}`,
      undefined,
      home,
    )) as DispatchStatusResponse;
    process.stdout.write(formatStatusSummary(status));
    process.stdout.write(
      `  matched (${status.matched.length}): ${
        status.matched.length
          ? status.matched.map((entry) => `${entry.id} (${entry.mode})`).join(", ")
          : "none"
      }\n`,
    );
    for (const agent of status.agents) {
      const failCount = status.failures[agent.role];
      process.stdout.write(
        `  ${agent.role}${agent.tier ? ` (${agent.tier})` : ""}: ${agent.command}${
          failCount ? ` — ${failCount} consecutive failure(s)` : ""
        }\n`,
      );
    }
    return 0;
  }

  if (sub === "on" || sub === "off" || sub === "set") {
    const maxOpt = readOption(args, "--max");
    const filterOpt = readOption(args, "--filter");
    const payload: Record<string, unknown> = {};
    if (sub !== "set") {
      payload.enabled = sub === "on";
    }
    if (maxOpt.present) {
      const parsed = Number(maxOpt.value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        process.stderr.write("te dispatch: --max must be an integer >= 1\n");
        return 2;
      }
      payload.max_issues = parsed;
    }
    if (filterOpt.present) {
      if (filterOpt.value === undefined) {
        process.stderr.write("te dispatch: --filter needs an expression\n");
        return 2;
      }
      payload.filter = filterOpt.value;
    }
    if (sub === "set" && Object.keys(payload).length === 0) {
      process.stderr.write("te dispatch set: pass --max <n> and/or --filter <expr>\n");
      return 2;
    }
    try {
      const status = (await daemonApi(
        "POST",
        `/api/dispatch${wsQuery}`,
        payload,
        home,
      )) as DispatchStatusResponse;
      process.stdout.write(formatStatusSummary(status));
      return 0;
    } catch (e) {
      process.stderr.write(`te dispatch: ${(e as Error).message}\n`);
      return 2;
    }
  }

  process.stderr.write(`te dispatch: unknown '${sub}'\n\n`);
  process.stdout.write(DISPATCH_HELP);
  return 2;
}
