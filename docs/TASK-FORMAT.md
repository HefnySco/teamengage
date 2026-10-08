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
| Plain-English companion | `<same name>.simple.md` | next to its task |

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
| `## Notes` | yes (may be empty) | Append-only working notes. |

## Who changes what

- **Agents** create task files only through `propose` and never by hand. In
  existing files they make additive edits only: append to `## Acceptance`
  or `## Notes`, and record each edit with `log`.
- **Agents never** touch the `te:` line, move files (e.g. into `done/`), or
  change status by editing a file. Status lives in TeamEngage.
- **The human** may edit anything and move files; TeamEngage follows moves
  by the `te:` tag.

## Cleaning up older files (target mapping)

| Older form | Becomes |
|---|---|
| `**Order:** after X` / `Blocked by: X` | `**Depends on:** X` |
| `X-simplified.md` | `X.simple.md` (both are read today) |
| `**Status:** …` lines, `done/` as the only status | status in TeamEngage (`te done`, accept) — remove the line |
| no acceptance list | `## Acceptance` with checkable items |
| repos named only in prose | a `**Touches:**` line |
| several tasks in one file | one file per task, the old file becomes the epic |
