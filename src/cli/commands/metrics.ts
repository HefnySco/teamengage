import { daemonApi } from "../client.js";

/**
 * `te metrics` — derived scorecards from the event log (GL-0317): agent
 * table, tier and domain roll-ups, or one plan's parts with --plan.
 */

const flag = (args: string[], n: string) => args.includes(n);
const opt = (args: string[], n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const wsQ = (args: string[]) => {
  const w = opt(args, "--ws");
  return w ? `ws=${encodeURIComponent(w)}` : "";
};

function fmtMs(ms?: number): string {
  if (ms === undefined) return "-";
  const m = ms / 60000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
const pct = (x?: number) => (x === undefined ? "-" : `${Math.round(x * 100)}%`);

interface Rollup {
  items: number;
  done: number;
  claims: number;
  review_rounds: number;
  bounces: number;
  handoffs: number;
  rejects: number;
  bounce_rate?: number;
  median_claim_to_submit_ms?: number;
  median_submit_to_accept_ms?: number;
  median_claim_to_accept_ms?: number;
  tokens_in: number;
  tokens_out: number;
  usd: number;
}
interface Group extends Rollup {
  key: string;
}
interface Part {
  id: string;
  title: string;
  status: string;
  tier: string;
  domains: string[];
  metrics: {
    review_rounds: number;
    bounces: number;
    handoffs: number;
    done: number;
    worker?: string;
    claim_to_submit_ms: number[];
    submit_to_accept_ms: number[];
    tokens_in: number;
    tokens_out: number;
    usd: number;
  } | null;
}
interface MetricsResponse {
  totals: Rollup;
  agents?: Group[];
  tiers?: Group[];
  domains?: Group[];
  plan?: string;
  parts?: Part[];
}

function table(head: string[], rows: string[][]) {
  const w = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const fmt = (r: string[]) =>
    r
      .map((v, c) => v.padEnd(w[c]))
      .join("  ")
      .trimEnd();
  process.stdout.write(fmt(head) + "\n");
  for (const r of rows) process.stdout.write(fmt(r) + "\n");
}

const tok = (n?: number) => {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
};
const usd = (n?: number) => (!n ? "-" : `$${n < 1 ? n.toFixed(4).replace(/0+$/, "") : n.toFixed(2)}`);

const hasCost = (gs: { tokens_in?: number; tokens_out?: number; usd?: number }[]) =>
  gs.some((g) => (g.tokens_in ?? 0) + (g.tokens_out ?? 0) + (g.usd ?? 0) > 0);

// cost columns appear only when some row actually reported cost (GL-0318)
const groupTable = (label: string, gs: Group[]) => {
  const cost = hasCost(gs);
  const head = [label, "items", "done", "claim→accept", "bounce%"];
  if (cost) head.push("tok in/out", "usd");
  const rows = gs.map((g) => {
    const r = [
      g.key,
      String(g.items),
      String(g.done),
      fmtMs(g.median_claim_to_accept_ms),
      pct(g.bounce_rate),
    ];
    if (cost) r.push(`${tok(g.tokens_in)}/${tok(g.tokens_out)}`, usd(g.usd));
    return r;
  });
  table(head, rows);
};

export async function metricsCmd(args: string[], home?: string): Promise<number> {
  const plan = opt(args, "--plan");
  const q = [wsQ(args), plan ? `plan=${encodeURIComponent(plan.toUpperCase())}` : ""]
    .filter(Boolean)
    .join("&");
  const data = (await daemonApi(
    "GET",
    `/api/metrics${q ? `?${q}` : ""}`,
    undefined,
    home,
  )) as MetricsResponse;
  if (flag(args, "--json")) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }

  if (data.plan) {
    const t = data.totals;
    process.stdout.write(
      `${data.plan}: ${t.items} items, ${t.done} done, ${t.review_rounds} review rounds, ` +
        `${t.bounces} bounces, ${t.handoffs} handoffs — med claim→submit ${fmtMs(t.median_claim_to_submit_ms)}, ` +
        `submit→accept ${fmtMs(t.median_submit_to_accept_ms)}\n\n`,
    );
    const parts = data.parts ?? [];
    const cost = parts.some(
      (p) => (p.metrics?.tokens_in ?? 0) + (p.metrics?.tokens_out ?? 0) > 0,
    );
    const head = ["part", "status", "title", "rounds", "bounces", "worker"];
    if (cost) head.push("tok in/out");
    const rows = parts.map((p) => {
      const r = [
        p.id,
        p.status,
        p.title,
        String(p.metrics?.review_rounds ?? 0),
        String(p.metrics?.bounces ?? 0),
        p.metrics?.worker ?? "-",
      ];
      if (cost) r.push(`${tok(p.metrics?.tokens_in)}/${tok(p.metrics?.tokens_out)}`);
      return r;
    });
    table(head, rows);
    return 0;
  }

  const t = data.totals;
  process.stdout.write(
    `${t.items} items with events — ${t.done} done, ${t.review_rounds} review rounds, ` +
      `${t.bounces} bounces, ${t.handoffs} handoffs\n\n`,
  );
  const agents = data.agents ?? [];
  if (agents.length) {
    process.stdout.write("agents\n");
    groupTable("agent", agents);
    process.stdout.write("\n");
  }
  const tiers = data.tiers ?? [];
  if (tiers.length) {
    process.stdout.write("tiers\n");
    groupTable("tier", tiers);
    process.stdout.write("\n");
  }
  const domains = (data.domains ?? []).filter((g) => g.items > 0);
  if (domains.length) {
    process.stdout.write("domains\n");
    groupTable("domain", domains);
  }
  return 0;
}
