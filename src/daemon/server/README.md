# src/daemon/server/ — process and HTTP server

- `server.ts` — daemon lifecycle (DESIGN §6.1): binds Fastify to `127.0.0.1`
  on a random port, writes `{pid, port, token}` to `~/.teamengage/daemon.json`
  (0600); the bearer token lives in `~/.teamengage/token` so it survives
  restarts. `runningDaemon()` is how the CLI/shim/agent API discover it;
  every route except `/health` needs the token.
- `context.ts` — `DaemonCtx` and `WorkspaceRuntime`: the shared state passed
  to route registrars (loaded workspaces with their store, watcher, overlay
  tracker and links, plus sessions, event bus and home dir).
