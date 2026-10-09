import { daemonApi } from "../client.js";

/**
 * Domain commands:
 *   te domains [--json]                       list with counts
 *   te domains suggest [--apply] [--json]     keyword suggestions (adds only)
 *   te domain add <name> [description…] [--color c] [--keywords a,b]
 *   te domain rename <old> <new>              (merge when <new> exists)
 *   te domain rm <name>
 *   te tag <ID> name… [-name…]                add (name) / remove (-name)
 */

const opt = (args: string[], n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const positional = (args: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (!["--json", "--apply"].includes(args[i])) i++;
    } else out.push(args[i]);
  }
  return out;
};
const wsQ = (args: string[], sep = "?") => {
  const w = opt(args, "--ws");
  return w ? `${sep}ws=${encodeURIComponent(w)}` : "";
};

interface DomainRow {
  name: string;
  description?: string;
  keywords: string[];
  count: number;
  open: number;
  archived: number;
}

export async function domainsCmd(args: string[], home?: string): Promise<number> {
  if (args[0] === "suggest") {
    const rest = args.slice(1);
    if (rest.includes("--apply")) {
      const r = (await daemonApi("POST", `/api/domains/suggest/apply${wsQ(rest)}`, {}, home)) as { items: number; added: number };
      process.stdout.write(`added ${r.added} domain tag(s) on ${r.items} item(s)\n`);
      return 0;
    }
    const s = (await daemonApi("GET", `/api/domains/suggest${wsQ(rest)}`, undefined, home)) as Array<{
      id: string;
      title: string;
      current: string[];
      add: string[];
    }>;
    if (rest.includes("--json")) {
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
      return 0;
    }
    const per = new Map<string, number>();
    for (const x of s) for (const d of x.add) per.set(d, (per.get(d) ?? 0) + 1);
    for (const x of s) process.stdout.write(`${x.id} +${x.add.join(" +")}  ${x.title}\n`);
    process.stdout.write(
      `\n${s.length} item(s) would get tags: ${[...per].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n}`).join(", ") || "none"}\n` +
        "te domains suggest --apply adds them (never removes)\n",
    );
    return 0;
  }
  const rows = (await daemonApi("GET", `/api/domains${wsQ(args)}`, undefined, home)) as DomainRow[];
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  if (!rows.length) process.stdout.write("no domains yet — te domain add <name>, or tag an item: te tag <ID> <name>\n");
  for (const r of rows) {
    process.stdout.write(
      `${r.name.padEnd(18)} ${String(r.count).padStart(4)} items  ${String(r.open).padStart(4)} open` +
        `${r.description ? `  ${r.description}` : ""}\n`,
    );
  }
  return 0;
}

export async function domainCmd(args: string[], home?: string): Promise<number> {
  const [sub, ...rest] = args;
  const pos = positional(rest);
  const usage = () => {
    process.stderr.write(
      "usage: te domain add <name> [description] [--color c] [--keywords a,b]\n" +
        "       te domain rename <old> <new>   (merges when <new> exists)\n" +
        "       te domain rm <name>\n",
    );
    return 2;
  };
  if (sub === "add" && pos[0]) {
    const r = (await daemonApi(
      "POST",
      `/api/domains${wsQ(rest)}`,
      {
        name: pos[0],
        description: pos.slice(1).join(" ") || undefined,
        color: opt(rest, "--color"),
        keywords: opt(rest, "--keywords")?.split(","),
      },
      home,
    )) as { name: string };
    process.stdout.write(`domain ${r.name} saved\n`);
    return 0;
  }
  if (sub === "rename" && pos[0] && pos[1]) {
    const r = (await daemonApi(
      "POST",
      `/api/domains/${encodeURIComponent(pos[0])}/rename${wsQ(rest)}`,
      { to: pos[1] },
      home,
    )) as { items: string[]; merged: boolean };
    process.stdout.write(`${pos[0]} ${r.merged ? "merged into" : "renamed to"} ${pos[1]} on ${r.items.length} item(s)\n`);
    return 0;
  }
  if ((sub === "rm" || sub === "delete") && pos[0]) {
    const r = (await daemonApi("POST", `/api/domains/${encodeURIComponent(pos[0])}/delete${wsQ(rest)}`, {}, home)) as {
      items: string[];
    };
    process.stdout.write(`domain ${pos[0]} deleted (removed from ${r.items.length} item(s))\n`);
    return 0;
  }
  return usage();
}

/** `te tag <ID> a b -c` — add a and b, remove c. */
export async function tagCmd(args: string[], home?: string): Promise<number> {
  const [id, ...names] = positional(args);
  if (!id || !names.length) {
    process.stderr.write("usage: te tag <ID> name… [-name…]   (add / remove domains)\n");
    return 2;
  }
  const item = (await daemonApi("GET", `/api/items/${encodeURIComponent(id.toUpperCase())}${wsQ(args)}`, undefined, home)) as {
    item: { meta: { domains?: string[] } };
  };
  const cur = new Set(item.item.meta.domains ?? []);
  for (const n of names) {
    if (n.startsWith("-")) cur.delete(n.slice(1).toLowerCase());
    else cur.add(n.replace(/^\+/, ""));
  }
  const r = (await daemonApi(
    "POST",
    `/api/items/${encodeURIComponent(id.toUpperCase())}/domains${wsQ(args)}`,
    { domains: [...cur] },
    home,
  )) as { domains: string[]; added: string[] };
  process.stdout.write(
    `${id.toUpperCase()} domains: ${r.domains.map((d) => `#${d}`).join(" ") || "(none)"}` +
      `${r.added.length ? `  (new: ${r.added.join(", ")})` : ""}\n`,
  );
  return 0;
}
