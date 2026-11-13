import { daemonApi } from "../client.js";
import { parseDuration } from "../../core/model/workspace.js";

/**
 * `te digest` — what happened since the human's last action (GL-0320):
 * finished items by plan, stuck work, and what waits for the human.
 * `--since 24h|30m|7d` overrides the window's start.
 */

const opt = (args: string[], n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};

interface DigestLine {
  id: string;
  title: string;
  why?: string;
}
interface Digest {
  since: string;
  finished: { plan?: string; items: DigestLine[] }[];
  stuck: DigestLine[];
  waits: DigestLine[];
}

const printLines = (label: string, rows: DigestLine[]) => {
  process.stdout.write(`${label}\n`);
  if (!rows.length) {
    process.stdout.write("  nothing there\n");
    return;
  }
  for (const r of rows)
    process.stdout.write(`  ${r.id}  ${r.title}${r.why ? ` — ${r.why}` : ""}\n`);
};

export async function digestCmd(args: string[], home?: string): Promise<number> {
  let since: string | undefined;
  const dur = opt(args, "--since");
  if (dur) since = new Date(Date.now() - parseDuration(dur)).toISOString();
  const w = opt(args, "--ws");
  const q = [w ? `ws=${encodeURIComponent(w)}` : "", since ? `since=${encodeURIComponent(since)}` : ""]
    .filter(Boolean)
    .join("&");
  const d = (await daemonApi("GET", `/api/digest${q ? `?${q}` : ""}`, undefined, home)) as Digest;
  process.stdout.write(`since ${d.since.slice(0, 16).replace("T", " ")}\n\n`);
  if (!d.finished.length) {
    process.stdout.write("finished\n  nothing there\n\n");
  } else {
    process.stdout.write("finished\n");
    for (const g of d.finished) {
      if (g.plan) process.stdout.write(`  ${g.plan}\n`);
      for (const r of g.items)
        process.stdout.write(`  ${g.plan ? "  " : ""}${r.id}  ${r.title}\n`);
    }
    process.stdout.write("\n");
  }
  printLines("stuck", d.stuck);
  process.stdout.write("\n");
  printLines("waits for you", d.waits);
  return 0;
}
