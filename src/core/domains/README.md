# src/core/domains/ — domain labels

Domains are hashtag-like labels on items (many per item, next to the single
`project`). The vocabulary lives in `workspace.yaml` `domains:` with a
description, colour and keywords per domain; new names used on items are
added automatically.

- `domains.ts` — pure helpers: `normalizeDomain` (`Web Client` → `web-client`),
  colour assignment, and keyword-based ranking that powers
  `te domains suggest` and the te-tag skill.
