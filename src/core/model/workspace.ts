import { z } from "zod";
import { Prefix } from "./refs.js";
import { Tier } from "./item.js";

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

/**
 * An Ops target (DESIGN §14): a deploy slot a playbook runs against —
 * a host, a service, an environment. `probe` is a read-only shell that
 * prints the deployed version.
 */
export const TargetConfig = z
  .object({
    title: z.string().optional(),
    service: z.string().optional(),
    env: z.string().optional(),
    probe: z.string().optional(),
    /** `te ops watch` runs the probe on this cadence (a duration like "5m"); unset = manual only */
    probe_every: z.string().optional(),
    /**
     * Drift compare rule (GL-0336): a regex with one capture group applied to
     * the job version and the probe version before the compare; unset = raw
     * string compare. A text the rule does not match reports unknown, not drift.
     */
    version_match: z.string().optional(),
    /** machine file id this target lives on — deploy edges decide which runners may run jobs */
    machine: z.string().optional(),
    /** app name inside the target machine's apps list */
    app: z.string().optional(),
    /** extra args for the ssh transport, e.g. ["-o","ConnectTimeout=10"] */
    ssh_opts: z.array(z.string()).optional(),
  })
  .passthrough();
export type TargetConfig = z.infer<typeof TargetConfig>;

export const ProjectConfig = z
  .object({
    prefix: Prefix,
    /** overlay mode: task folder relative to the root (default: the project name) */
    path: z.string().optional(),
  })
  .passthrough();
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/**
 * One entry of `auto_accept_rules`: every listed condition must match
 * (`domains` = the item carries each listed domain). `after` is a duration
 * string or `never` — never keeps the item for the human.
 */
export const AutoAcceptRule = z.object({
  tier: Tier.optional(),
  project: z.string().optional(),
  domains: z.array(z.string()).optional(),
  after: z.string(),
  /** the item must carry the verified badge (a passed te verify result per check) to auto-accept */
  require_verified: z.boolean().optional(),
});
export type AutoAcceptRule = z.infer<typeof AutoAcceptRule>;

/**
 * One entry of `notify` (GL-0327): fire an alert when an event of kind `on`
 * needs the human's decision. The daemon runs `command` with the event JSON
 * on stdin, or POSTs the JSON to `url`. One alert per event per rule; a
 * failed alert is logged, never fatal.
 */
export const NOTIFY_ON = [
  "question",
  "needs_human",
  "max_attempts",
  "ops_gate",
  "digest",
] as const;
export type NotifyOn = (typeof NOTIFY_ON)[number];
export const NotifyRule = z
  .object({
    on: z.enum(NOTIFY_ON),
    command: z.string().optional(),
    url: z.string().optional(),
  })
  .refine((r) => r.command || r.url, { message: "notify needs command or url" });
export type NotifyRule = z.infer<typeof NotifyRule>;

/** `<plans>/workspace.yaml` (DESIGN §4). */
/**
 * Daemon-side agent launcher (GL-0328). Unlike `run:` (a `te run` on the
 * human's command), the daemon itself starts a role's command when work for
 * that role exists — until `max_sessions` live sessions are reached.
 */
export const DispatchAgent = z.object({
  /** which pool of work starts this command: planner | coder | reviewer | ops */
  role: z.enum(["planner", "coder", "reviewer", "ops"]),
  /** the command's model tier — caps what its `next` probe sees */
  tier: z.enum(["light", "standard", "heavy"]).optional(),
  /** e.g. `claude -p "$TE_PROMPT" --model sonnet` — runs in the workspace root */
  command: z.string().min(1),
});
export type DispatchAgent = z.infer<typeof DispatchAgent>;

export const DispatchConfig = z.object({
  /** human turns it on with `te dispatch on` — off by default */
  enabled: z.boolean().default(false),
  /** active local issues (dispatches + live local in_progress claims) the dispatcher fills up to */
  max_issues: z.number().int().min(1).optional(),
  /** legacy alias for max_issues */
  max_sessions: z.number().int().min(1).default(2),
  /** optional item selector filter (e.g. "SE-01xx:inreview, Plan PL-1032:ready") */
  filter: z.string().optional(),
  agents: z.array(DispatchAgent).default([]),
});
export type DispatchConfig = z.infer<typeof DispatchConfig>;

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
    /**
     * How much agents may move work forward on their own. `strict`: every
     * plan needs the human's approve and every submission the human's accept.
     * `solo` (one human / small team): an agent's follow-up task (proposed
     * with depends_on an existing item) lands ready, and a submission with
     * an `ok` peer review is accepted by the daemon after auto_accept_after
     * unless the human acts first. Key tasks are never auto-accepted.
     */
    autonomy: z.enum(["strict", "solo"]).default("strict"),
    /** solo: delay between an `ok` peer review and the daemon's auto-accept. */
    auto_accept_after: z.string().default("30m"),
    /**
     * solo: ordered accept rules — the first that matches an item sets its
     * delay instead of auto_accept_after. A rule lists the conditions it
     * needs (all must match): `tier` (item tier, unset items match only a
     * tier-less rule), `project`, `domains` (the item must carry every listed
     * domain). `after` is a duration or `never` — never keeps the item for
     * the human. Items no rule matches use auto_accept_after.
     */
    auto_accept_rules: z.array(AutoAcceptRule).default([]),
    /**
     * GL-0361: which model may review which work. `deep`/`quick` are model
     * ids a session declares at hello. Three rules apply when set: the
     * reviewer must declare a model; its model must differ from the
     * submitter's (always required anyway); an item at or above
     * deep_from_tier needs the deep model, a lower item the quick or the
     * deep model. Unset = the different-model rule only.
     */
    review_models: z
      .object({
        deep: z.string().optional(),
        quick: z.string().optional(),
        deep_from_tier: Tier.default("heavy"),
      })
      .optional(),
    /**
     * Routine sweep, unset = off: the daemon archives an item that has been
     * done or dropped for longer than this duration. A starred item is never
     * archived by rule.
     */
    auto_archive_after: z.string().optional(),
    /**
     * Routine sweep, unset = off: the daemon releases a claim stale longer
     * than this duration whose holder session is not live on this machine —
     * the worktree and the branch stay. in_review items and claims held on
     * other machines are never released.
     */
    auto_release_after: z.string().optional(),
    /**
     * Failed attempts (AI bounces + handoffs) after which an item's tier is
     * raised one step, so a stronger model takes it (light → standard → heavy).
     */
    escalate_after: z.number().int().min(1).default(2),
    /** After this many failed attempts the item is put on hold for the human. */
    max_attempts: z.number().int().min(1).default(5),
    /**
     * A `to: "peer"` question unanswered this long becomes a normal human
     * question — the daemon's sweep moves the item to waiting (GL-0324).
     */
    peer_answer_after: z.string().default("30m"),
    /** daemon-side agent launcher — unset = the daemon starts nothing (GL-0328) */
    dispatch: DispatchConfig.optional(),
    /**
     * Alert the human on events that need a decision (GL-0327) — a list of
     * {on, command | url} rules; see NotifyRule. Unset: nothing runs.
     */
    notify: z.array(NotifyRule).default([]),
    /**
     * Agent kinds (GL-0364): kind name → glob patterns matched against the
     * session's agent name, lowercased, first match wins — e.g.
     * `{ devin: ["devin*"], forge: ["forge*", "devin-forge-*"] }`. A name
     * with no match uses the text before its first `-`/`_` as its kind.
     * Metrics groups the scorecard by kind.
     */
    agent_kinds: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * Agent models (metrics fallback): model id → glob patterns on the
     * agent name, matched like agent_kinds, first match wins. Used only
     * when a submit/review event carries no declared model —
     * events from before GL-0360 and sessions that never declare one.
     * A name with no match keeps the "unknown" row.
     */
    agent_models: z.record(z.string(), z.array(z.string())).optional(),
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
    /**
     * brief: the line cap on each inherited context block — the parent
     * plan's summary/architecture and each relates source's digest
     * (TE-0179). Longer text stops at the cap with a `more` hint.
     */
    brief_inherit_lines: z.number().int().min(1).default(60),
    /**
     * lessons: cap on the `- ` bullet lines in each lessons/<domain>.md
     * (TE-0182). An accepted lesson that would cross the cap stays pending
     * and the inbox asks the human which line to drop instead.
     */
    lessons_max: z.number().int().min(1).default(25),
    /**
     * submit: the most files outside the task's Touches a submit may
     * declare (TE-0183). Each needs extra_touches_reason and must not sit
     * inside another live claim; the human judges them at acceptance.
     */
    extra_touches_max: z.number().int().min(1).default(2),
    /**
     * A session with no pid (curl hello) whose last call is older than this
     * duration is not live; its claims become dead claims. Default 2h.
     */
    session_idle_after: z.string().default("2h"),
    projects: z.record(z.string(), ProjectConfig).default({}),
    resources: z.record(z.string(), ResourceConfig).default({}),
    /**
     * Code repos `te sync` carries between machines besides the git
     * resources: paths or `dir/*` globs relative to the root (`../*` = every
     * repo next to the task folder). Each repo's checked-out branch and any
     * te/* branches are pulled/pushed, fast-forward only.
     */
    repos: z.array(z.string()).default([]),
    /**
     * Remotes `te sync` may use for code, in preference order — a strict
     * allow-list (e.g. [origin_local, origin] keeps a public `upstream`
     * from ever being pushed). Unset: each branch's upstream remote.
     */
    sync_remotes: z.array(z.string()).default([]),
    /**
     * Extra remotes `te sync` also carries code and plans through — mirrors
     * such as a USB drive (`[USB]`). Each repo syncs through every mirror it
     * actually has, with the same fast-forward-only rules as the primary
     * remote; a mirror whose URL is a local path that is not mounted is
     * skipped. A repo with no allowed `sync_remotes` match still syncs its
     * mirrors.
     */
    mirror_remotes: z.array(z.string()).default([]),
    /** Ops deploy slots (DESIGN §14): id → host/service/env + read-only probe */
    targets: z.record(z.string(), TargetConfig).default({}),
    /** attached files (`## Artifacts`): max_mb caps one file's size (attach refuses bigger) */
    artifacts: z.object({ max_mb: z.number().positive().default(5) }).default({}),
    /** saved chats: transcript_max_mb caps one transcript's size (capture refuses bigger) */
    discussions: z
      .object({ transcript_max_mb: z.number().positive().default(20) })
      .default({}),
    /** linked workspaces: name → workspace root path. */
    links: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

/**
 * `te run` on this machine: which agent CLIs code and review. Machine-local
 * because each machine has its own agents installed. A command gets the
 * prompt as its last argument, or wherever it says `$TE_PROMPT`.
 */
export const RunConfig = z.object({
  /** e.g. `devin -p --model swe-2-high --permission-mode accept-edits --` */
  coder: z.string().min(1).optional(),
  /** e.g. `claude -p --model sonnet --permission-mode acceptEdits` — unset: the human reviews */
  reviewer: z.string().min(1).optional(),
  /** agents running at once */
  concurrency: z.number().int().min(1).default(1),
  /** times the coder is sent back to fix an `issues` review before the human decides */
  fix_rounds: z.number().int().min(0).default(1),
});
export type RunConfig = z.infer<typeof RunConfig>;

/** `~/.teamengage/machine.yaml`. */
export const MachineConfig = z
  .object({
    name: z.string().min(1),
    run: RunConfig.optional(),
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
