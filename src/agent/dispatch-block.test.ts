import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../daemon/store/store.js";
import { resolveWorkspace } from "../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../daemon/server/server.js";
import type { DaemonCtx, WorkspaceRuntime } from "../daemon/server/context.js";
import { WorkspaceOps } from "../daemon/api/ops.js";
import { SessionRegistry } from "../daemon/sessions/sessions.js";
import { EventBus, registerEventRoutes } from "../daemon/api/events.js";
import { registerApiRoutes } from "../daemon/api/api.js";
import { registerAgentRoutes, SESSION_HEADER } from "./http.js";
import { Dispatcher } from "../daemon/dispatch/dispatch.js";

/**
 * TE-0237: the agent-side dispatch_block verb — a claim holder self-ejects
 * its item from auto-dispatch. Holder only, recorded with actor=agent,
 * surfaced in /api/inbox, refused by admit(), lifted only by the human's
 * te dispatch unblock.
 */

let home: string;
let ctx: DaemonCtx;
let wsr: WorkspaceRuntime;
let daemon: DaemonHandle;
let holderToken: string;
let holderSid: string;

const url = (p: string) => `${daemon.url}${p}`;
const ops = () => new WorkspaceOps(wsr, ctx.sessions, undefined, home);

async function call(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(url(path), {
    method,
    headers: opts.token ? { [SESSION_HEADER]: opts.token } : {},
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, text: await res.text() };
}

const api = (path: string, init?: RequestInit) =>
  fetch(`${daemon.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${daemon.token}`, ...(init?.headers ?? {}) },
  });

async function hello(agent: string): Promise<{ token: string; sessionId: string }> {
  const r = await call("POST", "/agent/hello", { body: { agent } });
  expect(r.status).toBe(200);
  return {
    token: /^token (\S+)/m.exec(r.text)![1],
    sessionId: /^session (\S+)/m.exec(r.text)![1],
  };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-dispatch-block-"));
  const root = join(home, "ws");
  const plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: ., worktree: false }\n",
  );
  for (const n of [1, 2, 3]) {
    const id = `WS-000${n}`;
    writeFileSync(
      join(plans, "items", "WS", `${id}.md`),
      `---\nid: ${id}\ntype: task\ntitle: task ${n}\nstatus: ready\nversion: 1\ntargets: ["@self:src/f${n}.ts"]\n---\n\n## Summary\nx\n`,
    );
  }
  for (const a of [
    ["init", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "-m", "init"],
  ]) {
    execFileSync("git", a, { cwd: plans });
  }
  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  wsr = { ws, store };
  ctx = {
    home,
    machine: "test",
    workspaces: new Map([["ws", wsr]]),
    sessions: new SessionRegistry("test"),
    bus: new EventBus(),
  };
  ctx.dispatchers = new Map([["ws", new Dispatcher(wsr, ctx.sessions, home)]]);
  store.onEvent = (ev) => ctx.bus.publish(ev);
  daemon = await startDaemon({
    home,
    register: (app) => {
      registerApiRoutes(app, ctx);
      registerEventRoutes(app, ctx.bus);
      registerAgentRoutes(app, ctx);
    },
  });
}, 30_000);

afterAll(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("agent dispatch_block (TE-0237)", () => {
  it("the verb sits beside flag_drop/handoff in the /agent protocol text", async () => {
    const guide = await call("GET", "/agent");
    expect(guide.status).toBe(200);
    expect(guide.text).toMatch(/^ {2}dispatch_block\s/m);
    // no unblock verb for agents — the human's 'te dispatch unblock' is the only way back
    expect(guide.text).not.toMatch(/^ {2}dispatch_unblock\s/m);
  });

  it("holder blocks its own claim — meta records actor=agent, session and reason; non-holder and unclaimed are refused", async () => {
    const holder = await hello("coder-one");
    holderToken = holder.token;
    holderSid = holder.sessionId;
    const other = await hello("other-agent");
    expect((await call("POST", "/agent/claim/WS-0001", { token: holderToken })).text).toMatch(
      /^claimed WS-0001/,
    );

    // a session cannot block work it does not hold
    const steal = await call("POST", "/agent/dispatch_block/WS-0001", {
      token: other.token,
      body: { reason: "not mine" },
    });
    expect(steal.status).toBe(403);
    expect(steal.text).toContain("held by");
    // an unclaimed item is refused too
    const free = await call("POST", "/agent/dispatch_block/WS-0002", {
      token: other.token,
      body: { reason: "unclaimed" },
    });
    expect(free.status).toBe(409);
    expect(free.text).toContain("not claimed");
    // a missing item is a plain 404
    expect(
      (
        await call("POST", "/agent/dispatch_block/WS-9999", {
          token: holderToken,
          body: { reason: "x" },
        })
      ).status,
    ).toBe(404);
    // holder-only on another session's claim too
    expect((await call("POST", "/agent/claim/WS-0003", { token: other.token })).text).toMatch(
      /^claimed WS-0003/,
    );
    expect(
      (
        await call("POST", "/agent/dispatch_block/WS-0003", {
          token: holderToken,
          body: { reason: "not mine either" },
        })
      ).status,
    ).toBe(403);

    // the holder self-ejects: reason is required, then recorded
    expect(
      (await call("POST", "/agent/dispatch_block/WS-0001", { token: holderToken })).status,
    ).toBe(400);
    // an empty reason is refused too — the block must say why
    expect(
      (
        await call("POST", "/agent/dispatch_block/WS-0001", {
          token: holderToken,
          body: { reason: "" },
        })
      ).status,
    ).toBe(400);
    const blocked = await call("POST", "/agent/dispatch_block/WS-0001", {
      token: holderToken,
      body: { reason: "needs rpi5 hardware this machine lacks" },
    });
    expect(blocked.status).toBe(200);
    expect(blocked.text).toContain("te dispatch unblock");
    const meta = ops().index.get("WS-0001")!.meta;
    expect(meta.dispatch_blocked).toMatchObject({
      reason: "needs rpi5 hardware this machine lacks",
      by: holderSid,
      actor: "agent",
    });
    expect(meta.dispatch_blocked?.at).toBeTruthy();
    // status and claim are untouched — the block only ejects dispatch picks
    expect(meta.status).toBe("in_progress");
    expect(ops().index.claims.get("WS-0001")?.holder).toBe(holderSid);
  });

  it("the block posts an inbox entry naming the item, the session and the reason", async () => {
    const inbox = (await (await api("/api/inbox")).json()) as {
      dispatch_blocks: Array<{
        id: string;
        status: string;
        by?: string;
        actor?: string;
        reason: string;
        at: string;
      }>;
    };
    const entry = inbox.dispatch_blocks.find((x) => x.id === "WS-0001");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      status: "in_progress",
      by: holderSid,
      actor: "agent",
      reason: "needs rpi5 hardware this machine lacks",
    });
    expect(entry!.at).toBeTruthy();
  });

  it("the dispatcher refuses the blocked item; the human's unblock restores it exactly like a human-set block", async () => {
    // hand the item back → ready; the block persists past release
    expect(
      (
        await call("POST", "/agent/release/WS-0001", {
          token: holderToken,
          body: { note: "hand back — keep it out of dispatch" },
        })
      ).status,
    ).toBe(200);
    expect(ops().index.get("WS-0001")!.meta.status).toBe("ready");
    expect(ops().index.get("WS-0001")!.meta.dispatch_blocked).toBeDefined();

    // a ready+blocked item is a work candidate the admission gate refuses —
    // the same refusal reason a human-set block shows
    const prev = wsr.ws.config.dispatch;
    wsr.ws.config.dispatch = {
      enabled: true,
      agents: [{ role: "coder", command: "sleep 30" }],
    } as typeof prev;
    try {
      const status = (await (await api("/api/dispatch")).json()) as {
        matched: Array<{
          id: string;
          blocked?: boolean;
          admission?: { ok: boolean; reasons: string[] };
        }>;
      };
      const entry = status.matched.find((c) => c.id === "WS-0001");
      expect(entry).toBeDefined();
      expect(entry!.blocked).toBe(true);
      expect(entry!.admission?.ok).toBe(false);
      expect(entry!.admission?.reasons.join(" ")).toContain(
        "dispatch_blocked: needs rpi5 hardware this machine lacks",
      );
    } finally {
      wsr.ws.config.dispatch = prev;
    }

    // only the human's lever lifts it — an agent session on the lever is refused
    expect(
      (
        await api("/api/dispatch", {
          method: "POST",
          headers: { "content-type": "application/json", "x-te-session": "agent-x" },
          body: JSON.stringify({ unblock: { id: "WS-0001" } }),
        })
      ).status,
    ).toBe(403);
    const unblock = await api("/api/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unblock: { id: "WS-0001" } }),
    });
    expect(unblock.status).toBe(200);
    expect(ops().index.get("WS-0001")!.meta.dispatch_blocked).toBeUndefined();
    // and the inbox entry is gone with it
    const inbox = (await (await api("/api/inbox")).json()) as {
      dispatch_blocks: Array<{ id: string }>;
    };
    expect(inbox.dispatch_blocks.find((x) => x.id === "WS-0001")).toBeUndefined();
  });
});
