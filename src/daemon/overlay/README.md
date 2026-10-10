# src/daemon/overlay/ — overlay task-file tracker

- `tracker.ts` — `OverlayTracker`: a chokidar watcher on the overlay task
  folder (the human's Markdown, outside the plans dir). On any `.md`
  add/change/move/delete — human edits or a `git pull` — it rescans the tree
  once (debounced): files that moved update their item's `source`, everything
  else becomes an inbox finding. A full rescan is cheaper and more robust
  than pairing unlink/add events into moves.
