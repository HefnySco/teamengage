import { daemonApi } from "../client.js";

/** Read commands (CL-0001): ls, show, graph, validate, status, inbox. */

const flag = (args: string[], n: string) => args.includes(n);
const opt = (args: string[], n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};

const wsQ = (args: string[]) => {
  const w = opt(args, "--ws");
  return w ? `ws=${encodeURIComponent(w)}` : "";
};

interface ItemRow {
  id: string;
  status: string;
  title: string;
  ready?: boolean;
  blocked?: boolean;
  claim?: { holder: string } | null;
}

const row = (i: ItemRow) => {
  const flags = [i.claim ? `held:${i.claim.holder}` : "", i.blocked ? "blocked" : i.ready ? "ready" : ""]
    .filter(Boolean)
    .join(" ");
  return `${i.id} ${i.status} "${i.title}"${flags ? `  ${flags}` : ""}`;
};

export async function lsCmd(args: string[], home?: string): Promise<number> {
  const q = [
    wsQ(args),
    opt(args, "--status") ? `status=${opt(args, "--status")}` : "",
    opt(args, "--project") ? `project=${opt(args, "--project")}` : "",
    opt(args, "--text") ? `text=${encodeURIComponent(opt(args, "--text")!)}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const items = (await daemonApi("GET", `/api/items${q ? `?${q}` : ""}`, undefined, home)) as ItemRow[];
  if (flag(args, "--json")) {
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return 0;
  }
  for (const i of items) process.stdout.write(row(i) + "\n");
  return 0;
}

export async function showCmd(args: string[], home?: string): Promise<number> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) {
    process.stderr.write("usage: te show <ID>\n");
    return 2;
  }
  const b = (await daemonApi(
    "GET",
    `/api/items/${encodeURIComponent(id)}?${wsQ(args)}`,
    undefined,
    home,
  )) as {
    item: { meta: Record<string, unknown>; sections: { heading: string; body: string }[] };
    deps: Array<{ ref: string; status: string; outcome: string }>;
    decisions: Array<{ meta: { id: string; title: string } }>;
    targets: Array<{ ref: string; kind: string; path?: string }>;
    source?: { path: string; text?: string; moved?: boolean; missing?: boolean };
  };
  if (flag(args, "--json")) {
    process.stdout.write(JSON.stringify(b, null, 2) + "\n");
    return 0;
  }
  const m = b.item.meta;
  process.stdout.write(`${m.id} ${m.status} "${m.title}" v${m.version}\n`);
  if (b.source) {
    const note = b.source.missing ? " (MISSING)" : b.source.moved ? " (moved)" : "";
    process.stdout.write(`source: ${b.source.path}${note}\n`);
    if (b.source.text) process.stdout.write(`\n${b.source.text.trimEnd()}\n`);
  }
  for (const s of b.item.sections) {
    if (s.body.trim()) process.stdout.write(`\n## ${s.heading}\n${s.body.trimEnd()}\n`);
  }
  for (const d of b.deps) process.stdout.write(`dep ${d.ref} ${d.status}\n`);
  for (const d of b.decisions) process.stdout.write(`decision ${d.meta.id}: ${d.meta.title}\n`);
  for (const t of b.targets) process.stdout.write(`target ${t.ref} → ${t.kind}${t.path ? ` ${t.path}` : ""}\n`);
  return 0;
}

export async function graphCmd(args: string[], home?: string): Promise<number> {
  const q = [
    wsQ(args),
    opt(args, "--root") ? `root=${opt(args, "--root")}` : "",
    opt(args, "--depth") ? `depth=${opt(args, "--depth")}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const r = (await daemonApi("GET", `/api/graph${q ? `?${q}` : ""}`, undefined, home)) as {
    mermaid: string;
  };
  process.stdout.write(r.mermaid + "\n");
  return 0;
}

export async function validateCmd(args: string[], home?: string): Promise<number> {
  const findings = (await daemonApi(
    "GET",
    `/api/findings?${wsQ(args)}`,
    undefined,
    home,
  )) as Array<{ severity: string; item?: string; path?: string; message: string }>;
  if (flag(args, "--json")) {
    process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
    return findings.some((f) => f.severity === "error") ? 1 : 0;
  }
  for (const f of findings) {
    process.stdout.write(`${f.severity} ${f.item ?? f.path ?? ""} ${f.message}\n`);
  }
  if (!findings.length) process.stdout.write("no findings\n");
  return findings.some((f) => f.severity === "error") ? 1 : 0;
}

export async function syncCmd(args: string[], home?: string): Promise<number> {
  const s = (await daemonApi("GET", `/api/sync?${wsQ(args)}`, undefined, home)) as {
    repo: { remote: boolean; ahead: number; behind: number; upstream?: string };
    unsyncedClaims: string[];
    notPushed: Array<{ item: string; resource: string; merge_commit: string }>;
    pushed: Array<{ item: string; resource: string; remotes: string[] }>;
  };
  if (flag(args, "--json")) {
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    return 0;
  }
  if (!s.repo.remote) {
    process.stdout.write("plans repo has no remote (sync is manual file/git ops)\n");
  } else {
    process.stdout.write(`plans repo: ${s.repo.ahead} ahead, ${s.repo.behind} behind ${s.repo.upstream ?? "?"}\n`);
  }
  if (s.unsyncedClaims.length) process.stdout.write(`unsynced claims: ${s.unsyncedClaims.join(", ")}\n`);
  for (const d of s.notPushed) {
    process.stdout.write(`not pushed: ${d.item} ${d.resource} ${d.merge_commit.slice(0, 12)}\n`);
  }
  for (const d of s.pushed) {
    process.stdout.write(`pushed: ${d.item} ${d.resource} → ${d.remotes.join(", ")}\n`);
  }
  return 0;
}

export async function statusCmd(args: string[], home?: string): Promise<number> {
  const inbox = await daemonApi("GET", `/api/inbox?${wsQ(args)}`, undefined, home);
  if (flag(args, "--json")) {
    process.stdout.write(JSON.stringify(inbox, null, 2) + "\n");
    return 0;
  }
  const i = inbox as {
    drafts: string[];
    questions: Array<{ id: string; question?: { text: string } }>;
    reviews: string[];
    claims: Array<{ item: string }>;
    findings: Array<{ severity: string }>;
  };
  process.stdout.write(
    [
      `drafts: ${i.drafts.join(", ") || "-"}`,
      `questions: ${i.questions.map((q) => q.id).join(", ") || "-"}`,
      `reviews: ${i.reviews.join(", ") || "-"}`,
      `conflicted claims: ${i.claims.map((c) => c.item).join(", ") || "-"}`,
      `findings: ${i.findings.length}`,
    ].join("\n") + "\n",
  );
  return 0;
}
