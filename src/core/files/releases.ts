/**
 * Release records (DESIGN §15.3, GL-0332) — `.teamengage/releases/*.release.yaml`.
 * GL-0331 reads them for one thing: whether a release contains a set of item
 * ids, so a feature can derive `shipped`. A missing dir is just "nothing
 * shipped yet".
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";

/** One set of frozen item ids per release file; `[]` when none exist. */
export async function releaseItemSets(plansDir: string): Promise<Set<string>[]> {
  let files: string[];
  try {
    files = (await readdir(join(plansDir, "releases"))).filter((f) => f.endsWith(".release.yaml"));
  } catch {
    return [];
  }
  const sets: Set<string>[] = [];
  for (const f of files.sort()) {
    try {
      const doc = YAML.parse(await readFile(join(plansDir, "releases", f), "utf8")) as {
        items?: Array<{ item?: string }>;
      };
      sets.push(new Set((doc?.items ?? []).map((i) => i.item).filter((x): x is string => Boolean(x))));
    } catch {
      /* an unreadable release file is a validator finding, not a crash */
    }
  }
  return sets;
}
