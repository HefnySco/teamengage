# src/resources/git/ — git driver

- `git.ts` — thin async `execFile` wrapper over the `git` binary, the only
  way TeamEngage runs git: `isRepo`, `isDirty`, `remotes`, `fetch`,
  `showFile`, `aheadBehind`, `revParse`, `remoteBranchesContaining`,
  worktree `add`/`remove`, `merge --no-ff` and `merge --abort`. Failures
  raise `GitError` carrying repo, args, stderr and exit code.
