# src/daemon/sync/ — plans-repo sync

Multi-machine coordination through the plans repo's git remote
(SY-0001/2, RS-0004). TeamEngage itself pushes nothing.

- `sync.ts` — fetch-before-claim in `manual` mode: when the remote is
  reachable, fetched `claims/` are checked for the same item or overlapping
  targets and a hit refuses the claim with "pull first" (offline → claim
  proceeds, marked `unsynced`). Post-pull reconciliation marks loser claims
  `conflicted`. `handoffStatus`/`handoffLines` produce the machine-handoff
  report `hello` shows — e.g. `plans behind upstream — STOP`.
