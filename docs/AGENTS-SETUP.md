# Agent setup (MC-0005)

TeamEngage exposes one MCP server named `teamengage`. It runs over stdio via
`te mcp` — the shim auto-starts the local daemon if needed. Register it with
your agent tool, then drop the protocol snippet (`te agents-md`) into the
project's agent instructions file.

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
