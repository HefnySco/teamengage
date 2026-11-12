import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonCtx } from "../daemon/server/context.js";
import type { AgentBinding } from "../mcp/server/mcp.js";
import { pickWorkspace } from "../mcp/server/mcp.js";
import { needSession, isToolResult } from "../mcp/tools/read.js";
import { okText, errFrom } from "../mcp/format.js";
import { opsPlaybooks, opsTargets, opsJobs, opsJob, opsStart, opsStep, opsSkip, opsApprove, opsAbort, opsResume } from "../daemon/api/opsapi.js";

/**
 * Ops agent tools (GL-0271): the agent half of the playbook protocol. The
 * daemon accepts results in strict step order; it never runs playbook
 * commands — `te ops exec` does that and posts here. Registered only on
 * the plain-HTTP agent surface for now.
 */

const ws = z.string().optional();

function jobLine(j: { id: string; status: string; playbook: string; target?: string; cursor: number; steps: unknown[] }): string {
  return `${j.id} ${j.status} ${j.playbook}${j.target ? ` on ${j.target}` : ""} — step ${j.cursor}/${j.steps.length}`;
}

export function registerOpsTools(
  server: McpServer,
  binding: AgentBinding,
  ctx: DaemonCtx,
): void {
  const wsrOf = (workspace?: string) => pickWorkspace(binding, ctx, workspace);
  const session = () => needSession(binding);

  server.registerTool(
    "ops_playbooks",
    {
      description: "List the playbooks under ops/ — id, title, target, start policy, step count.",
      inputSchema: { workspace: ws },
    },
    async ({ workspace }) => {
      const w = wsrOf(workspace);
      if ("content" in w) return w;
      const rows = opsPlaybooks(w).map((l) =>
        l.playbook
          ? `${l.playbook.name} — start:${l.playbook.start}${l.playbook.min_tier ? ` min_tier:${l.playbook.min_tier}` : ""}${l.playbook.target ? ` target:${l.playbook.target}` : ""} — ${l.playbook.steps.length} steps — ${l.file}`
          : `${l.file} — does not parse: ${l.error}`,
      );
      return okText(rows.length ? rows.join("\n") : "no playbooks under ops/");
    },
  );

  server.registerTool(
    "ops_targets",
    {
      description: "List the deploy targets declared in workspace.yaml targets:.",
      inputSchema: { workspace: ws },
    },
    async ({ workspace }) => {
      const w = wsrOf(workspace);
      if ("content" in w) return w;
      const t = opsTargets(w);
      const rows = Object.entries(t).map(
        ([id, x]) => `${id}${x.title ? ` — ${x.title}` : ""}${x.service ? ` service:${x.service}` : ""}${x.env ? ` env:${x.env}` : ""}`,
      );
      return okText(rows.length ? rows.join("\n") : "no targets in workspace.yaml");
    },
  );

  server.registerTool(
    "ops_start",
    {
      description:
        "Start a job from a playbook. Only a playbook with start: agent and at or under its min_tier may start " +
        "from an agent session — the human starts the rest. Takes the target lock (one live job per target).",
      inputSchema: {
        playbook: z.string(),
        target: z.string().optional(),
        params: z.record(z.string(), z.string()).optional(),
        workspace: ws,
      },
    },
    async ({ playbook, target, params, workspace }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const w = wsrOf(workspace);
        if ("content" in w) return w;
        const j = await opsStart(w, ctx, { playbook, target, params, session: s });
        return okText(`started ${jobLine(j)}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "ops_jobs",
    {
      description: "List jobs — filters: playbook, target, status, machine. Newest machine files first.",
      inputSchema: {
        playbook: z.string().optional(),
        target: z.string().optional(),
        status: z.string().optional(),
        machine: z.string().optional(),
        workspace: ws,
      },
    },
    async ({ playbook, target, status, machine, workspace }) => {
      const w = wsrOf(workspace);
      if ("content" in w) return w;
      const rows = opsJobs(w, ctx, { playbook, target, status, machine }).map(jobLine);
      return okText(rows.length ? rows.join("\n") : "no jobs");
    },
  );

  server.registerTool(
    "ops_job",
    {
      description: "One job record: status, cursor, every step's state, tail and evidence.",
      inputSchema: { id: z.string(), workspace: ws },
    },
    async ({ id, workspace }) => {
      const w = wsrOf(workspace);
      if ("content" in w) return w;
      try {
        const j = opsJob(w, ctx, id);
        const steps = j.steps
          .map((s) => `  ${s.id}: ${s.status}${s.exit_code !== undefined ? ` exit:${s.exit_code}` : ""}${s.evidence ? ` — ${s.evidence}` : ""}`)
          .join("\n");
        return okText(`${jobLine(j)}${j.version ? ` version:${j.version}` : ""}\n${steps}`);
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "ops_step",
    {
      description:
        "Post a result for the step at the cursor: exit_code and output for cmd/check, evidence for agent steps. " +
        "Anything else is OPS_ORDER; a changed playbook file is OPS_PLAYBOOK_CHANGED.",
      inputSchema: {
        id: z.string(),
        step: z.string(),
        status: z.string().optional(),
        exit_code: z.number().int().optional(),
        output: z.string().optional(),
        output_tail: z.string().optional(),
        output_sha256: z.string().optional(),
        evidence: z.string().optional(),
        workspace: ws,
      },
    },
    async ({ id, step, status, exit_code, output, output_tail, output_sha256, evidence, workspace }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const w = wsrOf(workspace);
        if ("content" in w) return w;
        const j = await opsStep(
          w,
          ctx,
          id,
          { step, status, exit_code, output, output_tail, output_sha256, evidence },
          s,
        );
        return okText(jobLine(j));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "ops_skip",
    {
      description: "Skip the cursor step — only when the playbook marks it optional, and only with a reason.",
      inputSchema: { id: z.string(), step: z.string(), reason: z.string(), workspace: ws },
    },
    async ({ id, step, reason, workspace }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const w = wsrOf(workspace);
        if ("content" in w) return w;
        const j = await opsSkip(w, ctx, id, { step, reason }, s);
        return okText(jobLine(j));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "ops_approve",
    {
      description: "Approve the gate step at the cursor — human only; agent sessions get FORBIDDEN.",
      inputSchema: { id: z.string(), step: z.string(), workspace: ws },
    },
    async ({ id, step, workspace }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const w = wsrOf(workspace);
        if ("content" in w) return w;
        const j = await opsApprove(w, ctx, id, { step }, s);
        return okText(jobLine(j));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "ops_abort",
    {
      description: "Abort a live job (running, waiting or failed) — releases the target lock.",
      inputSchema: { id: z.string(), reason: z.string().optional(), workspace: ws },
    },
    async ({ id, workspace }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const w = wsrOf(workspace);
        if ("content" in w) return w;
        const j = await opsAbort(w, ctx, id, s);
        return okText(jobLine(j));
      } catch (e) {
        return errFrom(e);
      }
    },
  );

  server.registerTool(
    "ops_resume",
    {
      description:
        "Resume a failed job at the same cursor — the failed step retries. Same machine only.",
      inputSchema: { id: z.string(), workspace: ws },
    },
    async ({ id, workspace }) => {
      try {
        const s = session();
        if (isToolResult(s)) return s;
        const w = wsrOf(workspace);
        if ("content" in w) return w;
        const j = await opsResume(w, ctx, id, s);
        return okText(jobLine(j));
      } catch (e) {
        return errFrom(e);
      }
    },
  );
}
