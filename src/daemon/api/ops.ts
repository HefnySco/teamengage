import YAML from "yaml";
import { execFileSync } from "node:child_process";
import { readFile, readdir, unlink } from "node:fs/promises";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, sep, isAbsolute, relative } from "node:path";
import { resolveSource, stripFrontmatter, sectionBody } from "../../core/files/source.js";
import { parseArtifacts, parseChecks } from "../../core/files/markdown.js";
import { scanSecrets, redactSecrets } from "../../core/files/secrets.js";
import { transcriptToMarkdown } from "../../core/files/transcript.js";
import {
  normalizeDomain,
  normalizeDomains,
  domainColor,
  rankDomains,
  type DomainDef,
} from "../../core/domains/domains.js";
import { parseItemRef, parseTargetRef, allocateId, normPath, compareIds } from "../../core/address/refs.js";
import { targetsOverlap } from "../../core/claims/claims.js";
import { depSatisfied, type IndexedItem } from "../../core/index/index.js";

/** `brief <id> more=transcript` page size, in lines (TE-0158). */
export const TRANSCRIPT_PAGE_LINES = 200;
import { parseTouches, touchesOverlap, type Touch } from "../../core/index/overlap.js";
import {
  evidenceCommits,
  fileMatches,
  historyRow,
  touchMatches,
  type HistoryQuery,
  type HistoryRow,
} from "../../core/index/history.js";
import { searchDocs, type SearchDoc, type SearchHit } from "../../core/index/search.js";
import { JobStore } from "../../core/ops/job.js";
import { renderMermaid, type MermaidOpts } from "../../core/mermaid/mermaid.js";
import type { Actor } from "../../core/state/machine.js";
import type { Claim } from "../../core/model/claim.js";
import type { ItemMetrics } from "../../core/metrics/metrics.js";
import {
  StarColor,
  tierRank,
  type Check,
  type ItemMeta,
  type ReviewFinding,
  VerifyFile,
  type VerifyResult,
  type Status,
  type SubmitCost,
} from "../../core/model/item.js";
import {
  ClaimRefusedError,
  ForbiddenError,
  InvalidError,
  InvalidTransitionError,
  NotFoundError,
  TeError,
  ValidationError,
} from "../../core/model/errors.js";
import { parseDuration, type AutoAcceptRule } from "../../core/model/workspace.js";
import { appendLesson, readLessons, removeLesson } from "../../core/files/lessons.js";
import { readRepoContext, writeRepoContext } from "../../core/files/repo-context.js";
import { isRepo, revParse, commitFiles as gitCommitFiles } from "../../resources/git/git.js";
import { validate, type Finding } from "../../core/validate/validate.js";
import { loadPlaybooks, playbookFindings } from "../../core/ops/playbook.js";
import { loadMachines, machineFindings, targetMachineFindings } from "../../core/ops/machine.js";
import { envFindings, loadEnvs } from "../../core/ops/env.js";
import { transFindings } from "../../core/ops/trans.js";
import { probeHistory, probeStats } from "../../core/ops/probe.js";
import type { AskHuman, Question } from "../../core/model/item.js";
import { renumber as doRenumber } from "../../core/address/renumber.js";
import {
  plannedPaths,
  setupWork,
  cleanupWork,
  mergeWork,
  snapshotDiff,
  rollbackWork,
  itemSnapshots,
  cleanupSnapshots,
} from "../effects/effects.js";
import { checkRemoteClaims, fetchPlansRepo } from "../sync/sync.js";
import { resourceRoots, resolveRepoDir, resolveRepoDirs } from "../../core/config/config.js";
import type { WorkspaceRuntime } from "../server/context.js";
import type { SessionRegistry } from "../sessions/sessions.js";
import type { Session } from "../../core/model/session.js";
import type { Index } from "../../core/index/index.js";

/**
 * Workspace operations shared by MCP tools (compact text) and the human REST
 * API (JSON). All mutations go through the store's serialized queue.
 */

export interface Links {
  statusOf(ref: string): Status | undefined;
  index(name: string): Index | undefined;
  missing(): string[];
}

/** Title/summary words that mark an item as a fix — it always carries `bug`. */
/** GL-0343/0344: word-count guard for the short human-facing fields. */
function checkWords(field: string, text: string | undefined, max: number, required = false): void {
  const t = text?.trim() ?? "";
  if (!t) {
    if (required) throw new TeError("USAGE", `${field} is required`);
    return;
  }
  const n = t.split(/\s+/).filter(Boolean).length;
  if (n > max) throw new TeError("USAGE", `${field} is ${n} words — max ${max}`);
}

/**
 * GL-0344: the human's decision card on reviews and bounces — problem
 * ≤40 words, recommendation ≤30 words, two or three options of ≤4 words.
 */
function checkAskHuman(a: AskHuman | undefined, required: boolean): void {
  if (!a) {
    if (required) throw new TeError("USAGE", "ask_human is required — {problem, recommendation, options?}");
    return;
  }
  checkWords("ask_human.problem", a.problem, 40, true);
  checkWords("ask_human.recommendation", a.recommendation, 30, true);
  if (a.options !== undefined) {
    if (a.options.length < 2 || a.options.length > 3) {
      throw new TeError("USAGE", `ask_human.options has ${a.options.length} entries — want 2 or 3`);
    }
    for (const o of a.options) checkWords("ask_human option", o, 4, true);
  }
}

const FIX_WORDS =
  /\b(bug|bugfix|broke|broken|crash|defect|fix|fixed|fixes|fixing|hotfix|regression|repair)\b/i;

/** mtime-cached verify/<ID>.yaml per file — brief() runs per request (GL-0358). */
const verifyFileCache = new Map<string, { mtimeMs: number; file: VerifyFile }>();

/** mtime-cached checks+touches per file — findings() runs per request (GL-0348). */
interface ChecksAndTouches {
  mtimeMs: number;
  checks: Check[];
  error?: string;
  touches: Touch[];
}
const checkFileCache = new Map<string, ChecksAndTouches>();

export class WorkspaceOps {
  constructor(
    readonly wsr: WorkspaceRuntime,
    private sessions: SessionRegistry,
    private links?: Links,
    /** home dir for machine-local clones/snapshots (~/.teamengage). */
    private home?: string,
  ) {}

  get store() {
    return this.wsr.store;
  }
  get index() {
    return this.wsr.store.idx;
  }

  // ---- sessions ---------------------------------------------------------

  async hello(
    agent: string,
    pid?: number,
    tier?: Session["tier"],
    role?: Session["role"],
    model?: string,
    label?: string,
  ): Promise<{ session: Session; resume: Claim[] }> {
    // GL-0360: the model id is stored lowercased — convert, never refuse
    const session = this.sessions.hello(agent, {
      pid,
      tier,
      role,
      model: model?.toLowerCase(),
      label,
    });
    // rebind only claims held by DEAD sessions — a second window of the same
    // agent on this machine must not take over a live session's claims.
    // (Dead = transport closed, client process gone, or minted before a
    // daemon restart.)
    const prior = this.sessions
      .resumeClaims(agent, this.index.claims.values())
      .filter((c) => !this.sessions.isLive(c.holder));
    const resume = await this.store.rebindClaims(prior, session.id);
    return { session, resume };
  }

  private actorFor(session: Session | "human"): Actor {
    if (session === "human") {
      return { kind: "human", session: "human", machine: this.wsr.store.machine };
    }
    this.sessions.touch(session.id);
    return {
      kind: "agent",
      session: session.id,
      machine: session.machine,
      ...(session.tier ? { tier: session.tier } : {}),
      ...(session.model ? { model: session.model } : {}),
    };
  }

  private depsDone(it: IndexedItem): boolean {
    return it.meta.depends_on.every((ref) => {
      let parsed;
      try {
        parsed = parseItemRef(ref);
      } catch {
        return false;
      }
      const local = parsed.workspace ? undefined : this.index.get(parsed.id);
      const status = local?.meta.status ?? this.links?.statusOf(ref);
      return (
        status !== undefined &&
        depSatisfied(status, this.wsr.ws.config.review_unblocks, local?.meta.unblocks_on)
      );
    });
  }

  // ---- reads ------------------------------------------------------------

  /**
   * `session`: the asking session — its tier hides items above it (its own
   * tier first) and its role picks the pool: a reviewer gets in_review items
   * it did not submit, a planner gets ready sources nothing references yet and
   * light-authored drafts to vet, a coder (or no role) gets ready items as
   * usual (GL-0323).
   */
  next(limit = 3, domain?: string, session?: Session): IndexedItem[] {
    const d = domain ? normalizeDomain(domain) : undefined;
    if (session?.role === "reviewer") {
      // DE-0161: the reviewer must be a different model — hide submissions
      // the same model produced (model id, or agent name as the fallback)
      const mine = session.model ?? session.agent;
      return [...this.index.items.values()]
        .filter((i) => i.meta.status === "in_review" && !i.meta.archived)
        .filter((i) => i.claim?.holder !== session.id) // never your own submission
        .filter((i) => {
          const submitter = i.meta.submitted_model ?? i.claim?.holder.split("@")[0];
          return !submitter || submitter !== mine;
        })
        // GL-0361: review_models — only items this model may review
        .filter((i) => {
          const rm = this.wsr.ws.config.review_models;
          if (!rm) return true;
          if (!session.model) return false;
          if (tierRank(i.meta.tier) >= tierRank(rm.deep_from_tier)) {
            return !!rm.deep && session.model === rm.deep;
          }
          const allowed = [rm.quick, rm.deep].filter(Boolean);
          return allowed.length === 0 || allowed.includes(session.model);
        })
        .filter((i) => !d || i.meta.domains.includes(d))
        .slice(0, limit);
    }
    if (session?.role === "planner") {
      return [...this.index.items.values()]
        .filter((i) => !i.meta.archived)
        .filter(
          (i) =>
            // sources: only ready ones with no live referrer — a draft is
            // not offered (the human's approve queues it) and a referenced
            // one is planned already; refs left only by dropped items count as free
            ((i.meta.type === "idea" || i.meta.type === "discussion") &&
              i.meta.status === "ready" &&
              (i.idea_refs ?? []).every(
                (rid) => this.index.get(rid)?.meta.status === "dropped",
              )) ||
            (i.meta.status === "draft" && i.meta.authored_tier === "light" && !i.meta.vetted_by),
        )
        .filter((i) => !d || i.meta.domains.includes(d))
        .slice(0, limit);
    }
    const tier = session?.tier;
    const claimedTargets = [...this.index.claims.values()]
      .filter((c) => !c.conflicted)
      .flatMap((c) => c.targets);
    return this.index
      .readyItems()
      .filter((i) => i.meta.type !== "epic" && i.meta.type !== "idea" && i.meta.type !== "discussion") // plans and sources — agents claim tasks
      .filter((i) => !d || i.meta.domains.includes(d))
      .filter(
        (i) => !targetsOverlap(i.meta.targets, claimedTargets, resourceRoots(this.wsr.ws)).overlap,
      )
      .filter((i) => !tier || !i.meta.tier || tierRank(i.meta.tier) <= tierRank(tier))
      .map((i, n) => ({ i, n, k: tier && i.meta.tier === tier ? 0 : 1 }))
      .sort((a, b) => a.k - b.k || a.n - b.n)
      .map((x) => x.i)
      .slice(0, limit);
  }

  // ---- domains ------------------------------------------------------------

  /** The vocabulary with item counts (archived items not counted as open). */
  async domains() {
    const defs = await this.store.currentDomains();
    const names = new Set(Object.keys(defs));
    for (const it of this.index.items.values()) for (const d of it.meta.domains) names.add(d);
    return [...names].sort().map((name) => {
      const items = [...this.index.items.values()].filter((i) => i.meta.domains.includes(name));
      return {
        name,
        description: defs[name]?.description,
        keywords: defs[name]?.keywords ?? [],
        color: domainColor(name, defs[name]),
        count: items.filter((i) => !i.meta.archived).length,
        open: items.filter((i) => !i.meta.archived && !["done", "dropped"].includes(i.meta.status))
          .length,
        archived: items.filter((i) => i.meta.archived).length,
      };
    });
  }

  async setDomains(id: string, domains: string[], actor: Session | "human") {
    this.item(id);
    return this.store.setDomains(id, domains, this.actorFor(actor));
  }

  defineDomain(name: string, patch: DomainDef) {
    return this.store.defineDomain(name, patch);
  }

  renameDomain(from: string, to: string) {
    return this.store.renameDomain(from, to, this.actorFor("human"));
  }

  deleteDomain(name: string) {
    return this.store.deleteDomain(name, this.actorFor("human"));
  }

  // ---- shared lessons per domain (GL-0322) ----------------------------------

  /** Domains a lesson may name: the vocabulary plus every name items use. */
  private async knownDomains(): Promise<Set<string>> {
    const defs = await this.store.currentDomains();
    const names = new Set(Object.keys(defs));
    for (const it of this.index.items.values()) for (const d of it.meta.domains) names.add(d);
    return names;
  }

  /**
   * An agent shares a hard-won lesson: one `- date session — text` line
   * appended to lessons/<domain>.md in the plans folder. Unknown domains
   * are refused — a lesson under a typo teaches nobody.
   */
  async lesson(session: Session, domain: string, text: string) {
    const d = normalizeDomain(domain);
    if (!d || !text.trim()) throw new TeError("USAGE", "lesson needs a domain and a text");
    if (!(await this.knownDomains()).has(d)) {
      throw new InvalidTransitionError(
        `lesson: unknown domain '${d}' — define it first (domains page or a domains: tag on an item)`,
      );
    }
    await appendLesson(this.wsr.ws.plansDir, d, session.id, text, new Date().toISOString());
    return { domain: d };
  }

  /**
   * An agent updates one section of a repo's context card
   * (repos/<repo>.context.md, GL-0355) — e.g. a build command that
   * turned out wrong. The daemon writes it and logs the event.
   */
  async repoContext(session: Session, repo: string, section: string, text: string) {
    if (!repo?.trim() || !section?.trim() || !text?.trim()) {
      throw new ValidationError("repo_context needs a repo, a section and a text");
    }
    await writeRepoContext(this.wsr.ws.root, repo.trim(), section, text);
    await this.store.logEvent({
      ts: new Date().toISOString(),
      actor: session.id,
      session: session.id,
      action: "repo_context",
      note: `${repo.trim()} — ${section.trim()}`,
    });
    return { repo: repo.trim(), section: section.trim() };
  }

  /** Context cards for the repos named in an item's Touches. For `brief`. */
  private async repoContextsOf(it: IndexedItem): Promise<{ repo: string; text: string }[]> {
    const repos = new Set(
      (await this.touchesOf(it)).map((t) => t.repo).filter((r): r is string => Boolean(r)),
    );
    const out: { repo: string; text: string }[] = [];
    for (const repo of repos) {
      const text = await readRepoContext(this.wsr.ws.root, repo);
      if (text) out.push({ repo, text });
    }
    return out;
  }

  /**
   * Lessons for these item domains — newest first (the date each line
   * starts with), at most `limit`. For `brief`.
   */
  async lessonsFor(domains: string[], limit = 10): Promise<string[]> {
    const all: { date: string; line: string }[] = [];
    for (const d of domains) {
      for (const l of await readLessons(this.wsr.ws.plansDir, d)) {
        const date = /^(\d{4}-\d{2}-\d{2})\s/.exec(l)?.[1] ?? "";
        all.push({ date, line: `[#${d}] ${l}` });
      }
    }
    return all
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map((x) => x.line);
  }

  /** Every lessons file, for the domains page: domain → its lines. */
  async allLessons(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    let files: string[] = [];
    try {
      files = await readdir(join(this.wsr.ws.plansDir, "lessons"));
    } catch {
      return out;
    }
    for (const f of files.filter((x) => x.endsWith(".md"))) {
      const lines = await readLessons(this.wsr.ws.plansDir, f.slice(0, -3));
      if (lines.length) out[f.slice(0, -3)] = lines;
    }
    return out;
  }

  /** Human deletes lesson number `n` (1-based) of a domain. */
  async deleteLesson(domain: string, n: number) {
    const removed = await removeLesson(this.wsr.ws.plansDir, domain, n);
    if (removed === null) throw new NotFoundError(`no lesson ${n} for #${domain}`);
    return { removed };
  }

  /**
   * Keyword-based suggestions: for each non-archived item, domains whose
   * keywords occur in its title / task file / simple text and that it
   * doesn't have yet. Nothing is changed.
   */
  async suggestDomains(): Promise<
    Array<{ id: string; title: string; current: string[]; add: string[] }>
  > {
    const defs = await this.store.currentDomains();
    const out: Array<{ id: string; title: string; current: string[]; add: string[] }> = [];
    for (const it of this.index.items.values()) {
      if (it.meta.archived) continue;
      let text = "";
      if (this.wsr.ws.config.mode === "overlay" && it.meta.source) {
        const src = await resolveSource(this.wsr.ws.root, it.meta.id, it.meta.source);
        if (src) text = stripFrontmatter(src.text);
      } else {
        text = it.sections.map((s) => s.body).join("\n");
      }
      const touches = text.match(/^\**touches:?\**:?.*$/im)?.[0] ?? "";
      const body = text.replace(/^#.*$/m, ""); // the title line counts as strong already
      const lead = body
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .slice(0, 2)
        .join("\n");
      // the file name, not its folder: the folder is the project, already shown
      const fileName = (it.meta.source ?? "").split("/").pop() ?? "";
      const strong = [it.meta.title, it.meta.legacy_id ?? "", fileName, touches].join("\n");
      const add = rankDomains({ strong, lead, body }, defs).filter(
        (d) => !it.meta.domains.includes(d),
      );
      if (add.length)
        out.push({ id: it.meta.id, title: it.meta.title, current: it.meta.domains, add });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Apply suggestions (only adds — never removes a domain). */
  async applySuggestions(ids?: string[]) {
    const all = await this.suggestDomains();
    const pick = ids ? all.filter((s) => ids.includes(s.id)) : all;
    for (const s of pick) await this.setDomains(s.id, [...s.current, ...s.add], "human");
    return { items: pick.length, added: pick.reduce((n, s) => n + s.add.length, 0) };
  }

  item(id: string): IndexedItem {
    const it = this.index.get(id);
    if (!it) throw new NotFoundError(`item ${id} not found`);
    return it;
  }

  async brief(id: string) {
    const it = this.item(id);
    const source = await this.source(it);
    const sectionBody = (dep: IndexedItem, name: string) =>
      dep.sections.find((s) => s.heading.toLowerCase() === name.toLowerCase())?.body ?? "";
    // archiving/starring is bookkeeping, not an outcome — skip those lines
    const lastLine = (s: string) =>
      s
        .trim()
        .split("\n")
        .filter((l) => l && !/ (un)?(archived|starred)( \w+)? \(status /.test(l))
        .at(-1) ?? "";
    const deps = it.meta.depends_on.map((ref) => {
      const parsed = parseItemRef(ref);
      const dep = parsed.workspace ? undefined : this.index.get(parsed.id);
      return {
        ref,
        status: dep?.meta.status ?? this.links?.statusOf(ref) ?? "unknown",
        archived: Boolean(dep?.meta.archived),
        /** satisfied only because review_unblocks: its work may still be rejected */
        pending:
          dep?.meta.status === "in_review" &&
          depSatisfied("in_review", this.wsr.ws.config.review_unblocks, dep.meta.unblocks_on),
        /** a key task: dependents wait for its acceptance */
        key:
          (dep?.meta.unblocks_on ?? (this.wsr.ws.config.review_unblocks ? "review" : "done")) ===
          "done",
        outcome: dep ? lastLine(sectionBody(dep, "Log")) : "",
        evidence: dep ? lastLine(sectionBody(dep, "Evidence")) : "",
        /** provides: lines from all of the dep's ## Evidence (GL-0325) */
        provides: dep
          ? sectionBody(dep, "Evidence")
              .split("\n")
              .map((l) => /^- provides:\s*(.+)$/.exec(l.trim())?.[1])
              .filter((x): x is string => Boolean(x))
          : [],
      };
    });
    const decisions = [...this.index.decisions.values()].filter((d) => {
      try {
        const depIds = new Set(it.meta.depends_on.map((r) => parseItemRef(r).id));
        return depIds.has(parseItemRef(d.meta.item).id) || parseItemRef(d.meta.item).id === id;
      } catch {
        return false;
      }
    });
    const targets = it.meta.targets.map((t) => {
      const parsed = parseTargetRef(t);
      const res = this.wsr.ws.resources.get(parsed.resource);
      return {
        ref: t,
        resource: parsed.resource,
        kind: res?.config.kind ?? "unknown",
        path: it.claim?.paths?.[parsed.resource] ?? res?.path,
        host: res?.config.kind === "ssh" ? res.config.host : undefined,
      };
    });
    // reverse edges: the items this one unblocks (it.blocks is derived by the index)
    const dependents = it.blocks.map((ref) => {
      const dep = this.index.get(ref);
      return { ref, status: dep?.meta.status ?? "unknown", archived: Boolean(dep?.meta.archived) };
    });
    // loose references, both ways — e.g. a plan pointing back at the idea(s)
    // it was generated from. Reference only: no ordering, no blocking.
    const relates = it.meta.relates.map((ref) => {
      const parsed = parseItemRef(ref);
      const dep = parsed.workspace ? undefined : this.index.get(parsed.id);
      return { ref, status: dep?.meta.status ?? this.links?.statusOf(ref) ?? "unknown" };
    });
    const found_by = (it.meta.found_by ?? []).map((ref) => {
      const parsed = parseItemRef(ref);
      const dep = parsed.workspace ? undefined : this.index.get(parsed.id);
      return { ref, status: dep?.meta.status ?? this.links?.statusOf(ref) ?? "unknown" };
    });
    // GL-0356: context from past work — the parent plan's goal line,
    // titles of decisions in this item's domains, and the newest done
    // items that touched the same paths.
    let plan_goal: string | undefined;
    if (it.meta.parent) {
      try {
        const p = this.index.get(parseItemRef(it.meta.parent).id);
        if (p) {
          plan_goal =
            sectionBody(p, "Summary").trim().split("\n").find((l) => l.trim()) ?? p.meta.title;
        }
      } catch {
        /* bad parent ref — the validator reports it */
      }
    }
    const listed = new Set(decisions.map((d) => d.meta.id));
    const domain_decisions = [...this.index.decisions.values()]
      .filter((d) => {
        if (listed.has(d.meta.id)) return false;
        try {
          const src = this.index.get(parseItemRef(d.meta.item).id);
          return src !== undefined && src.meta.domains.some((x) => it.meta.domains.includes(x));
        } catch {
          return false;
        }
      })
      .map((d) => ({ id: d.meta.id, title: d.meta.title }));
    const myTouches = await this.touchesOf(it);
    const histAll: HistoryRow[] = [];
    for (const d of this.index.items.values()) {
      if (d.meta.id === it.meta.id || d.meta.status !== "done") continue;
      if (touchesOverlap(myTouches, await this.touchesOf(d)).length) histAll.push(historyRow(d));
    }
    histAll.sort((a, b) => b.date.localeCompare(a.date) || compareIds(b.id, a.id));

    const wsName = this.wsr.ws.config.name;
    const referenced_by = [...this.index.items.values()]
      .filter(
        (x) =>
          x.meta.id !== id &&
          x.meta.relates.some((r) => {
            try {
              const p = parseItemRef(r);
              return (p.workspace === undefined || p.workspace === wsName) && p.id === id;
            } catch {
              return false;
            }
          }),
      )
      .map((x) => ({ ref: x.meta.id, status: x.meta.status }));
    return {
      item: it.claim ? { ...it, claim: { ...it.claim, dead: this.claimDead(it.claim) } } : it,
      deps,
      dependents,
      decisions,
      targets,
      relates,
      found_by,
      found_here: it.found_here,
      plan_problems: it.plan_problems,
      referenced_by,
      question: it.meta.question,
      repo_context: await this.repoContextsOf(it),
      plan_goal,
      domain_decisions,
      history: histAll.slice(0, 3),
      history_total: histAll.length,
      source,
      checks: (await this.checksOf(it)).checks,
      verify: await this.verifyOf(it),
      verified: this.verifiedBadge(it),
      ops_jobs: this.opsJobsForItem(it),
      reviewUnblocks: this.wsr.ws.config.review_unblocks,
      autonomy: this.wsr.ws.config.autonomy,
      autoAcceptAt: this.autoAcceptAt(it),
      autoAcceptRule: this.autoAcceptRuleLabel(it),
      overlap: await this.touchOverlaps(id),
      ...(it.meta.type === "feature" ? { feature: await this.featureView(it) } : {}),
    };
  }

  /**
   * A feature's derived lifecycle (GL-0331, DESIGN §15.1): `planned` while no
   * part is done, `in_progress` once work lands.
   */
  async featureStatus(it: IndexedItem): Promise<"planned" | "in_progress"> {
    const accepted = (it.feature_parts ?? []).filter(
      (p) => this.index.items.get(p)?.meta.status === "done",
    );
    return accepted.length ? "in_progress" : "planned";
  }

  /**
   * The feature page's payload: derived status, progress, the plans that name
   * it with their own progress, open found problems under those plans, and the
   * ideas it came from.
   */
  async featureView(it: IndexedItem) {
    const plans = (it.feature_plans ?? []).map((pid) => {
      const p = this.index.items.get(pid);
      return {
        id: pid,
        title: p?.meta.title ?? pid,
        status: p?.meta.status ?? "unknown",
        plan_state: p?.plan_state,
        done: p?.plan_progress?.done ?? 0,
        total: p?.plan_progress?.total ?? 0,
      };
    });
    // problems under the plans: found_here items plus problem parts — the
    // same set planProblems counts, kept as a list for the page
    const problems = new Map<string, { id: string; title: string; status: string }>();
    for (const pid of it.feature_plans ?? []) {
      for (const p of this.index.planProblemItems(pid)) problems.set(p.id, p);
    }
    const ideas = it.meta.relates
      .map((ref) => {
        try {
          return this.index.items.get(parseItemRef(ref).id);
        } catch {
          return undefined;
        }
      })
      .filter((d): d is IndexedItem => d?.meta.type === "idea" || d?.meta.type === "discussion")
      .map((d) => ({ id: d.meta.id, title: d.meta.title, idea_state: d.idea_state }));
    return {
      status: await this.featureStatus(it),
      progress: it.feature_progress ?? { done: 0, total: 0 },
      plans,
      problems: [...problems.values()],
      ideas,
    };
  }

  /** Feature id → derived status, for the items list. */
  async featureStatusMap(): Promise<Map<string, string>> {
    const feats = [...this.index.items.values()].filter((i) => i.meta.type === "feature");
    const out = new Map<string, string>();
    for (const f of feats) out.set(f.meta.id, await this.featureStatus(f));
    return out;
  }

  /**
   * The item's `**Touches:**` entries — the overlay task file for overlay
   * items, the item file itself otherwise (GL-0326).
   */
  private async touchesOf(it: IndexedItem): Promise<Touch[]> {
    let text = "";
    if (this.wsr.ws.config.mode === "overlay" && it.meta.source) {
      text =
        (await resolveSource(this.wsr.ws.root, it.meta.id, it.meta.source))?.text ?? "";
    } else {
      text = await readFile(join(this.wsr.ws.plansDir, it.path), "utf8").catch(() => "");
    }
    return parseTouches(text);
  }

  /** Repo name → local checkout dir, built once — the shared resolver (git resources, `repos:` globs, the root). */
  private repoDirs?: Map<string, string>;
  private repoDir(name: string): string | undefined {
    if (this.repoDirs === undefined) this.repoDirs = resolveRepoDirs(this.wsr.ws);
    return resolveRepoDir(this.wsr.ws, name, this.repoDirs);
  }

  private commitFileCache = new Map<string, Promise<string[]>>();
  private commitFiles(repo: string, sha: string): Promise<string[]> {
    const key = `${repo}@${sha}`;
    let p = this.commitFileCache.get(key);
    if (!p) {
      p = gitCommitFiles(repo, sha);
      this.commitFileCache.set(key, p);
    }
    return p;
  }

  /**
   * GL-0353: the last finished items that changed `path` — a Touches glob
   * covers it, or one of the item's Evidence commits touched it when the
   * repo is on this machine. Newest first, `limit` rows (default 5).
   */
  async history(q: HistoryQuery): Promise<HistoryRow[]> {
    const query: HistoryQuery = { ...q, path: normPath(q.path) };
    const rows: HistoryRow[] = [];
    for (const it of this.index.items.values()) {
      if (it.meta.status !== "done") continue;
      let hit = (await this.touchesOf(it)).some((t) => touchMatches(t, query));
      if (!hit) {
        for (const c of evidenceCommits(it)) {
          if (query.repo !== undefined && c.repo !== query.repo) continue;
          const dir = this.repoDir(c.repo);
          if (!dir) continue;
          for (const sha of c.shas) {
            if (fileMatches(await this.commitFiles(dir, sha), query.path)) {
              hit = true;
              break;
            }
          }
          if (hit) break;
        }
      }
      if (hit) rows.push(historyRow(it));
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || compareIds(b.id, a.id));
    return rows.slice(0, q.limit ?? 5);
  }

  /** mtime-cached source text per file — deep search re-reads only what changed (GL-0354). */
  private searchFileCache = new Map<string, { mtimeMs: number; text: string }>();

  /** An item's searchable text: managed sections plus the overlay task file.
   *  A discussion gives its whole distilled layer — that is what makes a
   *  saved chat findable again (TE-0158). */
  private searchTextOf(it: IndexedItem): string {
    const parts = [
      it.meta.title,
      ...it.sections
        .filter((s) =>
          it.meta.type === "discussion"
            ? true
            : /^(summary|notes|for the human|walkthrough|evidence|review|simple)$/i.test(s.heading),
        )
        .map((s) => s.body),
    ];
    if (this.wsr.ws.config.mode === "overlay" && it.meta.source) {
      const file = join(this.wsr.ws.root, it.meta.source);
      try {
        const mtimeMs = statSync(file).mtimeMs;
        const cached = this.searchFileCache.get(file);
        let text: string;
        if (cached?.mtimeMs === mtimeMs) text = cached.text;
        else {
          text = readFileSync(file, "utf8");
          this.searchFileCache.set(file, { mtimeMs, text });
        }
        parts.push(text);
      } catch {
        /* missing source — the overlay finding reports it */
      }
    }
    return parts.join("\n");
  }

  /**
   * GL-0354: deep search over finished items (summary/what/how/walkthrough/
   * notes), decisions and lessons — every query word must hit, ranked by
   * match count, one ≤30-word snippet per hit. In memory, no database.
   */
  /** A discussion's raw transcript on disk (TE-0158): the overlay sidecar
   *  `<source>.transcript.md` or the `.artifacts/` file capture wrote. */
  private transcriptFileOf(it: IndexedItem): string | undefined {
    if (this.wsr.ws.config.mode === "overlay" && it.meta.source) {
      const p = join(this.wsr.ws.root, it.meta.source.replace(/\.md$/i, ".transcript.md"));
      if (existsSync(p)) return p;
    }
    const art = it.artifacts.find((a) => a.path.endsWith(".transcript.md"));
    if (art) {
      const p = isAbsolute(art.path)
        ? art.path
        : join(this.wsr.ws.root, ".artifacts", art.path);
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  /**
   * `brief <id> more=transcript page=N` (TE-0158): the discussion's raw
   * transcript in pages of ~200 lines. Pages clamp to [1, pages].
   */
  discussionTranscript(id: string, page = 1) {
    const it = this.item(id.toUpperCase());
    if (it.meta.type !== "discussion") {
      throw new ValidationError(
        `brief more=transcript: ${id} is a ${it.meta.type}, not a discussion`,
      );
    }
    const file = this.transcriptFileOf(it);
    if (!file) throw new NotFoundError(`${id}: no transcript saved yet`);
    const lines = readFileSync(file, "utf8").split("\n");
    const pages = Math.max(1, Math.ceil(lines.length / TRANSCRIPT_PAGE_LINES));
    const p = Math.min(Math.max(1, page), pages);
    // every `## ` turn header over the whole file — the reader's jump dots
    // cover all pages, not only the one shown (a ## inside a fence is code)
    const turns: Array<{ line: number; page: number; head: string }> = [];
    let fence: string | null = null;
    lines.forEach((l, i) => {
      const f = /^(```|~~~)/.exec(l.trim());
      if (f) {
        if (fence === null) fence = f[1];
        else if (l.trim().startsWith(fence)) fence = null;
        return;
      }
      if (fence) return;
      // only real turn heads count — "## Section" lines inside a body are
      // content (dumps carry task files, docs, reports)
      const m = /^##\s+((?:user|assistant|human)\b.*)$/i.exec(l);
      if (m) turns.push({ line: i, page: Math.floor(i / TRANSCRIPT_PAGE_LINES) + 1, head: m[1] });
    });
    return {
      path: relative(this.wsr.ws.root, file).split(sep).join("/"),
      page: p,
      pages,
      total: lines.length,
      start: (p - 1) * TRANSCRIPT_PAGE_LINES,
      turns,
      text: lines.slice((p - 1) * TRANSCRIPT_PAGE_LINES, p * TRANSCRIPT_PAGE_LINES).join("\n"),
    };
  }

  async search(q: {
    text: string;
    domain?: string;
    limit?: number;
    in?: string;
  }): Promise<SearchHit[]> {
    const docs: SearchDoc[] = [];
    if (q.in === "transcript") {
      // TE-0158: `in: transcript` searches only the raw transcripts —
      // a word that lives only there is found here, not in the default corpus
      for (const it of this.index.items.values()) {
        if (it.meta.type !== "discussion") continue;
        const file = this.transcriptFileOf(it);
        if (!file) continue;
        docs.push({
          kind: "transcript",
          id: it.meta.id,
          title: it.meta.title,
          domains: it.meta.domains,
          date: it.meta.updated ?? "",
          text: readFileSync(file, "utf8"),
        });
      }
      return searchDocs(docs, q.text, { domain: q.domain, limit: q.limit ?? 10 });
    }
    for (const it of this.index.items.values()) {
      // discussions enter the corpus at any status — the distilled layer is
      // what makes a saved chat findable again (TE-0158)
      if (it.meta.type === "discussion") {
        docs.push({
          kind: "discussion",
          id: it.meta.id,
          title: it.meta.title,
          domains: it.meta.domains,
          date: historyRow(it).date,
          text: this.searchTextOf(it),
        });
        continue;
      }
      if (it.meta.status !== "done" && it.meta.status !== "dropped") continue;
      docs.push({
        kind: "item",
        id: it.meta.id,
        title: it.meta.title,
        domains: it.meta.domains,
        date: historyRow(it).date,
        text: this.searchTextOf(it),
      });
    }
    for (const d of this.index.decisions.values()) {
      let domains: string[] = [];
      try {
        domains = this.index.get(parseItemRef(d.meta.item).id)?.meta.domains ?? [];
      } catch {
        /* a decision naming an item this workspace doesn't have */
      }
      docs.push({
        kind: "decision",
        id: d.meta.id,
        title: d.meta.title,
        domains,
        date: d.meta.created ?? "",
        text: [d.meta.title, ...d.sections.map((s) => s.body)].join("\n"),
      });
    }
    try {
      for (const f of readdirSync(join(this.wsr.ws.plansDir, "lessons")).filter((f) =>
        f.endsWith(".md"),
      )) {
        const domain = f.slice(0, -3);
        docs.push({
          kind: "lesson",
          id: `#${domain}`,
          title: `lessons for #${domain}`,
          domains: [domain],
          date: "",
          text: readFileSync(join(this.wsr.ws.plansDir, "lessons", f), "utf8"),
        });
      }
    } catch {
      /* no lessons dir yet */
    }
    return searchDocs(docs, q.text, { domain: q.domain, limit: q.limit ?? 10 });
  }

  /**
   * An item's `## Checks` (GL-0348): the overlay task file for overlay
   * items, the item file otherwise. A section that does not parse comes
   * back as `error` — a finding, never a broken index.
   */
  private async checksOf(it: IndexedItem): Promise<{ checks: Check[]; error?: string }> {
    if (this.wsr.ws.config.mode === "overlay" && it.meta.source) {
      const found = await resolveSource(this.wsr.ws.root, it.meta.id, it.meta.source);
      if (!found) return { checks: [] };
      try {
        return { checks: parseChecks(sectionBody(found.text, "Checks")) };
      } catch (e) {
        return { checks: [], error: e instanceof Error ? e.message : String(e) };
      }
    }
    return { checks: it.checks ?? [] };
  }

  /**
   * The stored `te verify` results of an item (GL-0358) — `verify/<ID>.yaml`
   * in the plans repo, cached by mtime.
   */
  verifyOf(it: IndexedItem): VerifyResult[] {
    const file = join(this.wsr.ws.plansDir, "verify", `${it.meta.id}.yaml`);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return [];
    }
    const cached = verifyFileCache.get(file);
    if (cached?.mtimeMs === mtimeMs) return cached.file.results;
    try {
      const parsed = VerifyFile.parse(YAML.parse(readFileSync(file, "utf8")));
      verifyFileCache.set(file, { mtimeMs, file: parsed });
      return parsed.results;
    } catch {
      return [];
    }
  }

  /** checksOf for sync callers — the recorded source file only (no walk). */
  private checksSyncOf(it: IndexedItem): Check[] {
    if (this.wsr.ws.config.mode === "overlay" && it.meta.source) {
      try {
        return parseChecks(
          sectionBody(readFileSync(join(this.wsr.ws.root, it.meta.source), "utf8"), "Checks"),
        );
      } catch {
        return [];
      }
    }
    return it.checks ?? [];
  }

  /**
   * The verified badge (GL-0350): the item has checks and every check has a
   * passed `te verify` result. `results` is the latest stored result per
   * check — the UI shows its runner (actor) and when.
   */
  verifiedBadge(it: IndexedItem): { ok: boolean; results: VerifyResult[] } {
    const checks = this.checksSyncOf(it);
    const results = this.verifyOf(it);
    const latest = new Map<string, VerifyResult>();
    for (const r of results) if (!latest.has(r.check)) latest.set(r.check, r);
    const ok =
      checks.length > 0 && checks.every((c) => results.some((r) => r.check === c.name && r.passed));
    return { ok, results: [...latest.values()] };
  }

  /**
   * The ops jobs that deployed one of this item's Evidence commits
   * (GL-0340): for each `commit <repo>@<sha>` line a job matches when its
   * recorded repo path resolves to the resource's path and the sha is an
   * ancestor of the job's recorded HEAD.
   */
  opsJobsForItem(it: IndexedItem): { id: string; playbook: string; status: string; version?: string }[] {
    let lines: string[] = [];
    try {
      const text = readFileSync(join(this.wsr.ws.plansDir, it.path), "utf8");
      lines = (sectionBody(text, "Evidence") ?? "").split("\n");
    } catch {
      /* source-doc items keep evidence in the source file — try it */
      try {
        const text = readFileSync(join(this.wsr.ws.root, it.meta.source ?? ""), "utf8");
        lines = (sectionBody(text, "Evidence") ?? "").split("\n");
      } catch {
        return [];
      }
    }
    const commits = lines
      .map((l) => /^- commit (\S+)@([0-9a-f]+)/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ repo: m[1], sha: m[2] }));
    if (!commits.length) return [];
    const jobs = new JobStore(this.wsr.ws.root, this.wsr.ws.plansDir, this.wsr.store.machine).listAll();
    const out: { id: string; playbook: string; status: string; version?: string }[] = [];
    const seen = new Set<string>();
    for (const c of commits) {
      const res = this.wsr.ws.resources.get(c.repo);
      if (!res?.path) continue;
      const dir = resolve(res.path);
      for (const job of jobs) {
        if (seen.has(job.id) || !job.repos) continue;
        for (const r of job.repos) {
          if (!r.commit || resolve(this.wsr.ws.root, r.path) !== dir) continue;
          try {
            execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", c.sha, r.commit]);
            out.push({ id: job.id, playbook: job.playbook, status: job.status, version: job.version });
            seen.add(job.id);
          } catch {
            /* the sha is not in this job's recorded HEAD */
          }
          break;
        }
      }
    }
    return out;
  }

  /**
   * Record one `te verify` result posted by the runner (GL-0358): the check
   * name must be one of the item's checks (else INVALID), the output tail is
   * kept to its last 50 lines, and the store writes the result file, the
   * `verified:` Evidence line and the event in one commit. The daemon never
   * runs the command — it only records.
   */
  async verifyResult(
    id: string,
    args: {
      check: string;
      exit_code: number;
      passed: boolean;
      commit?: string;
      output_tail?: string;
      output_sha256?: string;
    },
    actor: Session | "human",
  ): Promise<VerifyResult> {
    const it = this.item(id.toUpperCase());
    const { checks } = await this.checksOf(it);
    if (!checks.some((c) => c.name === args.check)) {
      throw new InvalidError(`check '${args.check}' is not one of the item's checks`);
    }
    const tail = args.output_tail?.split("\n").slice(-50).join("\n");
    const result: VerifyResult = {
      check: args.check,
      exit_code: args.exit_code,
      passed: args.passed,
      commit: args.commit ?? "",
      at: new Date().toISOString(),
      ...(args.output_sha256 ? { output_sha256: args.output_sha256 } : {}),
      ...(tail ? { output_tail: tail } : {}),
      actor: actor === "human" ? "human" : actor.id,
    };
    const at = result.commit ? ` @${result.commit.slice(0, 10)}` : "";
    const line = `- verified: ${result.check} — ${result.passed ? "passed" : "not passed"} (exit ${result.exit_code})${at}`;
    await this.store.recordVerify(it.meta.id, result, line, this.actorFor(actor));
    return result;
  }

  /**
   * Open items whose Touches paths overlap `id`'s — a warning, never a
   * refusal (GL-0326). Only items an agent could pick up or is working on
   * count: ready or in_progress leaf items, not archived, not done/dropped.
   */
  async touchOverlaps(id: string): Promise<{ id: string; paths: string[] }[]> {
    const mine = await this.touchesOf(this.item(id));
    if (!mine.length) return [];
    const out: { id: string; paths: string[] }[] = [];
    for (const other of this.index.items.values()) {
      if (other.meta.id === id || other.meta.archived) continue;
      if (other.meta.type === "epic" || other.meta.type === "idea" || other.meta.type === "discussion")
        continue;
      if (other.meta.status !== "ready" && other.meta.status !== "in_progress") continue;
      const paths = touchesOverlap(mine, await this.touchesOf(other));
      if (paths.length) out.push({ id: other.meta.id, paths });
    }
    return out;
  }

  /** All pairwise Touches overlaps among open leaf items — for the board chip. */
  async overlapMap(): Promise<Map<string, { id: string; paths: string[] }[]>> {
    const open = [...this.index.items.values()].filter(
      (i) =>
        !i.meta.archived &&
        i.meta.type !== "epic" &&
        i.meta.type !== "idea" &&
        i.meta.type !== "discussion" &&
        (i.meta.status === "ready" || i.meta.status === "in_progress"),
    );
    const touches = new Map<string, Touch[]>();
    for (const i of open) touches.set(i.meta.id, await this.touchesOf(i));
    const map = new Map<string, { id: string; paths: string[] }[]>();
    const push = (k: string, v: { id: string; paths: string[] }) =>
      map.set(k, [...(map.get(k) ?? []), v]);
    for (const a of open)
      for (const b of open) {
        if (b.meta.id <= a.meta.id) continue;
        const paths = touchesOverlap(touches.get(a.meta.id)!, touches.get(b.meta.id)!);
        if (!paths.length) continue;
        push(a.meta.id, { id: b.meta.id, paths });
        push(b.meta.id, { id: a.meta.id, paths });
      }
    return map;
  }

  /**
   * Overlay mode: the item's task file (frontmatter stripped), found by its
   * recorded path or, after a rename/move, by its `te:` tag. `missing` when
   * the item records a source that no longer exists anywhere.
   */
  private async source(
    it: IndexedItem,
  ): Promise<
    | { path: string; text: string; moved: boolean; simple?: { path: string; text: string } }
    | { path: string; missing: true }
    | undefined
  > {
    if (this.wsr.ws.config.mode !== "overlay" || !it.meta.source) return undefined;
    const root = this.wsr.ws.root;
    const main = await resolveSource(root, it.meta.id, it.meta.source);
    if (!main) return { path: it.meta.source, missing: true };
    const simple = it.meta.simple_source
      ? await resolveSource(root, it.meta.id, it.meta.simple_source, { simple: true })
      : undefined;
    return {
      path: main.path,
      text: stripFrontmatter(main.text),
      moved: main.moved,
      ...(simple ? { simple: { path: simple.path, text: stripFrontmatter(simple.text) } } : {}),
    };
  }

  query(filter: Parameters<Index["query"]>[0]): IndexedItem[] {
    return this.index.query(filter);
  }

  graph(opts: MermaidOpts): string {
    return renderMermaid(this.index, { ...opts, autoAcceptAt: (it) => this.autoAcceptAt(it) });
  }

  /** All descendant ids of an item (children recursively, parent-cycle safe). */
  descendants(id: string): string[] {
    return this.index.descendants(id);
  }

  /** The problems chip's expandable list — the same set plan_problems counts. */
  planProblemList(id: string) {
    const it = this.item(id);
    return { problems: this.index.planProblemItems(it.meta.id) };
  }

  async findings(): Promise<Finding[]> {
    // claims whose holder session ended on this machine strand their item
    // (in_progress forever, invisible to next) — a day-late stale_claim is
    // not enough, so warn now: take it over (claim) or release it
    const dead: Finding[] = [...this.index.claims.values()]
      .filter((c) => {
        if (!this.claimDead(c)) return false;
        const st = this.index.items.get(c.item)?.meta.status;
        return st !== undefined && st !== "done" && st !== "dropped";
      })
      .map((c) => ({
        severity: "warning" as const,
        kind: "dead_claim" as const,
        item: c.item,
        message: `claim by ${c.holder} — its session ended; another agent can take it over (claim), or release it`,
      }));
    const machines = loadMachines(this.wsr.ws.root);
    const machineIds = new Set(machines.flatMap((m) => (m.machine ? [m.machine.id] : [])));
    const ops = [
      ...playbookFindings(loadPlaybooks(this.wsr.ws.root), this.wsr.ws.config.targets),
      ...machineFindings(machines),
      ...envFindings(loadEnvs(this.wsr.ws.root), machineIds),
      ...targetMachineFindings(this.wsr.ws.config.targets, machines),
      ...transFindings(this.wsr.ws.root, machineIds),
    ];
    return [
      ...validate(this.index, {
        staleAfterMs: parseDuration(this.wsr.ws.config.stale_after),
        roots: resourceRoots(this.wsr.ws),
        contextDir: join(this.wsr.ws.root, "repos"),
        reviewModels: this.wsr.ws.config.review_models,
      }),
      ...dead,
      ...ops,
      ...(this.wsr.overlay?.findings() ?? []),
      ...this.checkFindings(),
      ...this.probeFindings(),
    ];
  }

  /**
   * Probe down alerts (GL-0338): one inbox line per target whose newest
   * stored probe row is not ok — derived from the GL-0335 history, so a
   * target that recovers clears by itself and a not_reachable target
   * (nothing stored, GL-0337) never lands here.
   */
  private probeFindings(): Finding[] {
    const out: Finding[] = [];
    for (const t of Object.keys(this.wsr.ws.config.targets)) {
      const hist = probeHistory(t, this.home);
      const last = hist[hist.length - 1];
      if (!last || last.ok) continue;
      const since = probeStats(hist).last_state_change ?? last.ts;
      out.push({
        severity: "warning",
        kind: "ops_probe",
        path: "workspace.yaml",
        message: `target '${t}' probe is not ok since ${since}${last.error ? ` — ${last.error}` : last.exit_code !== undefined ? ` — exit ${last.exit_code}` : ""} (by ${last.by})`,
      });
    }
    return out;
  }

  /**
   * `## Checks` findings (GL-0348): a section that does not parse, a check
   * with no run, a check naming a repo outside the item's Touches, and a
   * duplicate check name. Cached per file by mtime — findings() runs on
   * every request and must not re-read unchanged task files.
   */
  private checkFindings(): Finding[] {
    const out: Finding[] = [];
    const overlay = this.wsr.ws.config.mode === "overlay";
    for (const it of this.index.items.values()) {
      const file =
        overlay && it.meta.source
          ? join(this.wsr.ws.root, it.meta.source)
          : join(this.wsr.ws.plansDir, it.path);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue; // missing source has its own overlay finding
      }
      const cached = checkFileCache.get(file);
      if (cached?.mtimeMs === mtimeMs) {
        out.push(...this.checkFindingsOf(it, cached));
        continue;
      }
      let entry: ChecksAndTouches;
      try {
        const text = readFileSync(file, "utf8");
        entry = {
          mtimeMs,
          touches: parseTouches(text),
          ...(() => {
            try {
              return { checks: overlay ? parseChecks(sectionBody(text, "Checks")) : it.checks ?? [], error: undefined };
            } catch (e) {
              return { checks: [] as Check[], error: e instanceof Error ? e.message : String(e) };
            }
          })(),
        };
      } catch {
        continue;
      }
      checkFileCache.set(file, entry);
      out.push(...this.checkFindingsOf(it, entry));
    }
    return out;
  }

  /** The findings for one item's cached checks+touches. */
  private checkFindingsOf(it: IndexedItem, c: ChecksAndTouches): Finding[] {
    const id = it.meta.id;
    const f = (message: string): Finding => ({ severity: "error", kind: "check", item: id, path: it.path, message });
    if (c.error) return [f(`${id}: ${c.error}`)];
    if (!c.checks.length) return [];
    const out: Finding[] = [];
    const repos = new Set(c.touches.map((t) => t.repo).filter(Boolean));
    const seen = new Set<string>();
    for (const check of c.checks) {
      if (seen.has(check.name)) out.push(f(`${id}: duplicate check name '${check.name}'`));
      seen.add(check.name);
      if (!check.run?.trim()) out.push(f(`${id}: check '${check.name}' has no run`));
      if (!check.repo?.trim()) {
        out.push(f(`${id}: check '${check.name}' has no repo`));
      } else if (!repos.has(check.repo)) {
        out.push(
          f(
            `${id}: check '${check.name}' names repo '${check.repo}' outside Touches` +
              (repos.size ? ` (${[...repos].join(", ")})` : " (Touches has no repos)"),
          ),
        );
      }
    }
    return out;
  }

  // ---- agent writes -----------------------------------------------------

  async claim(
    id: string,
    session: Session,
  ): Promise<{
    claim: Claim;
    version: number;
    resumed: Array<{ resource: string; branch: string }>;
    overlap: { id: string; paths: string[] }[];
  }> {
    const it = this.item(id);
    if (it.meta.type === "epic") {
      throw new ClaimRefusedError("epics are plans — claim their tasks");
    }
    if (it.meta.type === "idea") {
      throw new ClaimRefusedError("ideas are sources — plan from them");
    }
    if (it.meta.type === "discussion") {
      throw new ClaimRefusedError(
        "discussions are never claimed — a saved chat is a source; plan from it",
      );
    }
    const mine = it.claim;
    if (mine) {
      // takeover: an AI-flagged submission (in_review + issues) stays
      // claimed to its machine — another session here may pick the fix up.
      // A needs_human card (the send-back cap) is the human's, never a
      // takeover. An in_progress item whose holder can't act from here
      // (dead session) is takeable the same way — it would strand
      // otherwise. The state machine makes the final call (holderAway via
      // ctx below).
      const takeover =
        (it.meta.status === "in_review" &&
          it.meta.ai_review?.verdict === "issues" &&
          !it.meta.ai_review.needs_human &&
          mine.machine === session.machine) ||
        (it.meta.status === "in_progress" &&
          this.holderAway(it) &&
          mine.machine === session.machine);
      if (!takeover) {
        throw new ClaimRefusedError(
          `already claimed by ${mine.holder} on ${mine.machine} — release on ${mine.machine} or by the human here`,
          mine.holder,
          mine.machine,
        );
      }
    }
    const now = new Date().toISOString();
    const claim: Claim = {
      item: id,
      holder: session.id,
      actor: "agent",
      machine: session.machine,
      targets: it.meta.targets,
      claimed_at: now,
      last_seen: now,
      paths: await plannedPaths(this.wsr.ws, id, it.meta.targets),
      ...(session.tier ? { tier: session.tier } : {}),
    };
    // SY-0001: shrink the double-claim race — fetch plans repo and check
    // remote claims before writing ours (manual sync mode). The local
    // overlap check runs inside the store's write queue via `guard` —
    // checking it here raced with other claims mid-flight.
    await checkRemoteClaims(this.wsr, claim);
    const roots = resourceRoots(this.wsr.ws);
    const r = await this.store.perform(
      id,
      it.meta.version,
      this.actorFor(session),
      { type: "claim", claim },
      {
        depsDone: this.depsDone(it),
        guard: this.overlapGuard(it.meta.targets, roots, id),
        holderAway: () => this.holderAway(this.item(id)),
        planHold: () => this.index.get(id)?.paused_by,
      },
    );
    // worktrees/snapshots come after the committed claim; failure → release
    let resumed: Array<{ resource: string; branch: string }> = [];
    try {
      resumed = (await setupWork(this.wsr.ws, id, claim, this.home)).resumed;
    } catch (e) {
      await this.release(id, session, `setup failed: ${(e as Error).message}`).catch(() => {});
      throw e;
    }
    for (const res of resumed) {
      await this.store.annotate(id, {
        heading: "Log",
        lines: [`- resumed prior work on branch ${res.branch} (@${res.resource})`],
      });
    }
    // GL-0326: warn when the claimed item's Touches paths overlap another
    // open item's — advisory only, the claim already stands
    const overlap = await this.touchOverlaps(id);
    return { claim, version: r.meta.version, resumed, overlap };
  }

  /** Overlap check that runs inside the store's serialized write queue. */
  private overlapGuard(
    targets: string[],
    roots = resourceRoots(this.wsr.ws),
    except_item?: string,
  ) {
    return () => {
      for (const c of this.index.claims.values()) {
        if (c.conflicted) continue;
        if (c.item === except_item) continue; // an item's own claim can't conflict with it (takeover)
        const o = targetsOverlap(targets, c.targets, roots);
        if (o.overlap) {
          throw new ClaimRefusedError(
            `target ${o.via?.[0]} overlaps claim on ${c.item} held by ${c.holder} on ${c.machine} — release on ${c.machine} or by the human here`,
            c.holder,
            c.machine,
            o.via?.[0],
          );
        }
      }
    };
  }

  async release(id: string, actor: Session | "human", note?: string) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(id, it.meta.version, this.actorFor(actor), {
      type: "release",
      note,
    });
    if (claim) {
      await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
    }
    // refresh our view of other machines' claims — the release itself only
    // reaches them when the human pushes, but a fetch keeps the next claim's
    // remote check current
    if (this.wsr.ws.config.sync === "manual") await fetchPlansRepo(this.wsr.ws.plansDir);
    return r;
  }

  /**
   * The item's claim holder can't act from this daemon: the claim lives on
   * another machine, or its local session is no longer live. Human claims
   * never count — the human acts through any machine's UI.
   */
  private holderAway(it: IndexedItem): boolean {
    const c = it.claim;
    if (!c || c.actor === "human") return false;
    return c.machine !== this.wsr.store.machine || !this.sessions.isLive(c.holder);
  }

  /**
   * The claim's holder session ended on this machine — the item strands
   * (in_progress) until a session takes it over (claim) or the human
   * releases it. Surfaced as `dead` on API claims and a `dead_claim`
   * finding.
   */
  claimDead(c: Claim): boolean {
    return (
      c.actor === "agent" && c.machine === this.wsr.store.machine && !this.sessions.isLive(c.holder)
    );
  }

  private assertLiveClaim(it: IndexedItem): void {
    if (it.claim?.conflicted) {
      throw new ClaimRefusedError(
        `claim on ${it.meta.id} lost a sync conflict — stop work and release (see inbox)`,
        it.claim.holder,
        it.claim.machine,
      );
    }
  }

  async log(id: string, session: Session, note: string) {
    const it = this.item(id);
    this.assertLiveClaim(it);
    return this.store.perform(
      id,
      it.meta.version,
      this.actorFor(session),
      {
        type: "log",
        note,
      },
      {
        // persist last_seen inside the write queue + the same commit
        touchClaim: this.sessions.shouldTouchClaim(id),
      },
    );
  }

  async ask(id: string, session: Session, text: string, options?: string[], to?: "peer", context?: string) {
    const it = this.item(id);
    this.assertLiveClaim(it);
    checkWords("question", text, 40, true);
    const question = {
      text,
      options,
      ...(context !== undefined ? { context } : {}),
      asked_by: session.id,
      asked_at: new Date().toISOString(),
    };
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "ask",
      question,
      to,
    });
  }

  /** A peer session answers a `to: "peer"` question — the item stays with its holder (GL-0324). */
  async answerPeer(id: string, session: Session, answer: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "answer_peer",
      answer,
    });
  }

  /**
   * Daemon sweep (GL-0324): a `to: "peer"` question unanswered for longer
   * than peer_answer_after becomes a normal human question → waiting.
   */
  async peerAnswerSweep(now = new Date()): Promise<string[]> {
    const after = parseDuration(this.wsr.ws.config.peer_answer_after);
    const moved: string[] = [];
    for (const it of this.index.items.values()) {
      const q = it.meta.question;
      if (!q || q.to !== "peer" || it.meta.status !== "in_progress") continue;
      if (now.getTime() - new Date(q.asked_at).getTime() < after) continue;
      await this.store.perform(
        it.meta.id,
        this.item(it.meta.id).meta.version,
        { kind: "daemon", session: "daemon", machine: this.wsr.store.machine },
        { type: "peer_timeout" },
      );
      moved.push(it.meta.id);
    }
    return moved;
  }

  /** Open peer questions a session may answer — other sessions, same or higher tier. */
  peerQuestionsFor(session?: Session): IndexedItem[] {
    return [...this.index.items.values()].filter((i) => {
      const q = i.meta.question;
      if (!q || q.to !== "peer" || i.meta.status !== "in_progress") return false;
      if (session && q.asked_by === session.id) return false;
      return tierRank(session?.tier ?? "standard") >= tierRank(q.peer_tier ?? "standard");
    });
  }

  async submit(
    id: string,
    session: Session,
    evidence?: {
      commits?: string[];
      tests?: string;
      notes?: string;
      walkthrough?: string;
      what?: string;
      how?: string;
      cost?: SubmitCost;
      finding_states?: Array<{ finding: number; state: "done" | "skipped"; reason?: string }>;
      provides?: string[];
      /** GL-0349: skip the checks gate — the reason is stored and the
       * ok review on this submission becomes needs_human */
      unverified_reason?: string;
    },
  ) {
    const it = this.item(id);
    this.assertLiveClaim(it);
    // GL-0349: an item with checks needs a passed verify result per check
    // at the current HEAD of its repo — unverified_reason is the way around
    const { checks } = await this.checksOf(it);
    if (checks.length && !evidence?.unverified_reason?.trim()) {
      const results = await this.verifyOf(it);
      const byName = new Map(results.map((r) => [r.check, r]));
      const firstRes = it.meta.targets[0]
        ? parseTargetRef(it.meta.targets[0]).resource
        : undefined;
      for (const check of checks) {
        const r = byName.get(check.name);
        if (!r) {
          throw new InvalidTransitionError(
            `submit: check '${check.name}' has no verify result — run te verify (or give unverified_reason)`,
          );
        }
        if (!r.passed) {
          throw new InvalidTransitionError(
            `submit: check '${check.name}' did not pass (exit ${r.exit_code}) — fix it or give unverified_reason`,
          );
        }
        const resource = check.repo ?? firstRes;
        const dir = resource
          ? (it.claim?.paths?.[resource] ??
            this.wsr.ws.resources.get(resource)?.path ??
            this.repoDir(resource))
          : undefined;
        if (dir && (await isRepo(dir))) {
          const head = await revParse(dir, "HEAD").catch(() => "");
          if (head && r.commit !== head) {
            throw new InvalidTransitionError(
              `submit: check '${check.name}' result is stale — it passed at ${r.commit.slice(0, 10) || "?"}, the repo is at ${head.slice(0, 10)} — run te verify again`,
            );
          }
        }
      }
    }
    // GL-0343: the human reads what/how, the agent layer keeps walkthrough
    checkWords("what", evidence?.what, 40, true);
    checkWords("how", evidence?.how, 60, true);
    // RS-0006/7: attach the live-vs-snapshot diff for ssh/folder targets
    const diffs: string[] = [];
    const seen = new Set<string>();
    for (const t of it.claim?.targets ?? []) {
      const { resource } = parseTargetRef(t);
      if (seen.has(resource)) continue;
      seen.add(resource);
      const r = this.wsr.ws.resources.get(resource);
      if (!r || (r.config.kind !== "ssh" && r.config.kind !== "folder")) continue;
      const d = await snapshotDiff(this.wsr.ws, id, resource, this.home);
      if (d) diffs.push(`@${resource}: ${d}`);
    }
    const ev = diffs.length
      ? { ...evidence, notes: [evidence?.notes, diffs.join("\n")].filter(Boolean).join("\n") }
      : evidence;
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "submit",
      evidence: ev,
    });
  }

  /**
   * AI peer review of a submission: a second agent session (never the
   * holder) records verdict ok|issues + note. An `ok` is advisory — the
   * item stays `in_review` for the human. `issues` is the one send-back
   * path: a live local holder keeps the claim and fixes, a dead or
   * outgrown holder's claim goes to `ready` (branch kept), a holder on
   * another machine is left untouched, and at the issues cap the item
   * stays for the human. Find submissions with `query status=in_review`.
   */
  async review(
    id: string,
    session: Session,
    verdict: "ok" | "issues",
    note?: string,
    summary?: string,
    needsHuman?: boolean,
    report?: string,
    findings?: ReviewFinding[],
    askHuman?: AskHuman,
  ) {
    // GL-0344: a plain ok needs only a ≤25-word summary; anything the
    // human must decide on needs the ask_human card
    if (verdict === "ok" && !needsHuman) checkWords("summary", summary, 25);
    else checkAskHuman(askHuman, true);
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(
      id,
      it.meta.version,
      this.actorFor(session),
      { type: "review", verdict, note, summary, needs_human: needsHuman, report, findings, ask_human: askHuman },
      {
        ...(verdict === "issues"
          ? { priorBounces: () => this.aiBouncesSinceHumanTouch(id) }
          : {}),
        holderAway: () => this.holderAway(this.item(id)),
      },
    );
    // an issues verdict that freed the claim (dead or outgrown holder,
    // attempts exhausted) cleans the work up but keeps the branch
    if (claim && r.meta.status !== "in_review" && r.meta.status !== "in_progress") {
      await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
    }
    return r;
  }

  /**
   * Compat alias, one release only: a bounce is a `review` with an
   * `issues` verdict now — same claim rules, same cap.
   */
  async bounce(
    id: string,
    session: Session,
    reason: string,
    summary?: string,
    findings?: ReviewFinding[],
    askHuman?: AskHuman,
  ) {
    return this.review(id, session, "issues", reason, summary, undefined, undefined, findings, askHuman);
  }

  /**
   * The holder pulls its own submission back to keep working:
   * in_review → in_progress, claim and worktree kept.
   */
  async withdraw(id: string, actor: Session | "human") {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor(actor), { type: "withdraw" });
  }

  /**
   * The holder is stuck: record problem / tried / state / next in the task's
   * ## Handoff, release the claim (branches kept) so a fresh session — or a
   * stronger tier after escalate_after attempts — picks it up from the note.
   */
  async handoff(
    id: string,
    session: Session,
    h: { problem: string; tried: string; state?: string; next?: string },
  ) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "handoff",
      ...h,
    });
    if (claim) await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
    return r;
  }

  /** A stronger session checks a light-authored draft; under solo an `ok` approves it. */
  async vet(id: string, session: Session, verdict: "ok" | "issues", note?: string) {
    const it = this.item(id);
    const r = await this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "vet",
      verdict,
      note,
    });
    if (verdict === "ok" && this.wsr.ws.config.autonomy === "solo") {
      await this.store.perform(id, r.meta.version, this.daemonActor(), { type: "approve_plan" });
      await this.store.annotate(id, {
        heading: "Log",
        lines: ["- auto-approved after vet ok (autonomy: solo)"],
      });
      return { ...r, approved: true };
    }
    return { ...r, approved: false };
  }

  /** Human: set or clear the tier an item needs; `reset` zeroes its attempts. */
  async setTier(id: string, tier?: Session["tier"], reset = false) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "set_tier",
      tier,
      reset,
    });
  }

  /**
   * Bounces by AI reviewers this item took since anything else happened to
   * it — the holder's fix/submit cycle in between doesn't count, but any
   * human/daemon action or a new claim starts a fresh cycle (loop guard).
   * Best-effort: reads the merged event streams, so a machine behind on
   * pull may miss the most recent bounces from other machines.
   */
  private async aiBouncesSinceHumanTouch(id: string): Promise<number> {
    const { readAllEvents } = await import("../../core/events/log.js");
    const r = await readAllEvents(join(this.wsr.ws.plansDir, "events"));
    let bounces = 0;
    for (const e of [...r.events].reverse()) {
      if (e.item !== id) continue;
      // legacy bounce events and unified issues-reviews both count
      if (e.action === "bounce" || (e.action === "review" && (e.note ?? "").startsWith("issues"))) {
        bounces++;
        continue;
      }
      // the holder's own line of work between bounces
      if (
        e.action === "submit" ||
        e.action === "log" ||
        e.action === "review" ||
        e.action === "ask"
      ) {
        continue;
      }
      break;
    }
    return bounces;
  }

  /**
   * Metrics derived from the merged event log — nothing is stored (GL-0317).
   * No `plan` → per-agent scorecard plus tier and domain roll-ups over the
   * whole workspace. `plan` → roll-up of that plan and its parts.
   */
  async metrics(plan?: string) {
    const { readAllEvents } = await import("../../core/events/log.js");
    const { deriveMetrics, rollUp, agentKind, deriveReviewers } = await import("../../core/metrics/metrics.js");
    const r = await readAllEvents(join(this.wsr.ws.plansDir, "events"));
    const stats = deriveMetrics(r.events, this.wsr.ws.config.agent_models);

    if (plan) {
      const ids = new Set([plan, ...this.index.descendants(plan)]);
      const parts = [...ids]
        .filter((id) => this.index.items.has(id))
        .sort()
        .map((id) => {
          const it = this.index.items.get(id)!;
          return {
            id,
            title: it.meta.title,
            status: it.meta.status,
            tier: it.meta.tier ?? "unset",
            domains: it.meta.domains,
            metrics: stats.get(id) ?? null,
          };
        });
      return {
        plan,
        totals: rollUp(
          parts.map((p) => p.metrics).filter((m): m is NonNullable<typeof m> => m !== null),
        ),
        parts,
        warnings: r.warnings,
      };
    }

    const by = (keyOf: (id: string) => string | string[] | undefined) => {
      const buckets = new Map<string, ItemMetrics[]>();
      for (const m of stats.values()) {
        const keys = keyOf(m.id) ?? "untagged";
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          const list = buckets.get(k) ?? [];
          list.push(m);
          buckets.set(k, list);
        }
      }
      return [...buckets.entries()]
        .map(([key, list]) => ({ key, ...rollUp(list) }))
        .sort((a, b) => b.done - a.done || a.key.localeCompare(b.key));
    };

    return {
      totals: rollUp([...stats.values()]),
      // GL-0364: scorecard rows are agent KINDS — devin-sl0005 rolls into
      // devin — each row names its member session names with their counts
      agents: (() => {
        const kinds = new Map<string, ItemMetrics[]>();
        for (const m of stats.values()) {
          if (!m.worker) continue;
          const kind = agentKind(m.worker, this.wsr.ws.config.agent_kinds);
          const list = kinds.get(kind) ?? [];
          list.push(m);
          kinds.set(kind, list);
        }
        return [...kinds.entries()]
          .map(([key, list]) => {
            const byName = new Map<string, { items: number; done: number }>();
            for (const m of list) {
              const e = byName.get(m.worker!) ?? { items: 0, done: 0 };
              e.items++;
              e.done += m.done;
              byName.set(m.worker!, e);
            }
            return {
              key,
              ...rollUp(list),
              members: [...byName.entries()]
                .map(([name, c]) => ({ name, ...c }))
                .sort((a, b) => b.items - a.items || a.name.localeCompare(b.name)),
            };
          })
          .sort((a, b) => b.done - a.done || a.key.localeCompare(b.key));
      })(),
      tiers: by((id) => this.index.items.get(id)?.meta.tier ?? "unset"),
      // GL-0365: one row per submit model ("unknown" for submits without
      // one). An item with no submits credits no model — it is skipped,
      // not counted as unknown.
      models: (() => {
        const buckets = new Map<string, ItemMetrics[]>();
        for (const m of stats.values()) {
          for (const model of m.models) {
            const list = buckets.get(model) ?? [];
            list.push(m);
            buckets.set(model, list);
          }
        }
        return [...buckets.entries()]
          .map(([key, list]) => ({ key, ...rollUp(list) }))
          .sort((a, b) => b.done - a.done || a.key.localeCompare(b.key));
      })(),
      reviewers: deriveReviewers(r.events, this.wsr.ws.config.agent_models),
      domains: by((id) => {
        const d = this.index.items.get(id)?.meta.domains;
        return d && d.length ? d : "untagged";
      }),
      warnings: r.warnings,
    };
  }

  /**
   * Drill-down behind one metrics number — the items inside a bucket.
   * `by` is the scorecard section (agents / tiers / models / domains /
   * reviewers / all), `key` the row inside it; `member` narrows an agent
   * kind to one session name. `field` is the clicked column: scorecards
   * filter on it (done, bounces, handoffs, rounds, claims, rejects, cost,
   * durations; "items" keeps the whole bucket), reviewers pick the
   * verdict list (ok / issues / wrong_ok).
   */
  async metricsDrill(q: { by?: string; key?: string; field?: string; member?: string }) {
    const { readAllEvents } = await import("../../core/events/log.js");
    const { deriveMetrics, agentKind, deriveReviewers, median } = await import("../../core/metrics/metrics.js");
    const r = await readAllEvents(join(this.wsr.ws.plansDir, "events"));
    const stats = deriveMetrics(r.events, this.wsr.ws.config.agent_models);
    const by = q.by ?? "all";

    let list: ItemMetrics[];
    if (by === "reviewers") {
      // a reviewer number counts verdicts, not item stats — the drill lists
      // the verdict events (one row per review round, items may repeat)
      const row = deriveReviewers(r.events, this.wsr.ws.config.agent_models).find((x) => x.model === q.key);
      const refs =
        q.field === "ok" ? row?.ok_events : q.field === "wrong_ok" ? row?.wrong_ok_events : (row?.issues_events ?? []);
      const items = (refs ?? [])
        .map((ref) => {
          const it = this.index.items.get(ref.item);
          return { id: ref.item, title: it?.meta.title ?? "", status: it?.meta.status ?? "", verdict: q.field, actor: ref.actor, ts: ref.ts };
        })
        .sort((a, b) => b.ts.localeCompare(a.ts));
      return { by, key: q.key, field: q.field, member: q.member, items };
    } else {
      list = [...stats.values()].filter((m) => {
        switch (by) {
          case "all":
            return true;
          case "agents": {
            if (!m.worker) return false;
            if (q.member && m.worker !== q.member) return false;
            return agentKind(m.worker, this.wsr.ws.config.agent_kinds) === q.key;
          }
          case "tiers":
            return (this.index.items.get(m.id)?.meta.tier ?? "unset") === q.key;
          case "models":
            return m.models.has(q.key ?? "");
          case "domains": {
            const d = this.index.items.get(m.id)?.meta.domains;
            return (d && d.length ? d : ["untagged"]).includes(q.key ?? "");
          }
          default:
            return false;
        }
      });
    }

    const keep = (m: ItemMetrics): boolean => {
      switch (q.field) {
        case "done":
          return m.done > 0;
        case "bounces":
          return m.bounces > 0;
        case "handoffs":
          return m.handoffs > 0;
        case "rounds":
          return m.review_rounds > 0;
        case "claims":
          return m.claims > 0;
        case "rejects":
          return m.rejects > 0;
        case "cost":
          return m.tokens_in + m.tokens_out > 0 || m.usd > 0;
        case "durations":
          return m.claim_to_accept_ms.length > 0;
        default:
          return true; // "items", reviewer fields, unknown fields
      }
    };

    const items = list
      .filter(keep)
      .map((m) => {
        const it = this.index.items.get(m.id);
        return {
          id: m.id,
          title: it?.meta.title ?? "",
          status: it?.meta.status ?? "",
          worker: m.worker,
          models: [...m.models].sort(),
          claims: m.claims,
          review_rounds: m.review_rounds,
          bounces: m.bounces,
          handoffs: m.handoffs,
          rejects: m.rejects,
          done: m.done,
          median_claim_to_accept_ms: median(m.claim_to_accept_ms),
          tokens_in: m.tokens_in,
          tokens_out: m.tokens_out,
          usd: m.usd,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    return { by, key: q.key, field: q.field, member: q.member, items };
  }

  /**
   * Daily digest (GL-0320): finished / stuck / waits-for-you since the last
   * human action — or since an ISO ts the caller passes. Read-only.
   */
  async digest(since?: string) {
    const { readAllEvents } = await import("../../core/events/log.js");
    const { buildDigest } = await import("../../core/metrics/digest.js");
    const r = await readAllEvents(join(this.wsr.ws.plansDir, "events"));
    const d = buildDigest(r.events, this.index.items, {
      since,
      staleAfterMs: parseDuration(this.wsr.ws.config.stale_after),
      maxAttempts: this.wsr.ws.config.max_attempts,
    });
    return { ...d, warnings: r.warnings };
  }

  /** `te rollback` — restore claim snapshots back onto live targets (RS-0006/7). */
  async rollback(id: string, force = false) {
    const it = this.item(id);
    // a stale snapshot must not silently revert live state long after the fact
    if (it.meta.status === "done" && !force) {
      throw new TeError(
        "INVALID_TRANSITION",
        `${id} is done — rollback refused (use --force to override)`,
      );
    }
    const claimRes = new Set((it.claim?.targets ?? []).map((t) => parseTargetRef(t).resource));
    const snaps = await itemSnapshots(this.wsr.ws, id, this.home);
    const resources = [...new Set([...claimRes, ...snaps])];
    const restored = await rollbackWork(this.wsr.ws, id, resources, this.home);
    if (!restored.length) {
      throw new NotFoundError(`no snapshots for ${id}`);
    }
    await this.store.annotate(id, {
      heading: "Log",
      lines: [`- rollback: restored snapshot for ${restored.map((r) => `@${r}`).join(", ")}`],
    });
    return { restored };
  }

  async propose(
    drafts: Array<{
      type?: string;
      title: string;
      project?: string;
      targets?: string[];
      depends_on?: string[];
      parent?: string;
      feature?: string;
      relates?: string[];
      found_by?: string[];
      summary?: string;
      acceptance?: string[];
      touches?: string[];
      checks?: Check[];
      /** discussion items: body text of the fixed ## sections, keyed by heading */
      sections?: Record<string, string>;
      simple?: string;
      domains?: string[];
      tier?: "light" | "standard" | "heavy";
    }>,
    actor: Session | "human",
  ) {
    // Every non-idea item lands with at least one domain: explicit, else
    // inferred from title/touches/summary via the workspace vocabulary; a
    // fix (type `bug`, or fix words in title/summary) always carries `bug`.
    // An item that still has none is refused — an untagged task is
    // invisible to domain filters and suggestions.
    const defs = await this.store.currentDomains();
    const enriched = drafts.map((d, i) => {
      let domains = normalizeDomains(d.domains ?? []);
      if (!domains.length && d.type !== "idea" && d.type !== "discussion") {
        domains = rankDomains(
          { strong: [d.title, ...(d.touches ?? [])].join("\n"), lead: d.summary ?? "", body: "" },
          defs,
        );
      }
      const isFix = d.type === "bug" || FIX_WORDS.test(`${d.title}\n${d.summary ?? ""}`);
      if (isFix && !domains.includes("bug")) domains = [...domains, "bug"];
      if (!domains.length && d.type !== "idea" && d.type !== "discussion") {
        throw new ValidationError(
          `propose item ${i} '${d.title}': no domain given and none inferred — a task needs at least one domain`,
        );
      }
      return { ...d, domains };
    });
    void this.actorFor(actor);
    // found_by refs: `#N` points into this batch (checked by the store); others must exist
    for (const d of drafts) {
      this.assertFoundBy(
        "",
        (d.found_by ?? []).filter((r) => !/^#\d+$/.test(r.trim())),
      );
    }
    const r = await this.store.createItems(
      enriched.map((d) => ({ type: d.type ?? "task", ...d })),
      this.actorFor(actor),
    );
    // autonomy: solo — an agent's follow-up/fix of known work needs no
    // approve: it lands ready. Epics and free-standing items stay drafts.
    const ready: string[] = [];
    if (this.wsr.ws.config.autonomy === "solo" && actor !== "human") {
      for (const id of r.ids) {
        const it = this.index.items.get(id);
        if (
          !it ||
          it.meta.type === "epic" ||
          it.meta.type === "idea" ||
          it.meta.type === "discussion" ||
          !it.meta.depends_on.length
        )
          continue;
        if (it.meta.authored_tier === "light") continue; // a stronger session vets it first
        const known = it.meta.depends_on.every((ref) => {
          try {
            const dep = this.index.items.get(parseItemRef(ref).id);
            return dep !== undefined && dep.meta.status !== "dropped";
          } catch {
            return false;
          }
        });
        if (!known) continue;
        await this.store.perform(id, it.meta.version, this.daemonActor(), { type: "approve_plan" });
        await this.store.annotate(id, {
          heading: "Log",
          lines: ["- auto-approved: follow-up task (autonomy: solo)"],
        });
        ready.push(id);
      }
    }
    return { ...r, ready };
  }

  private daemonActor(): Actor {
    return { kind: "daemon", session: "daemon", machine: this.wsr.store.machine };
  }

  /**
   * autonomy: solo — submissions whose latest peer review is `ok` and older
   * than auto_accept_after are accepted by the daemon (same local merge, never
   * a push). Key tasks, archived items, human claims and reviews the reviewer
   * flagged needs_human ("ok, but…") wait for the human; a resubmit or a
   * new review changes ai_review and so resets it.
   */
  autoAcceptDue(now = Date.now()): string[] {
    return [...this.index.items.values()]
      .filter((it) => {
        const at = this.autoAcceptAt(it);
        return at !== undefined && Date.parse(at) <= now;
      })
      .map((it) => it.meta.id);
  }

  /**
   * GL-0362: when review_models is set, an ok review only counts toward
   * auto-accept (and batch accept) when it names a reviewer_model that
   * differs from submitted_model and is the right class for the item's
   * tier. A review from before the rule existed has no reviewer_model and
   * never qualifies.
   */
  modelRuleOk(it: IndexedItem): boolean {
    const rm = this.wsr.ws.config.review_models;
    if (!rm) return true;
    const m = it.meta;
    const rv = m.ai_review;
    if (!rv?.reviewer_model) return false;
    if (m.submitted_model && rv.reviewer_model === m.submitted_model) return false;
    if (tierRank(m.tier) >= tierRank(rm.deep_from_tier)) {
      return rv.reviewer_model === rm.deep;
    }
    const allowed = [rm.quick, rm.deep].filter(Boolean);
    return allowed.length === 0 || allowed.includes(rv.reviewer_model);
  }

  /**
   * The auto_accept_rules entry this item matches, or undefined when no rule
   * matches (auto_accept_after is the delay then). First match wins; every
   * condition a rule lists must match — `domains` means the item carries
   * every listed domain.
   */
  autoAcceptRule(it: IndexedItem): { rule: AutoAcceptRule; index: number } | undefined {
    const rules = this.wsr.ws.config.auto_accept_rules ?? [];
    const m = it.meta;
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      if (rule.tier !== undefined && rule.tier !== m.tier) continue;
      if (rule.project !== undefined && rule.project !== m.project) continue;
      if (rule.domains?.length && !rule.domains.every((d) => m.domains.includes(d))) continue;
      return { rule, index };
    }
    return undefined;
  }

  /** One-line label for the UI — which rule (or the default) drives the delay. */
  autoAcceptRuleLabel(it: IndexedItem): string | undefined {
    const m = it.meta;
    const rv = m.ai_review;
    if (
      this.wsr.ws.config.autonomy !== "solo" ||
      m.status !== "in_review" ||
      rv?.verdict !== "ok" ||
      rv.needs_human ||
      m.unverified_reason ||
      m.unblocks_on === "done" ||
      m.archived ||
      m.auto_accept_off ||
      (m.tier === "heavy" && rv.reviewer_tier === "light") ||
      it.claim?.actor === "human"
    ) {
      return undefined;
    }
    // GL-0362: a review that breaks the model rule never starts auto-accept
    if (!this.modelRuleOk(it)) return "waits for you — no review by a different model";
    const hit = this.autoAcceptRule(it);
    if (!hit) return `auto_accept_after (${this.wsr.ws.config.auto_accept_after})`;
    if (hit.rule.require_verified && !this.verifiedBadge(it).ok)
      return `rule #${hit.index + 1} — waits for verified`;
    if (hit.rule.after === "never") return `rule #${hit.index + 1} — never (stays yours)`;
    const conds = [
      hit.rule.tier ? `tier: ${hit.rule.tier}` : undefined,
      hit.rule.project ? `project: ${hit.rule.project}` : undefined,
      hit.rule.domains?.length ? `domains: ${hit.rule.domains.join(", ")}` : undefined,
    ].filter(Boolean);
    return `rule #${hit.index + 1}${conds.length ? ` {${conds.join(", ")}}` : ""} → ${hit.rule.after}`;
  }

  /** When the daemon will auto-accept this item (ISO), or undefined if it won't. */
  autoAcceptAt(it: IndexedItem): string | undefined {
    const cfg = this.wsr.ws.config;
    const m = it.meta;
    const rv = m.ai_review;
    if (
      cfg.autonomy !== "solo" ||
      m.status !== "in_review" ||
      rv?.verdict !== "ok" ||
      rv.needs_human ||
      m.unverified_reason ||
      m.unblocks_on === "done" ||
      m.archived ||
      m.auto_accept_off ||
      (m.tier === "heavy" && rv.reviewer_tier === "light") ||
      it.claim?.actor === "human"
    ) {
      return undefined;
    }
    // GL-0362: a review that breaks the model rule never starts auto-accept
    if (!this.modelRuleOk(it)) return undefined;
    const hit = this.autoAcceptRule(it);
    if (hit?.rule.require_verified && !this.verifiedBadge(it).ok) return undefined;
    if (hit?.rule.after === "never") return undefined;
    const delay = hit?.rule.after ?? cfg.auto_accept_after;
    try {
      return new Date(Date.parse(rv.reviewed_at) + parseDuration(delay)).toISOString();
    } catch {
      // a malformed `after` must never auto-accept — the human decides
      return undefined;
    }
  }

  /** Human: stop auto-accept for the current submission (a resubmit re-arms it). */
  async stopAutoAccept(id: string) {
    this.item(id);
    await this.store.annotate(id, {
      heading: "Log",
      lines: [`- ${new Date().toISOString()} human stopped auto-accept`],
      metaPatch: { auto_accept_off: true },
    });
    return { meta: this.item(id).meta };
  }

  async autoAccept(now = Date.now()) {
    const done: string[] = [];
    for (const id of this.autoAcceptDue(now)) {
      const r = await this.accept(id, "daemon");
      if (!r.bounced?.length) {
        await this.store.annotate(id, {
          heading: "Log",
          lines: ["- auto-accepted after ok review (autonomy: solo)"],
        });
        done.push(id);
      }
    }
    return done;
  }

  /**
   * auto_archive_after (workspace.yaml, unset = off): items that have been
   * done or dropped for longer than the duration are archived by the daemon
   * on its sweep. A starred item is never archived by rule; an already
   * archived or still claimed one is skipped. Items older than this feature
   * have no finished_at — meta.updated is the (safe, later) fallback.
   */
  autoArchiveDue(now = Date.now()): string[] {
    const cfg = this.wsr.ws.config;
    if (!cfg.auto_archive_after) return [];
    const ms = parseDuration(cfg.auto_archive_after);
    return [...this.index.items.values()]
      .filter((it) => {
        const m = it.meta;
        if (m.archived || m.star_color || it.claim) return false;
        if (m.status !== "done" && m.status !== "dropped") return false;
        const since = Date.parse(m.finished_at ?? m.updated ?? "");
        return !Number.isNaN(since) && since + ms <= now;
      })
      .map((it) => it.meta.id);
  }

  async autoArchive(now = Date.now()) {
    const done: string[] = [];
    for (const id of this.autoArchiveDue(now)) {
      try {
        const it = this.item(id);
        await this.store.perform(id, it.meta.version, this.daemonActor(), {
          type: "archive",
          reason: "auto_archive_after",
        });
        done.push(id);
      } catch {
        // one failing item must not stall the sweep (e.g. a stale claim)
      }
    }
    return done;
  }

  /**
   * Plans finish themselves: an epic whose derived plan_state is `done` —
   * every part done or dropped, no open problem under it — gets `status:
   * done` from the daemon sweep (plan_auto_done). A sub-plan's own status
   * never counts, so a plan marked done by hand with unfinished parts
   * still waits.
   */
  autoCompletePlansDue(): string[] {
    return [...this.index.items.values()]
      .filter((it) => {
        const m = it.meta;
        return (
          m.type === "epic" &&
          m.status !== "done" &&
          m.status !== "dropped" &&
          this.index.planState(m.id) === "done"
        );
      })
      .map((it) => it.meta.id);
  }

  async autoCompletePlans() {
    const done: string[] = [];
    for (const id of this.autoCompletePlansDue()) {
      try {
        const it = this.item(id);
        await this.store.perform(id, it.meta.version, this.daemonActor(), {
          type: "plan_auto_done",
        });
        done.push(id);
        // with auto_archive_after set, a plan that finishes also has its
        // finished parts archived — the starred and the claimed keep
        // their place
        if (this.wsr.ws.config.auto_archive_after) {
          for (const cid of this.index.descendants(id)) {
            const c = this.index.get(cid);
            if (!c || c.meta.archived || c.meta.star_color || c.claim) continue;
            try {
              await this.store.perform(cid, c.meta.version, this.daemonActor(), {
                type: "archive",
                reason: "plan finished",
              });
            } catch {
              // a part that refuses to archive never blocks the plan
            }
          }
        }
      } catch {
        // one failing epic must not stall the sweep
      }
    }
    return done;
  }

  /**
   * Sources finish themselves: an idea or discussion whose derived
   * idea_state is `done` — one or more live referrers, every one done —
   * gets `status: done` from the daemon sweep (source_auto_done), so the
   * archive sweep and the UI treat it as finished. A source with no live
   * referrer yet is left for the planner.
   */
  autoCompleteSourcesDue(): string[] {
    return [...this.index.items.values()]
      .filter((it) => {
        const m = it.meta;
        return (
          (m.type === "idea" || m.type === "discussion") &&
          m.status !== "done" &&
          m.status !== "dropped" &&
          it.idea_state === "done"
        );
      })
      .map((it) => it.meta.id);
  }

  async autoCompleteSources() {
    const done: string[] = [];
    for (const id of this.autoCompleteSourcesDue()) {
      try {
        const it = this.item(id);
        await this.store.perform(id, it.meta.version, this.daemonActor(), {
          type: "source_auto_done",
        });
        done.push(id);
      } catch {
        // one failing source must not stall the sweep
      }
    }
    return done;
  }

  /**
   * auto_release_after (workspace.yaml, unset = off): a claim stale longer
   * than the duration whose holder session is not live on this machine is
   * released to ready by the daemon — the worktree and the branch stay.
   * Claims held on other machines and items already in review are kept.
   */
  autoReleaseDue(now = Date.now()): string[] {
    const cfg = this.wsr.ws.config;
    if (!cfg.auto_release_after) return [];
    const ms = parseDuration(cfg.auto_release_after);
    return [...this.index.claims.values()]
      .filter((c) => {
        if (c.actor !== "agent" || c.machine !== this.wsr.store.machine) return false;
        if (this.sessions.isLive(c.holder)) return false;
        if (now - Date.parse(c.last_seen) <= ms) return false;
        const st = this.index.items.get(c.item)?.meta.status;
        return st === "in_progress" || st === "waiting";
      })
      .map((c) => c.item);
  }

  async autoRelease(now = Date.now()) {
    const done: string[] = [];
    for (const id of this.autoReleaseDue(now)) {
      try {
        const it = this.item(id);
        // perform alone — unlike ops.release there is no cleanup_work: the
        // worktree and the branch stay for whoever claims the item next
        await this.store.perform(id, it.meta.version, this.daemonActor(), {
          type: "release",
          note: "auto_release_after",
        });
        done.push(id);
      } catch {
        // one failing release must not stall the sweep
      }
    }
    return done;
  }

  // ---- human writes -------------------------------------------------------

  /**
   * One human batch action over the ids the UI has in view (GL-0316). The
   * daemon re-checks every id, so a stale view can never act on the wrong
   * item: accept needs an ok AI review without needs_human (a stopped
   * auto-accept keeps its item too), approve needs draft, archive needs
   * done/dropped. With `plan`, approve targets the plan's draft children and
   * `ids` — when sent — only limits that set. What refused is returned
   * skipped, never thrown.
   */
  async batch(
    op: "accept" | "approve" | "archive",
    body: { ids?: string[]; plan?: string },
  ): Promise<{ done: string[]; skipped: { id: string; reason: string }[] }> {
    let ids = (body.ids ?? []).map((s) => s.toUpperCase());
    if (op === "approve" && body.plan) {
      const pid = body.plan.toUpperCase();
      const parts = (this.index.get(pid)?.children ?? []).filter(
        (cid) => this.index.get(cid)?.meta.status === "draft",
      );
      ids = ids.length ? parts.filter((id) => ids.includes(id)) : parts;
    }
    const done: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      try {
        const it = this.item(id);
        const m = it.meta;
        if (op === "accept") {
          if (m.status !== "in_review") {
            skipped.push({ id, reason: `not in_review (${m.status})` });
            continue;
          }
          if (m.ai_review?.verdict !== "ok") {
            skipped.push({ id, reason: "no ok AI review" });
            continue;
          }
          if (m.ai_review.needs_human) {
            skipped.push({ id, reason: "needs_human review" });
            continue;
          }
          if (m.auto_accept_off) {
            skipped.push({ id, reason: "auto-accept stopped" });
            continue;
          }
          if (!this.modelRuleOk(it)) {
            skipped.push({ id, reason: "no review by a different model" });
            continue;
          }
          await this.accept(id);
        } else if (op === "approve") {
          await this.approve(id);
        } else {
          if (m.status !== "done" && m.status !== "dropped") {
            skipped.push({ id, reason: `not finished (${m.status})` });
            continue;
          }
          await this.archive(id);
        }
        done.push(id);
      } catch (e) {
        skipped.push({ id, reason: (e as Error).message });
      }
    }
    return { done, skipped };
  }

  /**
   * Human approve. On an epic the same click also approves every draft
   * child — the plan carries no gate of its own, each part's draft status
   * is the only lock (one approve_plan event per child, the human actor).
   * A child that refuses is skipped, it never blocks the epic's approval.
   */
  async approve(id: string) {
    const it = this.item(id);
    const r = await this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "approve_plan",
    });
    if (it.meta.type === "epic") {
      for (const cid of it.children) {
        const c = this.index.get(cid);
        if (!c || c.meta.status !== "draft") continue;
        try {
          await this.store.perform(cid, c.meta.version, this.actorFor("human"), {
            type: "approve_plan",
          });
        } catch {
          // a part that refuses never blocks the plan's approval
        }
      }
    }
    return r;
  }

  async answer(id: string, decisionTitle: string) {
    const it = this.item(id);
    const decisionId = allocateId("D", this.index.decisions.keys());
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "answer",
      decisionId,
      decisionTitle,
    });
  }

  /** GL-0345: an option-button pick on a review's ask_human card — a decision
   *  record for the human, the item's status never moves. */
  async recordDecision(id: string, decisionTitle: string, question?: Question) {
    const it = this.item(id);
    const decisionId = allocateId("D", this.index.decisions.keys());
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "record_decision",
      decisionId,
      decisionTitle,
      question,
    });
  }

  /** Revise the answer already given: the item's latest decision. */
  async changeAnswer(id: string, decisionTitle: string) {
    const it = this.item(id);
    const own = [...this.index.decisions.values()]
      .filter((d) => {
        try {
          return parseItemRef(d.meta.item).id === id;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.meta.id.localeCompare(b.meta.id, undefined, { numeric: true }));
    const last = own[own.length - 1];
    if (!last) {
      throw new InvalidTransitionError(
        `cannot change_answer: ${id} has no answer yet`,
        it.meta.status,
        "change_answer",
      );
    }
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "change_answer",
      decisionId: last.meta.id,
      decisionTitle,
      previous: last.meta.title,
    });
  }

  /**
   * Orphan decisions (TE-0164): picks that record a choice nothing executed.
   * A decision is settled when any of these hold:
   *  - the human marked it `processed`;
   *  - a later item names the decision's item in relates/found_by/
   *    depends_on/parent — the follow-up exists;
   *  - the pick asked for inside work and the item's ## Log shows a later
   *    action (claim, submit, review, accept, …).
   * A pick asking for outside work ("create follow-up task", "separate bug
   * task", "propose …") settles only through the first two — an accept or a
   * resubmit on the item itself does not execute it.
   */
  orphanDecisions() {
    const EXTERNAL_PICK = /\b(follow-?up|separate task|new task|bug task|propose|spawn)\b/i;
    const ACTION =
      /\b(claimed|took over|submitted|bounced|handed off|released|answered|resumed|accepted|rejected|dropped|archived|completed|approved)\b/i;
    // item id → latest creation date of an item that references it — a pick
    // settles when a referencing item exists from the decision's day or later
    const referencing = new Map<string, string>();
    for (const it of this.index.items.values()) {
      const m = it.meta;
      const refs = [
        ...m.depends_on,
        ...m.relates,
        ...(m.found_by ?? []),
        ...(m.parent ? [m.parent] : []),
      ];
      for (const ref of refs) {
        try {
          const pid = parseItemRef(ref).id;
          const cur = referencing.get(pid);
          if (cur === undefined || (m.created ?? "") > cur) {
            referencing.set(pid, m.created ?? "");
          }
        } catch {
          /* unparseable ref */
        }
      }
    }
    const out: Array<{ id: string; item: string; title: string; created?: string }> = [];
    for (const d of this.index.decisions.values()) {
      if (d.meta.processed) continue;
      let itemId = d.meta.item;
      try {
        itemId = parseItemRef(d.meta.item).id;
      } catch {
        /* keep the raw ref */
      }
      const refAt = referencing.get(itemId);
      if (refAt !== undefined && (!d.meta.created || refAt >= d.meta.created)) continue;
      const it = this.index.get(itemId);
      if (it && !EXTERNAL_PICK.test(d.meta.title)) {
        const log = it.sections.find((s) => s.heading.toLowerCase() === "log");
        const lines = log?.body.split("\n") ?? [];
        const pickIdx = lines.findIndex((l) => l.includes(`→ ${d.meta.id}`));
        // no pick line and no mention at all = orphaned record; a mention
        // without a pick line (e.g. a promote approval) is a settled record
        if (pickIdx < 0) {
          if (lines.some((l) => l.includes(d.meta.id))) continue;
        } else if (lines.slice(pickIdx + 1).some((l) => ACTION.test(l))) {
          continue;
        }
      }
      out.push({ id: d.meta.id, item: itemId, title: d.meta.title, created: d.meta.created });
    }
    return out.sort((a, b) => compareIds(b.id, a.id));
  }

  /**
   * Mark a decision processed (TE-0164): its follow-through is done and it
   * leaves the inbox's decisions list. Human-only at the route; the flag
   * lives on the D-record so it survives item close.
   */
  async processDecision(decisionId: string) {
    const d = this.index.decisions.get(decisionId);
    if (!d) throw new NotFoundError(`no decision ${decisionId}`);
    if (d.meta.processed) return { ok: true };
    const itemId = parseItemRef(d.meta.item).id;
    const it = this.item(itemId);
    return this.store.perform(itemId, it.meta.version, this.actorFor("human"), {
      type: "process_decision",
      decisionId: d.meta.id,
    });
  }

  async accept(
    id: string,
    by: "human" | "daemon" = "human",
  ): Promise<{ meta: unknown; merged: unknown[]; bounced?: string[] }> {
    const it = this.item(id);
    // refuse early — never merge work for an item that isn't in_review
    if (it.meta.status !== "in_review") {
      throw new InvalidTransitionError(
        `cannot accept from ${it.meta.status}`,
        it.meta.status,
        "accept",
      );
    }
    const claim = it.claim;
    // RS-0003: merge the claim branch(es) into base BEFORE marking done —
    // a conflict bounces the item back to in_progress while it's still
    // in_review (the state machine's merge_conflict action).
    let merged: Array<{ resource: string; repo: string; mergeCommit: string; branch: string }> = [];
    if (claim) {
      const m = await mergeWork(this.wsr.ws, id, claim, this.home);
      if (m.conflicts.length || m.dirty.length) {
        const why = [
          ...m.conflicts.flatMap((c) => c.files.map((f) => `${c.resource}:${f}`)),
          ...m.dirty.map((d) => `${d} (dirty main checkout)`),
        ];
        const cur = this.item(id);
        await this.store.perform(
          id,
          cur.meta.version,
          { kind: "daemon", session: "daemon", machine: this.wsr.store.machine },
          { type: "merge_conflict", conflicts: why },
        );
        return { meta: cur.meta, merged: [], bounced: why };
      }
      merged = m.merged;
    }
    const r = await this.store.perform(
      id,
      it.meta.version,
      by === "daemon" ? this.daemonActor() : this.actorFor("human"),
      {
        type: "accept",
      },
    );
    for (const g of merged) {
      await this.store.annotate(id, {
        heading: "Evidence",
        lines: [`- merged ${g.branch} → ${g.mergeCommit.slice(0, 12)} (not pushed)`],
        metaPatch: {
          deliveries: [
            ...(((this.item(id).meta as Record<string, unknown>).deliveries as unknown[]) ?? []),
            {
              resource: g.resource,
              repo: g.repo,
              branch: g.branch,
              merge_commit: g.mergeCommit,
              at: new Date().toISOString(),
            },
          ],
        },
      });
    }
    if (claim) await cleanupWork(this.wsr.ws, id, claim, { home: this.home });
    // snapshots are evidence for review only — expire them once accepted
    await cleanupSnapshots(this.wsr.ws, id, this.home).catch(() => {});
    return { ...r, merged };
  }

  async reject(id: string, reason?: string, release = false) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "reject",
      reason,
      release,
    });
    // release: the transition deleted the claim — tear the worktree down
    // too. Branches stay, so the next claim resumes the same work.
    if (claim && r.meta.status === "ready") {
      await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
    }
    return r;
  }

  async drop(id: string, reason?: string) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "drop",
      reason,
    });
    if (claim) await cleanupWork(this.wsr.ws, id, claim, { home: this.home });
    return r;
  }

  /** Human: mark done from any status — no review, no merge; branches kept. */
  async complete(id: string, note?: string) {
    const it = this.item(id);
    const claim = it.claim;
    const r = await this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "complete",
      note,
    });
    if (claim) await cleanupWork(this.wsr.ws, id, claim, { keepBranches: true, home: this.home });
    return r;
  }

  /** Human: park a draft/ready item — agents can't see or claim it. */
  async hold(id: string, reason?: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "hold",
      reason,
    });
  }

  /** Human: release a hold → ready. */
  async unhold(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "unhold" });
  }

  /** Human: ready/hold/done → draft (needs approval again; reopens a done-by-mistake item). */
  async toDraft(id: string, reason?: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "to_draft",
      reason,
    });
  }

  /** Human: hide an item (status kept); refused while claimed. */
  async archive(id: string, reason?: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "archive",
      reason,
    });
  }

  async unarchive(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "unarchive" });
  }

  /** Human: bookmark an item (any status, even claimed — board ★, no workflow effect). */
  async star(id: string, color?: string) {
    const it = this.item(id);
    const parsed = color === undefined ? undefined : StarColor.safeParse(color);
    if (parsed && !parsed.success) {
      throw new TeError("USAGE", `star color must be one of ${StarColor.options.join("|")}`);
    }
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "star",
      color: parsed?.data,
    });
  }

  async unstar(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "unstar" });
  }

  /** Human: remove an item from tracking (task file stays, untagged). */
  async deleteItem(id: string, reason?: string) {
    this.item(id);
    return this.store.deleteItem(id, this.actorFor("human"), reason);
  }

  /** Agent or human: write the plain-English version (no claim needed — it touches no code). */
  async simple(id: string, actor: Session | "human", text: string) {
    this.item(id);
    return this.store.setSimple(id, text, this.actorFor(actor));
  }

  /** Add a multi-line note to the item (task file `## Notes`). */
  async note(id: string, actor: Session | "human", text: string) {
    this.item(id);
    return this.store.addNote(id, text, this.actorFor(actor));
  }

  /**
   * Correct a wrong `## Evidence` line without rewriting it: appends a
   * `supersedes` entry naming the old line, the correct value and the
   * reason — the old line stays visible. Append-only; any session may
   * correct the record (the reviewer who spots it is rarely the holder).
   */
  async supersede(
    id: string,
    actor: Session | "human",
    s: { line: string; correct: string; reason?: string },
  ) {
    this.item(id);
    const line = s.line.trim();
    const correct = s.correct.trim();
    if (!line || !correct) throw new ValidationError("supersede needs {line, correct[, reason]}");
    const who = actor === "human" ? "human" : actor.id;
    const now = new Date().toISOString();
    return this.store.annotate(id, {
      heading: "Evidence",
      lines: [
        `- supersedes "${line}" → ${correct}${s.reason?.trim() ? ` — ${s.reason.trim()}` : ""} (${who}, ${now.slice(0, 16).replace("T", " ")})`,
      ],
      log: [`- ${now} ${who} superseded an Evidence line`],
    });
  }

  /**
   * Attach a file to an item's `## Artifacts` — any session may attach to
   * any item, no claim needed (like ask): planners attach mockups to drafts.
   * `sensitive` marks the line `!sensitive` and returns a warning — the file
   * goes into the plans git repo.
   */
  async attach(
    id: string,
    actor: Session | "human",
    a: { path: string; caption: string; domains?: string[]; sensitive?: boolean },
  ) {
    this.item(id);
    const r = await this.store.attachArtifact(id, a, this.actorFor(actor));
    return {
      ...r,
      ...(a.sensitive
        ? {
            warning:
              ".artifacts/ is part of the plans git repo — a !sensitive file stays visible there",
          }
        : {}),
    };
  }

  /** Remove one `## Artifacts` line — the file on disk stays. Any session, no claim. */
  async detach(id: string, actor: Session | "human", path: string) {
    this.item(id);
    return this.store.detachArtifact(id, path, this.actorFor(actor));
  }

  /**
   * Save a chat as a discussion (TE-0157): create the DISC item with its
   * distilled sections, write the transcript as
   * `<project>/DISC-NN-<slug>.transcript.md` and link it in ## Artifacts.
   * Claude Code JSONL converts to Markdown turns first. The secret scan
   * refuses hits unless `redact` ([REDACTED] each) or `sensitive` (kept,
   * `!sensitive` tag) is set. The reply always warns that the transcript
   * goes into the plans git repo.
   */
  async capture(
    actor: Session | "human",
    a: {
      title: string;
      project?: string;
      summary?: string;
      sections?: Record<string, string>;
      participants?: string[];
      relates?: string[];
      transcript_text?: string;
      transcript_path?: string;
      domains?: string[];
      redact?: boolean;
      sensitive?: boolean;
    },
  ) {
    if (!a.title?.trim()) throw new ValidationError("capture needs {title}");
    if (a.transcript_text === undefined && a.transcript_path === undefined) {
      throw new ValidationError("capture needs transcript_text or transcript_path");
    }
    let raw = a.transcript_text ?? "";
    if (a.transcript_path !== undefined) {
      const given = a.transcript_path.replace(/\\/g, "/");
      const abs = given.startsWith("/") ? resolve(given) : resolve(this.wsr.ws.root, given);
      const st = existsSync(abs) ? statSync(abs) : undefined;
      if (!st?.isFile()) throw new NotFoundError(`capture: transcript not found: ${a.transcript_path}`);
      raw = readFileSync(abs, "utf8");
    }
    // Claude Code JSONL → Markdown turns; plain text / Markdown pass through
    const conv = transcriptToMarkdown(raw);
    let text = conv.text;
    const maxMb = this.wsr.ws.config.discussions.transcript_max_mb;
    const mb = Buffer.byteLength(text, "utf8") / 1048576;
    if (mb > maxMb) {
      throw new ValidationError(
        `transcript is ${mb.toFixed(1)} MB — over discussions.transcript_max_mb (${maxMb} MB)`,
      );
    }
    // secret scan — the transcript lands in the plans git repo
    let hits = scanSecrets(text);
    let redacted = false;
    if (hits.length && a.redact) {
      const r = redactSecrets(text);
      text = r.text;
      hits = r.hits;
      redacted = true;
    } else if (hits.length && !a.sensitive) {
      throw new ValidationError(
        `transcript holds ${hits.length} secret-looking string(s): ` +
          hits.map((h) => `line ${h.line} (${h.kind} ${h.preview})`).join("; ") +
          ` — pass redact: true to mask them or sensitive: true to keep them`,
      );
    }
    const sections: Record<string, string> = { ...(a.sections ?? {}) };
    if (a.participants?.length && !sections["Participants"]) {
      sections["Participants"] = a.participants.map((p) => `- ${p}`).join("\n");
    }
    const { ids, files } = await this.propose(
      [
        {
          type: "discussion",
          title: a.title.trim(),
          project: a.project,
          summary: a.summary,
          sections,
          relates: a.relates,
          domains: a.domains,
        },
      ],
      actor,
    );
    const id = ids[0];
    // a saved chat is a record, not a proposal — it lands ready, the human drops it if unwanted
    await this.approve(id);
    const { path } = await this.store.captureTranscript(
      id,
      {
        content: text.endsWith("\n") ? text : `${text}\n`,
        caption: "raw transcript of the saved chat",
        sensitive: a.sensitive,
      },
      this.actorFor(actor),
    );
    return {
      id,
      file: files[0],
      transcript: path,
      format: conv.format,
      ...(redacted ? { redacted: hits.length } : {}),
      ...(hits.length ? { secret_hits: hits.map((h) => `line ${h.line} (${h.kind})`) } : {}),
      warning:
        "the transcript goes into the plans git repo — every machine that pulls it can read it" +
        (a.sensitive ? " (tagged !sensitive)" : ""),
    };
  }

  /** A discussion's section body (TE-0160): the DISC file in overlay, the
   *  item file otherwise. */
  private async discussionSectionOf(it: IndexedItem, heading: string): Promise<string> {
    if (this.wsr.ws.config.mode === "overlay" && it.meta.source) {
      const found = await resolveSource(this.wsr.ws.root, it.meta.id, it.meta.source);
      if (found) return sectionBody(found.text, heading) ?? "";
    }
    return it.sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase())?.body ?? "";
  }

  /**
   * `promote` (TE-0160): a guideline or decision line out of a discussion,
   * as a pending candidate — nothing is written to lessons/ or decisions/
   * until the human settles it (the inbox lists it; /api/items/:id/promotions
   * /:n approves or rejects). The discussion's `## Actions` links the result.
   */
  async promote(
    actor: Session | "human",
    a: { id: string; section: string; line: string; to: string; domain?: string },
  ) {
    const it = this.item(a.id.toUpperCase());
    if (it.meta.type !== "discussion") {
      throw new ValidationError(`promote: ${a.id} is a ${it.meta.type}, not a discussion`);
    }
    const section = a.section?.trim().toLowerCase();
    const heading =
      section === "guidelines" ? "Guidelines" : section === "decisions" ? "Decisions reached" : "";
    if (!heading) {
      throw new ValidationError("promote: section must be 'guidelines' or 'decisions'");
    }
    const to = a.to?.trim().toLowerCase();
    if (to !== "lesson" && to !== "decision") {
      throw new ValidationError("promote: 'to' must be lesson or decision");
    }
    const want = a.line.trim().replace(/^[-*]\s*/, "");
    if (!want) throw new ValidationError("promote needs {id, section, line, to}");
    const bullets = (await this.discussionSectionOf(it, heading))
      .split("\n")
      .map((l) => l.trim().replace(/^[-*]\s*/, ""))
      .filter(Boolean);
    const exact = bullets.filter((b) => b === want);
    const contained = bullets.filter((b) => want.length >= 8 && b.includes(want));
    const matches = exact.length ? exact : contained;
    if (matches.length !== 1) {
      throw new ValidationError(
        matches.length > 1
          ? `promote: '${want}' matches ${matches.length} lines in ## ${heading} — give the whole line`
          : `promote: no such line in ## ${heading} — the section holds: ${bullets
              .map((b) => `"${b.slice(0, 60)}"`)
              .join(", ") || "(empty)"}`,
      );
    }
    const line = matches[0];
    const domain = a.domain?.trim()
      ? normalizeDomain(a.domain)
      : (it.meta.domains[0] ?? "");
    if (to === "lesson" && !domain) {
      throw new ValidationError("promote to lesson needs a domain — pass domain or tag the discussion");
    }
    const who = actor === "human" ? "human" : actor.id;
    const now = new Date().toISOString();
    const promos = (it.meta.promotions as Array<Record<string, unknown>> | undefined) ?? [];
    const n = promos.length + 1;
    const promo = {
      n,
      section,
      line,
      to,
      ...(domain ? { domain } : {}),
      by: who,
      at: now,
      state: "pending",
    };
    const short = line.length > 60 ? `${line.slice(0, 60)}…` : line;
    const target =
      to === "lesson" ? `lesson candidate for #${domain}` : "decision draft";
    await this.store.recordPromotion(
      it.meta.id,
      {
        promo,
        action_line: `- promoted "${short}" → ${target} — pending the human's OK (${who}, ${now.slice(0, 16).replace("T", " ")})`,
      },
      this.actorFor(actor),
    );
    return {
      id: it.meta.id,
      promotion: promo,
      pending: `${target} — it waits in the inbox for the human`,
    };
  }

  /**
   * The human settles a promotion (TE-0160): approve materializes the
   * result — a lesson line that names the discussion, or a decision record
   * whose item is the discussion — then `## Actions` gets the result line.
   * Reject only marks the candidate.
   */
  async settlePromotion(id: string, n: number, verdict: "approved" | "rejected") {
    const it = this.item(id.toUpperCase());
    const promos = (it.meta.promotions as Array<Record<string, unknown>> | undefined) ?? [];
    const promo = promos.find((p) => p.n === n);
    if (!promo) throw new NotFoundError(`${id}: no promotion #${n}`);
    if (promo.state !== "pending") {
      throw new InvalidError(`${id}: promotion #${n} is ${String(promo.state)} — already settled`);
    }
    const now = new Date().toISOString();
    const line = String(promo.line);
    let result: string;
    let decisionId: string | undefined;
    let lessonDomain: string | undefined;
    let lessonAppended = false;
    if (verdict === "approved") {
      if (promo.to === "lesson") {
        lessonDomain = String(promo.domain);
        await appendLesson(
          this.wsr.ws.plansDir,
          lessonDomain,
          "human",
          `${line} (from ${it.meta.id})`,
          now,
        );
        lessonAppended = true;
        result = `lesson for #${lessonDomain}`;
      } else {
        decisionId = allocateId("D", this.index.decisions.keys());
        result = `decision ${decisionId}`;
      }
    } else {
      result = "rejected";
    }
    // DE-0236: the settle step runs first. A failure there leaves no D-record
    // and no stray lesson line — the appended line is rolled back so a retry
    // cannot duplicate it.
    let meta: ItemMeta;
    try {
      meta = await this.store.settlePromotion(
        it.meta.id,
        n,
        {
          state: verdict,
          action_line: `- promotion #${n} ${verdict === "approved" ? `approved → ${result}` : "rejected"} (human, ${now.slice(0, 16).replace("T", " ")})`,
          ...(lessonAppended
            ? { commit_extra: [`lessons/${normalizeDomain(lessonDomain!)}.md`] }
            : {}),
        },
        this.actorFor("human"),
      );
    } catch (err) {
      if (lessonAppended) {
        const lessons = await readLessons(this.wsr.ws.plansDir, lessonDomain!);
        const suffix = `${line} (from ${it.meta.id})`;
        let at = -1;
        for (let i = lessons.length - 1; i >= 0; i--) {
          if (lessons[i].endsWith(suffix)) {
            at = i;
            break;
          }
        }
        if (at >= 0)
          await removeLesson(this.wsr.ws.plansDir, lessonDomain!, at + 1).catch(() => {});
        // a file our append created now holds only the header — remove it too
        if ((await readLessons(this.wsr.ws.plansDir, lessonDomain!)).length === 0)
          await unlink(join(this.wsr.ws.plansDir, "lessons", `${normalizeDomain(lessonDomain!)}.md`)).catch(
            () => {},
          );
      }
      throw err;
    }
    if (decisionId) {
      try {
        const cur = this.item(it.meta.id);
        await this.store.perform(cur.meta.id, cur.meta.version, this.actorFor("human"), {
          type: "record_decision",
          decisionId,
          decisionTitle: line.length > 80 ? `${line.slice(0, 80)}…` : line,
        });
      } catch (err) {
        // put the candidate back to pending so the human can try again
        await this.store.settlePromotion(
          it.meta.id,
          n,
          {
            state: "pending",
            action_line: `- promotion #${n} approval failed, back to pending (${now.slice(0, 16).replace("T", " ")})`,
          },
          this.actorFor("human"),
        );
        throw err;
      }
    }
    return { id: it.meta.id, promotion: n, verdict, result, meta };
  }

  /**
   * `## Artifacts` of one item, each tagged with its item id. Overlay reads
   * the task file (item files hold no body there); standard uses the parsed
   * item file. Own #tags win over the item's domains (parseArtifacts).
   */
  private async artifactsOfItem(
    it: IndexedItem,
  ): Promise<
    Array<{ item: string; path: string; caption: string; domains: string[]; sensitive: boolean }>
  > {
    if (this.wsr.ws.config.mode === "overlay" && it.meta.source) {
      const found = await resolveSource(this.wsr.ws.root, it.meta.id, it.meta.source);
      if (!found) return [];
      return parseArtifacts(sectionBody(found.text, "Artifacts"), it.meta.domains).map((a) => ({
        ...a,
        item: it.meta.id,
      }));
    }
    return it.artifacts.map((a) => ({ ...a, item: it.meta.id }));
  }

  /** Artifacts of an item; for an epic, of its descendants too (each with its item id). */
  async itemArtifacts(id: string) {
    const it = this.item(id);
    const ids = new Set(it.meta.type === "epic" ? [id, ...this.index.descendants(id)] : [id]);
    const out = [];
    for (const iid of ids) {
      const item = this.index.get(iid);
      if (item) out.push(...(await this.artifactsOfItem(item)));
    }
    return out;
  }

  /** Every artifact in the workspace — the gallery; filter by effective domain and/or project. */
  async allArtifacts(filter: { domain?: string; project?: string } = {}) {
    const out = [];
    for (const it of this.index.items.values()) {
      if (it.meta.type === "epic") continue;
      if (filter.project && it.meta.project !== filter.project) continue;
      for (const a of await this.artifactsOfItem(it)) {
        if (filter.domain && !a.domains.includes(filter.domain)) continue;
        out.push({
          ...a,
          status: it.meta.status,
          project: it.meta.project,
          updated: it.meta.updated,
        });
      }
    }
    return out.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  }

  /**
   * Import loose files from `.artifacts/` (GL-0121): a file named
   * `<prefix><digits>-<name>` attaches to item `<PREFIX>-<digits>` through
   * the same code as attach (caption = the file name). Root-level files move
   * to `.artifacts/<project>/`. `apply: false` only reports the plan;
   * unmatched and already-attached files are reported, never deleted.
   */
  async artifactsImport(apply: boolean, actor: Session | "human" = "human") {
    const { mkdir, readdir, rename } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { basename, dirname, join, relative, sep } = await import("node:path");
    const root = this.wsr.ws.root;
    const dir = join(root, ".artifacts");
    const out = {
      applied: apply,
      move: [] as string[],
      attach: [] as string[],
      already: [] as string[],
      no_item: [] as string[],
      errors: [] as string[],
    };
    if (!existsSync(dir)) return out;
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) files.push(p);
      }
    };
    await walk(dir);
    for (const abs of files.sort()) {
      const rel = relative(dir, abs).split(sep).join("/"); // path under .artifacts/
      const base = basename(abs);
      const m = /^([a-z]+)-?(\d+)-.+/i.exec(base);
      const id = m ? `${m[1]}-${m[2]}`.toUpperCase() : "";
      const it = id ? this.index.get(id) : undefined;
      if (!it) {
        out.no_item.push(rel);
        continue;
      }
      const project = it.meta.project ?? "_root";
      const target = rel.includes("/") ? rel : `${project}/${base}`;
      const attached = (await this.artifactsOfItem(it)).some((a) => a.path === target);
      if (attached) {
        out.already.push(target);
        continue;
      }
      if (target !== rel) {
        // a loose file at the root of .artifacts/ moves under <project>/;
        // a clash with different content is reported, never overwritten
        const absTarget = join(dir, target);
        if (existsSync(absTarget) && !(await readFile(absTarget)).equals(await readFile(abs))) {
          out.errors.push(`${rel}: ${target} exists with different content — left in place`);
          continue;
        }
        out.move.push(`${rel} → ${target}`);
        if (apply && !existsSync(absTarget)) {
          await mkdir(dirname(absTarget), { recursive: true });
          await rename(abs, absTarget);
        }
      }
      out.attach.push(`${id} ${target}`);
      if (apply) {
        try {
          await this.attach(id, actor, { path: `.artifacts/${target}`, caption: base });
        } catch (e) {
          out.errors.push(`${target}: ${(e as Error).message}`);
        }
      }
    }
    return out;
  }

  /** Agent asks the human to drop this item — advisory flag, status untouched. */
  async flagDrop(id: string, session: Session, reason?: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor(session), {
      type: "flag_drop",
      reason,
    });
  }

  /** Human dismisses a drop flag — the item stays. */
  async unflagDrop(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), {
      type: "unflag_drop",
    });
  }

  /**
   * Change a draft's scope (Touches line, extra acceptance). Only drafts: a
   * human moving an item back to draft is the go-ahead to rescope it. Agents
   * need a tier above light (the dispatcher doesn't plan); it stays a draft —
   * the human approves the new scope.
   */
  async rescope(
    id: string,
    actor: Session | "human",
    change: { touches?: string[]; addAcceptance?: string[]; reason: string },
  ) {
    this.item(id);
    if (actor !== "human" && actor.tier === "light") {
      throw new ForbiddenError(
        "rescope needs a standard- or heavy-tier session (planner), not light",
      );
    }
    if (!change.touches && !change.addAcceptance?.length) {
      throw new ValidationError("rescope: give touches and/or add_acceptance");
    }
    return this.store.rescope(id, change, this.actorFor(actor));
  }

  /**
   * Rewrite a draft — any field of it. Drafts only (a non-draft must be
   * moved back to draft by the human first); agents need a planner tier.
   * depends_on/parent refs are checked here (existence, self, cycles incl.
   * linked workspaces); the store writes and logs. It stays a draft.
   */
  async editDraft(
    id: string,
    actor: Session | "human",
    change: {
      reason: string;
      title?: string;
      summary?: string;
      acceptance?: string[];
      touches?: string[];
      depends_on?: string[];
      parent?: string | null;
      relates?: string[];
      found_by?: string[];
      targets?: string[];
      tier?: "light" | "standard" | "heavy" | null;
      domains?: string[];
      sections?: Record<string, string>;
      /** replaces the `## Checks` section (GL-0348); [] or null clears it */
      checks?: Check[] | null;
    },
  ) {
    this.item(id);
    if (actor !== "human" && actor.tier === "light") {
      throw new ForbiddenError("edit needs a standard- or heavy-tier session (planner), not light");
    }
    if (!change.reason?.trim()) throw new ValidationError("edit needs a reason");
    const { reason: _reason, ...fields } = change;
    if (!Object.values(fields).some((v) => v !== undefined)) {
      throw new ValidationError("edit: give at least one field to change");
    }
    if (change.depends_on) this.assertDeps(id, change.depends_on);
    if (change.parent) this.assertParent(id, change.parent);
    if (change.relates) this.assertRefs(id, change.relates);
    if (change.found_by) this.assertFoundBy(id, change.found_by);
    for (const t of change.targets ?? []) parseTargetRef(t); // throws on a bad ref
    return this.store.editDraft(id, change, this.actorFor(actor));
  }

  /** Human: replace an item's depends_on (any status). Refs + cycles checked here. */
  async setDepends(id: string, dependsOn: string[]) {
    this.item(id);
    this.assertDeps(id, dependsOn);
    return this.store.setDepends(id, dependsOn, this.actorFor("human"));
  }

  /** Human: replace an item's relates (any status). Reference-only refs checked here. */
  async setRelates(id: string, relates: string[]) {
    this.item(id);
    this.assertRefs(id, relates);
    return this.store.setRelates(id, relates, this.actorFor("human"));
  }

  /** Human: replace an item's found_by (any status). Reference only — checked here. */
  async setFoundBy(id: string, foundBy: string[]) {
    this.item(id);
    this.assertFoundBy(id, foundBy);
    return this.store.setFoundBy(id, foundBy, this.actorFor("human"));
  }

  /**
   * found_by refs: each must parse and name an existing item (local index or
   * a linked workspace), and not the item itself. An unknown id is a
   * VALIDATION error. Reference only — no cycle checks, never ordering.
   */
  private assertFoundBy(id: string, refs: string[]) {
    const wsName = this.wsr.ws.config.name;
    for (const r of refs) {
      const parsed = parseItemRef(r); // throws ValidationError on bad refs
      const here = parsed.workspace === undefined || parsed.workspace === wsName;
      if (here && parsed.id === id)
        throw new ValidationError(`found_by: ${id} may not reference itself`);
      if (here ? !this.index.get(parsed.id) : this.links?.statusOf(r) === undefined) {
        throw new ValidationError(`found_by: unknown item ${r}`);
      }
    }
  }

  /**
   * Loose refs (relates): each must parse, exist (local index or a linked
   * workspace) and not be the item itself. No cycle checks — relates is
   * reference only, never ordering.
   */
  private assertRefs(id: string, refs: string[]) {
    const wsName = this.wsr.ws.config.name;
    for (const r of refs) {
      const parsed = parseItemRef(r); // throws ValidationError on bad refs
      const here = parsed.workspace === undefined || parsed.workspace === wsName;
      if (here && parsed.id === id) {
        throw new ValidationError(`relates: ${id} may not reference itself`);
      }
      if (here) this.item(parsed.id);
      else if (this.links?.statusOf(r) === undefined) {
        throw new NotFoundError(`reference ${r} not found`);
      }
    }
  }

  /**
   * depends_on refs: each must parse, exist (local index or a linked
   * workspace) and not be the item itself; and none may already depend on
   * `id` — adding such an edge would close a dependency cycle.
   */
  private assertDeps(id: string, refs: string[]) {
    const wsName = this.wsr.ws.config.name;
    for (const r of refs) {
      const parsed = parseItemRef(r); // throws ValidationError on bad refs
      const here = parsed.workspace === undefined || parsed.workspace === wsName;
      if (here && parsed.id === id) {
        throw new ValidationError(`depends_on: ${id} may not depend on itself`);
      }
      if (here) this.item(parsed.id);
      else if (this.links?.statusOf(r) === undefined) {
        throw new NotFoundError(`dependency ${r} not found`);
      }
    }
    // a new dep closes a cycle iff `id` is reachable from it via depends_on
    const seen = new Set<string>();
    const stack = refs.map((r) => parseItemRef(r));
    while (stack.length) {
      const cur = stack.pop()!;
      const key = `${cur.workspace ?? ""}:${cur.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const here = cur.workspace === undefined || cur.workspace === wsName;
      if (here && cur.id === id) {
        throw new ValidationError(`depends_on cycle: ${id} is an ancestor of ${cur.id}`);
      }
      const deps = here
        ? this.index.get(cur.id)?.meta.depends_on
        : this.links?.index(cur.workspace!)?.get(cur.id)?.meta.depends_on;
      for (const d of deps ?? []) {
        try {
          stack.push(parseItemRef(d));
        } catch {
          /* dangling refs can't close a cycle */
        }
      }
    }
  }

  /**
   * Parent refs: must parse, exist (local index or a linked workspace), and
   * not make `id` its own ancestor — walking the new parent's ancestor
   * chain (local + linked) must never reach `id`.
   */
  private assertParent(id: string, parent: string) {
    const parsed = parseItemRef(parent); // throws ValidationError on bad refs
    const wsName = this.wsr.ws.config.name;
    if (parsed.workspace === undefined || parsed.workspace === wsName) this.item(parsed.id);
    else if (this.links?.statusOf(parent) === undefined) {
      throw new NotFoundError(`parent ${parent} not found`);
    }
    // refuse a parent cycle: walk the new ancestor chain (local + linked)
    const seen = new Set<string>();
    let cur: { workspace?: string; id: string } | undefined = parsed;
    while (cur) {
      const key = `${cur.workspace ?? ""}:${cur.id}`;
      if (seen.has(key)) break;
      seen.add(key);
      const here = cur.workspace === undefined || cur.workspace === wsName;
      if (here && cur.id === id) {
        throw new ValidationError(`parent cycle: ${id} is an ancestor of ${parent}`);
      }
      const anc = here
        ? this.index.get(cur.id)?.meta.parent
        : this.links?.index(cur.workspace!)?.get(cur.id)?.meta.parent;
      if (!anc) break;
      try {
        cur = parseItemRef(anc);
      } catch {
        break;
      }
    }
  }

  /** Human: remove a note block, identified by its `**ts · who**` header. */
  async removeNote(id: string, note: { ts: string; who: string; body?: string }) {
    this.item(id);
    return this.store.removeNote(id, note, this.actorFor("human"));
  }

  /** Human: when may this item's dependents start — "done" (key task), "review", or default. */
  async setUnblocksOn(id: string, on: "review" | "done" | "default") {
    this.item(id);
    return this.store.setUnblocksOn(id, on === "default" ? undefined : on, this.actorFor("human"));
  }

  /**
   * Human: set or clear an item's parent epic (`undefined` clears). Validates
   * the ref, existence (local index or linked workspace), self-parenting and
   * ancestor cycles — including chains that cross a linked workspace.
   */
  async setParent(id: string, parent: string | undefined) {
    this.item(id);
    if (parent !== undefined) this.assertParent(id, parent);
    return this.store.setParent(id, parent, this.actorFor("human"));
  }

  async undrop(id: string) {
    const it = this.item(id);
    return this.store.perform(id, it.meta.version, this.actorFor("human"), { type: "undrop" });
  }

  async humanClaim(id: string) {
    const it = this.item(id);
    const now = new Date().toISOString();
    const claim: Claim = {
      item: id,
      holder: "human",
      actor: "human",
      machine: this.wsr.store.machine,
      targets: it.meta.targets,
      claimed_at: now,
      last_seen: now,
      paths: await plannedPaths(this.wsr.ws, id, it.meta.targets),
    };
    const r = await this.store.perform(
      id,
      it.meta.version,
      this.actorFor("human"),
      { type: "claim", claim },
      // a human claim locks paths against agents — it must not trample a
      // live agent claim either
      { guard: this.overlapGuard(it.meta.targets, undefined, id) },
    );
    try {
      const { resumed } = await setupWork(this.wsr.ws, id, claim, this.home);
      for (const res of resumed) {
        await this.store.annotate(id, {
          heading: "Log",
          lines: [`- resumed prior work on branch ${res.branch} (@${res.resource})`],
        });
      }
    } catch (e) {
      await this.release(id, "human", `setup failed: ${(e as Error).message}`).catch(() => {});
      throw e;
    }
    return r;
  }

  async renumber(oldId: string, newId: string) {
    const r = await doRenumber(this.wsr.ws.plansDir, oldId, newId);
    // daemon writes — mark them so the watcher doesn't re-detect human edits
    for (const { from, to } of r.renamedFiles) {
      this.store.onFileWrite?.(from, null);
      const c = await readFile(to, "utf8").catch(() => null);
      if (c !== null) this.store.onFileWrite?.(to, c);
      this.store.idx.removeFile(from);
    }
    // reload touched files
    for (const f of r.changedFiles) {
      const c = await readFile(f, "utf8").catch(() => null);
      if (c !== null) this.store.onFileWrite?.(f, c);
      await this.store.idx.upsertFile(f);
    }
    return r;
  }
}
