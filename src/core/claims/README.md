# src/core/claims/ — claim model

Claim files live under `claims/` in the plans dir; this module is their logic
(DESIGN §6.2, §6.3, §6.5).

- `claims.ts` — parse/serialize claim YAML, target parsing and normalization
  (`normPath`, `staticBase`), `targetsOverlap` (do two claims touch the same
  resource paths?), staleness checks, and `resolveDoubleClaim` — marking the
  losing claim `conflicted` after a pull reveals another machine took the same
  work.
