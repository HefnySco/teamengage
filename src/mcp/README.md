# src/mcp/ — MCP interface for agents

The Model Context Protocol surface (DESIGN §6.1, §7). Agents that speak MCP
get the same tools the `/agent/*` HTTP API exposes.

- `format.ts` — the compact agent-facing output convention (IDs and
  one-liners, errors as `ERROR <code>: message`; docs/AGENT-OUTPUT.md) and
  the `ToolResult` shape.
- `server/` — the MCP server on Streamable HTTP, mounted at `/mcp` on the
  daemon.
- `shim/` — `teamengage mcp`: a stdio↔HTTP proxy for IDEs that only spawn
  local commands.
- `tools/` — the read and write tool registrations (hello/next/brief/… ,
  claim/log/ask/submit/propose).
