import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mergeHooks } from "./guard.js";

describe("te hooks: settings merge", () => {
  const ours = 'node "/x/dist/cli/main.js" guard';

  it("adds both hooks, keeps everything else, is idempotent", () => {
    const start = {
      theme: "dark",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "log.sh" }] }] },
    };
    const once = mergeHooks(start, ours);
    const twice = mergeHooks(once, ours);
    expect(twice).toEqual(once);
    expect(once.theme).toBe("dark");
    expect(once.hooks!.PreToolUse).toHaveLength(2);
    expect(once.hooks!.PreToolUse[1]).toMatchObject({ matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash" });
    expect(once.hooks!.SessionStart[0].hooks[0].command).toBe(ours);
    // an install from another path replaces, not duplicates
    expect(mergeHooks(once, 'node "/y/main.js" guard').hooks!.PreToolUse).toHaveLength(2);
  });

  it("uninstall removes only ours", () => {
    const off = mergeHooks(mergeHooks({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "log.sh" }] }] } }, ours), null);
    expect(off).toEqual({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "log.sh" }] }] } });
    expect(mergeHooks(mergeHooks({}, ours), null)).toEqual({});
  });
});

/** The built CLI exactly as Claude Code runs it: hook JSON on stdin. */
describe("te guard end-to-end (dist)", () => {
  let home: string;
  let root: string;
  const cli = resolve("dist/cli/main.js");
  const guard = (input: unknown, env: Record<string, string> = {}) => {
    const r = spawnSync("node", [cli, "guard"], {
      input: JSON.stringify(input),
      env: { ...process.env, TEAMENGAGE_HOME: home, ...env },
      encoding: "utf8",
    });
    return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null };
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "te-guard-"));
    root = join(home, "Tasks");
    mkdirSync(join(root, ".teamengage"), { recursive: true });
    mkdirSync(join(home, ".teamengage"), { recursive: true });
    writeFileSync(join(root, ".teamengage", "workspace.yaml"), "name: t\nprefix: GL\nmode: overlay\ncommit: false\n");
    writeFileSync(join(home, ".teamengage", "workspaces.yaml"), `workspaces:\n  t:\n    root: ${root}\n`);
    writeFileSync(join(root, "a.md"), "---\nte: GL-0001\n---\n# A\n");
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("denies with the reason; allows silently; TE_GUARD=off disables", () => {
    const bad = { hook_event_name: "PreToolUse", tool_name: "Edit", cwd: root, tool_input: { file_path: join(root, "a.md"), old_string: "te: GL-0001", new_string: "" } };
    const r = guard(bad);
    expect(r.code).toBe(0);
    expect(r.out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(r.out.hookSpecificOutput.permissionDecisionReason).toMatch(/^TeamEngage guard: a\.md: never change/);

    const ok = guard({ ...bad, tool_input: { file_path: join(root, "a.md"), old_string: "# A\n", new_string: "# A\nmore\n" } });
    expect(ok).toEqual({ code: 0, out: null });
    expect(guard(bad, { TE_GUARD: "off" })).toEqual({ code: 0, out: null });
  });

  it("SessionStart injects the rules; garbage input fails open", () => {
    const s = guard({ hook_event_name: "SessionStart", cwd: home });
    expect(s.out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(s.out.hookSpecificOutput.additionalContext).toMatch(/TeamEngage coordinates work here[\s\S]*propose/);
    const r = spawnSync("node", [cli, "guard"], { input: "not json", env: { ...process.env, TEAMENGAGE_HOME: home }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
