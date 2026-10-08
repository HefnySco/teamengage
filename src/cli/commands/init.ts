import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import YAML from "yaml";
import { teHome } from "../../core/config/config.js";
import { isRepo, git } from "../../resources/git/git.js";

/**
 * `te init [--plans <path>] [--name <n>] [--prefix <P>]` — create a workspace:
 * plans dir + workspace.yaml + git init + .gitignore, register it in
 * `~/.teamengage/workspaces.yaml`, create `machine.yaml` when missing.
 */
export async function initCmd(args: string[], home?: string): Promise<number> {
  const flag = (n: string) => {
    const i = args.indexOf(n);
    return i === -1 ? undefined : args[i + 1];
  };
  const root = resolve(flag("--root") ?? process.cwd());
  const plansDir = resolve(root, flag("--plans") ?? ".teamengage");
  const name = flag("--name") ?? basename(root);
  const prefix = (flag("--prefix") ?? name.slice(0, 2)).toUpperCase();

  mkdirSync(join(plansDir, "items"), { recursive: true });
  mkdirSync(join(plansDir, "claims"), { recursive: true });
  mkdirSync(join(plansDir, "decisions"), { recursive: true });
  mkdirSync(join(plansDir, "events"), { recursive: true });

  const wsYaml = join(plansDir, "workspace.yaml");
  if (!existsSync(wsYaml)) {
    writeFileSync(
      wsYaml,
      YAML.stringify({
        name,
        prefix,
        plans: ".teamengage",
        sync: "manual",
        stale_after: "24h",
        projects: {},
        links: {},
        resources: { self: { kind: "git", path: "." } },
      }),
    );
  }

  const ignore = join(plansDir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*.tmp\nworktrees/\n");

  if (!(await isRepo(plansDir))) {
    execFileSync("git", ["init", "-b", "main"], { cwd: plansDir });
    await git(plansDir, ["add", "-A"]);
    await git(plansDir, ["-c", "user.email=teamengage@local", "-c", "user.name=teamengage", "commit", "-m", "te: init workspace"]);
  }

  // machine.yaml on first run
  const home2 = teHome(home);
  mkdirSync(home2, { recursive: true });
  const machinePath = join(home2, "machine.yaml");
  if (!existsSync(machinePath)) writeFileSync(machinePath, `name: ${hostname()}\n`);

  // register in workspaces.yaml
  const regPath = join(home2, "workspaces.yaml");
  const reg = existsSync(regPath)
    ? (YAML.parse(readFileSync(regPath, "utf8")) ?? {})
    : { workspaces: {} };
  reg.workspaces ??= {};
  (reg.workspaces as Record<string, { root: string }>)[name] = { root };
  writeFileSync(regPath, YAML.stringify(reg));

  process.stdout.write(`workspace '${name}' initialized at ${plansDir} (prefix ${prefix})\n`);
  return 0;
}
