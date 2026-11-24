import { daemonApi, ensureDaemon } from "../client.js";

const DISPATCH_HELP = `te dispatch — the daemon's per-item agent launcher

  te dispatch on [--max <n>] [--filter <expr>]     start dispatching (human only)
  te dispatch set [--max <n>] [--filter <expr>]    update max issues or filter
  te dispatch off                                  stop starting new items
  te dispatch status                               live state — issues, filter, matches, runs

Forced levers (human only):
  te dispatch pause [--kill] [reason]              stop new starts; --kill stops running children too
  te dispatch resume                               lift a pause ('on' also does)
  te dispatch block <id> <reason>                  keep one item out of dispatch until unblock
  te dispatch unblock <id>                         clear a blocked item
  te dispatch reset <id>                           clear the item's tried/fix/failure memory

Options:
  --max <n>        max active local issues (dispatches + live local in_progress claims)
  --filter <expr>  item selector (e.g. "SE-01xx:inreview, Plan PL-1032:ready, -SE-0105", "" clears)
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
  matched: Array<{ id: string; mode: string; status: string; title: string; blocked?: boolean }>;
  running: Array<{ id: string; mode: string; role: string; pid: number; started_at: string }>;
  agents: Array<{ role: string; tier?: string; command: string }>;
  agents_ready: boolean;
  failures: Record<string, number>;
  why_idle?: string | null;
  paused?: string | null;
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
  const idleText = status.why_idle ? ` · ${status.why_idle}` : "";
  return (
    `dispatch ${status.enabled ? "on" : "off"} · issues ${status.online_issues}/${status.max_issues}` +
    ` · sessions ${status.live_sessions}${filterText}${idleText}${runningText}\n`
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
          ? status.matched
              .map((entry) => `${entry.id} (${entry.mode}${entry.blocked ? " blocked" : ""})`)
              .join(", ")
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

  // TE-0209: forced correction levers — positional args after the flags
  const positional = args.slice(1).filter((a, i, arr) => {
    if (a === "--ws") return false;
    if (i > 0 && arr[i - 1] === "--ws") return false;
    return !a.startsWith("--");
  });
  if (sub === "pause" || sub === "resume" || sub === "block" || sub === "unblock" || sub === "reset") {
    const kill = args.includes("--kill");
    let payload: Record<string, unknown>;
    let confirm: string;
    if (sub === "pause") {
      const reason = positional.join(" ").trim();
      payload = reason || kill ? { pause: { ...(reason ? { reason } : {}), kill } } : { pause: true };
      confirm = `dispatch paused${reason ? `: ${reason}` : ""}${kill ? " — running children killed" : ""}`;
    } else if (sub === "resume") {
      payload = { resume: true };
      confirm = "dispatch resumed";
    } else {
      const id = positional[0];
      if (!id) {
        process.stderr.write(`te dispatch ${sub}: pass an item id\n`);
        return 2;
      }
      if (sub === "block") {
        const reason = positional.slice(1).join(" ").trim();
        if (!reason) {
          process.stderr.write('te dispatch block: pass a reason — block <id> "why"\n');
          return 2;
        }
        payload = { block: { id, reason } };
        confirm = `${id} blocked from dispatch: ${reason}`;
      } else if (sub === "unblock") {
        payload = { unblock: { id } };
        confirm = `${id} unblocked`;
      } else {
        payload = { reset: { id } };
        confirm = `${id} dispatch memory cleared`;
      }
    }
    try {
      await daemonApi("POST", `/api/dispatch${wsQuery}`, payload, home);
      process.stdout.write(`${confirm}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`te dispatch ${sub}: ${(e as Error).message}\n`);
      return 2;
    }
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
