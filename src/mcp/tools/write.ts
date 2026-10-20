import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonCtx } from "../../daemon/server/context.js";
import type { AgentBinding } from "../server/mcp.js";
import type { WorkspaceOps } from "../../daemon/api/ops.js";
import { okText, errFrom, type ToolResult } from "../format.js";
import { opsFor, needSession, isToolResult } from "./read.js";

/**
 * Write tools (DESIGN §7): claim, release, log, ask, submit, review, bounce,
 * propose. All mutations go through the store — serialized, CAS-checked,
 * committed.
 */

export function registerWriteTools(
  server: McpServer,
  binding: AgentBinding,
  ctx: DaemonCtx,
): void {
  const ops = (): WorkspaceOps | ToolResult => opsFor(binding, ctx);
  const session = () => needSession(binding);

  server.registerTool(
    "claim",
    {
      description:
        "Take an item: writes the claim file, locks targets, sets up worktrees/snapshots. " +
        "On an in_review item with an AI 'issues' verdict this takes the claim over — same machine only.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const { claim, version } = await o.claim(id, s);
        return okText(`claimed ${id} v${version} holder=${claim.holder}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "release",
    {
      description: "Give back an item (claim deleted, work kept).",
      inputSchema: { id: z.string(), note: z.string().optional() },
    },
    async ({ id, note }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.release(id, s, note);
        return okText(`released ${id} → ready`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "log",
    {
      description: "Progress note on a claimed item.",
      inputSchema: { id: z.string(), note: z.string() },
    },
    async ({ id, note }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.log(id, s, note);
        return okText(`logged ${id}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "note",
    {
      description:
        "Add a note (multi-line markdown) to an item: appended to the task file's ## Notes with a timestamp. " +
        "Use it for findings worth keeping in the task; progress goes in log. No claim needed.",
      inputSchema: { id: z.string(), text: z.string() },
    },
    async ({ id, text }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.note(id, s, text);
        return okText(`noted ${id} → ${r.path}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "simple",
    {
      description:
        "Write the item's plain-English version for the human (a short, non-technical explanation of what and why). " +
        "Creates or replaces <task>.simple.md and links it — never create .simple.md files by hand. No claim needed.",
      inputSchema: { id: z.string(), text: z.string() },
    },
    async ({ id, text }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.simple(id, s, text);
        return okText(`simple ${id} → ${r.path}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "supersede",
    {
      description:
        "Correct a wrong ## Evidence line — append-only: adds a 'supersedes' entry that names the old " +
        "line (line), the correct value (correct) and why (reason). The old line stays visible; " +
        "evidence is never rewritten. No claim needed.",
      inputSchema: {
        id: z.string(),
        line: z.string(),
        correct: z.string(),
        reason: z.string().optional(),
      },
    },
    async ({ id, line, correct, reason }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.supersede(id, s, { line, correct, reason });
        return okText(`superseded evidence on ${id}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "ask",
    {
      description: "Record a question → item waits for the human.",
      inputSchema: {
        id: z.string(),
        question: z.string(),
        options: z.array(z.string()).optional(),
      },
    },
    async ({ id, question, options }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.ask(id, s, question, options);
        return okText(`waiting ${id}: human's turn`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "submit",
    {
      description: "Hand work to the human with evidence (commits/tests/notes).",
      inputSchema: {
        id: z.string(),
        commits: z.array(z.string()).optional(),
        tests: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async ({ id, commits, tests, notes }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.submit(id, s, { commits, tests, notes });
        return okText(`in_review ${id}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "review",
    {
      description:
        "Peer-review a submission as a different session than the holder (find them: query status=in_review). " +
        "Read the task file, the Evidence section and the actual diff/tests first, then record verdict ok|issues " +
        "with summary (one plain-English sentence for the human — what the verdict means, no jargon) " +
        "and a specific note for whoever fixes it (findings with file:line). " +
        "Advisory marker only — the human still accepts. One exception: an 'issues' verdict on a submission whose " +
        "holder is on another machine or no longer live releases the claim to ready so the fix isn't stranded. " +
        "Never review your own submission.",
      inputSchema: {
        id: z.string(),
        verdict: z.enum(["ok", "issues"]),
        summary: z.string(),
        note: z.string().optional(),
      },
    },
    async ({ id, verdict, summary, note }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.review(id, s, verdict, note, summary);
        return okText(
          `reviewed ${id}: ${verdict}` +
            (r.meta.status === "ready" ? " — holder can't act here, claim released → ready" : ""),
        );
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "bounce",
    {
      description:
        "Reviewer only (not the holder): send a broken submission back to its holder — in_review → in_progress, " +
        "the claim is kept so the holder fixes and resubmits — unless the holder is on another machine or no " +
        "longer live, where the claim is released to ready instead (a bounced item must not strand). " +
        "reason is required and goes to the holder; " +
        "summary is required too — one plain-English sentence for the human, no jargon. " +
        "Capped: after 2 AI bounces in a row the item stays in review for the human — record a review instead. " +
        "Each bounce is a failed attempt: on escalation past the holder's tier the claim is released for a stronger agent.",
      inputSchema: { id: z.string(), reason: z.string(), summary: z.string() },
    },
    async ({ id, reason, summary }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.bounce(id, s, reason, summary);
        const m = r.meta;
        const where =
          m.status === "in_progress"
            ? "in_progress (holder fixes and resubmits)"
            : m.status === "ready"
              ? `ready — claim released${m.tier ? ` (tier ${m.tier})` : ""}`
              : `${m.status} — out of attempts, the human decides`;
        return okText(`bounced ${id} → ${where} (attempt ${m.attempts ?? 0})`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "handoff",
    {
      description:
        "Holder only, when stuck (same error twice, no progress, circling): STOP and hand the item to a fresh session. " +
        "problem = what fails (exact error); tried = what you attempted and why each failed; state = branch/files/what passes now; " +
        "next = your best guess for the next step. Written to ## Handoff, claim released (branches kept) → ready. " +
        "Counts as a failed attempt: after escalate_after attempts the tier goes up; at max_attempts it waits for the human.",
      inputSchema: {
        id: z.string(),
        problem: z.string(),
        tried: z.string(),
        state: z.string().optional(),
        next: z.string().optional(),
      },
    },
    async ({ id, problem, tried, state, next }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.handoff(id, s, { problem, tried, state, next });
        const m = r.meta;
        return okText(
          `handed off ${id} → ${m.status} (attempt ${m.attempts ?? 0}${m.tier ? `, tier ${m.tier}` : ""}) — end this task now`,
        );
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "rescope",
    {
      description:
        "Change a DRAFT's scope — only after the human moved it back to draft (that is the go-ahead). " +
        "touches replaces the task file's **Touches:** line (list every repo: path, old and new); " +
        "add_acceptance appends checklist items. reason says why. Planners only (tier standard/heavy). " +
        "It stays a draft: tell the human to approve the new scope. Never on ready/in-progress work.",
      inputSchema: {
        id: z.string(),
        reason: z.string(),
        touches: z.array(z.string()).optional(),
        add_acceptance: z.array(z.string()).optional(),
      },
    },
    async ({ id, reason, touches, add_acceptance }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.rescope(id, s, { touches, addAcceptance: add_acceptance, reason });
        return okText(`rescoped ${id} → ${r.path} (still draft — the human approves)`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "flag_drop",
    {
      description:
        "Ask the human to drop this task — flag it with a reason; the human decides (drop or keep). " +
        "Use for stale, superseded, duplicated or wrong work — any status but done/dropped, claimed or not. " +
        "Advisory only: nothing changes until the human acts. Not for being stuck on your own claim — handoff instead.",
      inputSchema: { id: z.string(), reason: z.string() },
    },
    async ({ id, reason }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.flagDrop(id, s, reason);
        return okText(`flagged ${id} for drop — the human decides`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "edit",
    {
      description:
        "Rewrite a DRAFT — any of: title, summary, acceptance (replaces the whole checklist), touches " +
        "(the **Touches:** line), depends_on, parent (\"\" clears), targets, tier (any clears), domains, " +
        "sections ({\"## Heading\": new body}; ## Notes/Review/Evidence/Handoff/Log/History are managed — refused). " +
        "Only drafts: for anything else ask the human to move it back to draft first (that is the go-ahead). " +
        "reason says why. Planner tiers only (standard/heavy). It stays a draft — the human approves the new version.",
      inputSchema: {
        id: z.string(),
        reason: z.string(),
        title: z.string().optional(),
        summary: z.string().optional(),
        acceptance: z.array(z.string()).optional(),
        touches: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        parent: z.string().optional(),
        targets: z.array(z.string()).optional(),
        tier: z.enum(["light", "standard", "heavy", "any"]).optional(),
        domains: z.array(z.string()).optional(),
        sections: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ id, reason, title, summary, acceptance, touches, depends_on, parent, targets, tier, domains, sections }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.editDraft(id, s, {
          reason,
          title,
          summary,
          acceptance,
          touches,
          depends_on,
          parent: parent === "" ? null : parent,
          targets,
          tier: tier === "any" ? null : tier,
          domains,
          sections,
        });
        return okText(`edited ${id}${r.path ? ` → ${r.path}` : ""} (still draft — the human approves)`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "vet",
    {
      description:
        "Check a draft proposed by a light-tier session (hello lists them) — you must be a higher tier. " +
        "Read it: is the scope clear, acceptance checkable, Touches right, tier sensible? verdict ok|issues with a note. " +
        "Under autonomy: solo an ok approves it (→ ready); otherwise it marks it vetted for the human.",
      inputSchema: { id: z.string(), verdict: z.enum(["ok", "issues"]), note: z.string().optional() },
    },
    async ({ id, verdict, note }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const r = await o.vet(id, s, verdict, note);
        return okText(`vetted ${id}: ${verdict}${r.approved ? " → ready (autonomy: solo)" : ""}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "close_plan",
    {
      description:
        "Close a plan (epic): no more parts coming — plan_state turns active, then done when every part finishes. Human-only; agents are refused.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.closePlan(id, s);
        return okText(`plan closed ${id}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "reopen_plan",
    {
      description: "Reopen a closed plan (epic) — more parts may still be added. Human-only; agents are refused.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        await o.reopenPlan(id, s);
        return okText(`plan reopened ${id}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "propose",
    {
      description:
        "Create draft items for the human to approve (agents cannot set other statuses). " +
        "In a task-folder workspace each item becomes <project>/TASK-NN-<slug>.md (epics: PHASE-NN-…) " +
        "from the standard template — give acceptance criteria an agent can check and the repos/paths it touches. " +
        "depends_on/parent may use #N for the N-th (0-based) earlier item of the same call. " +
        "tier = the least capable model that can do it (light: mechanical/one-file; standard: normal feature/fix; heavy: cross-cutting/design-heavy). " +
        "Drafts proposed by a light-tier session wait for a stronger session's vet.",
      inputSchema: {
        items: z.array(
          z.object({
            type: z.string().optional(),
            title: z.string(),
            project: z.string().optional(),
            targets: z.array(z.string()).optional(),
            depends_on: z.array(z.string()).optional(),
            parent: z.string().optional(),
            summary: z.string().optional(),
            acceptance: z.array(z.string()).optional(),
            touches: z.array(z.string()).optional(),
            simple: z.string().optional(),
            domains: z.array(z.string()).optional(),
            /** minimum model tier to claim it: light | standard | heavy */
            tier: z.enum(["light", "standard", "heavy"]).optional(),
          }),
        ),
      },
    },
    async ({ items }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const o = ops();
        if (isToolResult(o)) return o;
        const { ids, files, ready } = await o.propose(items, s);
        return okText(
          (files.length
            ? ids.map((id, i) => `proposed ${id} → ${files[i]}`).join("\n")
            : `proposed ${ids.join(", ")}`) +
            (ready.length ? `\nready (autonomy: solo): ${ready.join(", ")}` : ""),
        );
      } catch (e) {
        return errFrom(e);
      }
    },
  );
}
