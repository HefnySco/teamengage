import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import YAML from "yaml";
import {
  MachineConfig,
  WorkspacesRegistry,
  WorkspaceConfig,
  type ResourceConfig,
} from "../model/workspace.js";
import { NotFoundError, ValidationError, ParseError } from "../model/errors.js";

export interface LoadedResource {
  name: string;
  config: ResourceConfig;
  /** Absolute local path for git/folder resources; remote path for ssh. */
  path?: string;
}

export interface LoadedWorkspace {
  name: string;
  /** Workspace root (absolute). */
  root: string;
  /** Plans repo dir (absolute). */
  plansDir: string;
  config: WorkspaceConfig;
  resources: Map<string, LoadedResource>;
  /** prefix → project name (workspace-level prefix maps to null). */
  prefixToProject: Map<string, string | null>;
}

export function teHome(home?: string): string {
  return join(home ?? homedir(), ".teamengage");
}

export function expandTilde(p: string, home?: string): string {
  if (p === "~" || p.startsWith("~/")) return join(home ?? homedir(), p.slice(1));
  return p;
}

function loadYamlFile<T>(path: string, schema: { parse(x: unknown): T }): T {
  if (!existsSync(path)) throw new NotFoundError(`config not found: ${path}`);
  let data: unknown;
  try {
    data = YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ParseError(`bad YAML in ${path}: ${(e as Error).message}`, path);
  }
  try {
    return schema.parse(data ?? {});
  } catch (e) {
    throw new ValidationError(`invalid ${path}: ${(e as Error).message}`);
  }
}

/** `~/.teamengage/machine.yaml`; defaults to the OS hostname. */
export function loadMachineConfig(home?: string): MachineConfig {
  const path = join(teHome(home), "machine.yaml");
  if (!existsSync(path)) return MachineConfig.parse({ name: hostname() });
  return loadYamlFile(path, MachineConfig);
}

/** `~/.teamengage/workspaces.yaml` — the per-machine registry. */
export function loadRegistry(home?: string): WorkspacesRegistry {
  const path = join(teHome(home), "workspaces.yaml");
  if (!existsSync(path)) return WorkspacesRegistry.parse({});
  return loadYamlFile(path, WorkspacesRegistry);
}

/** `<plans>/workspace.yaml`. */
export function loadWorkspaceConfig(plansDir: string): WorkspaceConfig {
  return loadYamlFile(join(plansDir, "workspace.yaml"), WorkspaceConfig);
}

/**
 * Load + resolve a workspace: expand `~`, resolve resource paths against the
 * root, apply per-machine registry overrides, verify unique prefixes.
 */
export function resolveWorkspace(
  root: string,
  opts: { home?: string; registryPath?: string } = {},
): LoadedWorkspace {
  const absRoot = resolve(expandTilde(root, opts.home));
  const registry = loadRegistry(opts.home);
  const entry = Object.values(registry.workspaces).find(
    (w) => resolve(expandTilde(w.root, opts.home)) === absRoot,
  );
  const plansDir = findPlansDir(absRoot);
  const config = loadWorkspaceConfig(plansDir);
  if (config.mode === "overlay" && plansDir === absRoot) {
    // overlay tracks task files in the root — the tracking state must stay apart
    throw new ValidationError(`overlay workspace ${absRoot}: keep the plans in .teamengage/, not at the root`);
  }

  const prefixToProject = new Map<string, string | null>([[config.prefix, null]]);
  for (const [proj, pc] of Object.entries(config.projects)) {
    if (prefixToProject.has(pc.prefix)) {
      throw new ValidationError(
        `duplicate prefix '${pc.prefix}' (project '${proj}' vs '${prefixToProject.get(pc.prefix) ?? "workspace"}')`,
      );
    }
    prefixToProject.set(pc.prefix, proj);
  }

  const resources = new Map<string, LoadedResource>();
  for (const [name, res] of Object.entries(config.resources)) {
    const override = entry?.overrides?.[name];
    const rawPath =
      override?.path ??
      ("path" in res ? res.path : undefined) ??
      undefined;
    let path: string | undefined;
    if (res.kind === "ssh") {
      path = rawPath; // remote path — never resolved locally
    } else if (rawPath !== undefined) {
      const expanded = expandTilde(rawPath, opts.home);
      path = isAbsolute(expanded) ? expanded : resolve(absRoot, expanded);
    }
    resources.set(name, { name, config: res, path });
  }

  return { name: config.name, root: absRoot, plansDir, config, resources, prefixToProject };
}

/**
 * Resource name → path root for target-overlap comparisons (CR-0008):
 * local path for git/folder resources, remote path for ssh.
 */
export function resourceRoots(ws: LoadedWorkspace): Record<string, string> {
  const roots: Record<string, string> = {};
  for (const [name, r] of ws.resources) {
    if (r.config.kind === "ssh") roots[name] = r.config.path;
    else if (r.path) roots[name] = r.path;
  }
  return roots;
}

/**
 * Locate the plans repo under a workspace root: `.teamengage/` when present;
 * the root itself when `workspace.yaml` sits there (a repo that holds only
 * plans); otherwise the single immediate child directory containing it.
 */
export function findPlansDir(absRoot: string): string {
  const def = join(absRoot, ".teamengage");
  if (existsSync(join(def, "workspace.yaml"))) return def;
  if (existsSync(join(absRoot, "workspace.yaml"))) return absRoot;
  for (const d of readdirSync(absRoot, { withFileTypes: true })) {
    if (d.isDirectory() && existsSync(join(absRoot, d.name, "workspace.yaml"))) {
      return join(absRoot, d.name);
    }
  }
  throw new NotFoundError(`no plans repo with workspace.yaml under ${absRoot}`);
}

/** Resolve `name` in the registry to a LoadedWorkspace. */
export function resolveWorkspaceByName(name: string, opts: { home?: string } = {}): LoadedWorkspace {
  const registry = loadRegistry(opts.home);
  const entry = registry.workspaces[name];
  if (!entry) throw new NotFoundError(`workspace '${name}' is not registered on this machine`);
  return resolveWorkspace(entry.root, opts);
}
