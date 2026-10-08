#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initCmd } from "./commands/init.js";
import { lsCmd, showCmd, graphCmd, validateCmd, statusCmd } from "./commands/read.js";
import {
  approveCmd,
  acceptCmd,
  humanClaimCmd,
  answerCmd,
  rejectCmd,
  dropCmd,
  releaseCmd,
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
  init [--plans <path>] [--name <n>] [--prefix <P>] [--root <dir>]
                   create a workspace (.teamengage plans repo)
  ls [--status s] [--project p] [--text t] [--json]
  show <ID> [--json]
  graph [--root <ID>] [--depth n]
  validate [--json]
  status [--json]
  approve | accept | claim | release <ID> [note]
  answer <ID> <text>
  reject | drop <ID> [reason]
  renumber <OLD> <NEW>
  import <folder>   import a Markdown task folder
  mcp        stdio MCP shim (auto-starts the daemon)
  agents-md  print the agent protocol snippet
  daemon     run the daemon in the foreground

options:
  --ws <name>  pick a workspace when several are registered
  --json       machine-readable output
  --version    print version
`;

const AGENTS_SNIPPET = `# TeamEngage agent protocol
This workspace is coordinated by TeamEngage (plans live in .teamengage/).
Use the MCP server "teamengage" — do NOT edit plan files directly.

1. hello({agent: "<your-name>"})            — once per session
2. next()                                  — pick from the returned ids
3. brief({id})                             — read targets, deps, decisions
4. claim({id})                             — then do the work
5. log({id, note}) / ask({id, question})   — progress / blockers
6. submit({id, commits, tests, notes})     — hand to the human
You may NOT set ready/done — the human decides. Ask, don't guess.
`;

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
    case "claim":
      return humanClaimCmd(rest, home);
    case "release":
      return releaseCmd(rest, home);
    case "renumber":
      return renumberCmd(rest, home);
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
    case "agents-md":
      process.stdout.write(AGENTS_SNIPPET);
      return 0;
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
