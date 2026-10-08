import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DaemonCtx, WorkspaceRuntime } from "../server/context.js";
import { WorkspaceOps } from "./ops.js";
import { TeError, NotFoundError } from "../../core/model/errors.js";

/**
 * Human action API (DM-0005): REST endpoints for the human-only transitions
 * plus JSON read endpoints mirroring the MCP read tools. Used by `te` and the
 * web UI.
 */

const IdParam = z.object({ id: z.string() });

function opsFor(ctx: DaemonCtx, ws?: string): WorkspaceOps {
  let wsr: WorkspaceRuntime | undefined;
  if (ws) wsr = ctx.workspaces.get(ws);
  else if (ctx.workspaces.size === 1) wsr = ctx.workspaces.values().next().value;
  if (!wsr) {
    throw new NotFoundError(
      ws ? `workspace '${ws}' not registered` : "no workspace registered on this machine",
    );
  }
  return new WorkspaceOps(wsr, ctx.sessions, wsr.links, ctx.home);
}

function sendErr(reply: FastifyReply, e: unknown) {
  if (e instanceof TeError) {
    const code = e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : e.code === "CONFLICT" || e.code === "CLAIM_REFUSED" ? 409 : 400;
    return reply.code(code).send({ error: e.code, message: e.message, details: e.details });
  }
  return reply.code(500).send({ error: "INTERNAL", message: (e as Error).message });
}

const wsOf = (q: unknown) => (q as { ws?: string }).ws;

export function registerApiRoutes(app: FastifyInstance, ctx: DaemonCtx): void {
  // ---- reads --------------------------------------------------------------
  app.get("/api/items", async (req, reply) => {
    try {
      const q = req.query as Record<string, string>;
      const ops = opsFor(ctx, q.ws);
      const items = ops.query({
        status: q.status as never,
        type: q.type,
        project: q.project,
        resource: q.resource,
        text: q.text,
        claimed: q.claimed === undefined ? undefined : q.claimed === "true",
      });
      return items.map((i) => ({
        ...i.meta,
        claim: i.claim,
        blocked: i.blocked,
        ready: i.ready,
        turn: i.turn,
      }));
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.get("/api/items/:id", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      const ops = opsFor(ctx, wsOf(req.query));
      return ops.brief(id.toUpperCase());
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.get("/api/next", async (req, reply) => {
    try {
      const ops = opsFor(ctx, wsOf(req.query));
      return ops.next(Number((req.query as { limit?: string }).limit ?? 10));
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.get("/api/graph", async (req, reply) => {
    try {
      const q = req.query as Record<string, string>;
      const ops = opsFor(ctx, q.ws);
      return {
        mermaid: ops.graph({
          roots: q.root ? [q.root] : undefined,
          depth: q.depth ? Number(q.depth) : undefined,
          filter: { status: q.status as never, project: q.project },
        }),
      };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.get("/api/findings", async (req, reply) => {
    try {
      return opsFor(ctx, wsOf(req.query)).findings();
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.get("/api/claims", async (req, reply) => {
    try {
      const ops = opsFor(ctx, wsOf(req.query));
      return [...ops.index.claims.values()];
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  /** Everything with turn=human: drafts, questions, reviews, stale/conflicted claims, findings. */
  app.get("/api/inbox", async (req, reply) => {
    try {
      const ops = opsFor(ctx, wsOf(req.query));
      const items = [...ops.index.items.values()];
      return {
        drafts: items.filter((i) => i.meta.status === "draft").map((i) => i.meta.id),
        questions: items
          .filter((i) => i.meta.status === "waiting" && i.meta.question)
          .map((i) => ({ id: i.meta.id, question: i.meta.question })),
        reviews: items.filter((i) => i.meta.status === "in_review").map((i) => i.meta.id),
        claims: [...ops.index.claims.values()].filter((c) => c.conflicted),
        findings: ops.findings(),
      };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  /** Sync status (SY-0001, RS-0004): plans repo ahead/behind, unsynced claims,
   * merged-but-not-pushed deliveries, pushes detected on fetch. */
  app.get("/api/sync", async (req, reply) => {
    try {
      const wsr = wsOf(req.query)
        ? ctx.workspaces.get(wsOf(req.query)!)
        : ctx.workspaces.size === 1
          ? ctx.workspaces.values().next().value
          : undefined;
      if (!wsr) throw new NotFoundError("no workspace registered on this machine");
      const { syncStatus } = await import("../sync/sync.js");
      return await syncStatus(wsr);
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  /** Markdown-folder import (IM-0001): dry-run preview or apply. */
  app.post("/api/import", async (req, reply) => {
    try {
      const b = req.body as { folder?: string; project?: string; apply?: boolean };
      if (!b.folder) throw new TeError("USAGE", "import needs {folder}");
      const ops = opsFor(ctx, wsOf(req.query));
      const { scanFolder } = await import("../../import/scan.js");
      const { planImport } = await import("../../import/import.js");
      const prefix = b.project
        ? ops.wsr.ws.config.projects[b.project]?.prefix
        : ops.wsr.ws.config.prefix;
      if (!prefix) throw new NotFoundError(`unknown project '${b.project}'`);
      const files = await scanFolder(b.folder);
      const existingLegacyIds = new Set(
        [...ops.index.items.values()]
          .map((i) => (i.meta as { legacy_id?: string }).legacy_id)
          .filter((x): x is string => Boolean(x)),
      );
      const plan = planImport(files, {
        prefix,
        existingIds: ops.index.items.keys(),
        existingLegacyIds,
      });
      if (!b.apply) {
        return { apply: false, preview: plan.preview, ambiguities: plan.ambiguities, count: plan.items.length };
      }
      const r = await ops.store.importItems(
        plan.items.map((i) => ({
          id: i.suggestedId,
          legacy_id: i.legacy_id,
          type: i.type,
          title: i.title,
          status: i.status,
          depends_on: i.depends_on,
          summary: i.summary,
          simple: i.simple,
          project: b.project,
        })),
        { kind: "human", session: "human", machine: ops.wsr.store.machine },
      );
      return { apply: true, ...r, ambiguities: plan.ambiguities };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  // ---- human actions -------------------------------------------------------
  const act = (
    path: string,
    fn: (ops: WorkspaceOps, id: string, body: Record<string, unknown>) => Promise<unknown>,
  ) =>
    app.post(`/api/items/:id/${path}`, async (req, reply) => {
      try {
        const { id } = IdParam.parse(req.params);
        const ops = opsFor(ctx, wsOf(req.query));
        return await fn(ops, id.toUpperCase(), (req.body ?? {}) as Record<string, unknown>);
      } catch (e) {
        return sendErr(reply, e);
      }
    });

  act("approve", (ops, id) => ops.approve(id));
  act("answer", (ops, id, b) => ops.answer(id, String(b.text ?? b.title ?? "answered")));
  act("accept", (ops, id) => ops.accept(id));
  act("reject", (ops, id, b) => ops.reject(id, b.reason ? String(b.reason) : undefined));
  act("drop", (ops, id, b) => ops.drop(id, b.reason ? String(b.reason) : undefined));
  act("claim", (ops, id) => ops.humanClaim(id));
  act("release", (ops, id, b) => ops.release(id, "human", b.note ? String(b.note) : undefined));
  act("rollback", (ops, id) => ops.rollback(id));

  app.post("/api/renumber", async (req, reply) => {
    try {
      const b = req.body as { old?: string; new?: string };
      if (!b.old || !b.new) throw new TeError("USAGE", "renumber needs {old,new}");
      return await opsFor(ctx, wsOf(req.query)).renumber(b.old, b.new);
    } catch (e) {
      return sendErr(reply, e);
    }
  });
}
