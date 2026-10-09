#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initCmd } from "./commands/init.js";
import { guardCmd, hooksCmd } from "./commands/guard.js";
import { AUTHORING_RULES, TEMPLATE_EXAMPLE } from "../core/files/template.js";
import { lsCmd, showCmd, graphCmd, validateCmd, statusCmd, syncCmd } from "./commands/read.js";
import { importCmd } from "./commands/import.js";
import {
  approveCmd,
  acceptCmd,
  humanClaimCmd,
  answerCmd,
  rejectCmd,
  dropCmd,
  undropCmd,
  holdCmd,
  archiveCmd,
  unarchiveCmd,
  unholdCmd,
  draftCmd,
  doneCmd,
  releaseCmd,
  rollbackCmd,
  renumberCmd,
} from "./commands/actions.js";

function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

const USAGE = `te — TeamEngage CLI

usage: te <command> [options]

commands:
  init [--plans <path>] [--name <n>] [--prefix <P>] [--root <dir>] [--overlay]
                   create a workspace (.teamengage plans repo)
  ls [--status s] [--project p] [--text t] [--json]
  show <ID> [--json]
  graph [--root <ID>] [--depth n]
  validate [--json]
  status [--json]
  approve | accept | claim | release <ID> [note]
  answer <ID> <text>
  reject | drop <ID> [reason]
  undrop <ID>         restore a dropped item back to draft
  hold <ID> [reason]  park a draft/ready item (agents can't see or claim it)
  unhold <ID>         release a hold → ready
  archive <ID> [reason] / unarchive <ID>   hide / restore an item (status kept)
  draft <ID> [reason] send a ready or held item back to draft
  done <ID> [note]    mark done from any status (no review, no merge)
  renumber <OLD> <NEW>
  rollback <ID> [--yes]  restore claim snapshots onto live targets
  import <folder|file>  import a Markdown task folder (or one task file)
  mcp        stdio MCP shim (auto-starts the daemon)
  agents-md  print the agent protocol snippet
  template   print the standard task-file template
  hooks [--install|--uninstall] [--settings <file>]
             Claude Code guard hooks (default ~/.claude/settings.json)
  guard      hook handler (reads hook JSON on stdin; TE_GUARD=off disables)
  daemon     run the daemon in the foreground

options:
  --ws <name>  pick a workspace when several are registered
  --json       machine-readable output
  --version    print version
`;

const AGENTS_SNIPPET = `# TeamEngage agent protocol
This workspace is coordinated by TeamEngage (tracking state lives in
.teamengage/). Read everything freely, but change state ONLY through
TeamEngage — never edit files under .teamengage/.

Plain HTTP (any agent with a shell): curl http://127.0.0.1:4747/agent
prints the full protocol with copy-paste curl examples. Or use the MCP
server "teamengage" if your IDE has it configured — same tools, same rules.

1. hello {agent: "<your-name>"}             — once per session (keep the token)
2. next                                      — pick from the returned ids
3. brief <id>                                — read targets, deps, decisions
4. claim <id>                                — then work only in returned paths
5. log <id> {note} / ask <id> {question}     — progress / blockers
6. submit <id> {commits, tests, notes}       — hand to the human
You may NOT set ready/done and must never git push — the human decides.
Ask, don't guess.

## ${AUTHORING_RULES}`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(version());
    return 0;
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [cmd, ...rest] = args;
  const home = process.env.TEAMENGAGE_HOME;
  switch (cmd) {
    case "init":
      return initCmd(rest, home);
    case "ls":
      return lsCmd(rest, home);
    case "show":
      return showCmd(rest, home);
    case "graph":
      return graphCmd(rest, home);
    case "validate":
      return validateCmd(rest, home);
    case "status":
      return statusCmd(rest, home);
    case "sync":
      return syncCmd(rest, home);
    case "approve":
      return approveCmd(rest, home);
    case "answer":
      return answerCmd(rest, home);
    case "accept":
      return acceptCmd(rest, home);
    case "reject":
      return rejectCmd(rest, home);
    case "drop":
      return dropCmd(rest, home);
    case "undrop":
      return undropCmd(rest, home);
    case "hold":
      return holdCmd(rest, home);
    case "archive":
      return archiveCmd(rest, home);
    case "unarchive":
      return unarchiveCmd(rest, home);
    case "unhold":
      return unholdCmd(rest, home);
    case "draft":
      return draftCmd(rest, home);
    case "done":
      return doneCmd(rest, home);
    case "claim":
      return humanClaimCmd(rest, home);
    case "release":
      return releaseCmd(rest, home);
    case "rollback":
      return rollbackCmd(rest, home);
    case "renumber":
      return renumberCmd(rest, home);
    case "import":
      return importCmd(rest, home);
    case "mcp": {
      const { runShim } = await import("../mcp/shim/shim.js");
      await runShim(home);
      return 0;
    }
    case "daemon": {
      const { spawnSync } = await import("node:child_process");
      const here = dirname(fileURLToPath(import.meta.url));
      const r = spawnSync(process.execPath, [join(here, "..", "daemon", "main.js")], {
        stdio: "inherit",
      });
      return r.status ?? 1;
    }
    case "guard":
      return guardCmd(rest, home);
    case "hooks":
      return hooksCmd(rest);
    case "template":
      process.stdout.write(TEMPLATE_EXAMPLE);
      return 0;
    case "agents-md":
      process.stdout.write(AGENTS_SNIPPET);
      return 0;
    case "ui": {
      const { ensureDaemon } = await import("./client.js");
      const { port, token } = await ensureDaemon(home);
      const url = `http://127.0.0.1:${port}/ui?token=${token}`;
      process.stdout.write(`${url}\n`);
      const { spawn } = await import("node:child_process");
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
      return 0;
    }
    default:
      process.stderr.write(`te: unknown command '${cmd}'\n`);
      process.stdout.write(USAGE);
      return 2;
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`te: ${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
