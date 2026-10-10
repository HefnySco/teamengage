# src/core/events/ — event log

Append-only JSONL event log (DESIGN §3, §6.5).

- `log.ts` — `EventLog` reads and appends events. One stream per machine —
  `events/<machine>/<YYYY-MM>.jsonl` — so git merges of the plans repo never
  conflict on the log. `seq` is a per-file monotonically increasing id, also
  used as the SSE `Last-Event-ID` when clients reconnect.
