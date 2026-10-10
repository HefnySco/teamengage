# src/daemon/sessions/ — agent sessions

- `sessions.ts` — `SessionRegistry` (DESIGN §3 Session, §6.2): `hello(agent)`
  mints a session id `<agent>@<machine>#<hex>`. Every later call updates the
  session's `last_seen`; claim `last_seen` writes are throttled (one per claim
  per 5 min) so activity doesn't produce a commit per call.
