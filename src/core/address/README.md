# src/core/address/ — references and IDs

The addressing layer (DESIGN §4.1).

- `refs.ts` — parse/format every reference kind: items (`MP-0042`,
  cross-workspace `ws:SL-0007`), claim targets (`@res`, `@res:glob`,
  `@res:/abs/path`), decisions (`D-0007`). Also `allocateId` (next free
  `PREFIX-NNNN`) and `compareIds` (natural ordering).
- `renumber.ts` — `renumber(oldId, newId)` rewrites every reference in the
  plans repo (ids, `depends_on`/`parent`/`relates`, body mentions, claim
  files) and renames the item file. Used when two machines allocated the same
  ID while offline (DESIGN CR-0005).
