# src/mcp/tools/ — tool registrations

The agent-facing tool handlers (DESIGN §7), registered on the MCP server and
reused by the `/agent/*` HTTP API via `collectTools`.

- `read.ts` — read tools: `hello` (session + handoff report), `next`,
  `brief`, `query`, `graph`. Output is compact text — ids and one-liners.
- `write.ts` — write tools: `claim`, `release`, `log`, `ask`, `submit`,
  `propose`. All mutations go through the store — serialized, CAS-checked,
  committed.
