import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "./ops.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { readRepoContext, writeRepoContext } from "../../core/files/repo-context.js";
import { validate } from "../../core/validate/validate.js";

/**
 * GL-0355: one context card per repo (repos/<repo>.context.md, ≤80 lines).
 * repo_context writes a section + logs; brief shows the card for repos in
 * Touches; te validate reports a card over the limit.
 */

let home: string;
let root: string;
let plans: string;
let ops: WorkspaceOps;
let store: PlansStore;

const writeItem = (id: string, status: string, body: string) => {
  const prefix = id.split("-")[0];
  mkdirSync(join(plans, "items", prefix), { recursive: true });
  writeFileSync(
    join(plans, "items", prefix, `${id}.md`),
    `---\nid: ${id}\ntype: task\ntitle: "${id} title"\nstatus: ${status}\npriority: 2\nversion: 1\ncreated: 2026-10-01\ndomains: [teamengage]\n---\n\n${body}`,
  );
};

const fakeSession = { id: "devin@test#t01" } as Parameters<WorkspaceOps["repoContext"]>[0];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-repoctx-"));
  root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(join(plans, "workspace.yaml"), `name: ws\nprefix: WS\n`);
  for (const a of [["init", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    execFileSync("git", a, { cwd: plans });
  }

  writeItem("WS-0001", "ready", `## Summary\na task\n\n**Touches:** de_mavlink: src/**\n`);
  writeItem("WS-0002", "ready", `## Summary\nanother\n\n**Touches:** teamengage: src/**\n`);

  const ws = resolveWorkspace(root, { home });
  store = new PlansStore(ws, "test");
  await store.init();
  ops = new WorkspaceOps({ ws, store } as WorkspaceRuntime, new SessionRegistry("test"));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("writeRepoContext", () => {
  it("creates the card, then replaces one section and adds another", async () => {
    await writeRepoContext(root, "de_mavlink", "Build", "cmake -B build && cmake --build build");
    const first = await readRepoContext(root, "de_mavlink");
    expect(first).toContain("# de_mavlink — context");
    expect(first).toContain("## Build");
    expect(first).toContain("cmake -B build");

    await writeRepoContext(root, "de_mavlink", "Build", "make -j4");
    const second = await readRepoContext(root, "de_mavlink");
    expect(second).toContain("make -j4");
    expect(second).not.toContain("cmake -B build");

    await writeRepoContext(root, "de_mavlink", "Test", "ctest --test-dir build");
    const third = (await readRepoContext(root, "de_mavlink"))!;
    expect(third).toContain("## Build");
    expect(third).toContain("## Test");
    expect(third).toContain("ctest --test-dir build");
  });

  it("replaces only the named section, keeps the rest", async () => {
    await writeRepoContext(root, "de_mavlink", "Test", "make test");
    const card = (await readRepoContext(root, "de_mavlink"))!;
    expect(card).toContain("make -j4"); // Build untouched
    expect(card).toContain("make test");
    expect(card).not.toContain("ctest --test-dir build");
  });

  it("refuses a bad repo name and a section with '#'", async () => {
    await expect(writeRepoContext(root, "../x", "Build", "x")).rejects.toThrow();
    await expect(writeRepoContext(root, "ok", "## Hack", "x")).rejects.toThrow();
  });
});

describe("ops.repoContext + brief", () => {
  it("writes the section and logs the event", async () => {
    await ops.repoContext(fakeSession, "de_mavlink", "Rules", "never push");
    const card = (await readRepoContext(root, "de_mavlink"))!;
    expect(card).toContain("## Rules");
    expect(card).toContain("never push");
    const evDir = join(plans, "events", "test");
    const lines = readdirSync(evDir)
      .flatMap((f) => readFileSync(join(evDir, f), "utf8").split("\n"))
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.some((e) => e.action === "repo_context" && /de_mavlink/.test(e.note))).toBe(true);
  });

  it("brief shows the card for a repo in Touches, nothing for an unknown repo", async () => {
    const b = await ops.brief("WS-0001");
    expect(b.repo_context.map((c) => c.repo)).toContain("de_mavlink");
    expect(b.repo_context.find((c) => c.repo === "de_mavlink")!.text).toContain("make -j4");
    const b2 = await ops.brief("WS-0002");
    expect(b2.repo_context).toEqual([]);
  });
});

describe("validate: context cards over 80 lines", () => {
  it("reports a card with 81 lines", async () => {
    const fat = `# de_mavlink — context\n\n` + Array.from({ length: 79 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(root, "repos", "de_mavlink.context.md"), fat);
    const findings = validate(store.idx, { contextDir: join(root, "repos") });
    const hit = findings.find((f) => f.kind === "context_file");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("81");
  });
});
