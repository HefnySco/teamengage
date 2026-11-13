import { execFile } from "node:child_process";
import type { Event } from "../../core/model/event.js";
import type { ItemMeta } from "../../core/model/item.js";
import type { LoadedWorkspace } from "../../core/config/config.js";
import type { NotifyOn } from "../../core/model/workspace.js";
import type { Job } from "../../core/ops/job.js";
import { jobPlaybook } from "../../core/ops/job.js";
import type { Playbook } from "../../core/ops/playbook.js";

/**
 * Decision-event alerts (GL-0327): `notify:` rules in workspace.yaml fire on
 * events that need the human — never on routine actions, never fatally.
 * A `command` rule runs `sh -c <cmd>` with the event JSON on stdin; a `url`
 * rule POSTs the same JSON. One alert per event per matching rule.
 */

/** The notify kind a committed item event maps to — undefined = routine. */
export function notifyKind(
  ev: Event,
  meta: ItemMeta | undefined,
  maxAttempts: number,
): NotifyOn | undefined {
  if (ev.action === "ask" || ev.action === "peer_timeout") return "question";
  if (ev.action === "flag_drop") return "needs_human";
  if (ev.action === "review" && meta?.ai_review?.needs_human) return "needs_human";
  if (ev.to === "hold" && (meta?.attempts ?? 0) >= maxAttempts) return "max_attempts";
  return undefined;
}

/** A job that just parked on a gate step — its id, instruction and step id. */
export function gateWait(
  job: Job,
  playbook: Playbook,
): { step: string; instruction?: string } | undefined {
  if (job.status !== "waiting") return undefined;
  const spec = jobPlaybook(job, playbook).steps[job.cursor];
  return spec?.kind === "gate"
    ? { step: spec.id, ...(spec.instruction ? { instruction: spec.instruction } : {}) }
    : undefined;
}

/** Fire every rule matching `on`; each failure is logged, never thrown. */
export async function fireNotify(
  ws: LoadedWorkspace,
  on: NotifyOn,
  payload: object,
): Promise<void> {
  const body = JSON.stringify({ on, ...payload });
  for (const rule of ws.config.notify) {
    if (rule.on !== on) continue;
    try {
      if (rule.command) await runCommand(rule.command, body);
      else if (rule.url) await postUrl(rule.url, body);
    } catch (e) {
      process.stderr.write(`teamengaged: notify '${on}' failed: ${(e as Error).message}\n`);
    }
  }
}

function runCommand(command: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("sh", ["-c", command], { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err)
        reject(new Error(`'${command}' → ${err.message}${stderr ? ` — ${stderr.trim()}` : ""}`));
      else resolve();
    });
    // a command that exits before reading stdin EPIPEs — the exit reports it
    child.stdin?.on("error", () => {});
    child.stdin?.end(body);
  });
}

async function postUrl(url: string, body: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
}
