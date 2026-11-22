# Agent setup (MC-0005)

TeamEngage has two agent interfaces with the same tools and rules:

- **Plain HTTP (no setup):** `http://127.0.0.1:4747/agent`. Any local agent
  that can run `curl` uses it directly; `GET /agent` prints the protocol and
  copy-paste examples. Sessions: `POST /agent/hello` returns a token, sent as
  `X-TE-Session` afterwards. Browsers are refused (Origin / Host checks), the
  port is loopback-only, and `TE_PORT` changes it (a busy port falls back to a
  random one — the daemon prints the URL).
- **MCP:** server `teamengage`, run over stdio via `te mcp` — the shim
  auto-starts the local daemon if needed.

Register MCP if your IDE prefers it (optional), then drop the protocol
snippet (`te agents-md`) into the project's agent instructions file.

## Plain HTTP quick start

```bash
curl -s http://127.0.0.1:4747/agent
T=$(curl -s -X POST http://127.0.0.1:4747/agent/hello -d '{"agent":"gemini-cli"}' | sed -n 's/^token //p')
curl -s http://127.0.0.1:4747/agent/next -H "X-TE-Session: $T"
curl -s -X POST http://127.0.0.1:4747/agent/claim/MP-0002 -H "X-TE-Session: $T"
```

Keep the token for the whole task. `POST /agent/bye` ends the session (claims
stay); after a daemon restart, `hello` again and held claims are rebound.

## MCP server registration

| Tool | Where | Config |
| --- | --- | --- |
| Claude Code | project `.mcp.json` | `"mcpServers": { "teamengage": { "command": "te", "args": ["mcp"] } }` |
| Gemini CLI | `~/.gemini/settings.json` | `"mcpServers": { "teamengage": { "command": "te", "args": ["mcp"] } }` |
| Cursor | `.cursor/mcp.json` | same `mcpServers` block |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | same `mcpServers` block |
| Devin | repo settings / `.devin/config.json` | add MCP server `te mcp` |

If `te` is not on PATH, use the absolute path to the binary or
`node <repo>/dist/cli/main.js mcp`.

## Instructions snippet

Run `te agents-md` and paste the output into whichever file your agent reads:

- `AGENTS.md` — Claude Code / Devin / most agents
- `CLAUDE.md` — Claude Code legacy
- `GEMINI.md` — Gemini CLI
- `.cursor/rules` or `.windsurfrules` — Cursor / Windsurf

The snippet tells agents: `hello` once per session → `next` → `brief` →
`claim` → `log`/`ask` → `submit`. Agents may not set `ready`/`done` — the
human decides. A second session may peer-review a submission
(`query status=in_review` → `review` — `ok` is advisory, `issues` sends
broken work back to its holder, max 2 in a row); accept/reject stay human-only.

Agent output has two layers. `submit` takes `what` and `how` (the human's
short lines, 40 and 60 words, no code names) plus an optional `walkthrough`
(the agent layer, no limit). `review` takes `summary` and —
when the human must decide — `ask_human`: `problem`, `recommendation` and
`options` for the decision card. The detail stays in `note`, `report` and
`findings`.

## Multiple machines

The MCP server talks only to the local daemon (`127.0.0.1`). Each machine runs
its own daemon; workspaces converge through the plans repo's git remote.

## Writing tasks (overlay workspaces)

Agents create tasks with `propose`; in a task-folder workspace it writes
`<project>/TASK-NN-<slug>.md` from the standard template
([TASK-FORMAT.md](TASK-FORMAT.md), `te template`).

A task for a problem an agent found names the item where it found it in
`found_by` (reference only), not in `depends_on`.

Skills (Claude Code and Devin use the same `SKILL.md` format), all
curl-only, no MCP needed:

- `skills/te-work/` — implement / continue / pick up a task: hello → brief →
  claim → log / ask → submit with evidence, release if blocked.
- `skills/te-review/` — peer-review another session's submission: verify the
  work, record a verdict — `issues` sends it back to the holder.
- `skills/te-plan/` — break a goal into tasks with one `propose` call.
- `skills/te-tag/` — tag untagged tasks with domains by reading them
  (`te domains untagged`, plan for the human's OK, `te tag`).
- `skills/te-analysis/` — read-only analysis of the task bank.
- `skills/te-discuss/` — save a chat as a discussion, plan from saved
  discussions with `relates`, promote their guidelines with `promote`.

Install by linking them into the agent's skills folder — never copy
(a copied skill teaches agents a stale protocol):

```bash
te skills --install    # detects ~/.claude, ~/.config/devin, ~/.codeium/windsurf
te skills --check      # exit 1 on drift (copy, stale copy, missing, broken link)
```

`--install` never deletes: a real dir it replaces lands under
`~/.teamengage/skill-backups/<ide>/<name>-<date>`, and it sweeps any old
`<name>.te-bak-*` / `<name>.bak-*` folder it finds out of the live dir —
IDEs load every subfolder, so a backup inside the skills folder would run
as a second, stale skill.

## Git safety

Agents never rewrite or drop commits: no `git reset --hard`, no
`git reset HEAD^`, no rebase that drops commits, no wiping the working
tree. A shared checkout or a claim worktree can hold other tasks' commits
and the human's uncommitted edits — a reset erases them for everyone, and
a cited Evidence commit disappears. The safe fixes are `git revert <sha>`
(undo a commit, keep history), file-level `git restore --source=<sha> --
<path>`, or `git cherry-pick` of the task's own commits onto a fresh
branch. Anything bigger goes to the human — agents ask, they do not
repair history.

## Enforcing the rules (when instructions aren't enough)

Agents can ignore `AGENTS.md`. Three layers make the rules hard to miss or
break:

- **Every session sees them**: the MCP server sends them as server
  `instructions`, and every `hello` reply ends with a one-line `rules:`
  summary (MCP and plain HTTP).
- **Claude Code guard hooks** (`te hooks --install`, merged into
  `~/.claude/settings.json`; `--uninstall` removes them):
  - *SessionStart* injects the protocol and authoring rules when a session
    starts inside a registered workspace, or in a folder that contains one.
  - *PreToolUse* (`Write|Edit|MultiEdit|NotebookEdit|Bash`) runs `te guard`.
    It refuses: writes under `.teamengage/`; creating task `.md` files by
    hand (use `propose`); changing or removing a `te:` line; non-additive
    edits of task files; and shell commands that write into `.teamengage/`,
    edit task files in place (`sed -i` …), move files into `done/`, or
    `git push` from the workspace.
  - The agent gets the reason and can correct itself. The guard fails open
    on any error. `TE_GUARD=off` disables it for a session started with that
    variable. Humans editing files directly are never affected.
- **The watcher** still reports anything that slips through: untracked
  task files, missing or duplicate `te:` tags.
