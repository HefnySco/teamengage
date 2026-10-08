import { z } from "zod";

/**
 * Append-only event record, one JSONL stream per machine
 * (`events/<machine>/<YYYY-MM>.jsonl`, DESIGN §3, §6.5).
 */
export const Event = z
  .object({
    /** Monotonic sequence within the machine stream; also the SSE id. */
    seq: z.number().int().optional(),
    ts: z.string(),
    machine: z.string(),
    /** Session id or `human`. */
    actor: z.string(),
    session: z.string().optional(),
    item: z.string().optional(),
    action: z.string(),
    from: z.string().optional(),
    to: z.string().optional(),
    note: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type Event = z.infer<typeof Event>;
