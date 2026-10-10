# src/mcp/server/ — MCP over Streamable HTTP

- `mcp.ts` — mounts an `McpServer` at `/mcp` on the daemon
  (`StreamableHTTPServerTransport`, DESIGN §6.1, §7). `MCP_INSTRUCTIONS` is
  sent at `initialize` so MCP clients put the workflow rules in the agent's
  system prompt. `AgentBinding` ties each connection to its session and
  workspace; `pickWorkspace` resolves which workspace a call targets.
