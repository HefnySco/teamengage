# src/core/guard/ — agent guard

Enforcement for the rules written instructions can't guarantee
(`te guard` — Claude Code PreToolUse/SessionStart hooks).

- `guard.ts` — `guardToolUse` inspects each tool call and denies: writes under
  a workspace's plans dir (`.teamengage/`), hand-creating task files in
  overlay workspaces, changing/removing a file's `te:` line, non-additive
  edits to task files, `sed -i`-style in-place edits, moving files into
  `done/`, and `git push` from a workspace. `sessionContext` produces the
  rules text injected at session start.

Pure — file reads are injected — and fail-open: anything it can't decide is
allowed, so a guard bug never bricks the agent.
