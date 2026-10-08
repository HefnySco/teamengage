import type { FastifyInstance, FastifyReply } from "fastify";
import type { Event } from "../../core/model/event.js";

/**
 * Live event stream (DM-0006): `GET /events` as Server-Sent Events. Every
 * committed event is pushed to all connected clients; `Last-Event-ID` resumes
 * from the in-memory replay buffer. Event ids are `machine|ts|seq`.
 */

export function eventId(e: Event): string {
  return `${e.machine}|${e.ts}|${e.seq ?? 0}`;
}

export class EventBus {
  private clients = new Set<FastifyReply>();
  private buffer: Event[] = [];

  constructor(private bufferSize = 2000) {}

  publish(e: Event): void {
    this.buffer.push(e);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    for (const reply of this.clients) this.send(reply, e);
  }

  /** Other findings/notifications the inbox should react to. */
  notify(kind: string, data: Record<string, unknown>): void {
    for (const reply of this.clients) {
      reply.raw.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  private send(reply: FastifyReply, e: Event): void {
    reply.raw.write(`id: ${eventId(e)}\ndata: ${JSON.stringify(e)}\n\n`);
  }

  /** Attach an SSE client; replays events after Last-Event-ID when given. */
  attach(reply: FastifyReply, lastEventId?: string): void {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write("retry: 3000\n\n");
    if (lastEventId) {
      const i = this.buffer.findIndex((e) => eventId(e) === lastEventId);
      for (const e of this.buffer.slice(i === -1 ? this.buffer.length : i + 1)) {
        this.send(reply, e);
      }
    }
    this.clients.add(reply);
    reply.raw.on("close", () => this.clients.delete(reply));
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export function registerEventRoutes(app: FastifyInstance, bus: EventBus): void {
  app.get("/events", async (req, reply) => {
    const last = req.headers["last-event-id"];
    bus.attach(reply, Array.isArray(last) ? last[0] : last);
    return reply; // keep the connection open
  });
}
