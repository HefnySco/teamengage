# src/agent/ — plain-HTTP agent interface

- `http.ts` — the no-MCP agent API (DESIGN §7): `GET /agent` returns the
  protocol text, and every MCP tool is reachable as `/agent/<tool>[/<id>]`
  through `collectTools`, which captures the same `registerTool` handlers the
  MCP server uses — so output and rules are identical whether an agent uses
  MCP or `curl`.

Auth: no daemon token. The daemon is loopback-only and these routes refuse
browsers — a non-loopback Host (DNS rebinding) or any Origin header is
rejected. `POST /agent/hello` mints a session token sent as `X-TE-Session`
on every later call.
