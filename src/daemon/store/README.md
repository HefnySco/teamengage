# src/daemon/store/ — the plans store

- `store.ts` — `PlansStore`: the single serialized writer over a workspace's
  plans dir. Runs each operation through the state machine, writes files,
  updates the index and appends events, CAS-checked so concurrent callers
  can't interleave. Also owns overlay `source` bookkeeping and the domains
  vocabulary in `workspace.yaml`.
- `atomic.ts` — `writeFileAtomic`: temp file in the same directory → fsync →
  rename → fsync the directory, so a crash leaves old or new, never a partial
  file (DESIGN §6.2).
