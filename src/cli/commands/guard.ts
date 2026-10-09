import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, resolveWorkspace, expandTilde } from "../../core/config/config.js";
import { guardToolUse, sessionContext, type GuardWorkspace } from "../../core/guard/guard.js";
import { AUTHORING_RULES } from "../../core/files/template.js";

/**
 * `te guard` — Claude Code hook handler (PreToolUse + SessionStart).
 * Reads the hook JSON on stdin; on a violation prints a PreToolUse "deny"
 * with the reason, on SessionStart prints the rules as additionalContext.
 * Fails open: any error, or TE_GUARD=off, allows silently.
 *
 * `te hooks [--install|--uninstall] [--settings <file>]` — print or merge the
 * hook config (default ~/.claude/settings.json).
 */

export function guardWorkspaces(home?: string): GuardWorkspace[] {
  const out: GuardWorkspace[] = [];
  for (const [name, entry] of Object.entries(loadRegistry(home).workspaces)) {
    try {
      const ws = resolveWorkspace(expandTilde(entry.root, home), { home });
      out.push({
        name,
        root: resolve(ws.root),
        plansDir: resolve(ws.plansDir),
        overlay: ws.config.mode === "overlay",
        ignore: ws.config.ignore,
      });
    } catch {
      /* a broken workspace is not guarded — never block on it */
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function guardCmd(_args: string[], home?: string): Promise<number> {
  if ((process.env.TE_GUARD ?? "").toLowerCase() === "off") return 0;
  try {
    const input = JSON.parse((await readStdin()) || "{}") as {
      hook_event_name?: string;
      tool_name?: string;
      tool_input?: Record<string, unknown>;
      cwd?: string;
    };
    const wss = guardWorkspaces(home);
    if (!wss.length) return 0;
    if (input.hook_event_name === "SessionStart") {
      const ctx = sessionContext(input.cwd ?? process.cwd(), wss, AUTHORING_RULES);
      if (ctx) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }),
        );
      }
      return 0;
    }
    if (!input.tool_name) return 0;
    const reason = guardToolUse(
      { tool_name: input.tool_name, tool_input: input.tool_input ?? {}, cwd: input.cwd },
      wss,
      (p) => {
        try {
          return existsSync(p) ? readFileSync(p, "utf8") : null;
        } catch {
          return null;
        }
      },
    );
    if (reason) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `TeamEngage guard: ${reason}`,
          },
        }),
      );
    }
    return 0;
  } catch {
    return 0; // fail open
  }
}

// ---- te hooks ----------------------------------------------------------------

const MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash";

/** The hook command: this CLI by absolute path, so it works without `te` on PATH. */
export function guardCommand(): string {
  const main = join(dirname(fileURLToPath(import.meta.url)), "..", "main.js");
  return `node ${JSON.stringify(resolve(main))} guard`;
}

type HookEntry = { matcher?: string; hooks: Array<{ type: string; command?: string; [k: string]: unknown }> };
type Settings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

/** Our entries: `te guard`, or `node "<…>/main.js" guard` from any install path. */
const isOurs = (e: HookEntry) => e.hooks.some((h) => /(^te|main\.js"?)\s+guard$/.test((h.command ?? "").trim()));

/** Settings with our two hooks merged in (or removed); everything else untouched. */
export function mergeHooks(settings: Settings, command: string | null): Settings {
  const out: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const put = (event: string, entry: HookEntry) => {
    const kept = (out.hooks![event] ?? []).filter((e) => !isOurs(e));
    out.hooks![event] = command ? [...kept, entry] : kept;
    if (!out.hooks![event].length) delete out.hooks![event];
  };
  put("PreToolUse", {
    matcher: MATCHER,
    hooks: [{ type: "command", command: command ?? "", timeout: 10, statusMessage: "TeamEngage guard" }],
  });
  put("SessionStart", { hooks: [{ type: "command", command: command ?? "", timeout: 10 }] });
  if (!Object.keys(out.hooks!).length) delete out.hooks;
  return out;
}

export async function hooksCmd(args: string[]): Promise<number> {
  const i = args.indexOf("--settings");
  const file = resolve(expandTilde(i === -1 ? join(homedir(), ".claude", "settings.json") : args[i + 1]));
  const install = args.includes("--install");
  const uninstall = args.includes("--uninstall");
  const command = guardCommand();
  if (!install && !uninstall) {
    process.stdout.write(JSON.stringify(mergeHooks({}, command), null, 2) + "\n");
    process.stdout.write(`\n# te hooks --install merges this into ${file}\n`);
    return 0;
  }
  let current: Settings = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, "utf8")) as Settings;
    } catch (e) {
      process.stderr.write(`refusing to touch ${file}: not valid JSON (${(e as Error).message})\n`);
      return 1;
    }
  }
  const next = mergeHooks(current, uninstall ? null : command);
  const tmp = `${file}.te-tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);
  process.stdout.write(
    uninstall
      ? `removed the TeamEngage guard hooks from ${file}\n`
      : `TeamEngage guard hooks installed in ${file} (PreToolUse ${MATCHER}, SessionStart)\n` +
          `takes effect in new Claude Code sessions; TE_GUARD=off disables it for one session\n`,
  );
  return 0;
}
