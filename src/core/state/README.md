# src/core/state/ — lifecycle state machine

- `machine.ts` — the pure state machine (DESIGN §5). Takes an `Actor`
  (agent / human / daemon) and an `Action` (`claim`, `submit`, `approve`,
  `accept`, `reject`, `drop`, `answer`, `release` …) plus the current item and
  claims, and returns the new meta, the `effects` the daemon must perform
  (claim file, merge, worktrees, decision file) and the `events` to append.

No I/O: every transition rule — who may do what, from which status — lives
here and nowhere else, so the daemon only executes what this module decided.
