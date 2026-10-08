import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "./ops.js";
import type { WorkspaceRuntime } from "../server/context.js";
import { targetsOverlap } from "../../core/claims/claims.js";
import { parseItemFile } from "../../core/files/markdown.js";
import { ClaimRefusedError, ConflictError, InvalidTransitionError } from "../../core/model/errors.js";

/**
 * MC-0006: N=8 agents racing through next → claim → log → submit against a
 * 60-item fixture. Invariants: no item claimed twice concurrently, no
 * overlapping live target claims, all files parse, linear git history,
 * event count = commit count. (In-process equivalent of N shim processes —
 * the serialized store queue is what's under test.)
 */

const N_ITEMS = 60;
const N_AGENTS = 8;

let home: string;
let plans: string;
let wsr: WorkspaceRuntime;
let ops: WorkspaceOps;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-swarm-"));
  const root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  mkdirSync(join(plans, "claims"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    "name: ws\nprefix: WS\nsync: manual\nresources:\n  self: { kind: git, path: ., worktree: false }\n",
  );
  // 4 hot target files → heavy overlap contention between agents
  for (let i = 1; i <= N_ITEMS; i++) {
    const id = `WS-${String(i).padStart(4, "0")}`;
    const f = `src/f${(i - 1) % 4}.ts`;
    writeFileSync(
      join(plans, "items", "WS", `${id}.md`),
      `---\nid: ${id}\ntype: task\ntitle: item ${i}\nstatus: ready\nversion: 1\ntargets: ["@self:${f}"]\n---\n\n## Summary\nx\n`,
    );
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });

  const ws = resolveWorkspace(root, { home });
  const store = new PlansStore(ws, "swarm");
  await store.init();
  wsr = { ws, store };
  ops = new WorkspaceOps(wsr, new SessionRegistry("swarm"), undefined, home);
}, 30_000);

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("agent swarm (MC-0006)", () => {
  it(
    "8 concurrent agents claim/log/submit without violating invariants",
    async () => {
      const done = new Set<string>();
      const errors: unknown[] = [];
      const violations: string[] = [];
      let contention = 0;
      const checkLive = () => {
        const live = [...wsr.store.idx.claims.values()];
        for (let a = 0; a < live.length; a++) {
          for (let b = a + 1; b < live.length; b++) {
            if (targetsOverlap(live[a].targets, live[b].targets).overlap) {
              violations.push(`${live[a].item} vs ${live[b].item}`);
            }
          }
        }
      };

      const agent = async (n: number) => {
        const { session } = ops.hello(`agent-${n}`);
        while (done.size < N_ITEMS) {
          const candidates = ops.next(10).filter((i) => !done.has(i.meta.id));
          if (!candidates.length) {
            await new Promise((r) => setTimeout(r, 5));
            if (done.size >= N_ITEMS) break;
            continue;
          }
          // pick a random candidate — always taking [0] means every agent
          // herds onto the same item and the claim race never triggers
          const it = candidates[Math.floor(Math.random() * candidates.length)];
          try {
            await ops.claim(it.meta.id, session);
            checkLive(); // probe: no two live claims may overlap right now
            await ops.log(it.meta.id, session, "working");
            await ops.submit(it.meta.id, session, { notes: "done" });
            done.add(it.meta.id);
          } catch (e) {
            // claim refused / CAS retry / submit-after-accept — expected
            // contention; anything else is a real bug and must fail below
            if (
              !(e instanceof ClaimRefusedError) &&
              !(e instanceof ConflictError) &&
              !(e instanceof InvalidTransitionError)
            ) {
              errors.push(e);
            } else {
              contention++;
            }
          }
        }
      };

      // the human side: accepts in_review items, freeing claims + targets
      const acceptor = async () => {
        while (done.size < N_ITEMS || [...wsr.store.idx.items.values()].some((i) => i.meta.status === "in_review")) {
          for (const i of wsr.store.idx.items.values()) {
            if (i.meta.status === "in_review") await ops.accept(i.meta.id).catch(() => {});
          }
          await new Promise((r) => setTimeout(r, 2));
        }
      };

      await Promise.all([...Array.from({ length: N_AGENTS }, (_, i) => agent(i)), acceptor()]);

      expect(errors).toEqual([]);
      expect(violations).toEqual([]);
      // contention actually happened — otherwise the race invariants mean nothing
      expect(contention).toBeGreaterThan(0);
      // every item was processed exactly once and is done
      expect(done.size).toBe(N_ITEMS);
      const claims = [...wsr.store.idx.claims.values()];
      for (const i of wsr.store.idx.items.values()) {
        expect(i.meta.status).toBe("done");
      }
      expect(claims).toEqual([]); // all claims freed by accept
      // no overlapping live target claims
      for (let a = 0; a < claims.length; a++) {
        for (let b = a + 1; b < claims.length; b++) {
          const o = targetsOverlap(claims[a].targets, claims[b].targets);
          expect(o.overlap, `${claims[a].item} vs ${claims[b].item}`).toBe(false);
        }
      }
      // all item files still parse
      for (const f of readdirSync(join(plans, "items", "WS"))) {
        const p = join(plans, "items", "WS", f);
        expect(() => parseItemFile(readFileSync(p, "utf8"), p), f).not.toThrow();
      }
      // linear history, one commit per mutation; event count = commit count
      const commits = Number(
        execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: plans, encoding: "utf8" }).trim(),
      );
      const eventDir = join(plans, "events", "swarm");
      const eventFiles = readdirSync(eventDir).filter((f) => f.endsWith(".jsonl"));
      const events = eventFiles.reduce(
        (n, f) =>
          n +
          readFileSync(join(eventDir, f), "utf8").trim().split("\n").filter(Boolean).length,
        0,
      );
      expect(commits - 1).toBe(events); // minus the seed commit
    },
    60_000,
  );
});
