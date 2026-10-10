# src/core/mermaid/ — graph rendering

- `mermaid.ts` — `renderMermaid(index, opts)`: renders the plan graph as a
  mermaid flowchart for `te graph`, the agent `graph` tool and the web UI's
  Graph view (DESIGN §7–§8). Deterministic — same input, byte-identical
  output — so it can be diffed and cached. Options: `roots`/`depth` to limit
  the neighbourhood, a `QueryFilter`, and `maxNodes` (extras collapse into a
  `+N more` node). Status classes colour the nodes.
