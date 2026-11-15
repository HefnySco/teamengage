/**
 * Release records (DESIGN §15.3, GL-0332) — `.teamengage/releases/*.release.yaml`.
 * A release is a file kind, not an item: no status, no claim. The human cuts
 * one; it freezes the accepted items, their commits, and each item's feature.
 * `deploys` is a stored back-reference filled by ops jobs that name the
 * release in `params.release` — the release page joins job records for the
 * rest (playbook, target, machine, version).
 *
 * GL-0331 reads them for one thing: whether a release contains a set of item
 * ids, so a feature can derive `shipped`. A missing dir is just "nothing
 * shipped yet".
 */
import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";

export interface ReleaseItem {
  item: string;
  title: string;
  /** via the item's plan — absent when no ancestor epic names a feature */
  feature?: string;
  commits: { resource: string; sha: string }[];
}

export interface Release {
  id: string;
  cut: { ts: string; by: string };
  /** previous release this window opened after */
  since?: string;
  /** start point given at cut (ISO date resolved from a date or a commit) —
   * only items finished after it entered the window */
  from?: string;
  /** frozen at cut — never recomputed later */
  items: ReleaseItem[];
  /** job ids that deployed this release — appended by JobStore on success */
  deploys: string[];
}

export const RELEASE_NAME = /^[a-z0-9][a-z0-9.-]{1,60}$/i;

const dir = (plansDir: string) => join(plansDir, "releases");
const file = (plansDir: string, id: string) => join(dir(plansDir), `${id}.release.yaml`);

export async function listReleases(plansDir: string): Promise<Release[]> {
  let files: string[];
  try {
    files = (await readdir(dir(plansDir))).filter((f) => f.endsWith(".release.yaml"));
  } catch {
    return [];
  }
  const out: Release[] = [];
  for (const f of files.sort()) {
    const r = await loadReleaseFile(join(dir(plansDir), f));
    if (r) out.push(r);
  }
  return out;
}

async function loadReleaseFile(p: string): Promise<Release | undefined> {
  try {
    const d = YAML.parse(await readFile(p, "utf8")) as Release;
    if (!d || typeof d.id !== "string") return undefined;
    return {
      ...d,
      cut: d.cut ?? { ts: "", by: "" },
      items: (d.items ?? []).map((i) => ({
        ...i,
        // GL-0376: early records stored 'repo@sha' in sha — split on read so
        // old files display correctly
        commits: (i.commits ?? []).map((c) => {
          const at = c.sha?.lastIndexOf("@") ?? -1;
          if (at <= 0) return c;
          return {
            resource: c.resource === "unknown" ? c.sha.slice(0, at) : c.resource,
            sha: c.sha.slice(at + 1),
          };
        }),
      })),
      deploys: d.deploys ?? [],
    };
  } catch {
    return undefined; // an unreadable record is a validator finding, not a crash
  }
}

export async function loadRelease(plansDir: string, id: string): Promise<Release | undefined> {
  return loadReleaseFile(file(plansDir, id));
}

/** Write a release record; returns the plansDir-relative path (for commits). */
export async function saveRelease(plansDir: string, r: Release): Promise<string> {
  await mkdir(dir(plansDir), { recursive: true });
  const p = file(plansDir, r.id);
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, YAML.stringify(r));
  await rename(tmp, p);
  return join("releases", `${r.id}.release.yaml`);
}

/** A finished ops job naming this release records itself — deduped. */
export async function linkDeploy(plansDir: string, releaseId: string, jobId: string): Promise<void> {
  const r = await loadRelease(plansDir, releaseId);
  if (!r || r.deploys.includes(jobId)) return;
  await saveRelease(plansDir, { ...r, deploys: [...r.deploys, jobId] });
}

/** One set of frozen item ids per release file; `[]` when none exist. */
export async function releaseItemSets(plansDir: string): Promise<Set<string>[]> {
  return (await listReleases(plansDir)).map((r) => new Set(r.items.map((i) => i.item)));
}
