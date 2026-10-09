import { join, relative, sep } from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DaemonCtx, WorkspaceRuntime } from "../server/context.js";
import { WorkspaceOps } from "./ops.js";
import { TeError, NotFoundError } from "../../core/model/errors.js";
import { readTeTag, toSourcePath, globToRegExp } from "../../core/files/source.js";
import type { Ambiguity } from "../../import/import.js";

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
        archived: q.archived === "all" ? "all" : q.archived === "true",
        domain: q.domain || undefined,
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
      const qq = req.query as { limit?: string; domain?: string };
      return ops.next(Number(qq.limit ?? 10), qq.domain || undefined);
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
      const items = [...ops.index.items.values()].filter((i) => !i.meta.archived);
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

  /** Machine handoff: behind/ahead (after a fetch), uncommitted plans, other machines' claims. */
  app.get("/api/handoff", async (req, reply) => {
    try {
      const ops = opsFor(ctx, wsOf(req.query));
      const { handoffStatus, handoffLines } = await import("../sync/sync.js");
      const h = await handoffStatus(ops.wsr);
      return { ...h, lines: handoffLines(h) };
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
      const { scanFolder, importRoot, sourceKey, sourcesUnder } = await import("../../import/scan.js");
      const { planImport } = await import("../../import/import.js");
      const prefix = b.project
        ? ops.wsr.ws.config.projects[b.project]?.prefix
        : ops.wsr.ws.config.prefix;
      if (!prefix) throw new NotFoundError(`unknown project '${b.project}'`);
      let files = await scanFolder(b.folder);
      const root = importRoot(b.folder);
      const ws = ops.wsr.ws;
      const overlay = ws.config.mode === "overlay";
      const tagged: Ambiguity[] = [];
      let existingSources: Set<string>;
      let keyOf: (rel: string) => string;
      if (overlay) {
        // overlay: sources are workspace-relative, so the folder must be the
        // root or under it; a file already tagged `te:` is never re-imported
        const wsRoot = importRoot(ws.root);
        if (root !== wsRoot && !root.startsWith(wsRoot + sep)) {
          throw new TeError("USAGE", `overlay import folder must be inside the workspace root ${wsRoot}`);
        }
        keyOf = (rel) => toSourcePath(wsRoot, join(root, rel));
        // `ignore:` globs (root-relative) name .md files that are not tasks
        const ignore = ws.config.ignore.map(globToRegExp);
        files = files.filter((f) => !ignore.some((r) => r.test(keyOf(f.path))));
        existingSources = new Set();
        for (const i of ops.index.items.values()) {
          for (const s of [i.meta.source, i.meta.simple_source]) {
            const abs = s ? join(wsRoot, s) : undefined;
            if (abs?.startsWith(root + sep)) existingSources.add(relative(root, abs));
          }
        }
        for (const f of files) {
          const tag = readTeTag(f.content);
          if (!tag) continue;
          existingSources.add(f.path);
          if (!ops.index.get(tag)) {
            tagged.push({
              kind: "unknown_tag",
              message: `tagged te: ${tag}, which is not in this workspace — pull the plans first?`,
              file: f.path,
            });
          }
        }
      } else {
        // imported_from holds absolute (~/…) keys; map the ones under this
        // folder back to folder-relative paths so subfolder-then-parent
        // imports recognise files they already brought in
        keyOf = (rel) => sourceKey(root, rel);
        existingSources = sourcesUnder(
          root,
          [...ops.index.items.values()]
            .map((i) => i.meta.imported_from)
            .filter((x): x is string => Boolean(x)),
        );
      }
      const plan = planImport(files, {
        prefix,
        existingIds: ops.index.items.keys(),
        existingSources,
      });
      plan.ambiguities.push(...tagged);
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
          source: keyOf(i.sources[0]),
          simple_source: overlay && i.sources[1] ? keyOf(i.sources[1]) : undefined,
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
  act("undrop", (ops, id) => ops.undrop(id));
  act("complete", (ops, id, b) => ops.complete(id, b.note ? String(b.note) : undefined));
  act("hold", (ops, id, b) => ops.hold(id, b.reason ? String(b.reason) : undefined));
  act("unhold", (ops, id) => ops.unhold(id));
  act("draft", (ops, id, b) => ops.toDraft(id, b.reason ? String(b.reason) : undefined));
  act("archive", (ops, id, b) => ops.archive(id, b.reason ? String(b.reason) : undefined));
  act("unarchive", (ops, id) => ops.unarchive(id));
  act("delete", (ops, id, b) => ops.deleteItem(id, b.reason ? String(b.reason) : undefined));
  act("simple", (ops, id, b) => ops.simple(id, "human", String(b.text ?? "")));
  act("note", (ops, id, b) => ops.note(id, "human", String(b.text ?? "")));
  act("domains", (ops, id, b) => ops.setDomains(id, Array.isArray(b.domains) ? b.domains.map(String) : [], "human"));

  // ---- domains vocabulary --------------------------------------------------
  const route = (method: "GET" | "POST", path: string, fn: (ops: WorkspaceOps, req: { params: unknown; body: unknown; query: unknown }) => Promise<unknown>) =>
    app.route({
      method,
      url: path,
      handler: async (req, reply) => {
        try {
          return await fn(opsFor(ctx, wsOf(req.query)), req);
        } catch (e) {
          return sendErr(reply, e);
        }
      },
    });
  route("GET", "/api/domains", (ops) => ops.domains());
  route("POST", "/api/domains", (ops, req) => {
    const b = (req.body ?? {}) as { name?: string; description?: string; color?: string; keywords?: unknown };
    if (!b.name) throw new TeError("USAGE", "domain needs {name}");
    const keywords = Array.isArray(b.keywords) ? b.keywords.map(String) : typeof b.keywords === "string" ? b.keywords.split(",") : undefined;
    return ops.defineDomain(b.name, { description: b.description, color: b.color, keywords });
  });
  route("POST", "/api/domains/:name/rename", (ops, req) => {
    const to = String(((req.body ?? {}) as { to?: string }).to ?? "");
    if (!to) throw new TeError("USAGE", "rename needs {to}");
    return ops.renameDomain(String((req.params as { name: string }).name), to);
  });
  route("POST", "/api/domains/:name/delete", (ops, req) => ops.deleteDomain(String((req.params as { name: string }).name)));
  route("GET", "/api/domains/suggest", (ops) => ops.suggestDomains());
  route("POST", "/api/domains/suggest/apply", (ops, req) => {
    const ids = ((req.body ?? {}) as { ids?: unknown }).ids;
    return ops.applySuggestions(Array.isArray(ids) ? ids.map(String) : undefined);
  });
  act("claim", (ops, id) => ops.humanClaim(id));
  act("release", (ops, id, b) => ops.release(id, "human", b.note ? String(b.note) : undefined));
  act("rollback", (ops, id, b) => ops.rollback(id, b.force === true));

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
