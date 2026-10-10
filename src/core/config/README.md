# src/core/config/ — configuration loading

Loads the machine-level config and each workspace's config.

- `config.ts` — `teHome()` (`~/.teamengage`), `machine.yaml` (this machine's
  name), `workspaces.yaml` (registry of known workspaces), each workspace's
  `workspace.yaml` (projects, domains, links, mode, sync policy). Resolves a
  workspace name/path to a `LoadedWorkspace` with absolute `root`, `plansDir`
  and resource roots (`resourceRoots`, `expandTilde`).
