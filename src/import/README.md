# src/import/ — Markdown-folder importer

Turns an existing Markdown task folder into TeamEngage items
(DESIGN §9, IM-0001), driven by `te import`.

- `import.ts` — pure planning: takes file paths + contents and produces
  `PlannedItem`s (legacy ids preserved), a unified-diff-style preview and an
  ambiguity report. Source files are never modified, and re-imports dedup on
  `legacy_id`, so the import is idempotent.
- `scan.ts` — `scanFolder` reads a folder tree of `.md` files into
  `ImportSource[]` (a single file is a one-file import); dot-directories are
  skipped.
