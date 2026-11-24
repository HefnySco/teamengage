import { daemonApi, ensureDaemon } from "../client.js";

const DISCOVER_HELP = `te discover — reattach orphaned agent processes (TE-0219)

  te discover [--ws <name>]   scan /proc for TE_ITEM-marked processes and
                              re-register their sessions, claims and tokens

Use after a daemon restart, or when a long-quiet agent lost its desk on the
team page while its process still runs. The daemon runs the same scan at
start. Human only.
`;

interface DiscoverReport {
  scanned: number;
  reattached: Array<{
    pid: number;
    id: string;
    session: string;
    claim: string;
    token: boolean;
  }>;
  skipped: Array<{ pid: number; item?: string; reason: string }>;
}

function readOption(args: string[], flagName: string): { present: boolean; value?: string } {
  const index = args.indexOf(flagName);
  if (index === -1) return { present: false };
  return { present: true, value: args[index + 1] };
}

export async function discoverCmd(args: string[], home?: string): Promise<number> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h") {
    process.stdout.write(DISCOVER_HELP);
    return 0;
  }
  const wsOpt = readOption(args, "--ws");
  const wsQuery = wsOpt.present && wsOpt.value ? `?ws=${encodeURIComponent(wsOpt.value)}` : "";
  await ensureDaemon(home);
  try {
    const report = (await daemonApi(
      "POST",
      `/api/dispatch/discover${wsQuery}`,
      {},
      home,
    )) as DiscoverReport;
    for (const r of report.reattached) {
      process.stdout.write(
        `reattached ${r.id} (pid ${r.pid}) → ${r.session} · claim ${r.claim}${r.token ? "" : " · no token"}\n`,
      );
    }
    const unmarked = report.skipped.filter((s) => s.reason === "no_marker").length;
    const children = report.skipped.filter((s) => s.reason === "child_process").length;
    for (const s of report.skipped) {
      if (s.reason === "no_marker" || s.reason === "child_process") continue;
      process.stdout.write(`skipped pid ${s.pid}${s.item ? ` ${s.item}` : ""}: ${s.reason}\n`);
    }
    process.stdout.write(
      `scanned ${report.scanned} · reattached ${report.reattached.length} · skipped ${report.skipped.length} (${unmarked} unmarked, ${children} child processes)\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`te discover: ${(e as Error).message}\n`);
    return 2;
  }
}
