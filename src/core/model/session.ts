import { z } from "zod";

/** A registered agent instance: `claude-code@laptop#a1f3` (DESIGN §3). */
export const Session = z
  .object({
    id: z.string().min(1),
    agent: z.string().min(1),
    machine: z.string().min(1),
    connected_at: z.string(),
    last_seen: z.string(),
    /** PID of the local client process (the `te mcp` shim) — liveness probe. */
    pid: z.number().int().positive().optional(),
  })
  .passthrough();
export type Session = z.infer<typeof Session>;

/** A host running a daemon (`desktop`, `laptop`). */
export const Machine = z
  .object({
    name: z.string().min(1),
  })
  .passthrough();
export type Machine = z.infer<typeof Machine>;
