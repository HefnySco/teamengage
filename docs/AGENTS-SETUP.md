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
human decides.

## Multiple machines

The MCP server talks only to the local daemon (`127.0.0.1`). Each machine runs
its own daemon; workspaces converge through the plans repo's git remote.

## Writing tasks (overlay workspaces)

Agents create tasks with `propose`; in a task-folder workspace it writes
`<project>/TASK-NN-<slug>.md` from the standard template
([TASK-FORMAT.md](TASK-FORMAT.md), `te template`). The `te-plan` Claude Code
skill (`skills/te-plan/`) is the recipe for breaking a goal into tasks.
Install it for Claude Code with:

```bash
ln -s "$PWD/skills/te-plan" ~/.claude/skills/te-plan
```
