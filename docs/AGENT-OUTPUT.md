# Agent-facing output format

MCP tools return compact text — ids and one-liners, detail only on request.
This is principle 8 of the design: an agent's context window is precious, so
the daemon does the condensing, not the agent.

## Conventions

- Success is one short line (or a short list): `claimed WS-0001 v2`.
- Failure is one line starting `ERROR <code>: message`, returned with
  `isError: true` so MCP clients surface it as a tool error.
- Item one-liner: `WS-0001 ready "title"  held:agent@m#1 blocked`
  (flags only when they apply).
- `brief` is the only verbose tool: summary, acceptance, dep outcomes,
  decisions, resolved targets — the minimum needed to do the work.
- `graph` returns a fenced-free Mermaid `flowchart LR` document. Plans
  (epics) wear a badge: `@{ shape: docs, label: "ID title · done/total" }`
  — a stacked-documents silhouette plus the finished-parts fraction; tasks
  are plain `["ID title"]` boxes. Fill colour still carries the status.
  Reviewed items end their label with `· AI ✓` / `· AI ✗` (+ `⚑` when the
  reviewer flagged needs_human, `⏱` when auto-accept is armed) — the same
  badge the board and inbox show.
- Agent-written text has two layers. The human's short lines —
  `what` (40 words) and `how` (60 words) on `submit`, `summary` (25 words
  on a plain ok), and the `ask_human` card (`problem` 40 words,
  `recommendation` 30 words, `options` of 2–3 labels of up to 4 words) —
  use plain words, no code names, and are word-limited; the daemon refuses
  over-limit text with the observed count. The agent layer — `walkthrough`,
  `note`, `report`, `findings`, `context` on `ask` — has no limit and
  carries the depth (files, functions, reasoning).
- Agents never see other sessions' data, credentials, or file paths outside
  the workspace unless they are resolved target paths.

## Error codes

| code           | meaning                                              |
| -------------- | ---------------------------------------------------- |
| `USAGE`        | bad arguments / ambiguous workspace                  |
| `NOT_FOUND`    | item, workspace, or resource does not exist          |
| `FORBIDDEN`    | human-only action attempted by an agent              |
| `CLAIM_REFUSED`| target overlap or item already claimed               |
| `CONFLICT`     | version mismatch / plans repo has unresolved merge   |
| `INVALID`      | transition not allowed from the current status       |
| `NO_SESSION`   | write tool called before `hello`                     |
| `INTERNAL`     | anything else (bug — report it)                      |
