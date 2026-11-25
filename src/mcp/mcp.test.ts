import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PlansStore } from "../daemon/store/store.js";
import { resolveWorkspace } from "../core/config/config.js";
import { startDaemon, type DaemonHandle } from "../daemon/server/server.js";
import type { DaemonCtx } from "../daemon/server/context.js";
import { SessionRegistry } from "../daemon/sessions/sessions.js";
import { EventBus } from "../daemon/api/events.js";
import { registerMcpRoutes } from "./server/mcp.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerApiRoutes } from "../daemon/api/api.js";

let home: string;
let plans: string;
let ctx: DaemonCtx;
let daemon: DaemonHandle;
let client: Client;

function item(id: string, status = "ready", extra = "") {
  return `---\nid: ${id}\ntype: task\ntitle: ${id}\nstatus: ${status}\nversion: 1\n${extra}---\n\n## Summary\n${id}\n`;
}

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-mcp-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nresources:\n  self: { kind: git, path: . }\n",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  writeFileSync(join(plans, "items", "WS", "WS-0001.md"), item("WS-0001", "ready", 'targets: ["@self:src/a.ts"]\n'));
  writeFileSync(join(plans, "items", "WS", "WS-0002.md"), item("WS-0002", "ready", 'targets: ["@self:src/b.ts"]\n'));
  writeFileSync(join(plans, "items", "WS", "WS-0003.md"), item("WS-0003", "ready", 'targets: ["@self:src/a.ts"]\ndepends_on: [WS-0001]\n'));
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "test");
  await store.init();
  ctx = {
    home,
    machine: "test",
    workspaces: new Map([["ws", { ws, store }]]),
    sessions: new SessionRegistry("test"),
    bus: new EventBus(),
  };

  daemon = await startDaemon({
    home,
    register: (app) => {
      registerMcpRoutes(app, {
        ctx,
        tools: (server, binding, c) => {
          registerReadTools(server, binding, c);
          registerWriteTools(server, binding, c);
        },
      });
      registerApiRoutes(app, ctx);
    },
  });

  client = new Client({ name: "test-agent", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${daemon.token}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close().catch(() => {});
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("MCP tools (MC-0001/2/3)", () => {
  it("lists all tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "answer_peer",
        "ask",
        "attach",
        "bounce",
        "brief",
        "capture",
        "claim",
        "detach",
        "dispatch_block",
        "edit",
        "flag_drop",
        "graph",
        "handoff",
        "hello",
        "history",
        "lesson",
        "log",
        "next",
        "note",
        "overview",
        "promote",
        "propose",
        "query",
        "release",
        "repo_context",
        "rescope",
        "review",
        "rules",
        "search",
        "simple",
        "submit",
        "supersede",
        "vet",
        "withdraw",
      ].sort(),
    );
  });

  it("hello returns session + resume hint", async () => {
    const r = await client.callTool({ name: "hello", arguments: { agent: "claude" } });
    const t = text(r as never);
    expect(t).toMatch(/session claude@test#[0-9a-f]{4}/);
    expect(t).toContain("workspace ws");
    // the rules reach every session, whatever its instruction files say
    expect(t).toMatch(/^rules: claim before code · new tasks only via propose/m);
  });

  it("server instructions carry the protocol and authoring rules", () => {
    const ins = client.getInstructions() ?? "";
    expect(ins).toMatch(/hello \(once\) → next → brief/);
    expect(ins).toContain("Never edit or remove the \"te:\" frontmatter line");
  });

  it("write tools require hello first (new binding)", async () => {
    const c2 = new Client({ name: "other", version: "0.0.1" });
    const tr = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${daemon.token}` } },
    });
    await c2.connect(tr);
    const r = await c2.callTool({ name: "claim", arguments: { id: "WS-0002" } });
    expect(text(r as never)).toMatch(/ERROR NO_SESSION/);
    await c2.close();
  });

  it("next lists ready items with free targets only", async () => {
    const r = await client.callTool({ name: "next", arguments: { limit: 5 } });
    const t = text(r as never);
    expect(t).toContain("WS-0001");
    expect(t).toContain("WS-0002");
    // WS-0003 is blocked by WS-0001 — must not appear
    expect(t).not.toContain("WS-0003");
  });

  it("brief shows summary, target resolution, dep status", async () => {
    const r = await client.callTool({ name: "brief", arguments: { id: "WS-0003" } });
    const t = text(r as never);
    expect(t).toContain("WS-0003");
    expect(t).toContain("dep WS-0001 ready");
    expect(t).toContain("target @self:src/a.ts → git");
  });

  it("claim → log → ask lifecycle with compact output", async () => {
    const c = await client.callTool({ name: "claim", arguments: { id: "WS-0001" } });
    expect(text(c as never)).toMatch(/^claimed WS-0001 v2/);
    expect(existsSync(join(plans, "claims", "WS-0001.yaml"))).toBe(true);

    // overlapping target — second agent's claim is refused
    const c2 = new Client({ name: "agent2", version: "0.0.1" });
    const tr = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${daemon.token}` } },
    });
    await c2.connect(tr);
    await c2.callTool({ name: "hello", arguments: { agent: "codex" } });
    const refuse = await c2.callTool({ name: "claim", arguments: { id: "WS-0003" } });
    // WS-0003 is blocked anyway; refuse with a target-free item instead
    expect(text(refuse as never)).toMatch(/ERROR/);
    await c2.close();

    const l = await client.callTool({ name: "log", arguments: { id: "WS-0001", note: "wip" } });
    expect(text(l as never)).toBe("logged WS-0001");
    const a = await client.callTool({
      name: "ask",
      arguments: { id: "WS-0001", question: "which api?", options: ["a", "b"] },
    });
    expect(text(a as never)).toContain("waiting WS-0001");
  });

  it("submit → human accept via REST completes lifecycle", async () => {
    // answer the question first via REST (human)
    const ans = await fetch(`${daemon.url}/api/items/WS-0001/answer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "use api a" }),
    });
    expect(ans.status).toBe(200);
    const s = await client.callTool({
      name: "submit",
      arguments: { id: "WS-0001", commits: ["abc123"], tests: "npm test ✓", walkthrough: "added the retry loop", what: "task done", how: "ran the steps" },
    });
    expect(text(s as never)).toBe("in_review WS-0001");
    const acc = await fetch(`${daemon.url}/api/items/WS-0001/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(acc.status).toBe(200);
    const store = ctx.workspaces.get("ws")!.store;
    expect(store.idx.get("WS-0001")!.meta.status).toBe("done");
    // claim file removed on completion
    expect(existsSync(join(plans, "claims", "WS-0001.yaml"))).toBe(false);
  });

  it("query + graph + propose work", async () => {
    const q = await client.callTool({ name: "query", arguments: { status: "ready" } });
    expect(text(q as never)).toContain("WS-0002");
    const g = await client.callTool({ name: "graph", arguments: {} });
    expect(text(g as never)).toContain("flowchart LR");
    const p = await client.callTool({
      name: "propose",
      arguments: { items: [{ title: "new thing", domains: ["meta"], project: undefined }] },
    });
    expect(text(p as never)).toMatch(/proposed WS-0004/);
    const it4 = ctx.workspaces.get("ws")!.store.idx.get("WS-0004")!;
    expect(it4.meta.status).toBe("draft");
  });

  it("release returns the item to ready", async () => {
    await client.callTool({ name: "claim", arguments: { id: "WS-0002" } });
    const r = await client.callTool({ name: "release", arguments: { id: "WS-0002" } });
    expect(text(r as never)).toContain("released WS-0002");
    expect(ctx.workspaces.get("ws")!.store.idx.get("WS-0002")!.meta.status).toBe("ready");
  });
});

describe("archived dependencies stay visible to agents", () => {
  it("brief tags an archived dep but keeps its status, so the sequence still reads right", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    const dep = store.idx.get("WS-0001")!;
    await store.perform("WS-0001", dep.meta.version, human, { type: "archive" });
    try {
      const t = text((await client.callTool({ name: "brief", arguments: { id: "WS-0003" } })) as never);
      expect(t).toMatch(/dep WS-0001 (\w+) \[archived\]/);
      expect(t).not.toMatch(/dep WS-0001 .*archived \(status/); // outcome is the real last step
      const own = text((await client.callTool({ name: "brief", arguments: { id: "WS-0001" } })) as never);
      expect(own).toMatch(/^WS-0001 \w+ \[archived\] /);
    } finally {
      const cur = store.idx.get("WS-0001")!;
      await store.perform("WS-0001", cur.meta.version, human, { type: "unarchive" });
    }
  });
});

describe("skills over MCP (SEP-2640)", () => {
  it("initialize advertises the resources capability and the skills extension", () => {
    const caps = client.getServerCapabilities()!;
    expect(caps.resources).toBeDefined();
    expect(caps.extensions).toMatchObject({ "io.modelcontextprotocol/skills": {} });
  });

  it("resources/list serves SKILL.md plus supporting files per skills/<name>", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    for (const skill of ["te-analysis", "te-discuss", "te-ops", "te-plan", "te-review", "te-tag", "te-work"]) {
      expect(uris).toContain(`skill://${skill}/SKILL.md`);
    }
    // supporting files are listed too
    expect(uris).toContain("skill://te-work/README.md");
    // entries carry name and description from the skill frontmatter
    const skillMd = resources.find((r) => r.uri === "skill://te-work/SKILL.md")!;
    expect(skillMd.name).toBe("te-work");
    expect(skillMd.description).toContain("TeamEngage");
  });

  it("resources/read returns the SKILL.md text and supporting files", async () => {
    const r = await client.readResource({ uri: "skill://te-work/SKILL.md" });
    const c = r.contents[0];
    expect(c.mimeType).toBe("text/markdown");
    expect("text" in c && c.text).toContain("name: te-work");
    const readme = await client.readResource({ uri: "skill://te-work/README.md" });
    const rc = readme.contents[0];
    expect("text" in rc && rc.text.length).toBeTruthy();
    // an unknown skill uri is an error
    await expect(client.readResource({ uri: "skill://no-such/SKILL.md" })).rejects.toThrow();
  });

  it("skills/list returns frontmatter and a sha256 manifest per skill", async () => {
    const res = await client.request(
      { method: "skills/list", params: {} } as never,
      z
        .object({
          resultType: z.string(),
          skills: z.array(
            z
              .object({
                uri: z.string(),
                frontmatter: z.record(z.string(), z.unknown()),
                resources: z.array(
                  z.object({ uri: z.string(), digest: z.string(), size: z.number() }).passthrough(),
                ),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    );
    const entry = res.skills.find((s) => s.uri === "skill://te-work/SKILL.md")!;
    expect(entry.frontmatter.name).toBe("te-work");
    expect(entry.resources[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.resources.map((f) => f.uri)).toContain("skill://te-work/README.md");
  });

  it("skills/get returns one skill's entry by uri", async () => {
    const res = await client.request(
      { method: "skills/get", params: { uri: "skill://te-plan/SKILL.md" } } as never,
      z.object({ resultType: z.string(), skill: z.object({ uri: z.string() }).passthrough() }).passthrough(),
    );
    expect(res.skill.uri).toBe("skill://te-plan/SKILL.md");
    await expect(
      client.request({ method: "skills/get", params: { uri: "skill://nope/SKILL.md" } } as never, z.object({}).passthrough()),
    ).rejects.toThrow();
  });
});

describe("domains for agents", () => {
  it("query/next filter by domain; brief and lists show #tags", async () => {
    const store = ctx.workspaces.get("ws")!.store;
    const human = { kind: "human" as const, session: "human", machine: "test" };
    await store.setDomains("WS-0003", ["mavlink", "missions"], human);
    try {
      const q = text((await client.callTool({ name: "query", arguments: { domain: "mavlink" } })) as never);
      expect(q).toMatch(/^WS-0003 .*#mavlink #missions/m);
      expect(q.split("\n")).toHaveLength(1);
      const none = text((await client.callTool({ name: "next", arguments: { domain: "nothing-here" } })) as never);
      expect(none).toBe("nothing ready");
      const b = text((await client.callTool({ name: "brief", arguments: { id: "WS-0003" } })) as never);
      expect(b).toContain("domains: #mavlink #missions");
    } finally {
      await store.setDomains("WS-0003", [], human);
    }
  });
});
