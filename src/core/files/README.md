# src/core/files/ — Markdown task files

Everything about how items are stored as Markdown.

- `markdown.ts` — generic parser/serializer for TeamEngage Markdown:
  YAML frontmatter + `## ` sections, with the raw text kept for stable
  round-trips (canonical key order, EOL preserved). Also `appendLog`,
  `appendToSection`, `emitFrontmatter`.
- `source.ts` — overlay-mode task files (DESIGN §9): the human's own Markdown,
  tracked by a single `te: <ID>` frontmatter key. This module only ever adds
  or rewrites that key — item identity survives renames and moves. Also
  `resolveSource`/`toSourcePath`, `globToRegExp`, `appendNote` (additive
  `## Notes` entries), the `.simple.md`/`-simplified.md` companion rule, and
  `scanTaskTree`/`overlayReport`.
- `template.ts` — the task-file standard (docs/TASK-FORMAT.md). `propose`
  renders new files from it; `AUTHORING_RULES` is what agents are told;
  the importer targets the same shape.
