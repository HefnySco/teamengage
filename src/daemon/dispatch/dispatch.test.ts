import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Dispatcher, isLegacyTeRunCommand, scanProcesses } from "./dispatch.js";
import { resolveWorkspace, type LoadedWorkspace } from "../../core/config/config.js";
import { PlansStore } from "../store/store.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "../api/ops.js";
import type { WorkspaceRuntime } from "../server/context.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let home: string;
let sessions: SessionRegistry;
const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
const activeDispatchers: Dispatcher[] = [];

interface SeedItem {
  id: string;
  type?: string;
  status?: string;
  parent?: string;
  domains?: string[];
  aiReview?: { verdict: "ok" | "issues"; summary: string; note?: string };
}

async function makeWs(
  config: string,
  seedItems: SeedItem[] = [{ id: "WS-0001", status: "ready" }],
): Promise<WorkspaceRuntime> {
  const root = join(home, `ws-${Math.random().toString(36).slice(2, 7)}`);
  const plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items"), { recursive: true });
  const prefixes = new Set<string>(["WS"]);
  for (const item of seedItems) {
    prefixes.add(item.id.split("-")[0]);
  }
  const extraProjects = [...prefixes]
    .filter((prefix) => prefix !== "WS")
    .map((prefix) => `  proj_${prefix.toLowerCase()}: { prefix: ${prefix} }`)
    .join("\n");
  const projectsYaml = extraProjects ? `projects:\n${extraProjects}\n` : "";

  writeFileSync(
    join(plans, "workspace.yaml"),
    `name: ws\nprefix: WS\n${projectsYaml}resources:\n  self: { kind: git, path: ., worktree: false }\n${config}`,
  );
  for (const item of seedItems) {
    const prefix = item.id.split("-")[0];
    mkdirSync(join(plans, "items", prefix), { recursive: true });
    const parentYaml = item.parent ? `parent: ${item.parent}\n` : "";
    const domainsYaml = item.domains?.length ? `domains: [${item.domains.join(", ")}]\n` : "";
    const reviewYaml = item.aiReview
      ? `ai_review:\n  verdict: ${item.aiReview.verdict}\n  summary: "${item.aiReview.summary}"\n${item.aiReview.note ? `  note: "${item.aiReview.note}"\n` : ""}  reviewed_by: rev@test#1111\n  reviewed_at: "2026-11-23T00:00:00.000Z"\n`
      : "";
    writeFileSync(
      join(plans, "items", prefix, `${item.id}.md`),
      `---\nid: ${item.id}\ntype: ${item.type ?? "task"}\ntitle: ${item.id}\nstatus: ${item.status ?? "ready"}\n${parentYaml}${domainsYaml}${reviewYaml}version: 1\n---\n\n## Summary\nx\n`,
    );
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });
  const ws: LoadedWorkspace = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  return { ws, store };
}

const dispatcher = (wsr: WorkspaceRuntime) => {
  const instance = new Dispatcher(wsr, sessions, home, (kind, data) => events.push({ kind, data }));
  activeDispatchers.push(instance);
  return instance;
};

const untilEvent = async (kind: string, count: number, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (events.filter((entry) => entry.kind === kind).length < count && Date.now() < deadline) {
    await sleep(40);
  }
};

beforeAll(() => {
  // a te run child inherits TE_SESSION — daemonApi would send it and the
  // human-only routes answer 403; tests always call the daemon as the human
  delete process.env.TE_SESSION;
  home = mkdtempSync(join(tmpdir(), "te-dispatch-"));
  sessions = new SessionRegistry("test");
});

afterEach(() => {
  while (activeDispatchers.length) {
    activeDispatchers.pop()?.stopAll();
  }
  for (const session of sessions.list()) {
    sessions.disconnect(session.id);
  }
  rmSync(join(home, ".teamengage", "machine.yaml"), { force: true });
  // TE-0223: every test workspace is named "ws" — the persisted state file
  // would leak into the next test's Dispatcher without this
  rmSync(join(home, "dispatch"), { recursive: true, force: true });
  events.length = 0;
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("Dispatcher per-item launch and online_issues cap (TE-0203)", () => {
  it("dispatch on + one ready item starts the coder command once for that item", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    const d = dispatcher(wsr);
    d.tick();
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(1);
    expect(events[0].data).toMatchObject({ id: "WS-0001", mode: "work", role: "coder" });
    expect(d.status().running.map((entry) => `${entry.id}:${entry.mode}`)).toEqual(["WS-0001:work"]);
    expect(d.status().online_issues).toBe(1);
    expect(d.status().events.map((e) => e.kind)).toEqual(["dispatch_start"]);
  });

  it("online_issues counts active dispatches plus live local in_progress claims and ignores idle, remote, and in_review claims", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  max_issues: 3\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "WS-0001", status: "ready" },
        { id: "WS-0002", status: "ready" },
        { id: "WS-0003", status: "ready" },
        { id: "WS-0004", status: "ready" },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);

    sessions.hello("idle-ide");
    const manualLocal = sessions.hello("manual-coder");
    await ops.claim("WS-0002", manualLocal);

    const reviewHolder = sessions.hello("review-holder");
    await ops.claim("WS-0003", reviewHolder);
    await ops.submit("WS-0003", reviewHolder, { summary: "submitted work" });

    ops.index.setClaim({
      item: "WS-0004",
      holder: "devin@other-box#9999",
      machine: "other-box",
      claimed_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      targets: [],
    });
    const ws4 = ops.index.get("WS-0004");
    if (ws4) ws4.meta.status = "in_progress";

    const d = dispatcher(wsr);
    expect(d.status().online_issues).toBe(1);
    expect(d.status().live_sessions).toBe(3);

    d.setEnabled(true);
    d.tick();
    expect(d.status().online_issues).toBe(2);
    expect(d.status().running.map((entry) => entry.id)).toEqual(["WS-0001"]);
  });

  it("starts no new item when manual local in_progress claims fill max_issues, while idle hello sessions do not block", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "WS-0001", status: "ready" },
        { id: "WS-0002", status: "ready" },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);

    sessions.hello("idle-one");
    sessions.hello("idle-two");
    const manualHolder = sessions.hello("manual-local");
    await ops.claim("WS-0002", manualHolder);

    const d = dispatcher(wsr);
    d.tick();
    expect(d.status().online_issues).toBe(1);
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(0);

    await ops.release("WS-0002", manualHolder, "done manual check");
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(1);
    expect(events[0].data.id).toBe("WS-0001");
  });

  it("live_sessions still counts only sessions inside the idle limit (TE-0165)", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    sessions.idleAfterMs = 60_000;
    const old = sessions.hello("curl-old");
    old.last_seen = new Date(Date.now() - 120_000).toISOString();
    sessions.hello("curl-fresh");
    expect(dispatcher(wsr).status().live_sessions).toBe(1);
    sessions.idleAfterMs = 2 * 60 * 60_000;
  });

  it("filter 'SE-01xx:inreview' dispatches reviewer on unreviewed SE-01xx and coder fix on SE-01xx issues verdicts", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 3\n  filter: "SE-01xx:inreview"\n  agents:\n    - { role: coder, command: "sleep 30" }\n    - { role: reviewer, command: "sleep 30" }\n`,
      [
        { id: "SE-0101", status: "ready" },
        { id: "SE-0102", status: "ready" },
        {
          id: "SE-0103",
          status: "in_review",
          aiReview: { verdict: "issues", summary: "missing check", note: "tests/x.test.ts:12 — run it" },
        },
        { id: "WS-0001", status: "ready" },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const subA = sessions.hello("author-a");
    await ops.claim("SE-0102", subA);
    await ops.submit("SE-0102", subA, { summary: "ready for review" });

    ops.index.setClaim({
      item: "SE-0103",
      holder: "author-b@test#2222",
      machine: "test",
      claimed_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      targets: [],
    });

    const subOther = sessions.hello("author-other");
    await ops.claim("WS-0001", subOther);
    await ops.submit("WS-0001", subOther, { summary: "unrelated project" });

    const d = dispatcher(wsr);
    d.tick();
    const starts = events.filter((e) => e.kind === "dispatch_start").map((e) => `${e.data.id}:${e.data.mode}:${e.data.role}`);
    expect(starts).toEqual(["SE-0102:review:reviewer", "SE-0103:fix:coder"]);
  });

  it("filter 'Plan PL-1032:ready' dispatches coder work only on ready descendant tasks of PL-1032", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  filter: "Plan PL-1032:ready"\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "PL-1032", type: "epic", status: "ready" },
        { id: "WS-0010", status: "ready", parent: "PL-1032" },
        { id: "WS-0099", status: "ready" },
      ],
    );
    const d = dispatcher(wsr);
    expect(d.status().matched.map((entry) => entry.id)).toEqual(["WS-0010"]);
    d.tick();
    const starts = events.filter((e) => e.kind === "dispatch_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].data).toMatchObject({ id: "WS-0010", mode: "work", role: "coder" });
  });

  it("stays enabled when matched queue empties and picks up a newly approved matching item on the next tick", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  filter: "SE-01xx:ready"\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "SE-0105", status: "draft" }],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const d = dispatcher(wsr);

    d.tick();
    expect(d.isEnabled()).toBe(true);
    expect(events).toHaveLength(0);

    await ops.approve("SE-0105");
    d.tick();
    expect(d.isEnabled()).toBe(true);
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(1);
    expect(events[0].data.id).toBe("SE-0105");
  });

  it("ignores legacy 'te run' commands in dispatch.agents and falls back to machine.yaml run config", async () => {
    expect(isLegacyTeRunCommand("env -u ACP_BACKEND -u AI_AGENT te run")).toBe(true);
    expect(isLegacyTeRunCommand("te run --watch")).toBe(true);
    expect(isLegacyTeRunCommand("devin -p --model swe-2-high --")).toBe(false);

    mkdirSync(join(home, ".teamengage"), { recursive: true });
    writeFileSync(
      join(home, ".teamengage", "machine.yaml"),
      `name: test\nrun:\n  coder: 'true #'\n  reviewer: 'true #'\n  concurrency: 2\n`,
    );
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_sessions: 2\n  agents:\n    - { role: coder, command: "env -u ACP_BACKEND -u AI_AGENT te run" }\n`,
    );
    const d = dispatcher(wsr);
    expect(d.status().agents_ready).toBe(true);
    expect(d.status().agents.map((a) => a.command)).toEqual(["true #", "true #"]);
    // TE-0208: the dropped legacy entry warns — never a silent config drop
    expect(events.some((e) => e.kind === "dispatch_config" && /legacy te run/.test(String(e.data.warning)))).toBe(true);
    expect(d.status().warnings).toEqual([expect.stringContaining("legacy te run")]);
    d.tick();
    const start = events.find((e) => e.kind === "dispatch_start");
    expect(start?.data.command).toBe("true #");
  });

  it("a command that fails 3 times in a row turns dispatch off and writes an event", async () => {
    // three ready items: the per-item breaker (TE-0208) blocks WS-0001 after
    // two failures, the next two items feed the third consecutive role fail
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  agents:\n    - { role: coder, command: "exit 1" }\n`,
      [
        { id: "WS-0001", status: "ready" },
        { id: "WS-0002", status: "ready" },
        { id: "WS-0003", status: "ready" },
      ],
    );
    const d = dispatcher(wsr);
    for (let i = 0; i < 3; i++) {
      d.tick();
      await untilEvent("dispatch_fail", i + 1);
    }
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(3);
    const off = events.find((e) => e.kind === "dispatch_off");
    expect(off?.data.reason).toContain("3 times");
    expect(d.isEnabled()).toBe(false);
    const count = events.filter((e) => e.kind === "dispatch_start").length;
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(count);
  });

  it("with dispatch unset or disabled the daemon starts nothing", async () => {
    const wsrUnset = await makeWs("");
    dispatcher(wsrUnset).tick();
    expect(events).toHaveLength(0);

    const wsrDisabled = await makeWs(
      `dispatch:\n  enabled: false\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    dispatcher(wsrDisabled).tick();
    expect(events).toHaveLength(0);
  });

  it("te dispatch on/set/status/off supports --max and --filter and prints issues, filter, matched, and running", async () => {
    const { startDaemon } = await import("../server/server.js");
    const { registerApiRoutes } = await import("../api/api.js");
    const { EventBus } = await import("../api/events.js");
    const { dispatchCmd } = await import("../../cli/commands/dispatch.js");

    const cliHome = mkdtempSync(join(tmpdir(), "te-dispatch-cli-"));
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "SE-0101", status: "ready" },
        { id: "SE-0102", status: "ready" },
        { id: "WS-0001", status: "ready" },
      ],
    );
    const d = dispatcher(wsr);
    const ctx = {
      home: cliHome,
      machine: "test",
      workspaces: new Map([["ws", wsr]]),
      sessions,
      bus: new EventBus(),
      dispatchers: new Map([["ws", d]]),
    };
    const handle = await startDaemon({
      home: cliHome,
      port: 0,
      health: () => ({ machine: "test", workspaces: ["ws"] }),
      register: async (app) => {
        registerApiRoutes(app, ctx);
      },
    });
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await dispatchCmd(["set", "--max", "3", "--filter", "SE-01xx:ready"], cliHome)).toBe(0);
      expect(await dispatchCmd(["on"], cliHome)).toBe(0);
      chunks.length = 0;
      expect(await dispatchCmd(["status"], cliHome)).toBe(0);
      const out = chunks.join("");
      expect(out).toContain("dispatch on · issues 1/3");
      expect(out).toContain("filter: SE-01xx:ready");
      expect(out).toContain("running: SE-0101 (work)");
      expect(out).toContain("matched (2): SE-0101 (work), SE-0102 (work)");
      expect(await dispatchCmd(["off"], cliHome)).toBe(0);
    } finally {
      process.stdout.write = origWrite;
      d.stopAll();
      await handle.close();
      rmSync(cliHome, { recursive: true, force: true });
    }
  });
});

describe("hard cap on live in-progress claims (TE-0206)", () => {
  it("hello adoption rebinds the holder but does not refresh the claim's last_seen", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "WS-0001", status: "ready" }],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const first = await ops.hello("devin");
    await ops.claim("WS-0001", first.session);
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const claim = ops.index.get("WS-0001")!.claim!;
    ops.index.setClaim({ ...claim, last_seen: stale });
    sessions.disconnect(first.session.id);

    const second = await ops.hello("devin", undefined, undefined, undefined, undefined, "WS-0001");
    expect(second.resume.map((c) => c.item)).toEqual(["WS-0001"]);
    const rebound = ops.index.get("WS-0001")!.claim!;
    expect(rebound.holder).toBe(second.session.id);
    expect(rebound.last_seen).toBe(stale);
  });

  it("a dispatcher-opened session adopts only its own item's dead claim, never the others", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "WS-0001", status: "ready" },
        { id: "WS-0002", status: "ready" },
        { id: "WS-0003", status: "ready" },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    // a devin session claimed two items, then died — its claims are dead
    const first = await ops.hello("devin");
    await ops.claim("WS-0001", first.session);
    await ops.claim("WS-0002", first.session);
    sessions.disconnect(first.session.id);

    // the dispatcher opens a one-shot session for WS-0003: it must inherit
    // nothing — before the fix it adopted every dead devin claim on the
    // machine, counted them toward the dispatch cap and stranded them
    const dispatched = await ops.hello("devin", undefined, undefined, undefined, undefined, "WS-0003", true);
    expect(dispatched.resume).toEqual([]);
    expect(sessions.isDispatchMinted(dispatched.session.id)).toBe(true);
    expect(ops.index.get("WS-0001")!.claim!.holder).toBe(first.session.id);
    expect(ops.index.get("WS-0002")!.claim!.holder).toBe(first.session.id);

    // dispatched for its own item (resume flow): only that claim adopts
    const resumed = await ops.hello("devin", undefined, undefined, undefined, undefined, "WS-0001", true);
    expect(resumed.resume.map((c) => c.item)).toEqual(["WS-0001"]);
    expect(ops.index.get("WS-0001")!.claim!.holder).toBe(resumed.session.id);
    expect(ops.index.get("WS-0002")!.claim!.holder).toBe(first.session.id);

    // TE-0211: an interactive hello with no label adopts nothing — the dead
    // WS-0002 claim is only listed as resumable (WS-0001's holder is live)
    const interactive = await ops.hello("devin");
    expect(interactive.resume).toEqual([]);
    expect(interactive.resumable.map((c) => c.item)).toEqual(["WS-0002"]);
    expect(ops.index.get("WS-0002")!.claim!.holder).toBe(first.session.id);
    // ...and it may take WS-0002 over explicitly with claim
    await ops.claim("WS-0002", interactive.session);
    expect(ops.index.get("WS-0002")!.claim!.holder).toBe(interactive.session.id);
  });

  it("a repeat hello on the same connection carries the replaced session's claims (TE-0211)", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "WS-0001", status: "ready" },
        { id: "WS-0002", status: "ready" },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const other = await ops.hello("devin");
    await ops.claim("WS-0002", other.session);
    sessions.disconnect(other.session.id);
    const first = await ops.hello("devin");
    await ops.claim("WS-0001", first.session);
    sessions.disconnect(first.session.id);
    // the connection says hello again: its own claim follows, the other
    // dead devin claim does not
    const again = await ops.hello("devin", undefined, undefined, undefined, undefined, undefined, undefined, first.session.id);
    expect(again.resume.map((c) => c.item)).toEqual(["WS-0001"]);
    expect(again.resumable.map((c) => c.item)).toEqual(["WS-0002"]);
    expect(sessions.isDispatchMinted(again.session.id)).toBe(false);
  });

  it("a stale last_seen claim with a live holder is not live capacity; a fresh one is", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "WS-0001", status: "ready" },
        { id: "WS-0002", status: "ready" },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const holder = sessions.hello("manual-local");
    await ops.claim("WS-0002", holder);
    const d = dispatcher(wsr);

    // fresh claim counts — cap is full
    expect(d.status().live_issues).toBe(1);
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(0);

    // age it past live_claim_window — the idle holder stops blocking
    const claim = ops.index.get("WS-0002")!.claim!;
    ops.index.setClaim({ ...claim, last_seen: new Date(Date.now() - 60 * 60_000).toISOString() });
    expect(d.status().live_issues).toBe(0);
    d.tick();
    const starts = events.filter((e) => e.kind === "dispatch_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].data.id).toBe("WS-0001");
  });

  it("a dispatch-minted session claim past the cap is refused; a manual claim is never refused", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  max_issues: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "WS-0001", status: "ready" },
        { id: "WS-0002", status: "ready" },
        { id: "WS-0003", status: "ready" },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const manual = sessions.hello("manual-coder");
    await ops.claim("WS-0001", manual); // live in_progress — fills the cap

    const minted = sessions.hello("sleep");
    sessions.markDispatchMinted(minted.id);
    await expect(ops.claim("WS-0002", minted)).rejects.toThrow(/dispatch cap|CLAIM_REFUSED/);
    await expect(ops.claim("WS-0003", manual)).resolves.toBeDefined();
  });

  it("status reports live_issues, cap_over and why_idle", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  max_issues: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "WS-0001", status: "ready" }],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const d = dispatcher(wsr);
    expect(d.status().why_idle).toBe("disabled");

    d.setEnabled(true);
    expect(d.status().why_idle).toBe(null);

    const holder = sessions.hello("manual-local");
    await ops.claim("WS-0001", holder);
    const st = d.status();
    expect(st.live_issues).toBe(1);
    expect(st.cap_over).toBe(true);
    expect(st.why_idle).toBe("cap");
  });

  it("why_idle names no_match for an empty board and filter for filtered-out work", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "WS-0001", status: "ready" }],
    );
    const d = dispatcher(wsr);
    expect(d.status().why_idle).toBe(null);
    d.update({ filter: "SE-01xx" });
    expect(d.status().why_idle).toBe("filter");

    const empty = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "WS-0001", status: "done" }],
    );
    const d2 = dispatcher(empty);
    expect(d2.status().why_idle).toBe("no_match");
  });
});

describe("dispatcher-held claims are never swept (TE-0207)", () => {
  it("a claim held by a running dispatcher child stays past auto_release_after", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const d = dispatcher(wsr);
    d.tick();
    await untilEvent("dispatch_start");
    expect(d.heldItemIds().has("WS-0001")).toBe(true);

    // the dispatched child claims the item like a real agent would
    const minted = sessions.hello("sleep");
    sessions.markDispatchMinted(minted.id);
    await ops.claim("WS-0001", minted);

    // age the claim far past the default 2h window
    const claim = ops.index.get("WS-0001")!.claim!;
    ops.index.setClaim({ ...claim, last_seen: new Date(Date.now() - 3 * 3_600_000).toISOString() });

    // without the held set it is due; with it, never
    expect(ops.autoReleaseDue(Date.now())).toContain("WS-0001");
    expect(ops.autoReleaseDue(Date.now(), d.heldItemIds())).not.toContain("WS-0001");
    const swept = await ops.autoRelease(Date.now(), d.heldItemIds());
    expect(swept.map((s) => s.id)).not.toContain("WS-0001");
    expect(ops.index.get("WS-0001")!.claim?.holder).toBe(minted.id);
    expect(ops.index.get("WS-0001")!.meta.status).toBe("in_progress");
  });
});

describe("admission checks before a dispatch (TE-0208)", () => {
  it("leaves a live same-named session's claim untouched", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "WS-0001", status: "in_progress" }],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const stranger = sessions.hello("sleep");
    ops.index.setClaim({
      item: "WS-0001",
      holder: stranger.id,
      actor: "agent",
      machine: "test",
      targets: [],
      claimed_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      last_seen: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const d = dispatcher(wsr);
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(0);
    expect(d.status().matched).toEqual([]);
  });

  it("end-to-end over /agent: same-name takeover claims cleanly and minted dead claim resumes without grace wait", async () => {
    const { startDaemon } = await import("../server/server.js");
    const { registerAgentRoutes } = await import("../../agent/http.js");
    const { EventBus } = await import("../api/events.js");

    const serverHome = mkdtempSync(join(tmpdir(), "te-dispatch-e2e-"));
    const scriptPath = join(serverHome, "coder.sh");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'BASE="$1"',
        'if [ "$TE_MODE" = "takeover" ]; then',
        '  curl -sf -X POST "$BASE/agent/claim/$TE_ITEM" -H "X-TE-Session: $TE_SESSION" >/dev/null',
        '  curl -sf -X POST "$BASE/agent/submit/$TE_ITEM" -H "X-TE-Session: $TE_SESSION" -d \'{"summary":"took over and finished"}\' >/dev/null',
        'elif [ "$TE_MODE" = "work" ]; then',
        '  curl -sf -X POST "$BASE/agent/claim/$TE_ITEM" -H "X-TE-Session: $TE_SESSION" >/dev/null',
        '  curl -sf -X POST "$BASE/agent/ask/$TE_ITEM" -H "X-TE-Session: $TE_SESSION" -d \'{"question":"port?"}\' >/dev/null',
        'elif [ "$TE_MODE" = "resume" ]; then',
        '  curl -sf -X POST "$BASE/agent/submit/$TE_ITEM" -H "X-TE-Session: $TE_SESSION" -d \'{"summary":"resumed without re-claim"}\' >/dev/null',
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );

    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  takeover_grace_after: "15m"\n`,
      [
        { id: "WS-0001", status: "ready" },
        { id: "WS-0002", status: "ready" },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const ctx = {
      home: serverHome,
      machine: "test",
      workspaces: new Map([["ws", wsr]]),
      sessions,
      bus: new EventBus(),
      dispatchers: new Map(),
    };
    const handle = await startDaemon({
      home: serverHome,
      port: 0,
      health: () => ({ machine: "test", workspaces: ["ws"] }),
      register: async (app) => {
        registerAgentRoutes(app, ctx);
      },
    });
    wsr.ws.config.dispatch = {
      enabled: true,
      max_issues: 2,
      agents: [{ role: "coder", command: `${scriptPath} ${handle.url} #` }],
    };

    const d = dispatcher(wsr);
    d.setBaseUrl(handle.url);
    try {
      // 1) GL-0217: manual session with the coder's agent name ('coder') claims WS-0001 and dies
      const manual = await ops.hello("coder");
      await ops.claim("WS-0001", manual.session);
      sessions.disconnect(manual.session.id);
      const oldClaim = ops.index.get("WS-0001")!.claim!;
      ops.index.setClaim({
        ...oldClaim,
        last_seen: new Date(Date.now() - 20 * 60_000).toISOString(),
      });

      // 2) Tick starts WS-0001 (takeover) and WS-0002 (work -> ask -> waiting)
      d.tick();
      await untilEvent("dispatch_start", 1);
      const waitStatus = async (id: string, target: string) => {
        const deadline = Date.now() + 8000;
        while (ops.index.get(id)?.meta.status !== target && Date.now() < deadline) {
          await sleep(40);
        }
      };
      await waitStatus("WS-0001", "in_review");
      expect(ops.index.get("WS-0001")!.meta.status).toBe("in_review");

      // Next tick picks WS-0002 as work; child claims and asks -> waiting, then exits (session dead)
      const waitIdle = async () => {
        const deadline = Date.now() + 8000;
        while (d.status().running.length > 0 && Date.now() < deadline) await sleep(40);
      };
      await waitIdle();
      d.tick();
      await waitStatus("WS-0002", "waiting");
      await waitIdle();

      // Human answers immediately (claim is <15m old, minted by d) -> resumes right away without grace wait
      await ops.answer("WS-0002", "8080");
      expect(ops.index.get("WS-0002")!.meta.status).toBe("in_progress");
      expect(d.status().matched.find((c) => c.id === "WS-0002")).toMatchObject({
        id: "WS-0002",
        mode: "resume",
        admission: { ok: true },
      });
      d.tick();
      await waitStatus("WS-0002", "in_review");
      expect(ops.index.get("WS-0002")!.meta.status).toBe("in_review");

      // stopAll (pause --kill) closes remote sessions so killed runs do not linger live
      wsr.ws.config.dispatch = {
        enabled: true,
        max_issues: 2,
        agents: [{ role: "reviewer", command: "sleep 30 #" }],
      };
      d.tick();
      await untilEvent("dispatch_start", 5);
      expect(sessions.list()).toHaveLength(2);
      d.pause("emergency", true);
      const byeDeadline = Date.now() + 4000;
      while (sessions.list().length > 0 && Date.now() < byeDeadline) await sleep(40);
      expect(sessions.list()).toHaveLength(0);
    } finally {
      d.stopAll();
      await handle.close();
      rmSync(serverHome, { recursive: true, force: true });
    }
  });

  it("a dead same-name claim is a takeover candidate, refused only until the grace passes", async () => {
    // GL-0217: a manual session with the coder's agent name claimed, then
    // died — before the fix the claim stranded: resume could never admit it
    // (not minted) and takeover skipped 'ours' claims
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  takeover_grace_after: "15m"\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "WS-0001", status: "in_progress" }],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const dead = (seenMs: number) =>
      ops.index.setClaim({
        item: "WS-0001",
        holder: "sleep@test#abcd",
        actor: "agent",
        machine: "test",
        targets: [],
        claimed_at: new Date(Date.now() - 86_400_000).toISOString(),
        last_seen: new Date(Date.now() - seenMs).toISOString(),
      });
    dead(60_000);
    const d = dispatcher(wsr);
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(0);
    const matched = d.status().matched.find((c) => c.id === "WS-0001");
    expect(matched?.mode).toBe("takeover");
    expect(matched?.admission?.ok).toBe(false);

    dead(20 * 60_000);
    d.tick();
    const starts = events.filter((e) => e.kind === "dispatch_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].data.mode).toBe("takeover");
  });

  it("takeover waits for takeover_grace_after after the claim dies", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  takeover_grace_after: "15m"\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "WS-0001", status: "in_progress" }],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const dead = () =>
      ops.index.setClaim({
        item: "WS-0001",
        holder: "other@test#abcd",
        actor: "agent",
        machine: "test",
        targets: [],
        claimed_at: new Date(Date.now() - 86_400_000).toISOString(),
        last_seen: new Date(Date.now() - 60_000).toISOString(), // died a minute ago
      });
    dead();
    const d = dispatcher(wsr);
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(0);
    const matched = d.status().matched.find((c) => c.id === "WS-0001");
    expect(matched?.mode).toBe("takeover");
    expect(matched?.admission?.ok).toBe(false);

    // past the grace — the claim stays dead long enough to take over
    dead();
    const claim = ops.index.get("WS-0001")!.claim!;
    ops.index.setClaim({ ...claim, last_seen: new Date(Date.now() - 20 * 60_000).toISOString() });
    d.tick();
    const starts = events.filter((e) => e.kind === "dispatch_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].data.id).toBe("WS-0001");
    expect(starts[0].data.mode).toBe("takeover");
  });

  it("two failed runs on one item set dispatch_blocked with the reason in its Log; admit refuses until unblock", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 1\n  agents:\n    - { role: coder, command: "exit 1" }\n`,
      [{ id: "WS-0001", status: "ready" }],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const d = dispatcher(wsr);
    for (let i = 0; i < 2; i++) {
      d.tick();
      await untilEvent("dispatch_fail", i + 1);
    }
    // the persisted breaker lands asynchronously — wait for it
    const deadline = Date.now() + 8000;
    while (!ops.index.get("WS-0001")!.meta.dispatch_blocked && Date.now() < deadline) {
      await sleep(40);
    }
    expect(ops.index.get("WS-0001")!.meta.dispatch_blocked?.reason).toContain("two failed dispatch runs");
    const logSec =
      ops.index.get("WS-0001")!.sections.find((s) => s.heading.toLowerCase() === "log")?.body ?? "";
    expect(logSec).toContain("blocked dispatch");
    expect(logSec).toContain("exit 1");

    // admission refuses it — no more starts
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(2);
    const matched = d.status().matched.find((c) => c.id === "WS-0001");
    expect(matched?.admission?.ok).toBe(false);
    expect(matched?.admission?.reasons.join(" ")).toContain("dispatch_blocked");

    // the human's unblock clears it — the item is pickable again
    const it = ops.index.get("WS-0001")!;
    await ops.store.perform("WS-0001", it.meta.version, { kind: "human", session: "human", machine: "test" }, {
      type: "dispatch_unblock",
    });
    expect(ops.index.get("WS-0001")!.meta.dispatch_blocked).toBeUndefined();
    expect(d.status().matched.find((c) => c.id === "WS-0001")?.admission?.ok).toBe(true);
  });
});

describe("forced correction levers (TE-0209)", () => {
  it("pause stops new starts and names the reason in why_idle; resume restarts them", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    const d = dispatcher(wsr);
    d.pause("maintenance");
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(0);
    expect(d.status().why_idle).toBe("paused: maintenance");
    expect(d.status().paused).toBe("maintenance");
    expect(events.some((e) => e.kind === "dispatch_pause")).toBe(true);
    // resume ticks — the ready item starts
    d.unpause();
    await untilEvent("dispatch_start", 1);
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(1);
    expect(d.status().paused).toBeNull();
  });

  it("pause --kill stops the running child", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    const d = dispatcher(wsr);
    d.tick();
    await untilEvent("dispatch_start", 1);
    expect(d.status().running).toHaveLength(1);
    d.pause("emergency", true);
    expect(d.status().running).toHaveLength(0);
    expect(d.status().why_idle).toBe("paused: emergency");
  });

  it("a blocked item is never started until the unblock lever clears it", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const d = dispatcher(wsr);
    await d.blockItem("WS-0001", "env broken");
    expect(ops.index.get("WS-0001")!.meta.dispatch_blocked?.reason).toBe("env broken");
    const logBody =
      ops.index.get("WS-0001")!.sections.find((s) => s.heading.toLowerCase() === "log")?.body ?? "";
    expect(logBody).toContain("blocked dispatch: env broken");
    d.tick();
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(0);
    expect(d.status().matched.find((c) => c.id === "WS-0001")?.blocked).toBe(true);
    await d.unblockItem("WS-0001");
    expect(ops.index.get("WS-0001")!.meta.dispatch_blocked).toBeUndefined();
    d.tick();
    await untilEvent("dispatch_start", 1);
    expect(events[0].data).toMatchObject({ id: "WS-0001" });
  });

  it("reset lets dispatch retry an item it had marked tried", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 1\n  agents:\n    - { role: coder, command: "exit 0" }\n`,
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const d = dispatcher(wsr);
    d.tick();
    // a clean exit with no status change marks the item tried at this version
    const deadline = Date.now() + 8000;
    while (d.status().running.length > 0 && Date.now() < deadline) await sleep(40);
    await untilEvent("dispatch_start", 1);
    // tried: a plain tick starts nothing
    d.tick();
    await sleep(150);
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(1);
    // reset clears the tried marker — the next tick starts it again and the
    // item Log records the lever
    await d.resetItem("WS-0001");
    const logBody =
      ops.index.get("WS-0001")!.sections.find((s) => s.heading.toLowerCase() === "log")?.body ?? "";
    expect(logBody).toContain("reset dispatch state");
    d.tick();
    await untilEvent("dispatch_start", 2);
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(2);
  });
});

describe("forced lever CLI (TE-0209)", () => {
  it("te dispatch pause/resume/block/unblock/reset print clear confirmations", async () => {
    const { startDaemon } = await import("../server/server.js");
    const { registerApiRoutes } = await import("../api/api.js");
    const { EventBus } = await import("../api/events.js");
    const { dispatchCmd } = await import("../../cli/commands/dispatch.js");

    const cliHome = mkdtempSync(join(tmpdir(), "te-dispatch-cli-"));
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  max_issues: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    const d = dispatcher(wsr);
    const ctx = {
      home: cliHome,
      machine: "test",
      workspaces: new Map([["ws", wsr]]),
      sessions,
      bus: new EventBus(),
      dispatchers: new Map([["ws", d]]),
    };
    const handle = await startDaemon({
      home: cliHome,
      port: 0,
      health: () => ({ machine: "test", workspaces: ["ws"] }),
      register: async (app) => {
        registerApiRoutes(app, ctx);
      },
    });
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await dispatchCmd(["pause", "maintenance"], cliHome)).toBe(0);
      expect(chunks.join("")).toContain("dispatch paused: maintenance");
      chunks.length = 0;
      expect(await dispatchCmd(["block", "WS-0001", "env", "broken"], cliHome)).toBe(0);
      expect(chunks.join("")).toContain("WS-0001 blocked from dispatch: env broken");
      chunks.length = 0;
      expect(await dispatchCmd(["unblock", "WS-0001"], cliHome)).toBe(0);
      expect(chunks.join("")).toContain("WS-0001 unblocked");
      chunks.length = 0;
      expect(await dispatchCmd(["reset", "WS-0001"], cliHome)).toBe(0);
      expect(chunks.join("")).toContain("WS-0001 dispatch memory cleared");
      chunks.length = 0;
      expect(await dispatchCmd(["resume"], cliHome)).toBe(0);
      expect(chunks.join("")).toContain("dispatch resumed");
      // status names the pause
      expect(await dispatchCmd(["pause"], cliHome)).toBe(0);
      chunks.length = 0;
      expect(await dispatchCmd(["status"], cliHome)).toBe(0);
      expect(chunks.join("")).toContain("paused");
    } finally {
      process.stdout.write = origWrite;
      d.stopAll();
      await handle.close();
      rmSync(cliHome, { recursive: true, force: true });
    }
  });
});

describe("a dispatch-minted session carries the spawned child's pid (TE-0218)", () => {
  it("the session opened for a spawned child gets child.pid attached once it exists", async () => {
    const { startDaemon } = await import("../server/server.js");
    const { registerApiRoutes } = await import("../api/api.js");
    const { registerAgentRoutes } = await import("../../agent/http.js");
    const { EventBus } = await import("../api/events.js");

    const srvHome = mkdtempSync(join(tmpdir(), "te-dispatch-pid-"));
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 1\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    const d = dispatcher(wsr);
    const ctx = {
      home: srvHome,
      machine: "test",
      workspaces: new Map([["ws", wsr]]),
      sessions,
      bus: new EventBus(),
      dispatchers: new Map([["ws", d]]),
    };
    const handle = await startDaemon({
      home: srvHome,
      port: 0,
      health: () => ({ machine: "test", workspaces: ["ws"] }),
      register: async (app) => {
        registerApiRoutes(app, ctx);
        registerAgentRoutes(app, ctx);
      },
    });
    try {
      d.setBaseUrl(`http://127.0.0.1:${handle.port}`);
      d.tick();
      await untilEvent("dispatch_start", 1);
      const running = d.status().running;
      expect(running).toHaveLength(1);
      const minted = sessions.list().find((s) => s.label === "WS-0001");
      expect(minted).toBeDefined();
      expect(minted!.pid).toBe(running[0].pid);
      // and the pid probe, not the 2h idle limit, keeps it live
      minted!.last_seen = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
      expect(sessions.isLive(minted!.id)).toBe(true);
    } finally {
      d.stopAll();
      await handle.close();
      rmSync(srvHome, { recursive: true, force: true });
    }
  });
});

describe("te discover: reattach orphaned agent processes (TE-0219)", () => {
  const markedChild = (env: Record<string, string>) =>
    spawn("bash", ["-c", "sleep 30"], { env: { ...process.env, ...env } });

  it("scanProcesses finds a spawned child's TE_* markers in /proc", async () => {
    const child = markedChild({
      TE_ITEM: "WS-0001",
      TE_MODE: "work",
      TE_ROLE: "coder",
      TE_SESSION: "tok-scan",
    });
    try {
      const found = scanProcesses("/proc").find((p) => p.pid === child.pid);
      expect(found).toMatchObject({
        item: "WS-0001",
        mode: "work",
        role: "coder",
        token: "tok-scan",
      });
      expect(found!.ppid).toBe(process.pid);
      expect(found!.started_at).toBeTruthy();
    } finally {
      child.kill();
    }
  });

  it("an orphan gets a live pid session, the dead claim, its rebound token and a children entry that reaps on exit", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "WS-0001", status: "ready" }],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    // the orphan's old session once claimed the item, then vanished
    const gone = await ops.hello("devin");
    await ops.claim("WS-0001", gone.session);
    sessions.disconnect(gone.session.id);

    const child = markedChild({
      TE_ITEM: "WS-0001",
      TE_MODE: "work",
      TE_ROLE: "coder",
      TE_SESSION: "tok-orphan",
    });
    const rebound: Array<{ token: string; session: string }> = [];
    const d = dispatcher(wsr);
    try {
      const report = await d.discoverOrphans({
        rebind: (token, session) => rebound.push({ token, session: session.id }),
        scan: () => [
          {
            pid: child.pid!,
            ppid: process.pid,
            started_at: new Date().toISOString(),
            item: "WS-0001",
            mode: "work",
            role: "coder",
            token: "tok-orphan",
          },
        ],
      });
      expect(report.reattached).toEqual([
        {
          pid: child.pid,
          id: "WS-0001",
          session: expect.any(String),
          claim: "adopted",
          token: true,
        },
      ]);
      const sessionId = report.reattached[0].session;
      // the minted session carries the process pid — the pid probe rules it
      expect(sessions.get(sessionId)?.pid).toBe(child.pid);
      expect(sessions.isLive(sessionId)).toBe(true);
      // the item's dead claim is adopted — holder is the new session
      expect(ops.index.get("WS-0001")!.claim!.holder).toBe(sessionId);
      // the recovered token is re-bound to that session
      expect(rebound).toEqual([{ token: "tok-orphan", session: sessionId }]);
      // and the pid counts in online_issues and the running list
      expect(d.status().online_issues).toBe(1);
      expect(d.status().running).toEqual([
        {
          id: "WS-0001",
          mode: "work",
          role: "coder",
          pid: child.pid,
          started_at: expect.any(String),
        },
      ]);
      expect(events.some((e) => e.kind === "dispatch_discover")).toBe(true);

      // when the process exits the entry is reaped and the session ends
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      expect(d.status().running).toEqual([]);
      expect(d.status().online_issues).toBe(0);
      expect(events.some((e) => e.kind === "dispatch_reaped")).toBe(true);
      expect(sessions.isLive(sessionId)).toBe(false);
    } finally {
      child.kill();
    }
  });

  it("lists unmarked, descendant, dead-pid, unknown-item, live-claim and already-running processes as skipped", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "WS-0001", status: "ready" },
        { id: "WS-0002", status: "ready" },
        { id: "WS-0003", status: "ready" },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const live = sessions.hello("devin");
    await ops.claim("WS-0001", live); // a live claim — the proc must not take it

    const plain = spawn("bash", ["-c", "sleep 30"]);
    const rootA = markedChild({ TE_ITEM: "WS-0001", TE_SESSION: "tok-a" });
    const rootB = markedChild({ TE_ITEM: "WS-0002", TE_SESSION: "tok-b" });
    const twin = markedChild({ TE_ITEM: "WS-0002", TE_SESSION: "tok-b2" });
    const other = markedChild({ TE_ITEM: "WS-0099" });
    const deadPid = 4_194_303; // past the usual pid_max — never alive
    const d = dispatcher(wsr);
    try {
      const report = await d.discoverOrphans({
        scan: () => [
          { pid: plain.pid!, ppid: process.pid, started_at: "" },
          { pid: rootA.pid!, ppid: process.pid, started_at: "", item: "WS-0001", token: "tok-a" },
          // a descendant: its parent carries the same TE_ITEM
          { pid: 4_194_302, ppid: rootA.pid!, started_at: "", item: "WS-0001", token: "tok-a" },
          { pid: rootB.pid!, ppid: process.pid, started_at: "", item: "WS-0002", token: "tok-b" },
          { pid: twin.pid!, ppid: process.pid, started_at: "", item: "WS-0002", token: "tok-b2" },
          { pid: deadPid, ppid: process.pid, started_at: "", item: "WS-0003" },
          { pid: other.pid!, ppid: process.pid, started_at: "", item: "WS-0099" },
        ],
      });
      const reason = (pid?: number) =>
        report.skipped.find((s) => s.pid === pid)?.reason;
      expect(reason(plain.pid)).toBe("no_marker");
      expect(reason(4_194_302)).toBe("child_process");
      expect(reason(rootA.pid)).toBe("claim_live");
      expect(reason(deadPid)).toBe("exited");
      expect(reason(other.pid)).toBe("unknown_item");
      // WS-0002 has no claim — the first root reattaches, the second is a duplicate
      expect(report.reattached.map((r) => r.id)).toEqual(["WS-0002"]);
      expect(report.reattached[0].claim).toBe("none");
      expect(report.reattached[0].token).toBe(true);
      expect(reason(twin.pid)).toBe("already_running");
      const minted = report.reattached[0].session;
      expect(minted.startsWith("discovered@test#")).toBe(true);
      expect(sessions.isDispatchMinted(minted)).toBe(true);
      expect(ops.index.get("WS-0002")!.claim ?? null).toBeNull();
      expect(ops.index.get("WS-0001")!.claim!.holder).toBe(live.id);
    } finally {
      for (const c of [plain, rootA, rootB, twin, other]) c.kill();
    }
  });

  it("a review-mode orphan gets the -review name, does not adopt the claim, and the daemon's own pid is skipped", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [{ id: "WS-0001", status: "ready" }],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    const gone = await ops.hello("devin");
    await ops.claim("WS-0001", gone.session);
    sessions.disconnect(gone.session.id);

    const rev = markedChild({ TE_ITEM: "WS-0001", TE_MODE: "review", TE_ROLE: "reviewer" });
    const d = dispatcher(wsr);
    try {
      const report = await d.discoverOrphans({
        scan: () => [
          { pid: process.pid, ppid: 1, started_at: "", item: "WS-0001", mode: "work" },
          { pid: rev.pid!, ppid: 1, started_at: "", item: "WS-0001", mode: "review", role: "reviewer" },
        ],
      });
      expect(report.skipped.find((s) => s.pid === process.pid)?.reason).toBe("daemon_self");
      expect(report.reattached).toHaveLength(1);
      const r = report.reattached[0];
      expect(r.claim).toBe("none");
      expect(r.session.startsWith("devin-review@test#")).toBe(true);
      // the submitter's claim is untouched, so the review is not a self-review
      expect(ops.index.get("WS-0001")!.claim!.holder).toBe(gone.session.id);
    } finally {
      rev.kill();
    }
  });
});

describe("dispatch state persists across a restart (TE-0223)", () => {
  const stateFile = () => join(home, "dispatch", "ws.json");
  const readState = () =>
    JSON.parse(readFileSync(stateFile(), "utf8")) as {
      enabled: boolean;
      max_issues: number;
      filter: string;
      paused: string | null;
      fixes: Record<string, number>;
      tried_versions: Record<string, number>;
      item_failures: Record<string, number>;
      minted_ids: string[];
    };

  it("enabled, max_issues, filter and a pause survive a new Dispatcher on the same home", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: false\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    const d = dispatcher(wsr);
    d.update({ enabled: true, max_issues: 3, filter: "ws-*" });
    d.pause("maintenance");
    expect(readState()).toMatchObject({
      enabled: true,
      max_issues: 3,
      filter: "ws-*",
      paused: "maintenance",
    });
    // a restarted dispatcher reloads the saved state, not the yaml defaults
    const d2 = dispatcher(wsr);
    const st = d2.status();
    expect(st.enabled).toBe(true);
    expect(st.max_issues).toBe(3);
    expect(st.filter).toBe("ws-*");
    expect(st.paused).toBe("maintenance");
    expect(st.why_idle).toBe("paused: maintenance");
    // a lifted pause persists too — the next restart resumes clean
    d2.unpause();
    expect(readState().paused).toBeNull();
  });

  it("tried markers and per-item failure counts survive; resetItem clears them on disk", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 1\n  agents:\n    - { role: coder, command: "exit 0" }\n`,
    );
    const d = dispatcher(wsr);
    d.tick();
    // a clean exit with no status change marks the item tried and counts one failure
    const deadline = Date.now() + 8000;
    let saved: ReturnType<typeof readState> | undefined;
    while (Date.now() < deadline) {
      try {
        saved = readState();
      } catch {
        saved = undefined;
      }
      if (saved?.tried_versions["WS-0001"] === 1 && saved?.item_failures["WS-0001"] === 1) break;
      await sleep(40);
    }
    expect(saved?.tried_versions["WS-0001"]).toBe(1);
    expect(saved?.item_failures["WS-0001"]).toBe(1);
    // the restarted dispatcher still knows the item was tried — no restart
    const d2 = dispatcher(wsr);
    d2.tick();
    await sleep(150);
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(1);
    // reset clears the entries in memory AND on disk — a retry is allowed
    await d2.resetItem("WS-0001");
    const after = readState();
    expect(after.tried_versions["WS-0001"]).toBeUndefined();
    expect(after.item_failures["WS-0001"]).toBeUndefined();
    d2.tick();
    await untilEvent("dispatch_start", 2);
    expect(events.filter((e) => e.kind === "dispatch_start")).toHaveLength(2);
  });

  it("minted session ids and the fix counter survive a restart", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
      [
        { id: "WS-0001", status: "in_progress" },
        {
          id: "WS-0002",
          status: "in_review",
          aiReview: { verdict: "issues", summary: "broken", note: "fix it" },
        },
      ],
    );
    const ops = new WorkspaceOps(wsr, sessions, undefined, home);
    // WS-0001's holder died — the orphan carries its work marker
    ops.index.setClaim({
      item: "WS-0001",
      holder: "sleep@test#dead1",
      actor: "agent",
      machine: "test",
      targets: [],
      claimed_at: new Date(Date.now() - 3_600_000).toISOString(),
      last_seen: new Date(Date.now() - 3_600_000).toISOString(),
    });
    // WS-0002 sits in review under its submitter's claim on this machine
    ops.index.setClaim({
      item: "WS-0002",
      holder: "devin@test#hold1",
      actor: "agent",
      machine: "test",
      targets: [],
      claimed_at: new Date(Date.now() - 3_600_000).toISOString(),
      last_seen: new Date().toISOString(),
    });
    const d = dispatcher(wsr);
    const orphan = spawn("bash", ["-c", "sleep 30"]);
    try {
      const report = await d.discoverOrphans({
        scan: () => [
          {
            pid: orphan.pid!,
            ppid: process.pid,
            started_at: "",
            item: "WS-0001",
            mode: "work",
            role: "coder",
          },
        ],
      });
      expect(report.reattached).toHaveLength(1);
      const minted = report.reattached[0].session;
      // the fix pick consumes the one fix round and starts a child
      d.tick();
      await untilEvent("dispatch_start", 1);
      const saved = readState();
      expect(saved.minted_ids).toContain(minted);
      expect(saved.fixes["WS-0002"]).toBe(1);
      // the minted session dies — its claim goes dead, adoptable by name only
      // if the restarted dispatcher still knows the minted id (resume needs it)
      sessions.disconnect(minted);
      const d2 = dispatcher(wsr);
      d2.tick();
      await untilEvent("dispatch_start", 2);
      const resume = events.find(
        (e) => e.kind === "dispatch_start" && e.data.id === "WS-0001",
      );
      expect(resume?.data.mode).toBe("resume");
      // the spent fix round refuses a second fix on WS-0002
      await sleep(150);
      expect(
        events.filter((e) => e.kind === "dispatch_start" && e.data.id === "WS-0002"),
      ).toHaveLength(1);
    } finally {
      orphan.kill();
    }
  });

  it("a missing or corrupt state file falls back to workspace.yaml defaults", async () => {
    const wsr = await makeWs(
      `dispatch:\n  enabled: true\n  max_issues: 2\n  agents:\n    - { role: coder, command: "sleep 30" }\n`,
    );
    // no file at all — the defaults apply
    const missing = dispatcher(wsr);
    expect(missing.status().enabled).toBe(true);
    expect(missing.status().max_issues).toBe(2);
    // garbage bytes and valid-but-wrong json both fall back, never throw
    mkdirSync(join(home, "dispatch"), { recursive: true });
    writeFileSync(stateFile(), "{ not json");
    const d2 = dispatcher(wsr);
    expect(d2.status().enabled).toBe(true);
    expect(d2.status().max_issues).toBe(2);
    writeFileSync(stateFile(), "42");
    const d3 = dispatcher(wsr);
    expect(d3.status().enabled).toBe(true);
    expect(d3.status().paused).toBeNull();
  });
});
