import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import type { AgentBinding } from "../server/mcp.js";
import { pickWorkspace } from "../server/mcp.js";
import { WorkspaceOps, TRANSCRIPT_PAGE_LINES } from "../../daemon/api/ops.js";
import type { Session } from "../../core/model/session.js";
import {
  okText,
  errText,
  errFrom,
  itemLine,
  briefBudget,
  type BriefBlock,
  type ToolResult,
} from "../format.js";
import { handoffStatus, handoffLines } from "../../daemon/sync/sync.js";
import { historyLine } from "../../core/index/history.js";

/**
 * Read tools (DESIGN §7): hello, next, brief, query, graph.
 * Output is compact text — ids and one-liners.
 */

export function opsFor(binding: AgentBinding, ctx: DaemonCtx, workspace?: string) {
  const wsr = pickWorkspace(binding, ctx, workspace);
  if ("content" in wsr) return wsr; // ToolResult error
  return new WorkspaceOps(wsr, ctx.sessions, wsr.links, ctx.home);
}

export function needSession(binding: AgentBinding): ToolResult | Session {
  if (!binding.session) return errText("NO_SESSION", "call hello first");
  return binding.session;
}

/** Zod passthrough objects defeat `in`-narrowing — use a real type guard. */
export function isToolResult(x: unknown): x is ToolResult {
  return (
    typeof x === "object" &&
    x !== null &&
    Array.isArray((x as ToolResult).content)
  );
}

/** One line every session sees, whatever its instruction files say. */
export const HELLO_RULES =
  "rules: claim before code · new tasks only via propose · never edit te: lines or .teamengage/, never move files to done/ · task-file edits additive + log · never push · scope is the human's — wider work → propose a dependent task (or edit, once the human moved it to draft) · stale or wrong task → flag_drop, the human decides · ask, don't guess · review only others' submissions, never your own · all text for the human in STE (ASD-STE100)";

/** Extra line under `autonomy: solo` (one human / small team). */
export const SOLO_RULES =
  "autonomy: solo — a follow-up you propose with depends_on an existing task lands ready (no approve wait); an ok peer review is auto-accepted after a delay unless the human acts (a reviewer's needs_human flag keeps it the human's call); key tasks, drop/delete and pushing stay the human's";

/** Session roles: what a session declares at hello, and what `next` picks. */
export const ROLE_RULES =
  "role: declare yours at hello (planner|coder|reviewer|ops) — next then picks for it: reviewer → in_review items you did not submit, planner → ideas nothing references yet + light-authored drafts to vet, coder/ops → ready items; no role → next as usual";

/** Model tiers: what a session declares at hello, and what it may then do. */
export const TIER_RULES =
  "tiers: declare yours at hello (light|standard|heavy) · you can't claim an item above your tier · stuck (same error twice, no progress)? STOP and handoff with problem/tried/state/next — a fresh session continues from your note · every bounce or handoff is an attempt; after escalate_after attempts the item's tier goes up, at max_attempts it waits for the human";

export function registerReadTools(server: McpServer, binding: AgentBinding, ctx: DaemonCtx): void {
  server.registerTool(
    "hello",
    {
      description:
        "Register a session; returns session id, machine, workspace summary, claims to resume. " +
        "tier: your model class — light (Haiku-class), standard (Sonnet-class), heavy (Opus-class). " +
        "role: what you're here to do — planner, coder, reviewer or ops; next picks its pool for it. " +
        "model: your model id (e.g. claude-sonnet-5-5) — recorded on your submits and reviews. " +
        "label: free text for this run — put the task id here, keep `agent` your stable name.",
      inputSchema: {
        agent: z.string(),
        workspace: z.string().optional(),
        tier: z.enum(["light", "standard", "heavy"]).optional(),
        role: z.enum(["planner", "coder", "reviewer", "ops"]).optional(),
        model: z.string().optional(),
        label: z.string().optional(),
      },
    },
    async ({ agent, workspace, tier, role, model, label }) => {
      try {
        const ops = opsFor(binding, ctx, workspace);
        if ("content" in ops) return ops;
        // a repeat hello on this connection replaces the old session —
        // retire it so its claims rebind instead of looking "live"
        if (binding.session) ctx.sessions.disconnect(binding.session.id);
        const { session, resume } = await ops.hello(agent, binding.clientPid, tier, role, model, label);
        binding.session = session;
        const ws = ops.wsr.ws;
        const counts = { ready: ops.index.readyItems().length, items: ops.index.items.size };
        const lines = [
          `session ${session.id} on ${session.machine}${session.tier ? ` tier ${session.tier}` : ""}${session.role ? ` role ${session.role}` : ""}${session.model ? ` model ${session.model}` : ""}${session.label ? ` label ${session.label}` : ""}`,
          `workspace ${ws.name} items:${counts.items} ready:${counts.ready}`,
        ];
        if (resume.length) {
          lines.push(`resume: ${resume.map((c) => c.item).join(", ")}`);
        }
        lines.push(...handoffLines(await handoffStatus(ops.wsr)));
        lines.push(HELLO_RULES);
        lines.push(TIER_RULES);
        lines.push(ROLE_RULES);
        if (session.tier && session.tier !== "light") {
          const vet = [...ops.index.items.values()].filter(
            (i) => i.meta.status === "draft" && i.meta.authored_tier === "light" && !i.meta.vetted_by && !i.meta.archived,
          );
          if (vet.length) lines.push(`to vet (light-authored drafts): ${vet.map((i) => i.meta.id).join(", ")}`);
        }
        if (ws.config.autonomy === "solo") lines.push(SOLO_RULES);
        return okText(lines.join("\n"));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "next",
    {
      description: "Ready, unclaimed items whose targets are free, best first. domain: only items tagged with it.",
      inputSchema: { limit: z.number().int().min(1).max(20).optional(), domain: z.string().optional() },
    },
    ({ limit, domain }) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        const items = ops.next(limit ?? 3, domain, binding.session);
        const peers = ops.peerQuestionsFor(binding.session);
        const lines = items.map(itemLine);
        if (peers.length) {
          lines.push("peer questions (answer_peer):");
          for (const p of peers) {
            lines.push(`  ${p.meta.id} "${p.meta.title}" — ${p.meta.question!.text}`);
          }
        }
        if (!lines.length) return okText("nothing ready");
        return okText(lines.join("\n"));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "brief",
    {
      description:
        "What an agent needs to work an item: summary, acceptance, dep outcomes, decisions, resolved targets. " +
        "The default brief stays under 120 lines — a block that does not fit shows its count and " +
        "the call for more: `brief <id> more=<block>` (blocks: lessons, decisions, " +
        "domain_decisions, history, repo_context). A discussion's brief also names its transcript; " +
        "`brief <id> more=transcript page=N` pages the raw chat ~200 lines at a time.",
      inputSchema: { id: z.string(), more: z.string().optional(), page: z.number().int().min(1).optional() },
    },
    async ({ id, more, page }) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        if (more === "transcript") {
          const t = ops.discussionTranscript(id, page ?? 1);
          const from = (t.page - 1) * TRANSCRIPT_PAGE_LINES + 1;
          const to = Math.min(t.page * TRANSCRIPT_PAGE_LINES, t.total);
          return okText(
            `transcript ${t.path} — page ${t.page}/${t.pages} (lines ${from}–${to} of ${t.total})\n\n${t.text}`,
          );
        }
        const b = await ops.brief(id);
        const it = b.item;
        const sec = (n: string) =>
          it.sections.find((s) => s.heading.toLowerCase() === n.toLowerCase())?.body.trim() ?? "";
        const lines: string[] = [
          `${it.meta.id} ${it.meta.status}${it.meta.archived ? " [archived]" : ""} "${it.meta.title}" v${it.meta.version}`,
        ];
        if (it.meta.ai_review) {
          const r = it.meta.ai_review;
          const detail = r.summary
            ? ` — ${r.summary}${r.note ? ` | ${r.note}` : ""}`
            : r.note
              ? ` — ${r.note}`
              : "";
          lines.push(`ai_review: ${r.verdict} by ${r.reviewed_by}${r.needs_human ? " (needs the human's call)" : ""}${detail}`);
        }
        if (it.meta.findings?.length) {
          lines.push("findings (answer each on submit with finding_states):");
          for (const [i, f] of it.meta.findings.entries()) {
            lines.push(
              `  ${i + 1}. [${f.severity}] ${f.text}${f.where ? ` (${f.where})` : ""}${f.state ? ` → ${f.state}${f.reason ? ` — ${f.reason}` : ""}` : ""}`,
            );
          }
        }
        if (it.meta.question) {
          const q = it.meta.question;
          lines.push(
            q.to === "peer"
              ? `open peer question (asked ${q.asked_at}): ${q.text} — waiting for a peer; answer lands in ## Notes`
              : `open question for the human: ${q.text}`,
          );
        }
        if (it.meta.peer_answer) {
          const a = it.meta.peer_answer;
          lines.push(`peer answer by ${a.by} at ${a.at}: ${a.text}`);
        }
        if (it.meta.type === "epic" && it.plan_state) {
          lines.push(
            `plan: ${it.plan_state} ${it.plan_progress?.done ?? 0}/${it.plan_progress?.total ?? 0} — epics are plans; work their children, not this item`,
          );
        }
        if (it.meta.type === "idea") {
          lines.push(
            `idea: a source document — plan from it (propose items with relates: ["${it.meta.id}"]); it is never claimed`,
          );
        }
        if (it.meta.type === "discussion") {
          lines.push(
            `discussion: a saved chat — a source document; plan from it (propose items with relates: ["${it.meta.id}"]); discussions are never claimed`,
          );
          try {
            const t = ops.discussionTranscript(it.meta.id, 1);
            lines.push(
              `transcript: ${t.path} — ${t.total} lines, ${t.pages} page(s) (brief ${it.meta.id} more=transcript page=N)`,
            );
          } catch {
            lines.push("transcript: none saved yet");
          }
        }
        if (it.meta.tier || it.meta.attempts) {
          lines.push(`tier: ${it.meta.tier ?? "any"}${it.meta.attempts ? ` · ${it.meta.attempts} failed attempt(s) — read ## Handoff / ## Review first` : ""}`);
        }
        if (it.meta.authored_tier) lines.push(`authored by a ${it.meta.authored_tier}-tier session${it.meta.vetted_by ? ` · vetted by ${it.meta.vetted_by}` : " · not vetted yet"}`);
        const handoff = sec("Handoff");
        if (handoff) lines.push(`handoff notes:\n${handoff}`);
        if (it.meta.domains.length) lines.push(`domains: ${it.meta.domains.map((d) => `#${d}`).join(" ")}`);
        if (b.plan_goal) lines.push(`plan goal: ${b.plan_goal}`);
        const lessons = await ops.lessonsFor(it.meta.domains);
        if (!b.source) lines.push(`summary: ${sec("Summary")}`);
        else if ("missing" in b.source) lines.push(`source: ${b.source.path} (MISSING — ask the human)`);
        else lines.push(`source: ${b.source.path}${b.source.moved ? " (moved)" : ""}`, b.source.text.trim());
        const acc = sec("Acceptance");
        if (acc) lines.push(`acceptance:\n${acc}`);
        if (b.checks.length) {
          lines.push("checks (te verify runs them):");
          for (const c of b.checks) {
            lines.push(
              `  - ${c.name}: ${c.run ?? "(no run)"}${c.repo ? ` [${c.repo}]` : ""}${c.timeout ? ` (timeout ${c.timeout}s)` : ""}${c.expect_exit !== undefined ? ` (expect exit ${c.expect_exit})` : ""}`,
            );
          }
        }
        for (const d of b.deps) {
          lines.push(
            `dep ${d.ref} ${d.status}${d.key && !["done", "dropped"].includes(d.status) ? " [key task — wait for its acceptance]" : ""}${d.pending ? " (not accepted yet — build on it, but it may still change)" : ""}${d.archived ? " [archived]" : ""}${d.outcome ? ` — ${d.outcome}` : ""}`,
          );
          for (const p of d.provides ?? []) lines.push(`  provides: ${p}`);
        }
        for (const r of b.relates) {
          lines.push(`relates ${r.ref} ${r.status}`);
        }
        for (const r of b.found_by) {
          lines.push(`found by ${r.ref} ${r.status}`);
        }
        for (const r of b.referenced_by) {
          lines.push(`referenced by ${r.ref} ${r.status}`);
        }
        for (const t of b.targets) {
          lines.push(`target ${t.ref} → ${t.kind}${t.host ? ` ${t.host}` : ""}${t.path ? ` ${t.path}` : ""}`);
        }
        // GL-0356: context blocks live under a 120-line budget — a block
        // that does not fit shows its entry count and `brief <id> more=`.
        const blocks: BriefBlock[] = [];
        blocks.push({
          name: "lessons",
          count: lessons.length,
          lines: lessons.length
            ? ["lessons (shared by earlier agents — newest first):", ...lessons.map((l) => `  - ${l}`)]
            : [],
        });
        blocks.push({
          name: "decisions",
          count: b.decisions.length,
          lines: b.decisions.map((d) => `decision ${d.meta.id}: ${d.meta.title}`),
        });
        blocks.push({
          name: "domain_decisions",
          count: (b.domain_decisions ?? []).length,
          lines: (b.domain_decisions ?? []).map((d) => `domain decision ${d.id}: ${d.title}`),
        });
        blocks.push({
          name: "history",
          count: b.history_total ?? 0,
          lines: (b.history ?? []).length
            ? [
                `history (done items on the same paths — \`history <path>\` for all ${b.history_total}):`,
                ...(b.history ?? []).map((r) => `  ${historyLine(r)}`),
              ]
            : [],
        });
        blocks.push({
          name: "repo_context",
          count: (b.repo_context ?? []).length,
          lines: (b.repo_context ?? []).flatMap((c) => [
            `context ${c.repo}:`,
            ...c.text.trim().split("\n").map((l) => `  ${l}`),
          ]),
        });
        const out = briefBudget(lines, blocks, more, it.meta.id);
        for (const o of b.overlap) {
          out.push(`warn: ${o.id} touches ${o.paths.join(", ")}`);
        }
        return okText(out.join("\n"));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "query",
    {
      description:
        "Search items by status/type/state/project/domain/resource/text/claimed/starred; state = idea state (draft|ready|done|dropped) for type idea, " +
        "discussion state (draft|unplanned|planned|in_progress|done|dropped) for type discussion; q = board search (all words in id/title/file/#domains). Archived items never match.",
      inputSchema: {
        status: z.string().optional(),
        domain: z.string().optional(),
        type: z.string().optional(),
        state: z.string().optional(),
        project: z.string().optional(),
        resource: z.string().optional(),
        text: z.string().optional(),
        q: z.string().optional(),
        claimed: z.boolean().optional(),
        starred: z.boolean().optional(),
      },
    },
    (args) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        const items = ops.query({
          status: args.status as never,
          type: args.type,
          idea_state: args.state as never,
          project: args.project,
          domain: args.domain,
          resource: args.resource,
          text: args.text,
          q: args.q,
          claimed: args.claimed,
          starred: args.starred,
        });
        if (!items.length) return okText("no matches");
        return okText(items.slice(0, 50).map(itemLine).join("\n"));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "search",
    {
      description:
        "Deep search over finished items (summary, what, how, walkthrough, notes), decisions, " +
        "lessons and the distilled sections of discussions. Every word must hit; one snippet per " +
        "result, ranked by match count. domain: restrict to a #domain; limit: rows (default 10); " +
        "in: 'transcript' searches only the raw transcripts of saved chats.",
      inputSchema: {
        text: z.string(),
        domain: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        in: z.enum(["transcript"]).optional(),
      },
    },
    async ({ text, domain, limit, in: scope }) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        const hits = await ops.search({ text, domain, limit, in: scope });
        if (!hits.length) return okText(`no hits for "${text}"`);
        return okText(
          hits.map((h) => `${h.kind} ${h.id} "${h.title}" — ${h.snippet}`).join("\n"),
        );
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "history",
    {
      description:
        "Finished items that changed a path — matched by Touches globs and by the files of Evidence " +
        "commits (when the repo is on this machine). Rows: id, date, title, what line, open problems. " +
        "path may be `repo:path`; limit defaults to 5, newest first.",
      inputSchema: {
        path: z.string(),
        repo: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ path, repo, limit }) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        let p = path;
        let r = repo;
        const i = path.indexOf(":");
        if (r === undefined && i > 0) {
          r = path.slice(0, i).trim();
          p = path.slice(i + 1).trim();
        }
        const rows = await ops.history({ path: p, repo: r, limit });
        if (!rows.length) return okText(`no history for ${path}`);
        return okText(rows.map(historyLine).join("\n"));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "graph",
    {
      description: "Mermaid flowchart of a scoped subgraph.",
      inputSchema: {
        root: z.string().optional(),
        depth: z.number().int().min(0).optional(),
        status: z.string().optional(),
        project: z.string().optional(),
      },
    },
    ({ root, depth, status, project }) => {
      try {
        const ops = opsFor(binding, ctx);
        if ("content" in ops) return ops;
        return okText(
          ops.graph({
            roots: root ? [root] : undefined,
            depth,
            filter: { status: status as never, project },
          }),
        );
      } catch (e) {
        return errFrom(e);
      }
    },
  );
}
