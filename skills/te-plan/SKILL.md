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
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>"}' | tee /dev/stderr | sed -n 's/^token //p')
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

## 6. Propose

One call with the whole plan. Over HTTP:

```bash
curl -s -X POST $B/propose -H "$H" -d '{
  "items": [
    { "type": "epic", "project": "global", "title": "Mission re-run support",
      "summary": "Flying the same mission twice must behave like the first run." },
    { "project": "global", "parent": "#0", "depends_on": ["GL-0019"],
      "title": "TASK-14 — Clear latched events when a mission restarts",
      "summary": "When restart is detected (GL-0019), clear latched module events so the second run fires them again.",
      "touches": ["droneengage_mavlink: src/mission/**", "droneengage_comm: src/de_mission/**"],
      "acceptance": [
        "a second AUTO run of the same mission fires every module event again (SITL: tests/rerun.sh)",
        "jumping back to an earlier waypoint re-fires the events from that waypoint on",
        "ctest -R mission_restart passes"
      ],
      "simple": "If you fly the same mission again, the drone's add-ons react again." },
    { "project": "global", "parent": "#0", "depends_on": ["#1"],
      "title": "TASK-15 — Report restarts to the web client",
      "touches": ["droneengage_webclient_react: src/js/mission/**"],
      "acceptance": ["the mission panel shows 'run 2' after a restart (manual check with SITL)",
                     "npm test passes in droneengage_webclient_react"] }
  ]
}'
```

The reply lists each new id and its file, e.g.
`proposed GL-0024 → global/TASK-14-clear-latched-events-when-a-mission-restarts.md`.

Field notes:
- `project` is the folder (`global`, `mission_planner`, `webclient`, …).
- `title`: imperative, specific. Keep the project's numbering style if it
  has one (`TASK-14 — …`); the file name gets its own number anyway.
- `summary`: what and why, with the facts an agent needs (functions, files,
  message ids). Longer background goes in `## Notes` later via `log` +
  additive edit.
- `simple`: add when the human will want a plain-English version.

## 7. After proposing

- Everything you propose is a **draft**. Tell the human the ids and the
  order you suggest approving them; they approve, reorder or drop.
- Do not claim your own drafts, edit the `te:` line, or move files.
- Later refinements to a proposed file: additive only (`## Acceptance`,
  `## Notes`), each recorded with `log`. To execute tasks, see te-work.

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
