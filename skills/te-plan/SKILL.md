---
name: te-plan
description: Break a goal into TeamEngage tasks in a task-folder (overlay) workspace — choose epics, tasks, dependencies and parents, write acceptance criteria an agent can check, and create everything with one propose call. Use when asked to "plan", "break down", "write tasks for", "make a task plan", or to add tasks to the Tasks folder.
---

# te-plan — turn a goal into TeamEngage tasks

You are writing tasks that **other agents** will claim and execute, and that
the human will approve and accept. A good task can be picked up cold by an
agent that has never seen this conversation: it says what to change, where,
in what order relative to other work, and how to prove it is done.

The file format is fixed: see `te template` (or `docs/TASK-FORMAT.md` in the
teamengage repo). You never write task files by hand — `propose` renders them.

## 0. Connect

Plain HTTP with curl — no MCP needed:

```bash
B=http://127.0.0.1:4747/agent
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>","tier":"<light|standard|heavy>"}' | tee /dev/stderr | sed -n 's/^token //p')
H="X-TE-Session: $T"
```

Read the `hello` output: if it says the plans are **behind** — stop and ask
the human to pull first.

## 1. Understand before you split

- Read what exists: `curl -s "$B/query?text=<keywords>" -H "$H"`,
  `curl -s "$B/query?project=<p>" -H "$H"`, and `curl -s $B/brief/<id> -H "$H"`
  on anything related. Do **not** duplicate an existing item — depend on it,
  or note the overlap.
- Read the project folder's README / PHASE / MEGAPLAN files for conventions.
- Read the code you will point at. Acceptance criteria and `touches` must
  name real files, real commands, real test names.
- Unclear goal or a real design choice → `ask` the human (on a related item)
  or ask in chat **before** proposing. Don't encode a guess as a plan.

## 2. Shape the plan

**Epic or not?** Make an epic (`type: "epic"` → `PHASE-NN-…`) when the goal
has more than ~5 tasks, spans several repos, or has phases the human will
approve separately. Otherwise propose plain tasks.

**Size a task** so that one agent finishes it in one sitting:
- one coherent change, usually one repo (two when the change is a protocol
  both sides must ship together — then say so in the summary);
- independently verifiable — its acceptance list passes on its own;
- small enough to review: if the diff would be >~500 lines or touch
  unrelated areas, split it.

**Split by deliverable, not by activity.** "Add restart detection to
de_mavlink" is a task; "investigate", "write code", "write tests" are not
three tasks — tests are part of the acceptance of the task that needs them.
A genuine unknown is a `spike` task whose acceptance is a written answer
(a `## Notes` entry, a decision the human records).

## 3. Dependencies and parents

- `depends_on` = **hard ordering only**: B cannot start, or cannot pass its
  acceptance, until A is done (B calls code A adds, B's test needs A's
  fixture, B migrates data A's schema creates).
- Not a dependency: "related", "same area", "nicer after", "same epic".
  Use `parent` for grouping; mention related items in the summary.
- Prefer wide plans: independent tasks run in parallel on different agents.
  A long chain is a smell — check every edge.
- Cross-project edges are fine: depend on `GL-0019` from an `MP` task.
- No cycles. If two tasks need each other, they are one task or need a
  third that lands the shared interface first.
- `parent` = the epic id. Every task of an epic sets it.

Inside one propose call, refer to earlier items as `#0`, `#1`, … (0-based):
`"parent": "#0", "depends_on": ["#1"]`. Put prerequisites before the items
that need them.

## 3b. Planning from idea sources

Ideas (`type: "idea"`, `IDEA-*.md` files) are **source documents** — a
thought, brainstorm or spec the human captured. They are never claimed or
executed; an agent turns them into a plan when the human asks.

When the human points you at one or more ("plan from GL-0044 and GL-0047"):

1. Read each with `curl -s $B/brief/<id> -H "$H"` — the idea's whole task
   file is the spec.
2. Propose the plan as usual (epic + tasks).
3. Set `"relates": ["GL-0044", "GL-0047"]` on every item it grows from —
   the epic at minimum. The edge is **reference only**: no ordering, no
   gate. The idea's page then lists the plan under "referenced by".

Capturing a thought as an idea works the same way — an agent may
`propose { "type": "idea", "title": "…", "summary": "…" }` to save a
brainstorm for later planning.

## 4. Acceptance criteria an agent can check

Each `acceptance` entry is one observable, binary check — ideally a command
with an expected result. The agent will paste evidence for each on `submit`.

| Weak | Strong |
|---|---|
| works correctly | `ctest -R mission_restart` passes |
| handles rerun | a second AUTO run of the same mission fires every module event (SITL: `tests/rerun.sh`) |
| good performance | p95 frame time ≤ 20 ms on the Pi 4 recording path (`tools/frametime.sh`) |
| code is clean | `npm run lint` and `npm run typecheck` pass in `droneengage_webclient_react` |
| documented | `docs/PROTOCOL.md` lists message type 1094 with its fields |

Also include, when they apply: the regression suites that must stay green,
behaviour that must **not** change, and migration/compat checks for older
units or firmware.

## 5. Touches

`touches` lists `repo: path-glob` — where the work happens. It tells the
human and other agents what this task will change. Be as narrow as you can
honestly be (`droneengage_mavlink: src/mission/**`, not the whole repo).

## 5b. Tier — who should do it

Give each task the **least capable model that can do it well** — it saves
tokens, and the tier only goes up when attempts fail:

| `tier` | Typical work |
|---|---|
| `light` | mechanical, one file, exact instructions (rename, add a field, wire a flag, docs) |
| `standard` | a normal feature or fix across a few files — the default for coding |
| `heavy` | cross-cutting design, subtle concurrency/protocol logic, a task that already failed twice |

Leave it unset only when any model will do.

## 6. Propose

One call with the whole plan. Over HTTP:

```bash
curl -s -X POST $B/propose -H "$H" -d '{
  "items": [
    { "type": "epic", "project": "global", "title": "Mission re-run support",
      "summary": "Flying the same mission twice must behave like the first run." },
    { "project": "global", "parent": "#0", "depends_on": ["GL-0019"],
      "title": "TASK-14 — Clear latched events when a mission restarts", "tier": "standard",
      "summary": "When restart is detected (GL-0019), clear latched module events so the second run fires them again.",
      "touches": ["droneengage_mavlink: src/mission/**", "droneengage_comm: src/de_mission/**"],
      "acceptance": [
        "a second AUTO run of the same mission fires every module event again (SITL: tests/rerun.sh)",
        "jumping back to an earlier waypoint re-fires the events from that waypoint on",
        "ctest -R mission_restart passes"
      ],
      "simple": "If you fly the same mission again, the drone's add-ons react again." },
    { "project": "global", "parent": "#0", "depends_on": ["#1"],
      "title": "TASK-15 — Report restarts to the web client", "tier": "light",
      "touches": ["droneengage_webclient_react: src/js/mission/**"],
      "acceptance": ["the mission panel shows 'run 2' after a restart (manual check with SITL)",
                     "npm test passes in droneengage_webclient_react"] }
  ]
}'
```

The reply lists each new id and its file, e.g.
`proposed GL-0024 → global/TASK-14-clear-latched-events-when-a-mission-restarts.md`.

Field notes:
- `relates`: loose references — the idea(s) this item was generated from,
  or other source docs. Reference only, never ordering (§3b).
- `project` is the folder (`global`, `mission_planner`, `webclient`, …).
- `title`: imperative, specific. Keep the project's numbering style if it
  has one (`TASK-14 — …`); the file name gets its own number anyway.
- `summary`: what and why, with the facts an agent needs (functions, files,
  message ids). Longer background goes in `## Notes` later via `log` +
  additive edit.
- `simple`: add when the human will want a plain-English version (for an
  existing task: `curl -s -X POST $B/simple/<id> -H "$H" -d '{"text":"…"}'`).

## 7. After proposing

- Everything you propose is a **draft**. Tell the human the ids and the
  order you suggest approving them; they approve, reorder or drop.
  Exception — `autonomy: solo` (shown by `hello`): a task whose
  `depends_on` names an existing task lands `ready` (the reply lists it
  under `ready`). Epics and tasks with no dependency stay drafts. Say which
  landed ready so the human knows agents can pick them up now.
- Do not claim your own drafts, edit the `te:` line, or move files.
- Later refinements to a proposed file: additive only (`## Acceptance`,
  `## Notes`), each recorded with `log` — or rewrite the draft wholesale
  with `edit` (§9), which stays the preferred path for real changes.
  To execute tasks, see te-work.

## Example result

`global/TASK-14-clear-latched-events-when-a-mission-restarts.md`:

```markdown
---
te: GL-0025
---
# TASK-14 — Clear latched events when a mission restarts

**Depends on:** GL-0019
**Parent:** GL-0024
**Touches:** droneengage_mavlink: src/mission/**; droneengage_comm: src/de_mission/**

## Summary
When restart is detected (GL-0019), clear latched module events so the second run fires them again.

## Acceptance
- [ ] a second AUTO run of the same mission fires every module event again (SITL: tests/rerun.sh)
- [ ] jumping back to an earlier waypoint re-fires the events from that waypoint on
- [ ] ctest -R mission_restart passes

## Notes
```

plus `TASK-14-clear-latched-events-when-a-mission-restarts.simple.md` with
the plain-English line.

## 8. Vetting a light-authored draft

Drafts proposed by a `light`-tier session (hello lists them as `to vet`)
wait for a stronger session — even under `autonomy: solo`. When asked to
pick them up: read each one; fix what is wrong by proposing a corrected
task or adding to its `## Acceptance` (additive), then

```bash
curl -s -X POST $B/vet/GL-0031 -H "$H" -d '{"verdict":"ok","note":"acceptance checkable, tier standard right"}'
# or {"verdict":"issues","note":"acceptance 2 can't be tested — needs a concrete check"}
```

Under `solo` an `ok` approves it (→ ready); otherwise it marks it vetted for
the human.

## 9. Widening a draft's scope (rescope)

Scope is the human's — but when the human moves a task **back to draft**,
that is the go-ahead to change it. One call (planner tiers only, drafts only):

```bash
curl -s -X POST $B/rescope/GL-0061 -H "$H" -d '{
  "touches":["engine: checks.py","de_comm: src/sv_core.cpp","de_comm: tests/test_sv_core.cpp"],
  "add_acceptance":["test_sv_core passes"],
  "reason":"the fix needs the core filter, not only the engine check"}'
```

`touches` **replaces** the whole line — list the old paths too. `add_acceptance`
only appends. The task stays a draft; tell the human to approve it again.

For bigger rewrites — wrong title, different summary, a re-cut acceptance
list, new `depends_on`/`parent`, tier, domains, extra sections — use `edit`
instead (same gates: drafts only, planner tiers, a `reason` is required):

```bash
curl -s -X POST $B/edit/GL-0061 -H "$H" -d '{
  "reason":"human asked to split storage work out",
  "summary":"Rerun only the module-event latch, not storage rotation.",
  "acceptance":["second AUTO run re-fires module events","ctest -R mission_restart passes"],
  "depends_on":["GL-0019"], "parent":"GL-0024", "tier":"standard",
  "sections":{"Approach":"Reuse the restart flag path from TASK-13."}}'
```

Fields left out are unchanged; `acceptance` replaces the whole checklist,
`"parent":""` / `"tier":"any"` clear, `depends_on: []` clears. Managed
sections (## Notes/Review/Evidence/Handoff/Log/History) are refused.

A task that turned out stale, duplicated or superseded is not yours to
delete — flag it instead: `curl -s -X POST $B/flag_drop/GL-0061 -H "$H" -d
'{"reason":"superseded by GL-0070"}'`. The human sees it in the inbox and
drops or keeps it.
