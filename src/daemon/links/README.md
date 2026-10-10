# src/daemon/links/ — linked workspaces

- `links.ts` — `LinkedWorkspaces` (DESIGN §4.1, DM-0007): workspaces named in
  `workspace.yaml` `links:` are loaded read-only so cross-workspace `ws:ID`
  references resolve in the index, `brief`, `graph` and the validator.
  A missing linked workspace is reported as a finding, never a crash.
