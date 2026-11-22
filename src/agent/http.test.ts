import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { PlansStore } from "../daemon/store/store.js";
import { PlansWatcher } from "../daemon/watch/watch.js";
import { resolveWorkspace } from "../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../daemon/server/server.js";
import type { DaemonCtx } from "../daemon/server/context.js";
import { SessionRegistry } from "../daemon/sessions/sessions.js";
import { EventBus } from "../daemon/api/events.js";
import { registerAgentRoutes, SESSION_HEADER } from "./http.js";
import { WorkspaceOps } from "../daemon/api/ops.js";

/**
 * Plain-HTTP agent API: the protocol an AI with only curl and a URL can use.
 * Same handlers as the MCP tools, so these tests focus on the HTTP layer —
 * discovery, sessions, arg parsing, status codes, and the browser guards.
 */

let home: string;
let plans: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let watcher: PlansWatcher;

const url = (p: string) => `${daemon.url}${p}`;
const dirty = () =>
  execFileSync("git", ["status", "--porcelain"], { cwd: plans, encoding: "utf8" }).trim();

async function call(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(url(path), {
    method,
    headers: {
      ...(opts.token ? { [SESSION_HEADER]: opts.token } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, text: await res.text() };
}

async function hello(agent: string): Promise<string> {
  const r = await call("POST", "/agent/hello", { body: { agent } });
  expect(r.status).toBe(200);
  const token = /^token (\S+)/.exec(r.text)?.[1];
  expect(token).toBeDefined();
  return token!;
}

/** Raw request with a forged Host header (fetch forbids setting Host). */
function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: daemon.port, path, method: "GET", headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-agent-http-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
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
  writeFileSync(
    join(plans, "items", "WS", "WS-0005.md"),
    `---\nid: WS-0005\ntype: task\ntitle: reviewable task\nstatus: ready\nversion: 1\ntargets: ["@self:src/f5.ts"]\n---\n\n## Summary\nx\n`,
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0006.md"),
    `---\nid: WS-0006\ntype: task\ntitle: tiered task\nstatus: ready\nversion: 1\ntier: standard\ntargets: ["@self:src/f6.ts"]\n---\n\n## Summary\nx\n`,
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0004.md"),
    `---\nid: WS-0004\ntype: epic\ntitle: epic 4\nstatus: ready\nversion: 1\n---\n\n## Summary\nplan\n`,
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0007.md"),
    `---\nid: WS-0007\ntype: task\ntitle: lesson task\nstatus: draft\nversion: 1\ndomains: [test-domain]\n---\n\n## Summary\nx\n`,
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0008.md"),
    `---\nid: WS-0008\ntype: task\ntitle: provides source\nstatus: ready\nversion: 1\ntier: heavy\ntargets: ["@self:src/f8.ts"]\n---\n\n## Summary\nx\n`,
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0009.md"),
    `---\nid: WS-0009\ntype: task\ntitle: dependent task\nstatus: draft\nversion: 1\ndepends_on: [WS-0008]\n---\n\n## Summary\nx\n`,
  );
  // GL-0324: peer questions — WS-0015 and WS-0016 get claimed + peer-asked in the tests
  for (const n of ["0015", "0016"]) {
    const id = `WS-${n}`;
    writeFileSync(
      join(plans, "items", "WS", `${id}.md`),
      `---\nid: ${id}\ntype: task\ntitle: peer task ${n}\nstatus: ready\nversion: 1\ntargets: ["@self:src/p${n}.ts"]\n---\n\n## Summary\nx\n`,
    );
  }
  // GL-0326: Touches-path overlap — WS-0010/WS-0011 share a path, WS-0012 is
  // done and WS-0014 dropped (not counted), WS-0013 names another repo
  for (const [n, status, touches] of [
    ["0010", "ready", "self: src/shared.ts"],
    ["0011", "ready", "self: src/shared.ts"],
    ["0012", "done", "self: src/shared.ts"],
    ["0013", "ready", "other: src/shared.ts"],
    ["0014", "dropped", "self: src/shared.ts"],
  ] as const) {
    const id = `WS-${n}`;
    writeFileSync(
      join(plans, "items", "WS", `${id}.md`),
      `---\nid: ${id}\ntype: task\ntitle: overlap ${n}\nstatus: ${status}\nversion: 1\n${n === "0010" ? 'targets: ["@self:src/t10.ts"]\n' : ""}---\n\n**Touches:** ${touches}\n\n## Summary\nx\n`,
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
  watcher = new PlansWatcher(store, { debounceMs: 50 });
  ctx = {
    home,
    machine: "test",
    workspaces: new Map([["ws", { ws, store, watcher }]]),
    sessions: new SessionRegistry("test"),
    bus: new EventBus(),
  };
  await watcher.start();
  daemon = await startDaemon({ home, register: (app) => registerAgentRoutes(app, ctx) });
}, 30_000);

afterAll(async () => {
  await watcher.close();
  await daemon.close();
  rmSync(home, { recursive: true, force: true });

  it("tiers: hidden/refused below tier; a stuck holder hands off and a fresh session reads the note", async () => {
    const light = (await call("POST", "/agent/hello", { body: { agent: "scout", tier: "light" } }))
      .text;
    expect(light).toMatch(/tier light/);
    const lt = /^token (\S+)/.exec(light)![1];
    expect((await call("GET", "/agent/next?limit=20", { token: lt })).text).not.toContain(
      "WS-0006",
    );
    const refused = await call("POST", "/agent/claim/WS-0006", { token: lt });
    expect(refused.status).toBe(409);
    expect(refused.text).toContain("standard-tier");
    const st = /^token (\S+)/.exec(
      (await call("POST", "/agent/hello", { body: { agent: "forge", tier: "standard" } })).text,
    )![1];
    expect(
      (await call("GET", "/agent/next?limit=20", { token: st })).text.split("\n")[0],
    ).toContain("WS-0006");
    expect((await call("POST", "/agent/claim/WS-0006", { token: st })).text).toMatch(/^claimed/);
    const h = await call("POST", "/agent/handoff/WS-0006", {
      token: st,
      body: {
        problem: "build fails: X undefined",
        tried: "renamed import",
        next: "check the barrel export",
      },
    });
    expect(h.text).toMatch(/^handed off WS-0006 → ready \(attempt 1, tier standard\)/);
    const st2 = /^token (\S+)/.exec(
      (await call("POST", "/agent/hello", { body: { agent: "forge", tier: "standard" } })).text,
    )![1];
    const brief = (await call("GET", "/agent/brief/WS-0006", { token: st2 })).text;
    expect(brief).toContain("1 failed attempt");
    expect(brief).toContain("check the barrel export");
  });
});

describe("plain-HTTP agent API", () => {
  it("GET /agent describes the protocol without any token", async () => {
    const r = await call("GET", "/agent");
    expect(r.status).toBe(200);
    expect(r.text).toContain("RULES");
    expect(r.text).toContain(`${daemon.url}/agent/hello`);
    for (const tool of ["next", "brief", "claim", "log", "ask", "submit", "propose"]) {
      expect(r.text).toMatch(new RegExp(`^  ${tool}\\s`, "m"));
    }
    // GL-0346: the guide names the human layer's fields and their word limits
    expect(r.text).toContain("summary is required");
    expect(r.text).toContain("max 40 words");   // ask_human problem
    expect(r.text).toContain("max 25 words");   // review summary
    expect(r.text).toContain("ask_human");
    expect(r.text).toContain("walkthrough is\n     required on heavy-tier tasks only");
  });

  it("refuses browsers: any Origin header, or a non-loopback Host (DNS rebinding)", async () => {
    const o = await call("GET", "/agent", { headers: { origin: "https://evil.example" } });
    expect(o.status).toBe(403);
    expect(await rawGet("/agent", "evil.example")).toBe(403);
    expect(await rawGet("/agent", `localhost:${daemon.port}`)).toBe(200);
  });

  it("calls without a session token are 401 with a hint", async () => {
    const r = await call("GET", "/agent/next");
    expect(r.status).toBe(401);
    expect(r.text).toContain("POST /agent/hello");
  });

  it("hello with model lowercases and echoes it (GL-0360); no model still works", async () => {
    const h = await call("POST", "/agent/hello", {
      body: { agent: "claude", model: "Claude-Sonnet-5-5" },
    });
    expect(h.status).toBe(200);
    expect(h.text).toContain("model claude-sonnet-5-5");
    // model flows into submits/reviews — covered at the machine level
    const plain = await hello("gemini-cli");
    expect(plain).toBeTruthy();
  });

  it("full loop: hello → next → brief → claim → log → ask; errors map to HTTP codes", async () => {
    const t = await hello("gemini-cli");
    const next = await call("GET", "/agent/next?limit=2", { token: t });
    expect(next.status).toBe(200);
    expect(next.text.trim().split("\n")).toHaveLength(2); // query limit coerced to a number
    const brief = await call("GET", "/agent/brief/WS-0001", { token: t });
    expect(brief.text).toContain("WS-0001");
    expect((await call("POST", "/agent/claim/WS-0001", { token: t })).text).toMatch(
      /^claimed WS-0001/,
    );
    const log = await call("POST", "/agent/log/WS-0001", { token: t, body: { note: "halfway" } });
    expect(log.text.trim()).toBe("logged WS-0001");
    const ask = await call("POST", "/agent/ask/WS-0001", {
      token: t,
      body: { question: "A or B?", options: ["A", "B"] },
    });
    expect(ask.status).toBe(200);

    // another agent can't touch it; a missing item is 404; bad args are 400
    const other = await hello("cursor");
    expect((await call("POST", "/agent/claim/WS-0001", { token: other })).status).toBe(409);
    expect(
      (await call("POST", "/agent/log/WS-0001", { token: other, body: { note: "x" } })).status,
    ).toBe(403);
    expect((await call("GET", "/agent/brief/WS-9999", { token: other })).status).toBe(404);
    const bad = await call("POST", "/agent/log/WS-0001", { token: t, body: {} });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("note");
    expect((await call("POST", "/agent/nope", { token: t })).status).toBe(404);
    await new Promise((r) => setTimeout(r, 300));
    expect(dirty()).toBe("");
  });

  it("works with plain curl (form content-type body, path id)", async () => {
    // async: the daemon under test runs in this process — a sync spawn would
    // block the event loop it needs to answer curl
    const curl = async (...args: string[]) =>
      (await promisify(execFile)("curl", ["-s", ...args])).stdout;
    const t = await hello("claude-code");
    const out = await curl(
      "-X",
      "POST",
      url("/agent/claim/WS-0002"),
      "-H",
      `${SESSION_HEADER}: ${t}`,
    );
    expect(out).toMatch(/^claimed WS-0002/);
    const log = await curl(
      url("/agent/log/WS-0002"),
      "-H",
      `${SESSION_HEADER}: ${t}`,
      "-d",
      '{"note":"via curl"}',
    );
    expect(log.trim()).toBe("logged WS-0002");
  });

  it("bye ends the session; hello again resumes the claim", async () => {
    const t1 = await hello("devin");
    expect((await call("POST", "/agent/claim/WS-0003", { token: t1 })).text).toMatch(/^claimed/);
    expect((await call("POST", "/agent/bye", { token: t1 })).text.trim()).toBe("bye");
    expect((await call("GET", "/agent/next", { token: t1 })).status).toBe(401);
    const h = await call("POST", "/agent/hello", { body: { agent: "devin" } });
    expect(h.text).toContain("resume: WS-0003");
    const t2 = /^token (\S+)/.exec(h.text)![1];
    expect(
      (await call("POST", "/agent/log/WS-0003", { token: t2, body: { note: "resumed" } })).status,
    ).toBe(200);
  });

  it("a live session's claims are not taken by a second hello of the same agent", async () => {
    // WS-0001 is held by the live gemini-cli session from the full-loop test
    const h = await call("POST", "/agent/hello", { body: { agent: "gemini-cli" } });
    expect(h.text).not.toContain("WS-0001");
  });

  it("AI peer review: a second session reviews a submission, issues sends broken work back, capped at 2 in a row", async () => {
    // the guide knows the tools
    const guide = await call("GET", "/agent");
    for (const tool of ["review", "bounce", "withdraw", "supersede"]) {
      expect(guide.text).toMatch(new RegExp(`^  ${tool}\\s`, "m"));
    }
    const holder = await hello("worker");
    const reviewer = await hello("auditor");
    expect((await call("POST", "/agent/claim/WS-0005", { token: holder })).text).toMatch(
      /^claimed/,
    );
    // what and how are required — the human's two short lines
    const noWhat = await call("POST", "/agent/submit/WS-0005", {
      token: holder,
      body: { tests: "1 passed" },
    });
    expect(noWhat.status).toBe(400);
    expect(noWhat.text).toContain("what");
    expect(
      (
        await call("POST", "/agent/submit/WS-0005", {
          token: holder,
          body: { tests: "1 passed", walkthrough: "Changed the counter reset path." , what: "task done", how: "ran the steps" },
        })
      ).text,
    ).toMatch(/^in_review/);
    // summary is required — a review without it is a usage error, not a marker
    const noSummary = await call("POST", "/agent/review/WS-0005", {
      token: reviewer,
      body: { verdict: "ok" },
    });
    expect(noSummary.status).toBe(400);
    expect(noSummary.text).toContain("summary");
    // the holder may not review its own submission
    const own = await call("POST", "/agent/review/WS-0005", {
      token: holder,
      body: { verdict: "ok", summary: "looks fine" },
    });
    expect(own.status).toBe(403);
    expect(own.text).toContain("own submission");
    // a reviewer records a verdict — advisory, the item stays in review
    const ok = await call("POST", "/agent/review/WS-0005", {
      token: reviewer,
      body: {
        verdict: "ok",
        summary: "The change does what the task asked.",
        note: "evidence checks out",
      },
    });
    expect(ok.text.trim()).toBe("reviewed WS-0005: ok");
    expect((await call("GET", "/agent/brief/WS-0005", { token: reviewer })).text).toContain(
      "in_review",
    );
    // broken work goes back to the holder on an issues verdict (claim kept, holder resubmits)
    for (let n = 1; n <= 2; n++) {
      const back = await call("POST", "/agent/review/WS-0005", {
        token: reviewer,
        body: { verdict: "issues", note: `tests red (${n})`, summary: `The tests are failing (${n}).`, ask_human: {
                  problem: "tests are red after the change",
                  recommendation: "revert or fix the failing path, then resubmit",
                  options: ["send it back", "I will check"],
                } },
      });
      expect(back.status).toBe(200);
      expect(back.text).toContain("sent back to the holder");
      const resubmit = await call("POST", "/agent/submit/WS-0005", {
        token: holder,
        body: { notes: "fixed", walkthrough: "Fixed the red tests.", what: "task done", how: "ran the steps" },
      });
      expect(resubmit.text).toMatch(/^in_review/);
    }
    // capped at 2: a third issues verdict stays in_review for the human —
    // and the /agent/bounce compat alias maps to the same review call
    const capped = await call("POST", "/agent/bounce/WS-0005", {
      token: reviewer,
      body: { reason: "still red", summary: "The tests still fail.", ask_human: {
                problem: "tests are red after the change",
                recommendation: "revert or fix the failing path, then resubmit",
                options: ["send it back", "I will check"],
              } },
    });
    expect(capped.status).toBe(200);
    expect(capped.text).toContain("WS-0005");
    const brief = await call("GET", "/agent/brief/WS-0005", { token: reviewer });
    expect(brief.text).toContain("in_review");
    // the holder pulls its own submission back — another session is refused
    const steal = await call("POST", "/agent/withdraw/WS-0005", { token: reviewer });
    expect(steal.status).toBe(403);
    const back = await call("POST", "/agent/withdraw/WS-0005", { token: holder });
    expect(back.status).toBe(200);
    expect(back.text).toContain("in_progress");
    expect((await call("GET", "/agent/brief/WS-0005", { token: holder })).text).toContain(
      "in_progress",
    );
    // put it back in review so the next tests find the pool they expect
    expect(
      (
        await call("POST", "/agent/submit/WS-0005", {
          token: holder,
          body: { notes: "resubmitted after withdraw", walkthrough: "Same work.", what: "task done", how: "ran the steps" },
        })
      ).text,
    ).toMatch(/^in_review/);
    // DE-0251: the withdraw did not reset the send-back cap — this issues
    // verdict is the fourth in a row (≥ cap), so the item stays in_review
    // for the human instead of going back to the holder
    const afterWithdraw = await call("POST", "/agent/review/WS-0005", {
      token: reviewer,
      body: { verdict: "issues", note: "red again", summary: "The tests fail again after the resubmit.", ask_human: {
                problem: "tests are red after the change",
                recommendation: "revert or fix the failing path, then resubmit",
                options: ["send it back", "I will check"],
              } },
    });
    expect(afterWithdraw.status).toBe(200);
    expect(afterWithdraw.text).not.toContain("sent back to the holder");
    expect((await call("GET", "/agent/brief/WS-0005", { token: reviewer })).text).toContain(
      "in_review",
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(dirty()).toBe("");
  });

  it("epics are plans: next skips them and claim is refused", async () => {
    const t = await hello("epic-check");
    const next = await call("GET", "/agent/next?limit=10", { token: t });
    expect(next.text).not.toContain("WS-0004");
    const claim = await call("POST", "/agent/claim/WS-0004", { token: t });
    expect(claim.status).toBe(409);
    expect(claim.text).toContain("epics are plans");
    // brief still works — epics are readable, just not claimable
    const brief = await call("GET", "/agent/brief/WS-0004", { token: t });
    expect(brief.status).toBe(200);
    expect(brief.text).toContain("WS-0004");
    expect(brief.text).toContain("plan:");
  });

  it("roles: hello takes one — reviewer gets others' submissions, coder/no-role the ready pool, bad role is USAGE", async () => {
    // an unknown role is refused with USAGE (GL-0323)
    const bad = await call("POST", "/agent/hello", { body: { agent: "joker", role: "king" } });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("USAGE");

    // no role: next is the ready pool, unchanged — no in_review items, no epics
    const plain = await hello("plain");
    const plainNext = (await call("GET", "/agent/next?limit=20", { token: plain })).text;
    expect(plainNext).toContain("WS-0006"); // handed off to ready in the tier test
    expect(plainNext).not.toContain("WS-0005"); // in_review
    expect(plainNext).not.toContain("WS-0004"); // epic

    // coder behaves the same as no role
    const coder = await hello("builder");
    void coder;
    const coderText = (
      await call("POST", "/agent/hello", { body: { agent: "builder", role: "coder" } })
    ).text;
    const ct = /^token (\S+)/.exec(coderText)![1];
    expect((await call("GET", "/agent/next?limit=20", { token: ct })).text).toContain("WS-0006");

    // reviewer: only in_review items it did not submit — WS-0005 (worker's)
    const revText = (
      await call("POST", "/agent/hello", { body: { agent: "peer", role: "reviewer" } })
    ).text;
    expect(revText).toContain("role reviewer");
    const rev = /^token (\S+)/.exec(revText)![1];
    let rNext = (await call("GET", "/agent/next?limit=20", { token: rev })).text;
    expect(rNext).toContain("WS-0005");
    expect(rNext).not.toContain("WS-0006");

    // its own submission leaves the pool once it becomes the holder
    expect((await call("POST", "/agent/claim/WS-0006", { token: rev })).text).toMatch(/^claimed/);
    expect(
      (
        await call("POST", "/agent/submit/WS-0006", {
          token: rev,
          body: { tests: "1 passed", walkthrough: "Changed the thing." , what: "task done", how: "ran the steps" },
        })
      ).text,
    ).toMatch(/^in_review/);
    rNext = (await call("GET", "/agent/next?limit=20", { token: rev })).text;
    expect(rNext).toContain("WS-0005");
    expect(rNext).not.toContain("WS-0006");

    // planner: the fixture has no unreferenced ideas or light drafts — empty pool
    const planText = (
      await call("POST", "/agent/hello", { body: { agent: "pm", role: "planner" } })
    ).text;
    const pt = /^token (\S+)/.exec(planText)![1];
    expect((await call("GET", "/agent/next?limit=20", { token: pt })).text).toContain(
      "nothing ready",
    );
  });

  it("touches overlap: claim succeeds but warns, brief warns; done/dropped/other repos don't count", async () => {
    const t = await hello("overlapper");
    // two ready items share self: src/shared.ts — claiming one warns about the other
    const claim = await call("POST", "/agent/claim/WS-0010", { token: t });
    expect(claim.status).toBe(200);
    expect(claim.text).toMatch(/^claimed WS-0010/);
    expect(claim.text).toContain("warn: WS-0011 touches self: src/shared.ts");
    expect(claim.text).not.toContain("WS-0012"); // done — not counted
    expect(claim.text).not.toContain("WS-0014"); // dropped — not counted
    expect(claim.text).not.toContain("WS-0013"); // same path, different repo
    // brief shows the same warning (WS-0010 is now in_progress, still counted)
    const brief = await call("GET", "/agent/brief/WS-0011", { token: t });
    expect(brief.text).toContain("warn: WS-0010 touches self: src/shared.ts");
  });
});

describe("shared lessons per domain (GL-0322)", () => {
  it("an agent lesson waits in the inbox; the human accepts it; brief shows it", async () => {
    const t = await hello("prof");

    // TE-0182: the lesson lands as a pending candidate — no line yet
    const ok = await call("POST", "/agent/lesson", {
      token: t,
      body: { domain: "test-domain", text: "run npm build before npm test — dist must be fresh" },
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("lesson #1 for #test-domain waits in the inbox");
    expect(existsSync(join(plans, "lessons", "test-domain.md"))).toBe(false);

    // the human accepts it — the line lands under the offering session
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions, wsr.links, ctx.home);
    const settled = await ops.settleLesson(1, "approved");
    expect(settled.domain).toBe("test-domain");
    const file = readFileSync(join(plans, "lessons", "test-domain.md"), "utf8");
    expect(file).toMatch(/- \d{4}-\d{2}-\d{2} prof@test#\w+ — run npm build before npm test/);

    // an unknown domain is refused with INVALID
    const bad = await call("POST", "/agent/lesson", {
      token: t,
      body: { domain: "no-such-domain", text: "x" },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.text).toContain("INVALID");

    // brief of an item with that domain lists the lesson
    const brief = await call("GET", "/agent/brief/WS-0007", { token: t });
    expect(brief.text).toContain("run npm build before npm test");
  });
});

describe("publish task outputs (GL-0325)", () => {
  it("submit with provides lists the lines in a dependent's brief dep block", async () => {
    const t = /^token (\S+)/.exec(
      (await call("POST", "/agent/hello", { body: { agent: "big", tier: "heavy" } })).text,
    )![1];
    expect((await call("POST", "/agent/claim/WS-0008", { token: t })).text).toMatch(/^claimed/);
    const sub = await call("POST", "/agent/submit/WS-0008", {
      token: t,
      body: {
        walkthrough: "added the things",
        provides: ["GET /api/lessons route", "lessons/<domain>.md files"],
        tests: "4 passed",
        what: "task done", how: "ran the steps",
      },
    });
    expect(sub.text).toMatch(/^in_review/);
    // the Evidence lines landed in the item file
    const file = readFileSync(join(plans, "items", "WS", "WS-0008.md"), "utf8");
    expect(file).toContain("- provides: GET /api/lessons route");
    expect(file).toContain("- provides: lessons/<domain>.md files");
    // and a dependent's brief lists them under the dep outcome
    const brief = await call("GET", "/agent/brief/WS-0009", { token: t });
    expect(brief.text).toContain("dep WS-0008 in_review");
    expect(brief.text).toContain("provides: GET /api/lessons route");
    expect(brief.text).toContain("provides: lessons/<domain>.md files");
  });
});

describe("peer questions (GL-0324)", () => {
  it("a peer answers before the human: question stays with the holder, answer lands in brief", async () => {
    const holder = await hello("q-holder");
    expect((await call("POST", "/agent/claim/WS-0015", { token: holder })).text).toMatch(
      /^claimed/,
    );
    const ask = await call("POST", "/agent/ask/WS-0015", {
      token: holder,
      body: { question: "which field?", to: "peer" },
    });
    expect(ask.status).toBe(200);
    expect(ask.text).toContain("peer question on WS-0015");
    // the item stays with its holder — still in_progress, still theirs
    const hb = await call("GET", "/agent/brief/WS-0015", { token: holder });
    expect(hb.text).toContain("WS-0015 in_progress");
    expect(hb.text).toContain("open peer question");
    // the holder cannot answer its own question
    expect(
      (await call("POST", "/agent/answer_peer/WS-0015", { token: holder, body: { answer: "me" } }))
        .status,
    ).toBe(403);
    // a lower-tier session cannot answer a standard-tier question
    const light = /^token (\S+)/.exec(
      (await call("POST", "/agent/hello", { body: { agent: "lite", tier: "light" } })).text,
    )![1];
    expect(
      (await call("POST", "/agent/answer_peer/WS-0015", { token: light, body: { answer: "x" } }))
        .status,
    ).toBe(403);
    // an eligible peer sees the question in next and answers it
    const peer = /^token (\S+)/.exec(
      (await call("POST", "/agent/hello", { body: { agent: "peer", tier: "standard" } })).text,
    )![1];
    const next = (await call("GET", "/agent/next?limit=20", { token: peer })).text;
    expect(next).toContain("peer questions");
    expect(next).toContain("WS-0015");
    const ans = await call("POST", "/agent/answer_peer/WS-0015", {
      token: peer,
      body: { answer: "use field X" },
    });
    expect(ans.status).toBe(200);
    expect(ans.text).toContain("answered peer question");
    // the holder sees the answer in brief; it also landed in ## Notes
    const hb2 = await call("GET", "/agent/brief/WS-0015", { token: holder });
    expect(hb2.text).toContain("peer answer by");
    expect(hb2.text).toContain("use field X");
    const file = readFileSync(join(plans, "items", "WS", "WS-0015.md"), "utf8");
    expect(file).toContain("## Notes");
    expect(file).toContain("use field X");
  });

  it("with no answer after peer_answer_after the item goes to waiting (fake clock)", async () => {
    const holder = await hello("q-holder-2");
    expect((await call("POST", "/agent/claim/WS-0016", { token: holder })).text).toMatch(
      /^claimed/,
    );
    await call("POST", "/agent/ask/WS-0016", {
      token: holder,
      body: { question: "stale?", to: "peer" },
    });
    const wsr = ctx.workspaces.get("ws")!;
    const ops = new WorkspaceOps(wsr, ctx.sessions, wsr.links, ctx.home);
    // fresh question — nothing moves (default peer_answer_after is 30m)
    expect(await ops.peerAnswerSweep(new Date())).toEqual([]);
    // 31 minutes later — the question becomes the human's
    expect(await ops.peerAnswerSweep(new Date(Date.now() + 31 * 60_000))).toEqual(["WS-0016"]);
    const brief = (await call("GET", "/agent/brief/WS-0016", { token: holder })).text;
    expect(brief).toContain("WS-0016 waiting");
    expect(brief).toContain("open question for the human");
  });
});

describe("role overview (TE-0196)", () => {
  it("overview?role= gives the role's pool, counts and top ids — compact, filtered like next", async () => {
    const viewer = await hello("ov-agent");

    // coder pool: ready tasks the session can claim (epic excluded, free targets)
    const coder = await call("GET", "/agent/overview?role=coder", { token: viewer });
    expect(coder.status).toBe(200);
    expect(coder.text.split("\n").filter(Boolean).length).toBeLessThanOrEqual(15);
    expect(coder.text).toContain("claimable:");
    expect(coder.text).toMatch(/^top: /m);

    // reviewer pool: a submission by this session never lists for it
    const wsr = ctx.workspaces.get("ws")!;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const { ids } = await wsr.store.createItems([{ type: "task", title: "overview review me" }], human);
    const reviewable = ids[0];
    const ops = new WorkspaceOps(wsr, ctx.sessions, wsr.links, ctx.home);
    await ops.approve(reviewable);
    const sub = await hello("ov-submitter");
    expect((await call("POST", `/agent/claim/${reviewable}`, { token: sub })).text).toMatch(/^claimed/);
    const sub_r = await call("POST", `/agent/submit/${reviewable}`, {
      token: sub,
      body: { summary: "made the change" },
    });
    expect(sub_r.status).toBe(200);
    const own = await call("GET", "/agent/overview?role=reviewer", { token: sub });
    expect(own.text).not.toContain(reviewable);
    const rev = await call("GET", "/agent/overview?role=reviewer", { token: viewer });
    expect(rev.text).toMatch(/^reviewable: \d+ \(light \d+, standard \d+, heavy \d+, untiered \d+\)$/m);
    expect(rev.text).toContain(reviewable);
    expect(rev.text.split("\n").filter(Boolean).length).toBeLessThanOrEqual(15);

    // planner pool: sources + drafts to vet
    const plan = await call("GET", "/agent/overview?role=planner", { token: viewer });
    expect(plan.text).toContain("to plan:");

    // rules endpoint: the protocol lines hello prints
    const rules = await call("GET", "/agent/rules", { token: viewer });
    expect(rules.status).toBe(200);
    expect(rules.text).toContain("claim before code");
    expect(rules.text).toContain("never push");
  });
});

describe("fixed port", () => {
  it("falls back to a random port when the preferred one is taken", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const busy = (blocker.address() as { port: number }).port;
    const h2 = mkdtempSync(join(tmpdir(), "te-port-"));
    const d = await startDaemon({ home: h2, port: busy });
    expect(d.portFallback).toBe(true);
    expect(d.port).not.toBe(busy);
    await d.close();
    blocker.close();
    rmSync(h2, { recursive: true, force: true });
  });
});
