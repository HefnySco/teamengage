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
    /** declared model tier (light|standard|heavy); unset = not tier-limited */
    tier: z.enum(["light", "standard", "heavy"]).optional(),
    /** what this session is here to do; unset = general worker (GL-0323) */
    role: z.enum(["planner", "coder", "reviewer", "ops"]).optional(),
    /** declared model id, lowercased (e.g. claude-sonnet-5-5) — GL-0360 */
    model: z.string().optional(),
    /** free-text label — the task id this session works on (GL-0364) */
    label: z.string().optional(),
  })
  .passthrough();
export type Session = z.infer<typeof Session>;

/**
 * The name part of a session id. Ids mint as `<name>@<machine>#<hex>`; a
 * client that sends a previous session id, or a name already carrying
 * "@<machine>", gets it cut at the first "@" or "#" (TE-0193).
 */
export function normalizeAgentName(agent: string): string {
  const cut = agent.search(/[@#]/);
  return (cut === -1 ? agent : agent.slice(0, cut)) || "agent";
}

/**
 * Does session id `holder` belong to `agent` on `machine`? Ids minted before
 * TE-0193 can repeat the machine part (`devin@box@box#1a2b`); they still
 * count as that agent's on that machine.
 */
export function sessionIdMatches(holder: string, agent: string, machine: string): boolean {
  const parts = holder.split("#", 1)[0].split("@");
  return parts[0] === normalizeAgentName(agent) && parts.length > 1 && parts.slice(1).every((p) => p === machine);
}

/** A host running a daemon (`desktop`, `laptop`). */
export const Machine = z
  .object({
    name: z.string().min(1),
  })
  .passthrough();
export type Machine = z.infer<typeof Machine>;
