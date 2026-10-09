---
name: te-work
description: Implement, continue or pick up a task from a TeamEngage-tracked task bank (e.g. drone_engage/Tasks) — find it, claim it, do the work, ask when unsure, and submit with evidence, all over plain curl (no MCP). Use when asked to "implement TASK-13", "work on GL-0019", "do the next task", "continue the task", "pick up a task", or when a task file under Tasks/ is the thing to execute. For breaking a goal into new tasks use te-plan instead.
---

# te-work — execute a task through TeamEngage

The task bank is shared with the human and with other agents (Claude Code,
Devin, Gemini, …) on this and other machines. TeamEngage records who is
working on what. Work **only** through it: claim before you touch code, hand
back with evidence, and let the human decide when something is done.

Everything is plain HTTP on the local daemon — no MCP needed:

```bash
B=http://127.0.0.1:4747/agent
curl -s $B            # full protocol + examples, if you need it
```

## 1. Start a session

```bash
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>"}' | tee /dev/stderr | sed -n 's/^token //p')
H="X-TE-Session: $T"
```

Read every line `hello` prints before going on:

| Line | Do |
|---|---|
| `plans behind … — STOP` | Stop. Ask the human to pull the Tasks repo, then `hello` again. |
| `resume: GL-0019` | You already hold that task (earlier session) — continue it, don't claim another. |
| `held on laptop: …` | That task is being worked on elsewhere — leave it. |
| `rules: …` | The rules. They are enforced. |

Keep `$T` for the whole task. After a daemon restart, `hello` again — your
claims come back to the new session.

## 2. Find the task

- The human named one: an id (`GL-0019`) → use it. A legacy name or file
  (`TASK-13`, `global/TASK-13-mission-rerun-reset.md`) → the id is the
  `te:` line at the top of that file, or search:
  `curl -s "$B/query?text=mission%20rerun" -H "$H"`.
- "Do the next one" → `curl -s $B/next -H "$H"` and take the first id,
  unless the human said otherwise.

## 3. Read the brief

```bash
curl -s $B/brief/GL-0019 -H "$H"
```

You get the task file itself (summary, `**Touches:**`, `## Acceptance`),
dependency status, decisions already made, and resolved targets.

- A dependency not `done` → don't start; tell the human which one blocks.
- Status `draft` or `hold` → not approved for agents; tell the human.
- Read the repo's own `AGENTS.md` for every repo the task touches.

## 4. Claim

```bash
curl -s -X POST $B/claim/GL-0019 -H "$H"
```

- Refused (`claimed on … by …`, target locked) → do **not** work on it.
  Report who holds it and pick something else only if the human agrees.
- The reply may return worktree paths — work there, not in the main checkout.
- Work only inside what `**Touches:**` / the claim names. Something outside
  that is needed → `ask` first.

## 5. Work

- Follow the task's own steps and the touched repos' rules (naming, build,
  commit style). Commit in the code repos as those rules say.
- `log` at real milestones (not every step) — it is the human's record:

  ```bash
  curl -s -X POST $B/log/GL-0019 -H "$H" -d '{"note":"restart detection in handleMissionCurrentCount; unit test green"}'
  ```

- Learned something the task file should keep? Append it under `## Notes`
  (or a new `## Acceptance` item) — additive only, never rewrite existing
  lines, never touch the `te:` line — and `log` that you did.

### Plain-English version

Asked for a "simple" version (or the task has none and the human wants one)?
Write it with the tool — never create `X.simple.md` by hand:

```bash
curl -s -X POST $B/simple/GL-0019 -H "$H" -d '{"text":"If you fly the same mission twice, the add-ons now react the second time too."}'
```

It creates (or replaces) the companion file next to the task, tags and links
it, and the web page shows it under "simple". No claim needed.

## 6. Unsure? Ask — don't guess

```bash
curl -s -X POST $B/ask/GL-0019 -H "$H" -d '{"question":"Reset de_comm dedup on restart too, or only de_mavlink?","options":["both","de_mavlink only"]}'
```

The task goes to `waiting` and it is the human's turn. Stop working on it
and tell the human there is a question. When it is answered the task comes
back to you (`brief` shows the decision).

## 7. Prove it, then submit

Go through `## Acceptance` one item at a time and actually run each check.
Then submit with the evidence:

```bash
curl -s -X POST $B/submit/GL-0019 -H "$H" -d '{
  "commits": ["droneengage_mavlink@3f2a1c9", "droneengage_comm@8be0d14"],
  "tests": "ctest -R mission_restart: 4/4 passed; SITL tests/rerun.sh: second AUTO run fired all 6 module events",
  "notes": "acceptance 1–3 verified as above; de_comm dedup reset behind the new restart flag"
}'
```

Then tell the human it is in review. An acceptance item you could not verify
→ say so in `notes` (and why); never claim it passed.

## 8. Giving it back

Can't finish (blocked, out of time, wrong approach)? Release it with what
you learned so the next agent starts from there:

```bash
curl -s -X POST $B/release/GL-0019 -H "$H" -d '{"note":"blocked: needs firmware ≥4.5 for mission_mode; branch kept"}'
```

## Never

- mark a task done, approve, or accept — the human does;
- `git push`, or move files (into `done/` or anywhere);
- edit files under `Tasks/.teamengage/` or a task's `te:` line;
- start without a claim, or keep working after `ask` until it is answered;
- create task files by hand — new work found along the way → `propose`
  (see te-plan) and mention it in your `log`.

In Claude Code these rules are enforced by a guard hook; a refused edit
comes back with the reason — follow it rather than working around it.
