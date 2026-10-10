# src/daemon/ — teamengaged, the single writer

One `teamengaged` process per machine (DESIGN §6). It owns the plans dir of
every registered workspace: all mutations go through it — serialized,
CAS-checked, committed — while readers (CLI, web UI, agents) hit its HTTP API
on `127.0.0.1`. `main.ts` is the entry point: loads workspaces, starts the
store, watchers, sessions and the Fastify server.

| Folder | Role |
|---|---|
| `server/` | Fastify boot + `daemon.json` pid/port/token lifecycle; shared `DaemonCtx`. |
| `api/` | HTTP routes: human action API, JSON reads, SSE event stream, web-UI statics. `ops.ts` is the shared operation layer. |
| `store/` | `PlansStore` — the serialized writer over the plans dir; atomic file writes. |
| `watch/` | Watches the plans dir: accepts human edits, flags parse failures. |
| `overlay/` | Watches the overlay task folder: tracks moved/renamed/changed task files. |
| `sessions/` | Agent session registry (`hello` tokens, last_seen). |
| `effects/` | Executes state-machine side effects: claim files, git merges, worktrees. |
| `links/` | Loads linked workspaces read-only so `ws:ID` refs resolve. |
| `sync/` | Plans-repo sync: fetch-before-claim, post-pull reconciliation, handoff report. |
