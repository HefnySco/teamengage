# src/daemon/api/ — HTTP routes

The daemon's Fastify route registrars.

- `api.ts` — the human action API (DM-0005): REST endpoints for the
  human-only transitions (approve, accept, reject, drop, answer, claim,
  release, renumber …) plus JSON read endpoints mirroring the MCP read tools.
  Used by `te` and the web UI.
- `ops.ts` — `WorkspaceOps`: the operation layer every interface shares —
  REST above, the MCP tools, and the `/agent/*` HTTP API all call the same
  methods, so behaviour and rules stay identical. Also the `Links` interface.
- `events.ts` — `EventBus` + `GET /events` as Server-Sent Events (DM-0006):
  every committed event is pushed to all clients; `Last-Event-ID` /
  `?replay=N` resume from the in-memory buffer.
- `ui.ts` — serves the web UI (`web/`) at `/`, including the esbuild bundles
  in `web/dist` (UI-0001).
