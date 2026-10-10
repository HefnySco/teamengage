# src/daemon/watch/ — plans-dir watcher

- `watch.ts` — `PlansWatcher` (DESIGN §6.2 "Human edits"): chokidar watcher on
  the plans dir. The daemon's own writes are suppressed via content-hash
  tracking; a human edit is accepted as a write by `human` (version bumped,
  event recorded, re-indexed). Files that fail to parse — including git
  conflict markers — are marked invalid in the index and surfaced as
  findings; the daemon never rewrites them.
