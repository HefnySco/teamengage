import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonApi, ensureDaemon } from "../client.js";
import { loadMachineConfig, teHome } from "../../core/config/config.js";
import { RunConfig } from "../../core/model/workspace.js";

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

export type Mode = "work" | "fix" | "resume" | "review";

export interface RunItem {
  id: string;
  status: string;
  title: string;
  claim?: { holder: string; machine: string } | null;
  ai_review?: { verdict: "ok" | "issues"; summary?: string; note?: string };
  question?: { text: string };
}

export interface RunState {
  /** items an agent is working on right now */
  running: Map<string, Mode>;
  /** fix rounds already spent per item in this run */
  fixes: Map<string, number>;
  /** items whose coder ended without the item moving — not retried this run */
  tried: Set<string>;
  /** a coder was started and has not claimed yet — wait before the next one (target locks) */
  pendingClaim?: string;
  started: number;
}

export interface Pick {
  id: string;
  mode: Mode;
}

/**
 * What to start next, given the board. Pure — `te run`'s whole policy:
 * reviews first (they unblock the human), then fixes, then new work.
 */
export function pickNext(
  cfg: RunConfig,
  st: RunState,
  items: RunItem[],
  ready: string[],
  machine: string,
  maxTasks = Infinity,
  coderName = cfg.coder ? agentName(cfg.coder) : "",
): Pick | undefined {
  if (st.running.size >= cfg.concurrency) return undefined;
  const free = (id: string) => !st.running.has(id);
  const here = (i: RunItem) => i.claim?.machine === machine; // the branch is on this machine
  if (cfg.reviewer) {
    const r = items.find((i) => i.status === "in_review" && !i.ai_review && here(i) && free(i.id));
    if (r) return { id: r.id, mode: "review" };
  }
  if (!cfg.coder) return undefined;
  const f = items.find(
    (i) =>
      i.status === "in_review" &&
      i.ai_review?.verdict === "issues" &&
      here(i) &&
      free(i.id) &&
      (st.fixes.get(i.id) ?? 0) < cfg.fix_rounds,
  );
  if (f) return { id: f.id, mode: "fix" };
  // a coder of ours stopped mid-task (asked and the human answered, or it
  // died): start it again on the same claim — hello rebinds a dead session's claims
  const prefix = `${coderName}@${machine}#`;
  const r = items.find(
    (i) => i.status === "in_progress" && i.claim?.holder.startsWith(prefix) && free(i.id) && !st.tried.has(i.id),
  );
  if (r) return { id: r.id, mode: "resume" };
  if (st.pendingClaim || st.started >= maxTasks) return undefined;
  const w = ready.find((id) => free(id) && !st.tried.has(id));
  return w ? { id: w, mode: "work" } : undefined;
}

export function agentName(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? "agent";
  const base = (first.split("/").pop() ?? "agent").replace(/\.[A-Za-z0-9]+$/, "");
  return base.replace(/[^A-Za-z0-9_-]/g, "") || "agent";
}

export function promptFor(mode: Mode, id: string, name: string, base: string, token?: string): string {
  const session = token
    ? `You are already registered — do NOT call hello; send the header "X-TE-Session: ${token}" on every call.`
    : `Say hello as {"agent":"${name}${mode === "review" ? "-review" : ""}"}.`;
  const common =
    `The TeamEngage daemon is at ${base}/agent (plain HTTP; GET it once for the protocol). ` +
    `Never edit .teamengage/ files or te: lines, never git push, never approve or accept — the human does.`;
  if (mode === "review") {
    return (
      `Use the te-review skill to review ${id}. ${session} You did not write this code. ` +
      `Check every acceptance item of ${id} against its branch diff and run its tests. ` +
      `Record review ok, or review issues with one sentence naming the failed acceptance item and a note a coder can act on. ` +
      `${common}\nFinal reply: exactly one line — "${id} ok" or "${id} issues: <summary>".`
    );
  }
  const how =
    mode === "fix"
      ? `${id} is in review with an issues verdict: claim it (takeover), read ## Review, fix exactly that, and submit again. `
      : mode === "resume"
        ? `You already hold ${id} (do not claim it again). Read brief ${id} — the human may have answered your question (decisions) — and continue from the work already on its branch in the worktree, then submit. `
        : `If brief shows a ## Review or ## Handoff from an earlier attempt, read it first — that is what to fix. `;
  return (
    `Use the te-work skill to implement ${id}. ${session} ${how}` +
    `Do only this task, within its Touches and acceptance. If the task is unclear, ask instead of guessing, then stop. ` +
    `When stuck (same error twice, no progress) call handoff with problem/tried/state/next and stop. ${common}\n` +
    `Final reply: exactly one line — "${id} in_review", "${id} waiting: <question>" or "${id} handed off: <problem>".`
  );
}

function loadRunConfig(home?: string): RunConfig {
  const m = loadMachineConfig(home);
  return RunConfig.parse(m.run ?? {});
}

const RUN_HELP = `te run — start agents on ready tasks until only you can move things forward

Configure the agents for this machine in ~/.teamengage/machine.yaml:

  run:
    coder: devin -p --model swe-2-high --permission-mode accept-edits --
    reviewer: claude -p --model sonnet --permission-mode acceptEdits
    concurrency: 1      # agents at once
    fix_rounds: 1       # issues review → coder fixes, this many times

Each command gets the prompt as its last argument (or wherever it says
"$TE_PROMPT"; $TE_ITEM and $TE_MODE are set too), runs in the task folder,
and logs to ~/.teamengage/runs/<workspace>/.

options:
  --max <n>    start at most n new tasks
  --watch      keep going when idle (pick up tasks as you approve them)
  --dry-run    print what would start, start nothing
  --ws <name>  pick a workspace
`;

interface Workspace {
  name: string;
  root: string;
  machine: string;
  autonomy: string;
}

async function board(args: string[], home?: string): Promise<{ items: RunItem[]; ready: string[] }> {
  const q = wsQ(args);
  const items = (await daemonApi("GET", `/api/items${q ? `?${q}` : ""}`, undefined, home)) as RunItem[];
  const next = (await daemonApi("GET", `/api/next?limit=50${q ? `&${q}` : ""}`, undefined, home)) as Array<{
    meta: { id: string };
  }>;
  return { items, ready: next.map((n) => n.meta.id) };
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
  const { port } = await ensureDaemon(home);
  const base = `http://127.0.0.1:${port}`;
  const ws = (await daemonApi("GET", `/api/workspace?${wsQ(args)}`, undefined, home)) as Workspace;
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
  /** cuts the idle poll short when an agent exits */
  let wake: (() => void) | undefined;
  /** Open the agent's session for it, so it ends when the agent's process does. */
  const hello = async (agent: string): Promise<{ token: string; resume: string[] }> => {
    const res = await fetch(`${base}/agent/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, ...(opt(args, "--ws") ? { workspace: opt(args, "--ws") } : {}) }),
    });
    const text = await res.text();
    const token = /^token (\S+)/m.exec(text)?.[1];
    if (!res.ok || !token) throw new Error(`hello failed: ${text.split("\n")[0]}`);
    const resume = /^resume: (.+)$/m.exec(text)?.[1].split(/,\s*/) ?? [];
    return { token, resume };
  };
  const bye = (token: string) =>
    fetch(`${base}/agent/bye`, { method: "POST", headers: { "x-te-session": token } }).catch(() => {});

  const start = async (p: Pick, items: RunItem[]) => {
    const cmd = p.mode === "review" ? cfg.reviewer! : cfg.coder!;
    const name = agentName(cmd);
    const title = items.find((i) => i.id === p.id)?.title ?? "";
    if (dry) {
      say(`would ${p.mode} ${p.id} "${title}" with ${name}`);
      st.running.set(p.id, p.mode); // shows the first wave, up to concurrency
      if (p.mode === "work") st.started++;
      return;
    }
    const s = await hello(p.mode === "review" ? `${name}-review` : name);
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
      env: { ...process.env, TE_PROMPT: prompt, TE_ITEM: p.id, TE_MODE: p.mode, TE_SESSION: s.token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
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
      // and a bounce or issues review on them releases instead of stranding
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
    const { items, ready } = await board(args, home);
    const byId = new Map(items.map((i) => [i.id, i]));
    // a started coder has claimed (or moved the item on) — the next may start
    if (st.pendingClaim && byId.get(st.pendingClaim)?.claim) st.pendingClaim = undefined;
    for (const d of done.splice(0)) {
      const now = byId.get(d.id);
      const line = lastLine(d.log);
      say(`■ ${d.mode} ${d.id} → ${now?.status ?? "?"}${now?.ai_review && d.mode === "review" ? ` (${now.ai_review.verdict})` : ""}${d.code ? ` · exit ${d.code}, log ${d.log}` : ""}${line ? ` · ${line}` : ""}`);
      if (d.mode !== "review" && (now?.status === "ready" || now?.status === "in_progress")) st.tried.add(d.id);
    }
    let p: Pick | undefined;
    while (!stopping && (p = pickNext(cfg, st, items, ready, ws.machine, maxTasks))) {
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
            ? `review ok${ws.autonomy === "solo" ? " (auto-accepts soon)" : ""}  → te accept`
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
        spawn("notify-send", ["TeamEngage", fresh.map(([, l]) => l).join("\n")], { stdio: "ignore", detached: true })
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
