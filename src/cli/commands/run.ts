import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonApi, ensureDaemon } from "../client.js";
import { loadMachineConfig, teHome } from "../../core/config/config.js";
import { RunConfig, parseDuration } from "../../core/model/workspace.js";
import type { Tier } from "../../core/model/item.js";
import {
  agentName,
  parseDispatchFilter,
  pickNext,
  promptFor,
  type AdmissionContext,
  type DispatchFilter,
  type Mode,
  type Pick,
  type RunItem,
  type RunState,
} from "../../core/dispatch/selector.js";

export {
  agentName,
  parseDispatchFilter,
  pickNext,
  promptFor,
  type DispatchFilter,
  type Mode,
  type Pick,
  type RunItem,
  type RunState,
};

/**
 * `te run` — the foreman. Starts this machine's configured agent CLIs on
 * ready tasks, sends each submission to the reviewer, sends an `issues`
 * review back to a coder for a fix, and stops when only the human can move
 * things forward (questions, accepts, drafts). The agents still do every
 * state change themselves (hello → claim → submit / review) over the
 * daemon's plain-HTTP interface, so claims, target locks and evidence work
 * exactly as when the human starts a session by hand.
 *
 * `te wait` — block until something new needs the human.
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

const RUN_HELP = `te run — start agents on ready tasks until only you can move things forward

Configure the agents for this machine in ~/.teamengage/machine.yaml:

  run:
    coder: devin -p --model swe-2-high --permission-mode accept-edits --
    reviewer: claude -p "$TE_PROMPT" --model sonnet --permission-mode acceptEdits --allowedTools Bash Read Edit Write Glob Grep
    concurrency: 1      # agents at once
    fix_rounds: 1       # issues review → coder fixes, this many times

Each command gets the prompt as its last argument (or wherever it says
"$TE_PROMPT"; $TE_ITEM and $TE_MODE are set too), runs in the task folder,
and logs to ~/.teamengage/runs/<workspace>/.

options:
  --max <n>         start at most n new tasks
  --filter <expr>   restrict items (e.g. "SE-01xx:inreview, Plan PL-1032:ready, -SE-0105")
  --watch           keep going when idle (pick up tasks as you approve them)
  --dry-run         print what would start, start nothing
  --ws <name>       pick a workspace
`;

interface Workspace {
  name: string;
  root: string;
  machine: string;
  autonomy: string;
  max_attempts?: number;
  takeover_grace_after?: string;
  review_models?: { deep?: string; quick?: string; deep_from_tier: Tier };
}

/** The model id a command declares (`--model x` or `--model=x`). */
const commandModel = (cmd: string): string | undefined =>
  /(?:^|\s)--?model(?:=|\s+)(\S+)/.exec(cmd)?.[1];

async function board(
  args: string[],
  home?: string,
): Promise<{ items: RunItem[]; ready: string[]; live: Set<string> }> {
  const q = wsQ(args);
  const items = (await daemonApi("GET", `/api/items${q ? `?${q}` : ""}`, undefined, home)) as Array<
    RunItem & { findings?: unknown }
  >;
  // the API carries the findings array; RunItem wants its count (admission)
  for (const i of items) if (Array.isArray(i.findings)) i.findings = i.findings.length;
  const next = (await daemonApi("GET", `/api/next?limit=500${q ? `&${q}` : ""}`, undefined, home)) as Array<{
    meta: { id: string };
  }>;
  // live session ids feed admit()'s isLive — a claim whose holder session is
  // still up is never resumed or taken over
  const sessions = (await daemonApi("GET", `/api/sessions${q ? `?${q}` : ""}`, undefined, home)) as Array<{
    id: string;
  }>;
  return { items, ready: next.map((n) => n.meta.id), live: new Set(sessions.map((s) => s.id)) };
}

function lastLine(file: string): string {
  try {
    const lines = readFileSync(file, "utf8").trim().split("\n");
    return (lines[lines.length - 1] ?? "").slice(0, 200);
  } catch {
    return "";
  }
}

const stamp = () => new Date().toTimeString().slice(0, 8);

function loadRunConfig(home?: string): RunConfig {
  const m = loadMachineConfig(home);
  return RunConfig.parse(m.run ?? {});
}

export async function runCmd(args: string[], home?: string): Promise<number> {
  if (flag(args, "--help") || flag(args, "-h")) {
    process.stdout.write(RUN_HELP);
    return 0;
  }
  const cfg = loadRunConfig(home);
  if (!cfg.coder && !cfg.reviewer) {
    process.stderr.write("te run: no agents configured for this machine\n\n");
    process.stdout.write(RUN_HELP);
    return 2;
  }
  const dry = flag(args, "--dry-run");
  const watch = flag(args, "--watch");
  const maxTasks = opt(args, "--max") ? Number(opt(args, "--max")) : Infinity;
  const filterExpr = opt(args, "--filter") ?? "";
  let filter: DispatchFilter;
  try {
    filter = parseDispatchFilter(filterExpr);
  } catch (e) {
    process.stderr.write(`te run: ${(e as Error).message}\n`);
    return 2;
  }
  const { port } = await ensureDaemon(home);
  const base = `http://127.0.0.1:${port}`;
  const ws = (await daemonApi("GET", `/api/workspace?${wsQ(args)}`, undefined, home)) as Workspace;
  // the agents skip hello, so its sync check happens here: never start
  // work on plans another machine has moved past
  const hand = (await daemonApi("GET", `/api/handoff?${wsQ(args)}`, undefined, home)) as {
    behind: number;
    upstream?: string;
  };
  if (hand.behind > 0 && !dry) {
    process.stderr.write(`te run: plans are ${hand.behind} commit(s) behind ${hand.upstream} — run te sync first\n`);
    return 1;
  }
  const logDir = join(teHome(home), "runs", ws.name);
  mkdirSync(logDir, { recursive: true });

  const st: RunState = { running: new Map(), fixes: new Map(), tried: new Set(), started: 0 };
  const children = new Set<ChildProcess>();
  const say = (s: string) => process.stdout.write(`${stamp()} ${s}\n`);
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    say(`stopping — waiting for ${children.size} agent(s) to finish (Ctrl-C again to kill them)`);
    if (!children.size) process.exit(130);
  });

  say(`te run on ${ws.machine} · ${ws.name} · coder: ${cfg.coder ? agentName(cfg.coder) : "—"} · reviewer: ${cfg.reviewer ? agentName(cfg.reviewer) : "you"}`);

  const done: Array<Pick & { code: number | null; log: string }> = [];
  /** session ids this run minted — resume admits only these (TE-0228) */
  const minted = new Set<string>();
  /** cuts the idle poll short when an agent exits */
  let wake: (() => void) | undefined;
  /** Open the agent's session for it, so it ends when the agent's process does. */
  // label: this run works ONE item — hello adopts only that item's dead
  // claim (resume), never the machine's other dead claims of the agent name
  const hello = async (
    agent: string,
    item: string,
    adopt: boolean,
    role: "coder" | "reviewer",
  ): Promise<{ token: string; resume: string[]; sessionId?: string }> => {
    const res = await fetch(`${base}/agent/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent,
        role,
        label: item,
        adopt,
        ...(opt(args, "--ws") ? { workspace: opt(args, "--ws") } : {}),
      }),
    });
    const text = await res.text();
    const token = /^token (\S+)/m.exec(text)?.[1];
    if (!res.ok || !token) throw new Error(`hello failed: ${text.split("\n")[0]}`);
    const resume = /^resume: (.+)$/m.exec(text)?.[1].split(/,\s*/) ?? [];
    const sessionId = /^session (\S+)/m.exec(text)?.[1];
    if (sessionId) minted.add(sessionId);
    return { token, resume, sessionId };
  };
  const bye = (token: string) =>
    fetch(`${base}/agent/bye`, { method: "POST", headers: { "x-te-session": token } }).catch(() => {});
  /** TE-0228: report the spawned child's pid so the session's liveness follows it. */
  const attachPid = (token: string, pid: number) =>
    fetch(`${base}/agent/pid`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-te-session": token },
      body: JSON.stringify({ pid }),
    }).catch(() => {});

  const start = async (p: Pick, items: RunItem[]) => {
    const role: "coder" | "reviewer" = p.mode === "review" ? "reviewer" : "coder";
    const cmd = p.mode === "review" ? cfg.reviewer! : cfg.coder!;
    const name = agentName(cmd);
    const title = items.find((i) => i.id === p.id)?.title ?? "";
    if (dry) {
      say(`would ${p.mode} ${p.id} "${title}" with ${name}`);
      st.running.set(p.id, p.mode); // shows the first wave, up to concurrency
      if (p.mode === "work") st.started++;
      return;
    }
    const s = await hello(p.mode === "review" ? `${name}-review` : name, p.id, p.mode === "resume", role);
    if (p.mode === "resume" && !s.resume.includes(p.id)) {
      // its holder is still live (an interactive session of the same name?) — not ours to resume
      await bye(s.token);
      st.tried.add(p.id);
      return;
    }
    const prompt = promptFor(p.mode, p.id, name, base, s.token);
    const log = join(logDir, `${p.id}-${p.mode}-${Date.now()}.log`);
    const out = createWriteStream(log);
    const script = cmd.includes("TE_PROMPT") ? cmd : `${cmd} "$TE_PROMPT"`;
    const child = spawn("bash", ["-c", script], {
      cwd: ws.root,
      env: {
        ...process.env,
        TE_PROMPT: prompt,
        TE_ITEM: p.id,
        TE_MODE: p.mode,
        TE_SESSION: s.token,
        TE_ROLE: role,
        TE_WS: ws.name,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
    if (child.pid) void attachPid(s.token, child.pid);
    children.add(child);
    st.running.set(p.id, p.mode);
    if (p.mode === "work") {
      st.started++;
      st.pendingClaim = p.id;
    }
    if (p.mode === "fix") st.fixes.set(p.id, (st.fixes.get(p.id) ?? 0) + 1);
    say(`▶ ${p.mode} ${p.id} "${title}" — ${name}`);
    child.on("exit", (code) => {
      // the session ends with the process: its claims become rebindable,
      // and an issues review on them releases instead of stranding
      void bye(s.token).then(() => {
        children.delete(child);
        st.running.delete(p.id);
        if (st.pendingClaim === p.id) st.pendingClaim = undefined;
        done.push({ ...p, code, log });
        wake?.();
      });
    });
  };

  for (;;) {
    const { items, ready, live } = await board(args, home);
    const byId = new Map(items.map((i) => [i.id, i]));
    // a started coder has claimed (or moved the item on) — the next may start
    if (st.pendingClaim && byId.get(st.pendingClaim)?.claim) st.pendingClaim = undefined;
    for (const d of done.splice(0)) {
      const now = byId.get(d.id);
      const line = lastLine(d.log);
      say(`■ ${d.mode} ${d.id} → ${now?.status ?? "?"}${now?.ai_review && d.mode === "review" ? ` (${now.ai_review.verdict})` : ""}${d.code ? ` · exit ${d.code}, log ${d.log}` : ""}${line ? ` · ${line}` : ""}`);
      if (d.mode !== "review" && (now?.status === "ready" || now?.status === "in_progress")) st.tried.add(d.id);
    }
    // TE-0228: the same admission gates the dispatcher enforces — rebuilt
    // per tick so attempts, blocks, liveness and minted sessions stay fresh
    const admission: AdmissionContext = {
      machine: ws.machine,
      now: Date.now(),
      maxAttempts: ws.max_attempts ?? 5,
      fixRounds: cfg.fix_rounds,
      fixes: st.fixes,
      coderNames: cfg.coder ? [agentName(cfg.coder)] : [],
      mintedSessions: minted,
      isLive: (id) => live.has(id),
      takeoverGraceMs: parseDuration(ws.takeover_grace_after ?? "15m"),
      reviewModels: ws.review_models,
      reviewerModels: cfg.reviewer ? [commandModel(cfg.reviewer)] : [],
      excludeDomains: cfg.exclude_domains,
    };
    let p: Pick | undefined;
    while (!stopping && (p = pickNext(cfg, st, items, ready, ws.machine, maxTasks, undefined, filter, admission))) {
      await start(p, items);
      if (dry) continue;
      if (p.mode === "work") break; // let it claim before choosing the next (target locks)
    }
    if (dry) return 0;
    if (!st.running.size && !watch) break;
    if (stopping && !st.running.size) break;
    await new Promise<void>((r) => {
      const t = setTimeout(r, 5_000);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });
    wake = undefined;
  }

  // what's left is the human's
  const { items } = await board(args, home);
  const needs = items.filter((i) => i.status === "waiting" || i.status === "in_review" || i.status === "draft");
  if (!needs.length) {
    say("nothing needs you — board is clear");
    return 0;
  }
  say("needs you:");
  for (const i of needs) {
    const why =
      i.status === "waiting"
        ? `question: ${i.question?.text ?? ""}  → te answer ${i.id} "…"`
        : i.status === "draft"
          ? "draft  → te approve"
          : i.ai_review?.verdict === "ok"
            ? i.ai_review.needs_human
              ? `review ok — the reviewer asks for your call  → te accept / te reject`
              : `review ok${ws.autonomy === "solo" ? " (auto-accepts soon)" : ""}  → te accept`
            : i.ai_review?.verdict === "issues"
              ? `review issues: ${i.ai_review.summary ?? ""}  → decide: te accept / te reject`
              : "submitted  → te accept / te reject";
    process.stdout.write(`  ${i.id} "${i.title}" — ${why}\n`);
  }
  return 0;
}

// ---- te wait ---------------------------------------------------------------

interface Inbox {
  drafts: string[];
  questions: Array<{ id: string; question?: { text: string } }>;
  reviews: string[];
  claims: Array<{ item: string }>;
  drop_flags: Array<{ id: string }>;
}

/** Inbox → stable "kind:id" keys with a human line each. */
export function inboxEntries(i: Inbox): Map<string, string> {
  const m = new Map<string, string>();
  for (const q of i.questions) m.set(`q:${q.id}`, `${q.id} asks: ${q.question?.text ?? ""}`);
  for (const id of i.reviews) m.set(`r:${id}`, `${id} submitted for review`);
  for (const c of i.claims) m.set(`c:${c.item}`, `${c.item} has a claim conflict`);
  for (const d of i.drop_flags) m.set(`f:${d.id}`, `${d.id} flagged for drop`);
  for (const id of i.drafts) m.set(`d:${id}`, `${id} draft waits for approve`);
  return m;
}

/**
 * `te wait [--any] [--notify] [--timeout 2h]` — block until something new
 * lands in the human's inbox (or, with --any, until it is non-empty), print
 * it, exit 0. Exit 1 on timeout. Use: `te wait --notify && te status`.
 */
export async function waitCmd(args: string[], home?: string): Promise<number> {
  const timeout = opt(args, "--timeout");
  const { parseDuration } = await import("../../core/model/workspace.js");
  const deadline = timeout ? Date.now() + parseDuration(timeout) : Infinity;
  const read = async () => inboxEntries((await daemonApi("GET", `/api/inbox?${wsQ(args)}`, undefined, home)) as Inbox);
  const seen = flag(args, "--any") ? new Map<string, string>() : await read();
  for (;;) {
    const now = await read();
    const fresh = [...now].filter(([k]) => !seen.has(k));
    if (fresh.length) {
      for (const [, line] of fresh) process.stdout.write(`${line}\n`);
      if (flag(args, "--notify")) {
        spawn("notify-send", ["TeamEngage", fresh.map(([, l]) => l).join("\n")], { stdio: "ignore", detached: true, windowsHide: true })
          .on("error", () => {})
          .unref();
      }
      return 0;
    }
    // something cleared — forget it, so it counts as new if it comes back
    for (const k of [...seen.keys()]) if (!now.has(k)) seen.delete(k);
    if (Date.now() > deadline) return 1;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
