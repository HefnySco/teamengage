import { z } from "zod";
import { Prefix } from "./refs.js";

/**
 * Resource kinds (DESIGN §4, §6.3). A `git` resource is either a local checkout
 * (`path`, in or outside the workspace root) or a remote `url` pulled into a
 * managed clone.
 */
export const ResourceConfig = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git"),
    path: z.string().optional(),
    url: z.string().optional(),
    base: z.string().default("main"),
    worktree: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("ssh"),
    host: z.string().min(1),
    path: z.string().min(1),
    snapshot: z.boolean().default(true),
    exclude: z.array(z.string()).optional(),
    max_file_size: z.string().optional(),
    /** extra args for the ssh transport, e.g. ["-p","2222","-i","~/.ssh/id"] */
    ssh_opts: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("folder"),
    path: z.string().min(1),
    snapshot: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("url"),
    url: z.string().min(1),
  }),
]).superRefine((r, ctx) => {
  if (r.kind === "git" && r.path === undefined && r.url === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "git resource needs path or url" });
  }
});
export type ResourceConfig = z.infer<typeof ResourceConfig>;

export const ProjectConfig = z
  .object({
    prefix: Prefix,
    /** overlay mode: task folder relative to the root (default: the project name) */
    path: z.string().optional(),
  })
  .passthrough();
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** `<plans>/workspace.yaml` (DESIGN §4). */
export const WorkspaceConfig = z
  .object({
    name: z.string().min(1),
    prefix: Prefix,
    plans: z.string().default(".teamengage"),
    sync: z.enum(["manual", "auto"]).default("manual"),
    /**
     * `standard`: item files hold the content. `overlay`: the workspace root is
     * an existing Markdown task folder; item files hold only tracking state and
     * point at the task file via `source` (relative to the root).
     */
    mode: z.enum(["standard", "overlay"]).default("standard"),
    /**
     * A dependency in review (submitted, not accepted yet) unblocks the items
     * that depend on it. `false`: only done/dropped unblock.
     */
    review_unblocks: z.boolean().default(true),
    /** Commit each plans mutation. `false` leaves committing to the human. */
    commit: z.boolean().default(true),
    /** domain vocabulary: name → { description, color, keywords } (see core/domains) */
    domains: z.preprocess((v) => v ?? {}, z
      .record(
        z.string(),
        z
          .object({
            description: z.string().optional(),
            color: z.string().optional(),
            keywords: z.array(z.string()).optional(),
          })
          .passthrough()
          .nullable()
          .transform((v) => v ?? {}),
      )).default({}),
    /** overlay mode: globs (relative to the root) of `.md` files that are not tasks */
    ignore: z.array(z.string()).default([]),
    /** Duration string like `24h`, `30m`, `7d`. */
    stale_after: z.string().default("24h"),
    projects: z.record(z.string(), ProjectConfig).default({}),
    resources: z.record(z.string(), ResourceConfig).default({}),
    /** linked workspaces: name → workspace root path. */
    links: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

/** `~/.teamengage/machine.yaml`. */
export const MachineConfig = z
  .object({
    name: z.string().min(1),
  })
  .passthrough();
export type MachineConfig = z.infer<typeof MachineConfig>;

/**
 * `~/.teamengage/workspaces.yaml` — the per-machine registry.
 * `overrides` may rewrite any resource `path` for this machine (DESIGN §4).
 */
export const WorkspaceRegistryEntry = z
  .object({
    root: z.string().min(1),
    overrides: z.record(z.string(), z.object({ path: z.string() }).passthrough()).optional(),
  })
  .passthrough();
export type WorkspaceRegistryEntry = z.infer<typeof WorkspaceRegistryEntry>;

export const WorkspacesRegistry = z
  .object({
    workspaces: z.record(z.string(), WorkspaceRegistryEntry).default({}),
  })
  .passthrough();
export type WorkspacesRegistry = z.infer<typeof WorkspacesRegistry>;

/** Parse `24h`/`30m`/`7d`/`90s` duration strings to milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`bad duration '${s}' (expected e.g. 24h, 30m, 7d)`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    m[2] as "ms" | "s" | "m" | "h" | "d"
  ];
  return n * unit;
}
