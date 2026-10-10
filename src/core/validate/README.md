# src/core/validate/ — health check

- `validate.ts` — `validate(index)` walks the index and reports `Finding`s
  (severity error/warning/info): dangling refs, dependency cycles,
  done-with-open-deps, duplicate ids, invalid frontmatter, git conflict
  markers, claims on missing/done items, overlapping or stale claims, bad
  targets, and overlay-specific findings like untracked task files (DESIGN
  CR-0009). Feeds the human inbox, `te validate` and the web UI.
