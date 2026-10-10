# src/daemon/effects/ — side effects

Executes the `effects` the pure state machine returns — the only place those
decisions touch the world outside the plans dir.

- `effects.ts` — writes claim files, runs git merges (`merge --no-ff`) and
  worktree add/remove for claimed work, writes decision files, cleans up on
  release/reject. Built on `resources/git`.
