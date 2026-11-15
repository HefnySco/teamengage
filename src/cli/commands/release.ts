import { daemonApi } from "../client.js";

/**
 * `te releases` (GL-0332, DESIGN §15.3–15.5) — the release record the human
 * cuts: `cut` freezes the accepted tasks since the last release with their
 * commits, `notes` prints them in STE grouped by feature, `list` shows all.
 * Agents have no route — the human-only API refuses them.
 */

const opt = (args: string[], n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};

const ws = (args: string[]) => {
  const w = opt(args, "--ws");
  return w ? `?ws=${encodeURIComponent(w)}` : "";
};

interface ReleaseRow {
  id: string;
  cut: { ts: string; by: string };
  since?: string;
  from?: string;
  items: number;
  deploys: number;
}

interface ReleaseFull {
  id: string;
  cut: { ts: string; by: string };
  since?: string;
  from?: string;
  items: { item: string; title: string; feature?: string; commits: { resource: string; sha: string }[] }[];
  deploys: { job: string; playbook?: string; target?: string; machine?: string; status: string; version?: string }[];
}

export async function releasesCmd(args: string[], home?: string): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const rels = (await daemonApi("GET", `/api/releases${ws(args)}`, undefined, home)) as ReleaseRow[];
    if (!rels.length) return console.log("no releases — cut one with: te releases cut <name>"), 0;
    for (const r of rels)
      console.log(
        `${r.id}  cut ${r.cut.ts.slice(0, 16).replace("T", " ")} by ${r.cut.by}  ${r.items} item(s)  ${r.deploys} deploy(s)${r.since ? `  since ${r.since}` : ""}${r.from ? `  after ${r.from.slice(0, 10)}` : ""}`,
      );
    return 0;
  }
  if (sub === "cut") {
    const name = args[1];
    if (!name || name.startsWith("--")) return console.log("usage: te releases cut <name> [--from <date|repo@sha>]"), 4;
    const from = opt(args, "--from");
    const r = (await daemonApi("POST", `/api/releases${ws(args)}`, { name, ...(from ? { from } : {}) }, home)) as ReleaseFull;
    console.log(`release ${r.id} cut — ${r.items.length} item(s)${r.since ? ` since ${r.since}` : ""}${r.from ? ` after ${r.from.slice(0, 10)}` : ""}`);
    for (const i of r.items)
      console.log(
        `  ${i.item}  ${i.title}${i.feature ? `  [${i.feature}]` : ""}${i.commits.length ? `  ${i.commits.map((c) => c.sha.slice(0, 8)).join(",")}` : ""}`,
      );
    return 0;
  }
  if (sub === "notes") {
    const name = args[1];
    if (!name || name.startsWith("--")) return console.log("usage: te releases notes <name>"), 4;
    const r = (await daemonApi("GET", `/api/releases/${encodeURIComponent(name)}${ws(args)}`, undefined, home)) as ReleaseFull;
    // group by feature — feature titles resolved over the items list
    const feats = (await daemonApi("GET", `/api/items?type=feature${ws(args) ? ws(args) + "&" : "?"}`, undefined, home)) as { id: string; title: string }[];
    const title = new Map(feats.map((f) => [f.id, f.title]));
    const groups = new Map<string, { item: string; title: string }[]>();
    for (const i of r.items) {
      const g = i.feature ?? "";
      groups.set(g, [...(groups.get(g) ?? []), i]);
    }
    console.log(`# ${r.id} — cut ${r.cut.ts.slice(0, 10)} by ${r.cut.by}`);
    for (const [f, items] of [...groups.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))) {
      console.log(`\n## ${f ? `${title.get(f) ?? f} (${f})` : "other"}`);
      for (const i of items) console.log(`- ${i.item} ${i.title}`);
    }
    return 0;
  }
  if (sub === "delete") {
    const name = args[1];
    if (!name || name.startsWith("--")) return console.log("usage: te releases delete <name>"), 4;
    await daemonApi("DELETE", `/api/releases/${encodeURIComponent(name)}${ws(args)}`, undefined, home);
    console.log(`release ${name} deleted`);
    return 0;
  }
  console.log("usage: te releases [list|cut <name> [--from d]|notes <name>|delete <name>] [--ws w]");
  return 4;
}
