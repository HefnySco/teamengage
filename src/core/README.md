# src/core/ — domain model (pure)

The heart of TeamEngage: all plan knowledge, deterministic and unit-tested.
Modules here do no I/O beyond plain file reads and never talk to the daemon —
side effects a decision needs (claim files, merges, worktrees) are returned as
data (`effects`) for the daemon to execute.

| Folder | Role |
|---|---|
| `model/` | zod schemas and types: item, claim, decision, event, session, workspace, refs, errors. |
| `files/` | Markdown + frontmatter parsing/serialization, overlay `te:` tag handling, the task-file template. |
| `address/` | Reference syntax (`MP-0042`, `ws:ID`, `@resource[:glob]`, `D-0007`), ID allocation, renumber. |
| `index/` | In-memory index of the plans dir: dependency graph, derived statuses (`ready`/`blocked`), query/search. |
| `state/` | The lifecycle state machine (claim → submit → review → accept …). |
| `claims/` | Claim-file model, target overlap, staleness, double-claim resolution. |
| `events/` | Append-only per-machine JSONL event log. |
| `validate/` | Plan-graph health findings (dangling refs, cycles, stale claims …). |
| `domains/` | Domain labels: vocabulary, normalization, suggestion ranking. |
| `mermaid/` | Deterministic mermaid renderer for the plan graph. |
| `config/` | `~/.teamengage` config and `workspace.yaml` loading. |
| `guard/` | Tracking rules enforced on agent tool calls (hooks / `te guard`). |
