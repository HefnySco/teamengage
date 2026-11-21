# src/core/index/ — in-memory index

- `index.ts` — `Index`: loads every item, claim and decision file in the
  plans dir into memory and derives the graph around them (DESIGN §5):
  dependencies (`depends_on`/`parent`/`relates`), derived statuses
  (`ready`, `blocked`, `turn`), `planState`/`planProgress` (an epic's
  derived plan lifecycle: draft → ready → in_progress → done
  (plus `dropped` for a dropped plan) from its `children` tree alone —
  a stored `done` is honored unless a part is in flight),
  `depSatisfied`
  (does a dependency's status —
  including the `unblocks_on: review` rule — let dependents start?), query
  filters and `matchesSearch`. Backs `ls`, `brief`, `graph`, the validator and
  the web UI.
