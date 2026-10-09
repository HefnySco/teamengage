<p align="center"><img src="web/logo.svg" alt="TeamEngage" width="360" /></p>

# teamengage

One human, many local LLM agents, planning and executing together on shared
plans — concurrently, without corrupting each other's tasks or code.

See `docs/DESIGN.md` for the design. This repository holds the tool only —
plans (TeamEngage's own or anyone's) live in their own repository, never here.

## Requirements

- Node.js >= 22
- git, rsync+ssh (only for ssh/folder resources)

## Build, test, run

```sh
npm ci          # install
npm run build   # compile TypeScript to dist/
npm test        # vitest
npm run lint    # eslint
npm run dev     # tsc --watch

npx te --version          # CLI
npx teamengaged           # daemon (one per machine)
npx teamengage mcp        # stdio MCP shim for IDEs
```

## Layout

```
src/core        pure model: schema, parser, addressing, index, state machine,
                claims, validation, mermaid, event log
src/daemon      single-writer daemon: store, watcher, HTTP server, sessions,
                human API, SSE
src/mcp         MCP Streamable HTTP server, tools, stdio shim
src/cli         `te` commands
src/resources   git / ssh / folder / url resource drivers
src/sync        multi-machine plans-repo sync and reconciliation
src/import      importer for existing Markdown task folders
web/            human web UI, served by the daemon
skills/         agent skills: te-work (execute a task), te-plan (plan tasks)
```

Task files in overlay workspaces follow `docs/TASK-FORMAT.md` (`te template`).

## License

MIT — free to use, modify and redistribute, including commercially; just keep
the copyright notice. See [LICENSE](LICENSE).
