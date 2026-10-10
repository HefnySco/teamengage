# src/cli/commands/ — `te` subcommands

One module per command group; each is a thin client over the daemon API.

| File | Commands |
|---|---|
| `init.ts` | `te init` — create a workspace (plans dir, `workspace.yaml`, git init, registry entry); `--overlay` tracks an existing Markdown task folder in place. |
| `read.ts` | `te ls`, `show`, `graph`, `validate`, `status`, `inbox`, `sync` — read-only views (CL-0001). |
| `actions.ts` | `te approve`, `accept`, `reject`, `drop`/`undrop`, `answer`, `hold`, `claim`, `release`, `renumber`, `archive` — the human's transitions, 1:1 with the DM-0005 endpoints (CL-0002). |
| `import.ts` | `te import <folder>` — import a Markdown task folder; dry-run preview by default, `--apply` writes (IM-0001). |
| `domains.ts` | `te domains`/`suggest`/`untagged`, `te domain add|rename|rm`, `te tag <ID>` — domain management. |
| `guard.ts` | `te guard` — the Claude Code hook handler (PreToolUse deny / SessionStart context; fails open), and `te hooks --install/--uninstall`. |
