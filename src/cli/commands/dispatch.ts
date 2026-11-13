import { daemonApi, ensureDaemon } from "../client.js";

/**
 * `te dispatch on|off|status` (GL-0328) — control the daemon's agent
 * launcher. `dispatch:` in workspace.yaml configures it; the human turns
 * it on here (agents get FORBIDDEN). Status shows live sessions, running
 * commands and consecutive failures.
 */

const DISPATCH_HELP = `te dispatch — the daemon's agent launcher (GL-0328)

  te dispatch on       start dispatching (human only)
  te dispatch off      stop starting agents
  te dispatch status   live state — sessions, running roles, failures

Configure in workspace.yaml:

  dispatch:
    enabled: false
    max_sessions: 2          # live agent sessions the daemon fills up to
    agents:
      - { role: coder, command: "devin -p --model swe-2-high --permission-mode accept-edits --" }
      - { role: reviewer, tier: standard, command: "claude -p \\"$TE_PROMPT\\"" }

While enabled, each minute the daemon starts a role's command when next
sees work for it and live sessions are under max_sessions. It never stops
a session. A command that fails 3 times in a row turns dispatch off.
Logs: ~/.teamengage/runs/<workspace>/dispatch-<role>-*.log
`;

export async function dispatchCmd(args: string[], home?: string): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(DISPATCH_HELP);
    return sub ? 0 : 2;
  }
  const wsIdx = args.indexOf("--ws");
  const ws = wsIdx === -1 ? "" : `?ws=${encodeURIComponent(args[wsIdx + 1] ?? "")}`;
  await ensureDaemon(home);
  if (sub === "status") {
    const s = (await daemonApi("GET", `/api/dispatch${ws}`, undefined, home)) as {
      enabled: boolean;
      max_sessions: number;
      agents: Array<{ role: string; tier?: string; command: string }>;
      live_sessions: number;
      running: string[];
      failures: Record<string, number>;
    };
    process.stdout.write(
      `dispatch ${s.enabled ? "on" : "off"} · sessions ${s.live_sessions}/${s.max_sessions}` +
        `${s.running.length ? ` · running: ${s.running.join(", ")}` : ""}\n`,
    );
    for (const a of s.agents) {
      const f = s.failures[a.role];
      process.stdout.write(
        `  ${a.role}${a.tier ? ` (${a.tier})` : ""}: ${a.command}${f ? ` — ${f} consecutive failure(s)` : ""}\n`,
      );
    }
    return 0;
  }
  if (sub === "on" || sub === "off") {
    const s = (await daemonApi("POST", `/api/dispatch${ws}`, { enabled: sub === "on" }, home)) as {
      enabled: boolean;
    };
    process.stdout.write(`dispatch ${s.enabled ? "on" : "off"}\n`);
    return 0;
  }
  process.stderr.write(`te dispatch: unknown '${sub}'\n\n`);
  process.stdout.write(DISPATCH_HELP);
  return 2;
}
