# src/mcp/shim/ — stdio MCP shim

- `shim.ts` — `teamengage mcp` (DESIGN §6.1): a stdio MCP server that proxies
  JSON-RPC verbatim to the daemon's Streamable HTTP `/mcp`, for IDEs that only
  spawn local commands. Starts the daemon detached when `daemon.json` is
  missing/stale, and reconnects — replaying the last `hello` — if the daemon
  restarts.
