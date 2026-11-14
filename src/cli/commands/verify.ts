import { join } from "node:path";
import { daemonApi } from "../client.js";
import { resolveWorkspace, teHome } from "../../core/config/config.js";
import { runChecks, type CheckRun } from "../../core/verify/verify.js";
import type { Check } from "../../core/model/item.js";

/**
 * `te verify <ID>` (GL-0357): run the item's ## Checks — each under bash in
 * the claim worktree of its repo (or the resource base when the item is not
 * claimed here), with its timeout. Prints name / exit code / pass or not /
 * HEAD commit per check; secret-looking env values are masked. Posts
 * nothing — GL-0358 stores the result.
 */

interface BriefItem {
  meta: { id: string; targets: string[] };
  claim?: { machine?: string; dead?: boolean; paths?: Record<string, string> } | null;
}
interface Brief {
  item: BriefItem;
  checks?: Check[];
  targets?: { resource: string; path?: string }[];
}

const api = <T>(method: string, path: string, body: unknown, home?: string) =>
  daemonApi(method, path, body, home) as Promise<T>;

const fmt = (r: CheckRun): string => {
  const at = r.commit ? ` @${r.commit.slice(0, 10)}` : "";
  if (r.error) return `${r.name}: not run — ${r.error}`;
  if (r.timed_out) return `${r.name}: timeout${at}`;
  if (r.passed) return `${r.name}: passed (exit ${r.exit_code})${at}`;
  return `${r.name}: not passed (exit ${r.exit_code}, want ${r.expect_exit})${at}`;
};

export async function verifyCmd(args: string[], home?: string): Promise<number> {
  const json = args.includes("--json");
  const id = args[0]?.toUpperCase();
  if (!id || id.startsWith("--")) {
    console.log("usage: te verify <ID> [--ws w] [--json]");
    return 4;
  }
  const wsi = args.indexOf("--ws");
  const ws = wsi === -1 ? "" : `?ws=${encodeURIComponent(args[wsi + 1])}`;
  try {
    const brief = await api<Brief>("GET", `/api/items/${id}${ws}`, undefined, home);
    const checks = brief.checks ?? [];
    if (checks.length === 0) {
      if (json) return console.log(JSON.stringify({ item: id, checks: [] }, null, 2)), 0;
      console.log(`${id}: no checks`);
      return 0;
    }
    const wsc = await api<{ root: string; machine: string }>(
      "GET", `/api/workspace${ws}`, undefined, home,
    );
    const lw = resolveWorkspace(wsc.root, { home });
    // resource → run dir: resource base, overridden by the claim worktree
    // only when the claim is live and on THIS machine — a foreign claim's
    // paths do not exist here
    const dirs: Record<string, string> = {};
    for (const [name, r] of lw.resources) if (r.path) dirs[name] = r.path;
    const claim = brief.item.claim;
    if (claim && !claim.dead && claim.machine === wsc.machine) {
      for (const [r, p] of Object.entries(claim.paths ?? {})) if (p) dirs[r] = p;
    }
    const first = brief.targets?.[0]?.resource;
    const default_dir = (first && dirs[first]) || wsc.root;
    const results = await runChecks({
      item_id: id,
      checks,
      dirs,
      default_dir,
      logsDir: join(teHome(home), "verify-logs"),
    });
    if (json) return console.log(JSON.stringify({ item: id, results }, null, 2)), results.every((r) => r.passed) ? 0 : 1;
    for (const r of results) console.log(fmt(r));
    const failed = results.filter((r) => !r.passed).length;
    console.log(`${id}: ${results.length - failed}/${results.length} checks passed`);
    return failed === 0 ? 0 : 1;
  } catch (e) {
    console.log(`verify ${id} failed: ${(e as Error).message}`);
    return 4;
  }
}
