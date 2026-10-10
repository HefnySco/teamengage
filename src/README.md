# src/ — TypeScript source

TeamEngage source tree. Node ≥ 22, ESM, compiled by `tsc` to `dist/`
(`npm run build` also bundles `web/`).

| Folder | Role |
|---|---|
| `core/` | Pure domain model — parsing, addressing, indexing, the state machine, validation. No I/O beyond plain file reads; no dependency on the daemon. |
| `daemon/` | `teamengaged` — one process per machine, the single writer. Owns the plans dir, serializes all mutations, serves HTTP on `127.0.0.1`. |
| `cli/` | `te` — the human's command-line client. Talks to the daemon over loopback HTTP; auto-starts it when needed. |
| `agent/` | Plain-HTTP agent interface (`/agent/*`) — every MCP tool reachable with `curl`, no MCP setup. |
| `mcp/` | MCP surface for agents — Streamable HTTP server on the daemon, a stdio shim for IDEs, the tool registrations. |
| `import/` | Importer that turns an existing Markdown task folder into tracked items. |
| `resources/` | External-resource drivers for claimable targets (git today). |
| `sync/` | Reserved for multi-machine sync; the working implementation is `daemon/sync/`. |

Top-level rule: the human's task files and the `.teamengage/` state change
only through the daemon. `core/` decides, the daemon performs.
