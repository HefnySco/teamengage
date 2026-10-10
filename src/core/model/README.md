# src/core/model/ — schemas and types

zod schemas that define every persisted shape, plus the error hierarchy.
`index.ts` re-exports everything.

| File | Contents |
|---|---|
| `item.ts` | `ItemMeta` (frontmatter), `Status`, `ItemType`, `Question`, `Turn`. `blocked`/`turn` are derived, never stored. |
| `claim.ts` | `Claim` (claim files under `claims/`), staleness rules. |
| `decision.ts` | `DecisionMeta` — `D-NNNN` decision records. |
| `event.ts` | `Event` — entries in the JSONL event log. |
| `session.ts` | `Session` — an agent's `hello` session (`agent@machine#hex`). |
| `workspace.ts` | `workspace.yaml`, `workspaces.yaml`, `machine.yaml` schemas, resource config, duration parsing. |
| `refs.ts` | ID and reference regexes (`ID_RE`, `ITEM_REF_RE`, `TARGET_RE`, `DECISION_ID_RE`). |
| `errors.ts` | `TeError` hierarchy: `ValidationError`, `NotFoundError`, `ForbiddenError`, `InvalidTransitionError`, `ClaimRefusedError`, `ParseError`, `ConflictMarkersError` … |
