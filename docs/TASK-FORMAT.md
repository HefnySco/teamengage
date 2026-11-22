# Task-file format

The standard for task files in an overlay workspace (a Markdown task folder
tracked in place, DESIGN §9.1). `propose` writes new files in this format,
`te template` prints a filled-in example, and it is the **target format** for
cleaning up older task files. The renderer is `src/core/files/template.ts` —
this page and that code must agree.

## File names

| What | Name | Where |
|---|---|---|
| Task (also bug, spike, review, wish) | `TASK-<NN>-<slug>.md` | the project folder (`projects.<p>.path`, default the project name) |
| Epic | `PHASE-<NN>-<slug>.md` (existing `*-MEGAPLAN.md` files stay valid) | same |
| Idea | `IDEA-<NN>-<slug>.md` | same |
| Discussion | `DISC-<NN>-<slug>.md` | same |
| Discussion transcript | `<same name>.transcript.md` | next to its discussion |
| Plain-English (STE) version | `## Simple` section in the task file (legacy: `<same name>.simple.md` companion, still read) | in the task file |

- `NN` is one above the highest number used anywhere under the project
  folder, `done/` included, and above any number an item still records —
  numbers are never reused. Two digits minimum.
- `slug`: the title in lowercase ASCII words joined by `-`, at most 48
  characters.
- Workspace-level items (no project) live in the root.

## Content

```markdown
---
te: GL-0024
---
# TASK-14 — Clear latched events when a mission restarts

**Depends on:** GL-0019
**Parent:** GL-0003
**Touches:** droneengage_mavlink: src/mission/**; droneengage_comm: src/de_mission/**

## Summary
When TASK-13 detects a mission restart, latched module events from the
previous run must be cleared so the second run fires them again.

## Acceptance
- [ ] a second AUTO run of the same mission fires every module event again (SITL: tests/rerun.sh)
- [ ] jumping back to an earlier waypoint re-fires the events from that waypoint on
- [ ] unit test for the restart handler passes: ctest -R mission_restart

## Checks
- name: unit tests
  repo: droneengage_mavlink
  run: ctest -R mission_restart
  timeout: 120
  expect_exit: 0

## Artifacts
- andruav/an0133-v2-sms.png — SMS tab mockup
- mission_planner/mp0409-fence.png — geofence editor mockup #mission-planner !sensitive

## Notes
```

| Part | Required | Rules |
|---|---|---|
| `te:` frontmatter | yes (added by TeamEngage) | One line. Never edit or remove it — it is how the item survives renames and moves. |
| `# Title` | yes | First heading. What the importer and the board show. |
| `**Depends on:**` | yes | Item ids (or legacy `TASK-NN` names) separated by `,`, or `nothing`. Only hard ordering — see the te-plan skill. |
| `**Parent:**` | if it belongs to an epic | The epic's id. |
| `**Touches:**` | yes | `repo: path-glob` entries separated by `;`. `TBD` until known. |
| `## Summary` | yes | What and why, technical. More sections (Background, Design, …) may follow it. |
| `## Acceptance` | yes | `- [ ]` checklist. Each line observable and checkable by an agent: a command, a test, a measurable behaviour. |
| `## Artifacts` | yes (may be empty) | Managed — `edit` refuses it, like `## Notes`. One attached file per line: `- <path> — <caption> [#domain ...] [!sensitive]`. The path is under `.artifacts/` for attached files (example: `- andruav/an0133-v2-sms.png — SMS tab mockup`), or repo-relative for a file written next to the item (example: a discussion's `X.transcript.md` sidecar). Every declared path opens through `/api/artifacts/file?path=…`. #tags are the artifact's own domains; a line without one takes the item's domains. `!sensitive` marks a file with private data. Written by `attach`/`capture`, never by hand. |
| `## Notes` | yes (may be empty) | Append-only working notes. |
| `**Relates:**` | optional | Loose references — e.g. the `IDEA-` source doc(s) the work was generated from. Reference only, never ordering. |
| `## Checks` | optional | Machine checks (GL-0348): a YAML list of `{name, repo, run, timeout, expect_exit}`. `te verify` runs each `run` in `repo` (must be named in `**Touches:**`), `timeout` in seconds, `expect_exit` defaults to 0. Written by `propose`/`edit` (`checks` argument); `te validate` reports a check with no run, a repo outside Touches and a duplicate name. |

Agent-written text — the title, `## Summary`, `## Acceptance`, `## Notes`
and the `## Simple` version — is written in ASD-STE100 Simplified
Technical English (STE): short sentences, active voice, plain approved
words used consistently. See the WRITING rules in `te agents-md`.

An **idea** file is lighter: `# Title`, an optional `**Relates:**` line,
`## Summary`, `## Notes` — no `**Depends on:**`, `**Parent:**`,
`**Touches:**` or `## Acceptance`. It is a source document, not work.

A **discussion** file saves a chat between the human and an agent (a
planning or review chat). It is a source document like an idea: it is never
claimed, and its derived state (`ready`, `done`) comes from the items
that name it in `**Relates:**` — `done` when every live referrer is,
`ready` otherwise. It has two layers:

1. The distilled layer — the `DISC-<NN>-<slug>.md` file itself, written by
   the agent in STE. `# Title`, an optional `**Relates:**` line, then these
   fixed `##` sections in order: `## Summary`, `## Participants`,
   `## Context`, `## Key points`, `## Decisions reached`,
   `## Open questions`, `## Guidelines`, `## Actions`, `## Artifacts`,
   `## Notes`.
2. The raw transcript — `<same name>.transcript.md` next to it, written by
   `capture`. It is part of the item (the discussion links it in
   `## Artifacts`), never a task file of its own: import and the
   untracked-file check skip it.

## Who changes what

- **Agents** create task files only through `propose` and never by hand. In
  existing files they make additive edits only: append to `## Acceptance`
  or `## Notes`, and record each edit with `log`.
- **Agents may rewrite a draft wholesale, but only through the `edit`
  tool** (planner tiers): title, `**Depends on:**`, `**Parent:**`,
  `**Touches:**` and `##` sections — the item stays a draft for the human
  to re-approve. Hand-edits to those header lines are not picked up as
  state changes.
- **Agents never** touch the `te:` line, move files (e.g. into `done/`), or
  change status by editing a file. Status lives in TeamEngage.
- **The human** may edit anything and move files; TeamEngage follows moves
  by the `te:` tag. `**Depends on:**` / `**Parent:**` are best changed with
  `te deps` / the item page — those keep the tracked meta and the line in
  sync (meta is the source of truth; editing the line alone does nothing).

## Cleaning up older files (target mapping)

| Older form | Becomes |
|---|---|
| `**Order:** after X` / `Blocked by: X` | `**Depends on:** X` |
| `X-simplified.md` | `X.simple.md` (both are read today) |
| `**Status:** …` lines, `done/` as the only status | status in TeamEngage (`te done`, accept) — remove the line |
| no acceptance list | `## Acceptance` with checkable items |
| repos named only in prose | a `**Touches:**` line |
| several tasks in one file | one file per task, the old file becomes the epic |
