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
  return new WorkspaceOps(wsr, ctx.sessions, wsr.links);
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
