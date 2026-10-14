# src/core/index/ — in-memory index

- `index.ts` — `Index`: loads every item, claim and decision file in the
  plans dir into memory and derives the graph around them (DESIGN §5):
  dependencies (`depends_on`/`parent`/`relates`), derived statuses
  (`ready`, `blocked`, `turn`), `planState`/`planProgress` (an epic's
  derived plan lifecycle: draft → decomposing → active → done over its
  `children` tree, gated by the stored `plan_closed` flag), `depSatisfied`
  (does a dependency's status —
  including the `unblocks_on: review` rule — let dependents start?), query
  filters and `matchesSearch`. Backs `ls`, `brief`, `graph`, the validator and
  the web UI.
