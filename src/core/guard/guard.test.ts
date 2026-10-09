import { describe, it, expect } from "vitest";
import { guardToolUse, sessionContext, isAdditive, type GuardWorkspace } from "./guard.js";

const ws: GuardWorkspace = {
  name: "de_tasks",
  root: "/r/Tasks",
  plansDir: "/r/Tasks/.teamengage",
  overlay: true,
  ignore: ["AGENTS.md", "CLAUDE.md"],
};
const std: GuardWorkspace = { name: "code", root: "/r/code", plansDir: "/r/code/.teamengage", overlay: false, ignore: [] };
const TASK = "---\nte: GL-0019\n---\n# Rerun\n\n## Acceptance\n- [ ] a\n\n## Notes\n";
const files: Record<string, string> = {
  "/r/Tasks/global/TASK-13-rerun.md": TASK,
  "/r/Tasks/global/legacy.md": "# untracked legacy\n",
  "/r/code/src/a.ts": "x",
};
const read = (p: string) => files[p] ?? null;
const run = (tool_name: string, tool_input: Record<string, unknown>, cwd = "/r") =>
  guardToolUse({ tool_name, tool_input, cwd }, [ws, std], read);

describe("file writes", () => {
  it("anything under .teamengage/ is refused, in every workspace", () => {
    expect(run("Write", { file_path: "/r/Tasks/.teamengage/items/GL/GL-0019.md", content: "x" })).toMatch(/belong to TeamEngage/);
    expect(run("Edit", { file_path: "/r/code/.teamengage/claims/X.yaml", old_string: "a", new_string: "b" })).toMatch(/belong/);
    expect(run("NotebookEdit", { notebook_path: "/r/Tasks/.teamengage/x.ipynb" })).toMatch(/belong/);
    // relative paths resolve against the session cwd
    expect(run("Write", { file_path: ".teamengage/workspace.yaml", content: "" }, "/r/Tasks")).toMatch(/belong/);
  });

  it("new task files must come from propose; ignored and non-md files are fine", () => {
    expect(run("Write", { file_path: "/r/Tasks/global/TASK-20-new.md", content: "# x" })).toMatch(/created with propose/);
    expect(run("Write", { file_path: "/r/Tasks/AGENTS.md", content: "x" })).toBeNull();
    expect(run("Write", { file_path: "/r/Tasks/tools/check.py", content: "x" })).toBeNull();
    // standard workspaces don't restrict files outside .teamengage/
    expect(run("Write", { file_path: "/r/code/notes.md", content: "x" })).toBeNull();
    expect(run("Write", { file_path: "/elsewhere/x.md", content: "x" })).toBeNull();
  });

  it("additive edits to a task file pass", () => {
    const f = "/r/Tasks/global/TASK-13-rerun.md";
    expect(run("Edit", { file_path: f, old_string: "## Notes\n", new_string: "## Notes\n- found X\n" })).toBeNull();
    expect(run("Edit", { file_path: f, old_string: "- [ ] a\n", new_string: "- [ ] a\n- [ ] b\n" })).toBeNull();
    expect(run("Write", { file_path: f, content: TASK + "- more\n" })).toBeNull();
    expect(
      run("MultiEdit", {
        file_path: f,
        edits: [
          { old_string: "- [ ] a\n", new_string: "- [ ] a\n- [ ] b\n" },
          { old_string: "## Notes\n", new_string: "## Notes\nnote\n" },
        ],
      }),
    ).toBeNull();
  });

  it("the te: line can't change or go", () => {
    const f = "/r/Tasks/global/TASK-13-rerun.md";
    expect(run("Edit", { file_path: f, old_string: "te: GL-0019", new_string: "te: GL-0020" })).toMatch(/never change or remove the "te: GL-0019"/);
    expect(run("Write", { file_path: f, content: TASK.replace("---\nte: GL-0019\n---\n", "") })).toMatch(/te: GL-0019/);
  });

  it("rewrites and deletions of existing lines are refused", () => {
    const f = "/r/Tasks/global/TASK-13-rerun.md";
    expect(run("Edit", { file_path: f, old_string: "# Rerun", new_string: "# Rerun v2" })).toMatch(/must be additive/);
    expect(run("Edit", { file_path: f, old_string: "- [ ] a\n", new_string: "- [x] a\n" })).toMatch(/additive/);
    expect(
      run("MultiEdit", {
        file_path: f,
        edits: [
          { old_string: "## Notes\n", new_string: "## Notes\nok\n" },
          { old_string: "- [ ] a\n", new_string: "" },
        ],
      }),
    ).toMatch(/additive/);
  });

  it("untracked legacy files and edits that won't apply are left to the tool", () => {
    expect(run("Edit", { file_path: "/r/Tasks/global/legacy.md", old_string: "legacy", new_string: "old" })).toBeNull();
    expect(run("Edit", { file_path: "/r/Tasks/global/TASK-13-rerun.md", old_string: "nope", new_string: "x" })).toBeNull();
  });

  it("isAdditive keeps order", () => {
    expect(isAdditive("a\nb", "a\nx\nb")).toBe(true);
    expect(isAdditive("a\nb", "b\na")).toBe(false);
  });
});

describe("shell commands", () => {
  const bash = (command: string, cwd = "/r/Tasks") => run("Bash", { command }, cwd);

  it("writes into .teamengage/ are refused; reads are not", () => {
    expect(bash("echo x > .teamengage/claims/GL-0019.yaml")).toMatch(/writes under de_tasks/);
    expect(bash("rm .teamengage/claims/GL-0019.yaml")).toMatch(/writes under/);
    expect(bash("sed -i s/a/b/ /r/Tasks/.teamengage/items/GL/GL-0019.md", "/tmp")).toMatch(/writes under/);
    // from the parent repo, relative to it
    expect(bash("rm Tasks/.teamengage/claims/X.yaml", "/r")).toMatch(/writes under/);
    expect(bash("cat .teamengage/items/GL/GL-0019.md 2>/dev/null | head")).toBeNull();
    expect(bash("grep -r status .teamengage/items > /tmp/out.txt")).toBeNull();
    expect(bash("git add .teamengage && git commit -m x")).toBeNull();
  });

  it("moving into done/, in-place edits of task files and git push are refused", () => {
    expect(bash("mv global/TASK-13-rerun.md global/done/")).toMatch(/never move task files into done/);
    expect(bash("git mv TASK-13.md done")).toMatch(/done/);
    expect(bash("sed -i 's/a/b/' global/TASK-13-rerun.md")).toMatch(/in place/);
    expect(bash("git push origin master")).toMatch(/never git push/);
    expect(bash("git -C /r/Tasks push", "/tmp")).toMatch(/never git push/);
  });

  it("commands outside any workspace are untouched", () => {
    expect(bash("git push", "/r/other")).toBeNull();
    expect(bash("mv a done/", "/tmp")).toBeNull();
    expect(bash("sed -i s/a/b/ README.md", "/r/code")).toBeNull(); // standard ws: only .teamengage is guarded
  });
});

describe("session context", () => {
  it("injected inside a workspace or in a directory that contains one", () => {
    expect(sessionContext("/r/Tasks/global", [ws], "RULES")).toMatch(/de_tasks \(\/r\/Tasks, task folder\)[\s\S]*RULES$/);
    expect(sessionContext("/r", [ws], "RULES")).toMatch(/TeamEngage coordinates work here/);
    expect(sessionContext("/elsewhere", [ws], "RULES")).toBeNull();
  });
});
