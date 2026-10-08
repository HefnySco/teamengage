# Agent-facing output format

MCP tools return compact text — ids and one-liners, detail only on request.
This is principle 8 of the design: an agent's context window is precious, so
the daemon does the condensing, not the agent.

## Conventions

- Success is one short line (or a short list): `claimed WS-0001 v2`.
- Failure is one line starting `ERROR <code>: message`, returned with
  `isError: true` so MCP clients surface it as a tool error.
- Item one-liner: `WS-0001 ready "title"  held:agent@m#1 blocked`
  (flags only when they apply).
- `brief` is the only verbose tool: summary, acceptance, dep outcomes,
  decisions, resolved targets — the minimum needed to do the work.
- `graph` returns a fenced-free Mermaid `flowchart LR` document.
- Agents never see other sessions' data, credentials, or file paths outside
  the workspace unless they are resolved target paths.

## Error codes

| code           | meaning                                              |
| -------------- | ---------------------------------------------------- |
| `USAGE`        | bad arguments / ambiguous workspace                  |
| `NOT_FOUND`    | item, workspace, or resource does not exist          |
| `FORBIDDEN`    | human-only action attempted by an agent              |
| `CLAIM_REFUSED`| target overlap or item already claimed               |
| `CONFLICT`     | version mismatch / plans repo has unresolved merge   |
| `INVALID`      | transition not allowed from the current status       |
| `NO_SESSION`   | write tool called before `hello`                     |
| `INTERNAL`     | anything else (bug — report it)                      |
