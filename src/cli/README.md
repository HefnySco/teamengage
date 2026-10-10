# src/cli/ — the `te` command

The human's CLI, installed as `te`/`teamengage` (bin: `dist/cli/main.js`).

- `main.ts` — entry point and subcommand dispatch (init, ls, show, graph,
  validate, status, import, actions, domains/tag, guard/hooks, daemon, ui,
  mcp, agents-md …).
- `client.ts` — daemon client: auto-starts `teamengaged` detached when
  `daemon.json` is missing/stale (same "second start is a no-op" guarantee
  the MCP shim relies on), then talks to `127.0.0.1` with the bearer token.
- `commands/` — one file per command group; all of them just call the daemon
  API, nothing writes plans files directly.
