import { daemonApi } from "../client.js";
import { planOriginBackfill, type BackfillPlan } from "../../core/origin/backfill.js";
import type { ItemMeta } from "../../core/model/item.js";

type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

const wsArg = (args: string[]) => {
  const i = args.indexOf("--ws");
  return i !== -1 && args[i + 1] ? `ws=${encodeURIComponent(args[i + 1])}` : "";
};

function table(plan: BackfillPlan, apply: boolean): string {
  const out: string[] = [];
  out.push(`${apply ? "applied" : "dry run"}: ${plan.candidates.length} problem item(s) with depends_on and no found_by`);
  for (const r of plan.candidates) {
    out.push(
      [r.id, r.status, `found_by <- ${r.move.join(",") || "-"}`, `keeps ${r.keep.join(",") || "-"}`, r.title.slice(0, 60)].join("\t"),
    );
  }
  out.push("");
  out.push(`${plan.unlinked.length} problem item(s) with no link at all (the human sets found_by):`);
  for (const r of plan.unlinked) out.push([r.id, r.status, r.title.slice(0, 60)].join("\t"));
  return out.join("\n") + "\n";
}

/**
 * Core of `te origin-backfill`. `api` is injected so a test can run it on a
 * temp copy of a bank. Returns [exit code, text].
 */
export async function runOriginBackfill(
  args: string[],
  api: Api,
  env: Record<string, string | undefined>,
): Promise<[number, string]> {
  const apply = args.includes("--apply");
  // An agent session never applies. te run and the agent protocol set TE_SESSION.
  if (apply && env.TE_SESSION) {
    return [1, "FORBIDDEN: origin-backfill --apply is for the human. An agent session may not run it.\n"];
  }
  const ki = args.indexOf("--keep");
  const keep = ki !== -1 && args[ki + 1] ? args[ki + 1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const q = wsArg(args);
  const items = (await api("GET", `/api/items?archived=all${q ? `&${q}` : ""}`)) as ItemMeta[];
  const plan = planOriginBackfill(items, keep);
  if (apply) {
    for (const r of plan.candidates) {
      if (!r.move.length) continue;
      // found_by first: if the second call fails, no link is lost
      await api("POST", `/api/items/${r.id}/found-by${q ? `?${q}` : ""}`, { found_by: r.move });
      await api("POST", `/api/items/${r.id}/deps${q ? `?${q}` : ""}`, { depends_on: r.keep });
    }
  }
  return [0, table(plan, apply)];
}

/**
 * `te origin-backfill [--apply] [--keep ID,ID]` — move old origin links from
 * depends_on to found_by on problem items. Dry run by default.
 */
export async function originBackfillCmd(args: string[], home?: string): Promise<number> {
  const [code, text] = await runOriginBackfill(
    args,
    (m, p, b) => daemonApi(m, p, b, home),
    process.env,
  );
  (code ? process.stderr : process.stdout).write(text);
  return code;
}
