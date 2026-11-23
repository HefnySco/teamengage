import { normalizeDomain } from "../domains/domains.js";
import { ValidationError } from "../model/errors.js";
import { tierRank, type Tier } from "../model/item.js";
import { normalizeAgentName, sessionIdMatches } from "../model/session.js";
import type { RunConfig } from "../model/workspace.js";

export type Mode = "work" | "fix" | "resume" | "review" | "takeover";

export interface RunItem {
  id: string;
  status: string;
  title: string;
  type?: string;
  parent?: string;
  domains?: string[];
  tier?: Tier;
  /** failed attempts so far — drives the max_attempts admission check (TE-0208) */
  attempts?: number;
  /** persisted dispatch breaker — set after two failed runs (TE-0208) */
  dispatch_blocked?: { reason: string; at: string };
  /** structured findings the latest issues review carries (TE-0208 fix check) */
  findings?: number;
  claim?: {
    holder: string;
    machine: string;
    dead?: boolean;
    last_seen?: string;
    /** when the dispatcher first saw the claim dead — takeover grace base */
    dead_since?: string;
  } | null;
  ai_review?: { verdict: "ok" | "issues"; summary?: string; note?: string; needs_human?: boolean };
  question?: { text: string };
}

export interface RunState {
  running: Map<string, Mode>;
  fixes: Map<string, number>;
  tried: Set<string>;
  pendingClaim?: string;
  started: number;
}

export interface Pick {
  id: string;
  mode: Mode;
  /** why this item qualified — carried into dispatch_start (TE-0208) */
  reasons?: string[];
}

export type DispatchStatusFilter = "ready" | "in_review" | "in_progress";

export type DispatchTarget =
  | { kind: "id"; rawPattern: string; regex: RegExp }
  | { kind: "plan"; rawPattern: string; regex: RegExp }
  | { kind: "domain"; domain: string };

export interface DispatchClause {
  target: DispatchTarget;
  status?: DispatchStatusFilter;
  allowedModes: ReadonlySet<Mode>;
}

export interface DispatchFilter {
  raw: string;
  clauses: DispatchClause[];
}

export interface MatchedCandidate {
  id: string;
  mode: Mode;
  status: string;
  title: string;
  /** TE-0208: why the item qualifies — or why admission refused it */
  admission?: Admission;
}

/**
 * Everything admit() needs that the item alone cannot say — caller feeds
 * live dispatcher state so the predicate stays pure (TE-0208).
 */
export interface AdmissionContext {
  machine: string;
  now: number;
  maxAttempts: number;
  fixRounds: number;
  fixes: ReadonlyMap<string, number>;
  coderName: string;
  /** session ids this dispatcher opened itself — resume trusts only these */
  mintedSessions: ReadonlySet<string>;
  isLive: (sessionId: string) => boolean;
  takeoverGraceMs: number;
  /** GL-0361 rule — the reviewer command's parsed model must satisfy it */
  reviewModels?: { deep?: string; quick?: string; deep_from_tier: Tier };
  reviewerModel?: string;
}

export interface Admission {
  ok: boolean;
  /** refused: why it failed · admitted: which checks qualified it */
  reasons: string[];
}

/**
 * TE-0208: no assignment without admission checks. Every refusal is a
 * reason the preview and the dispatcher can show; an admitted item carries
 * the checks it passed.
 */
export function admit(item: RunItem, mode: Mode, ctx: AdmissionContext): Admission {
  const failed: string[] = [];
  const passed: string[] = [];
  const attempts = item.attempts ?? 0;
  if (attempts >= ctx.maxAttempts) {
    failed.push(`attempts ${attempts} ≥ max_attempts ${ctx.maxAttempts}`);
  } else {
    passed.push(`attempts ${attempts} < max_attempts ${ctx.maxAttempts}`);
  }
  if (item.dispatch_blocked) {
    failed.push(`dispatch_blocked: ${item.dispatch_blocked.reason}`);
  }
  switch (mode) {
    case "work": {
      if (item.status !== "ready") failed.push(`status ${item.status}, expected ready`);
      else if (item.claim) failed.push(`claimed by ${item.claim.holder}`);
      else passed.push("ready and unclaimed");
      break;
    }
    case "fix": {
      const fixes = ctx.fixes.get(item.id) ?? 0;
      if (fixes >= ctx.fixRounds) {
        failed.push(`fix rounds used up (${fixes}/${ctx.fixRounds})`);
      } else if (!item.ai_review?.note && !(item.findings ?? 0)) {
        failed.push("the issues review carries no note or findings");
      } else {
        passed.push(`fix ${fixes + 1}/${ctx.fixRounds} with an issues note`);
      }
      break;
    }
    case "resume": {
      const holder = item.claim?.holder;
      if (!holder) {
        failed.push("not claimed");
      } else if (!ctx.mintedSessions.has(holder)) {
        // a same-named session the dispatcher never opened is the
        // phantom-resume hole — name match alone never qualifies
        failed.push(`holder ${holder} was not minted by this dispatcher`);
      } else if (!ctx.isLive(holder)) {
        failed.push(`holder ${holder} is not live`);
      } else {
        passed.push(`holder ${holder} minted and live`);
      }
      break;
    }
    case "takeover": {
      const deadSince = Date.parse(item.claim?.dead_since ?? item.claim?.last_seen ?? "");
      const deadForMs = Number.isFinite(deadSince) ? ctx.now - deadSince : Infinity;
      if (deadForMs < ctx.takeoverGraceMs) {
        failed.push(
          `claim dead ${Math.max(0, Math.round(deadForMs / 60_000))}m < takeover_grace_after ${Math.round(ctx.takeoverGraceMs / 60_000)}m`,
        );
      } else {
        passed.push(`claim dead ${Math.round(deadForMs / 60_000)}m ≥ grace`);
      }
      break;
    }
    case "review": {
      const rm = ctx.reviewModels;
      if (rm) {
        if (!ctx.reviewerModel) {
          failed.push("the reviewer command declares no model and review_models is set");
        } else {
          const needsDeep = tierRank(item.tier) >= tierRank(rm.deep_from_tier);
          const pool = [rm.quick, rm.deep].filter(Boolean);
          const allowed = needsDeep
            ? ctx.reviewerModel === rm.deep
            : pool.length === 0 || pool.includes(ctx.reviewerModel);
          if (!allowed) {
            failed.push(`reviewer model ${ctx.reviewerModel} may not review this item`);
          } else {
            passed.push(`reviewer model ${ctx.reviewerModel} allowed`);
          }
        }
      } else {
        passed.push("no review_models rule");
      }
      break;
    }
  }
  return { ok: failed.length === 0, reasons: failed.length ? failed : passed };
}

const ALL_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "review",
  "fix",
  "resume",
  "takeover",
  "work",
]);

const STATUS_MODES: Record<DispatchStatusFilter, ReadonlySet<Mode>> = {
  ready: new Set<Mode>(["work"]),
  in_review: new Set<Mode>(["review", "fix"]),
  in_progress: new Set<Mode>(["resume", "takeover"]),
};

const NON_TASK_TYPES = new Set(["epic", "idea", "discussion", "feature"]);

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function compileIdRegex(rawPattern: string): RegExp {
  const trimmed = rawPattern.trim();
  if (!trimmed || !/^[A-Za-z0-9*?_-]+$/.test(trimmed)) {
    throw new ValidationError(`invalid item pattern '${rawPattern}'`);
  }
  const hyphenIndex = trimmed.indexOf("-");
  let source = "^";
  for (let idx = 0; idx < trimmed.length; idx++) {
    const ch = trimmed[idx];
    if (ch === "*") {
      source += ".*";
    } else if (ch === "?") {
      source += ".";
    } else if (hyphenIndex !== -1 && idx > hyphenIndex && (ch === "x" || ch === "X")) {
      source += "[0-9]";
    } else {
      source += escapeRegexChar(ch.toUpperCase());
    }
  }
  source += "$";
  return new RegExp(source);
}

function parseStatusSuffix(rawStatus: string | undefined): {
  status?: DispatchStatusFilter;
  allowedModes: ReadonlySet<Mode>;
} {
  if (rawStatus === undefined) {
    return { allowedModes: ALL_MODES };
  }
  if (!rawStatus.trim()) {
    throw new ValidationError("empty status in dispatch filter");
  }
  const normalized = rawStatus.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "ready") {
    return { status: "ready", allowedModes: STATUS_MODES.ready };
  }
  if (normalized === "inreview" || normalized === "in_review") {
    return { status: "in_review", allowedModes: STATUS_MODES.in_review };
  }
  if (normalized === "inprogress" || normalized === "in_progress") {
    return { status: "in_progress", allowedModes: STATUS_MODES.in_progress };
  }
  throw new ValidationError(
    `unknown dispatch status '${rawStatus}' (expected ready, inreview, or inprogress)`,
  );
}

function splitTargetAndStatus(body: string, originalToken: string): [string, string | undefined] {
  const parts = body.split(":");
  if (parts.length > 2) {
    throw new ValidationError(`invalid dispatch selector '${originalToken}'`);
  }
  const targetText = parts[0] ?? "";
  if (!targetText.trim()) {
    throw new ValidationError(`empty target in dispatch selector '${originalToken}'`);
  }
  return [targetText.trim(), parts[1]];
}

function tokenizeClauses(raw: string): string[] {
  const words = raw
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const clauses: string[] = [];
  for (let idx = 0; idx < words.length; idx++) {
    const word = words[idx];
    const lower = word.toLowerCase();
    if (lower === "plan" || lower === "plan:" || lower === "in:") {
      const nextWord = words[idx + 1];
      if (!nextWord || nextWord.toLowerCase() === "plan") {
        throw new ValidationError(`missing plan id after '${word}'`);
      }
      const prefix = lower === "in:" ? "in:" : "plan:";
      clauses.push(`${prefix}${nextWord}`);
      idx++;
      continue;
    }
    clauses.push(word);
  }
  return clauses;
}

function parseClause(token: string): DispatchClause {
  const lower = token.toLowerCase();
  if (lower.startsWith("plan:") || lower.startsWith("in:")) {
    const prefixLength = lower.startsWith("plan:") ? 5 : 3;
    const [planId, statusSuffix] = splitTargetAndStatus(token.slice(prefixLength), token);
    const { status, allowedModes } = parseStatusSuffix(statusSuffix);
    return {
      target: {
        kind: "plan",
        rawPattern: planId.toUpperCase(),
        regex: compileIdRegex(planId),
      },
      status,
      allowedModes,
    };
  }
  if (token.startsWith("#")) {
    const [rawDomain, statusSuffix] = splitTargetAndStatus(token.slice(1), token);
    const domain = normalizeDomain(rawDomain);
    if (!domain) {
      throw new ValidationError(`empty domain in dispatch selector '${token}'`);
    }
    const { status, allowedModes } = parseStatusSuffix(statusSuffix);
    return {
      target: { kind: "domain", domain },
      status,
      allowedModes,
    };
  }
  const [idPattern, statusSuffix] = splitTargetAndStatus(token, token);
  const { status, allowedModes } = parseStatusSuffix(statusSuffix);
  return {
    target: {
      kind: "id",
      rawPattern: idPattern.toUpperCase(),
      regex: compileIdRegex(idPattern),
    },
    status,
    allowedModes,
  };
}

export function parseDispatchFilter(raw = ""): DispatchFilter {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*") {
    return { raw: trimmed, clauses: [] };
  }
  const tokens = tokenizeClauses(trimmed);
  const clauses = tokens.map(parseClause);
  if (clauses.length === 1 && clauses[0].target.kind === "id" && clauses[0].target.rawPattern === "*" && !clauses[0].status) {
    return { raw: trimmed, clauses: [] };
  }
  return { raw: trimmed, clauses };
}

function itemInPlanSubtree(
  item: RunItem,
  planRegex: RegExp,
  itemsById: ReadonlyMap<string, RunItem>,
): boolean {
  if (item.type && NON_TASK_TYPES.has(item.type)) return false;
  const visited = new Set<string>([item.id.toUpperCase()]);
  let currentParent = item.parent;
  while (currentParent) {
    const upperParent = currentParent.toUpperCase();
    if (visited.has(upperParent)) return false;
    visited.add(upperParent);
    if (planRegex.test(upperParent)) return true;
    currentParent = itemsById.get(upperParent)?.parent;
  }
  return false;
}

function clauseMatchesTarget(
  clause: DispatchClause,
  item: RunItem,
  itemsById: ReadonlyMap<string, RunItem>,
): boolean {
  const target = clause.target;
  if (target.kind === "id") {
    if (item.type && NON_TASK_TYPES.has(item.type)) return false;
    return target.regex.test(item.id.toUpperCase());
  }
  if (target.kind === "plan") {
    return itemInPlanSubtree(item, target.regex, itemsById);
  }
  if (item.type && NON_TASK_TYPES.has(item.type)) return false;
  const itemDomains = (item.domains ?? []).map((domain) => normalizeDomain(domain));
  return itemDomains.includes(target.domain);
}

export function matchesDispatchFilter(
  filter: DispatchFilter | undefined,
  item: RunItem,
  mode: Mode,
  itemsById: ReadonlyMap<string, RunItem>,
): boolean {
  if (!filter || filter.clauses.length === 0) return true;
  return filter.clauses.some(
    (clause) => clause.allowedModes.has(mode) && clauseMatchesTarget(clause, item, itemsById),
  );
}

function buildItemsById(items: RunItem[]): Map<string, RunItem> {
  const map = new Map<string, RunItem>();
  for (const entry of items) {
    map.set(entry.id.toUpperCase(), entry);
  }
  return map;
}

export function agentName(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? "agent";
  const base = (first.split("/").pop() ?? "agent").replace(/\.[A-Za-z0-9]+$/, "");
  return normalizeAgentName(base).replace(/[^A-Za-z0-9_-]/g, "") || "agent";
}

export function promptFor(mode: Mode, id: string, name: string, base: string, token?: string): string {
  const session = token
    ? `You are already registered — do NOT call hello; send the header "X-TE-Session: ${token}" on every call.`
    : `Say hello as {"agent":"${name}${mode === "review" ? "-review" : ""}"}.`;
  const common =
    `The TeamEngage daemon is at ${base}/agent (plain HTTP; GET it once for the protocol). ` +
    `Never edit .teamengage/ files or te: lines, never git push, never approve or accept — the human does.`;
  if (mode === "review") {
    return (
      `Use the te-review skill to review ${id}. ${session} You did not write this code. ` +
      `Check every acceptance item of ${id} against its branch diff and run its tests. ` +
      `Record review ok, or review issues with one sentence naming the failed acceptance item and a note a coder can act on. ` +
      `Also give report, the decision report for the human that the te-review skill describes. ` +
      `Ok but not yours to call (risky area, an unverifiable step, unclear acceptance)? Set needs_human so it never auto-accepts. ` +
      `${common}\nFinal reply: exactly one line — "${id} ok" or "${id} issues: <summary>".`
    );
  }
  const how =
    mode === "fix"
      ? `${id} is in review with an issues verdict: claim it (takeover), read ## Review, fix exactly that, and submit again. `
      : mode === "takeover"
        ? `${id} is in progress but its holder's session ended: claim it — the claim, worktree and branch become yours — read brief ${id} (## Handoff / ## Review say where it stopped), continue the work already there, then submit. `
        : mode === "resume"
          ? `You already hold ${id} (do not claim it again). Read brief ${id} — the human may have answered your question (decisions) — and continue from the work already on its branch in the worktree, then submit. `
          : `If brief shows a ## Review or ## Handoff from an earlier attempt, read it first — that is what to fix. `;
  return (
    `Use the te-work skill to implement ${id}. ${session} ${how}` +
    `Do only this task, within its Touches and acceptance. If the task is unclear, ask instead of guessing, then stop. ` +
    `When stuck (same error twice, no progress) call handoff with problem/tried/state/next and stop. ${common}\n` +
    `Final reply: exactly one line — "${id} in_review", "${id} waiting: <question>" or "${id} handed off: <problem>".`
  );
}

export function listDispatchCandidates(
  cfg: RunConfig,
  st: { fixes: Map<string, number>; tried: Set<string> },
  items: RunItem[],
  ready: string[],
  machine: string,
  coderName = cfg.coder ? agentName(cfg.coder) : "",
  filter?: DispatchFilter,
  admission?: AdmissionContext,
): MatchedCandidate[] {
  const itemsById = buildItemsById(items);
  const candidates: MatchedCandidate[] = [];
  const seenIds = new Set<string>();
  const here = (entry: RunItem) => entry.claim?.machine === machine;
  const pushCandidate = (entry: RunItem, mode: Mode) => {
    if (seenIds.has(entry.id)) return;
    if (!matchesDispatchFilter(filter, entry, mode, itemsById)) return;
    seenIds.add(entry.id);
    candidates.push({
      id: entry.id,
      mode,
      status: entry.status,
      title: entry.title,
      ...(admission ? { admission: admit(entry, mode, admission) } : {}),
    });
  };

  if (cfg.reviewer) {
    for (const entry of items) {
      if (entry.status === "in_review" && !entry.ai_review && here(entry)) {
        pushCandidate(entry, "review");
      }
    }
  }
  if (!cfg.coder) return candidates;

  for (const entry of items) {
    if (
      entry.status === "in_review" &&
      entry.ai_review?.verdict === "issues" &&
      !entry.ai_review.needs_human &&
      here(entry) &&
      (st.fixes.get(entry.id) ?? 0) < cfg.fix_rounds
    ) {
      pushCandidate(entry, "fix");
    }
  }

  const ours = (entry: RunItem) =>
    entry.claim != null && sessionIdMatches(entry.claim.holder, coderName, machine);
  for (const entry of items) {
    if (entry.status === "in_progress" && ours(entry) && !st.tried.has(entry.id)) {
      pushCandidate(entry, "resume");
    }
  }
  for (const entry of items) {
    if (
      entry.status === "in_progress" &&
      entry.claim?.dead === true &&
      here(entry) &&
      !ours(entry) &&
      !st.tried.has(entry.id)
    ) {
      pushCandidate(entry, "takeover");
    }
  }
  for (const id of ready) {
    if (st.tried.has(id)) continue;
    const entry = itemsById.get(id.toUpperCase()) ?? { id, status: "ready", title: id };
    pushCandidate(entry, "work");
  }
  return candidates;
}

export function pickNext(
  cfg: RunConfig,
  st: RunState,
  items: RunItem[],
  ready: string[],
  machine: string,
  maxTasks = Infinity,
  coderName = cfg.coder ? agentName(cfg.coder) : "",
  filter?: DispatchFilter,
  admission?: AdmissionContext,
): Pick | undefined {
  if (st.running.size >= cfg.concurrency) return undefined;
  const itemsById = buildItemsById(items);
  const free = (id: string) => !st.running.has(id);
  const here = (entry: RunItem) => entry.claim?.machine === machine;
  const allowed = (entry: RunItem, mode: Mode) => matchesDispatchFilter(filter, entry, mode, itemsById);
  // TE-0208: when the caller gives admission context, a candidate must pass
  // admit() — the returned pick carries the checks it qualified on
  const admitted = (entry: RunItem, mode: Mode): Admission | undefined => {
    if (!admission) return { ok: true, reasons: [] };
    const result = admit(entry, mode, admission);
    return result.ok ? result : undefined;
  };

  if (cfg.reviewer) {
    for (const entry of items) {
      if (
        entry.status !== "in_review" ||
        entry.ai_review ||
        !here(entry) ||
        !free(entry.id) ||
        !allowed(entry, "review")
      ) {
        continue;
      }
      const a = admitted(entry, "review");
      if (a) return { id: entry.id, mode: "review", ...(admission ? { reasons: a.reasons } : {}) };
    }
  }
  if (!cfg.coder) return undefined;

  for (const entry of items) {
    if (
      entry.status !== "in_review" ||
      entry.ai_review?.verdict !== "issues" ||
      entry.ai_review.needs_human ||
      !here(entry) ||
      !free(entry.id) ||
      (st.fixes.get(entry.id) ?? 0) >= cfg.fix_rounds ||
      !allowed(entry, "fix")
    ) {
      continue;
    }
    const a = admitted(entry, "fix");
    if (a) return { id: entry.id, mode: "fix", ...(admission ? { reasons: a.reasons } : {}) };
  }

  const ours = (entry: RunItem) =>
    entry.claim != null && sessionIdMatches(entry.claim.holder, coderName, machine);
  for (const entry of items) {
    if (
      entry.status !== "in_progress" ||
      !ours(entry) ||
      !free(entry.id) ||
      st.tried.has(entry.id) ||
      !allowed(entry, "resume")
    ) {
      continue;
    }
    const a = admitted(entry, "resume");
    if (a) return { id: entry.id, mode: "resume", ...(admission ? { reasons: a.reasons } : {}) };
  }

  for (const entry of items) {
    if (
      entry.status !== "in_progress" ||
      entry.claim?.dead !== true ||
      !here(entry) ||
      ours(entry) ||
      !free(entry.id) ||
      st.tried.has(entry.id) ||
      !allowed(entry, "takeover")
    ) {
      continue;
    }
    const a = admitted(entry, "takeover");
    if (a) return { id: entry.id, mode: "takeover", ...(admission ? { reasons: a.reasons } : {}) };
  }

  if (st.pendingClaim || st.started >= maxTasks) return undefined;
  for (const id of ready) {
    if (!free(id) || st.tried.has(id)) continue;
    const entry = itemsById.get(id.toUpperCase()) ?? { id, status: "ready", title: id };
    if (!allowed(entry, "work")) continue;
    const a = admitted(entry, "work");
    if (a) return { id, mode: "work", ...(admission ? { reasons: a.reasons } : {}) };
  }
  return undefined;
}
