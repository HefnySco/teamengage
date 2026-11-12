---
name: te-ops
description: Run a TeamEngage ops playbook as an agent — find a playbook, start a job (only when the playbook allows agent starts), run `te ops exec`, write evidence for agent steps, and stop at gates. Use when asked to "run the deploy playbook", "do the ops job", "execute a playbook", or when a task tells you to run a named playbook. For task-bank work (claim, submit) use te-work.
---

# te-ops — run an ops playbook as an agent

Playbooks live in `<task folder>/ops/*.playbook.yaml`. They describe an
ordered run (deploy, sync, migration). The daemon records each job and
each step. Only `te ops exec` runs the commands — the daemon never runs
them.

**Writing rule — ASD-STE100, always.** Every `note`, `log` and evidence
text you post uses ASD-STE100: short sentences, one idea each, active
voice.

## Before you start

```bash
B=http://127.0.0.1:4747/agent
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>","tier":"standard"}' | sed -n 's/^token //p')
H="X-TE-Session: $T"
```

## 1. Find the playbook

```bash
curl -s "$B/ops_playbooks" -H "$H"
```

Each playbook shows `name`, `start`, `min_tier` and its steps.

- `start: human` → **stop**. Only the human starts it (`te ops start`
  or the Ops page). Tell the human and end here.
- `start: agent` → check `min_tier`. If your session tier is lower, a
  start is refused with `ERROR FORBIDDEN`. Tell the human.

## 2. Start the job

```bash
curl -s -X POST $B/ops_start -H "$H" -d '{"playbook":"<name>","params":{"<key>":"<value>"}}'
```

The reply is `started <job-id>`. Keep the job id.

- `ERROR OPS_TARGET_BUSY` → another job holds the target. Wait. Try
  again later. Do not abort a job that is not yours.
- `ERROR NOT_FOUND` → the playbook name is wrong. List again.
- `ERROR VALIDATION` → a required param is missing.

## 3. Run the steps

```bash
te ops exec <job-id>
```

`exec` runs each `cmd` and `check` step in order. Exit codes:

| Code | Means | Do |
|---|---|---|
| 0 | job succeeded or stopped | go to step 6 |
| 1 | a step failed | go to step 5 |
| 2 | waiting on an `agent` or `gate` step | go to step 4 |
| 3 | refused (order, changed playbook, busy target) | read the error; do not retry blind |

Re-run `te ops exec <job-id>` after each agent step you complete.

## 4. Agent and gate steps

`exit 2` prints the cursor step and its instruction.

- `agent` step → do the work the instruction describes. Then post the
  result:

  ```bash
  curl -s -X POST $B/ops_step/<job-id> -H "$H" \
    -d '{"step":"<step-id>","status":"passed","evidence":"<what you did and checked, in STE>"}'
  ```

  Write real evidence: what you changed, what you ran, what you saw.
- `gate` step → **stop**. Only the human approves it. Tell the human
  the job id and the instruction. Do not post a result for a gate —
  it is refused with `ERROR FORBIDDEN`.
- An optional step you cannot do → `ops_skip` with a real `reason`.
  A non-optional step is refused.

## 5. A step failed

- Transient cause → the human or you run `te ops resume <job-id>`,
  then `te ops exec <job-id>` again.
- A real defect in the product → do not retry. Propose a bug task:

  ```bash
  curl -s -X POST $B/propose -H "$H" -d '{"items":[{
    "title":"<what failed>","project":"<project>",
    "summary":"Ops job <job-id> failed at step <step-id>: <error line>",
    "touches":"<repo(s) the step command touches>",
    "acceptance":["<the step command passes>"]}]}'
  ```

  Put the job id in the summary so the human finds the step record and
  its output tail.

## 6. Check the end state

```bash
curl -s "$B/ops_job/<job-id>" -H "$H"
te ops status <job-id>
```

`succeeded` is the only clean end. `stopped` means a check with
`on_fail: stop` decided the run is not needed — that is a clean stop,
not a failure. `failed` goes back to step 5.

## 7. Apply a machine or playbook note

The human writes notes in their own words. TeamEngage keeps each note in
the file and opens a ready task "Apply note to machine <id>" or "Apply
note to playbook <name>". You turn the note into a YAML change. Claim,
work and submit the task as usual (te-work).

A note block looks like this:

```markdown
### note 2026-11-12T13:30:00.000Z · pending · DE-0150
the human's words
```

A machine note is under `## Human notes` in `machines/<id>.machine.md`.
A playbook note is in `ops/<name>.notes.md`.

Do this:

1. Read the note. Then read the whole file that you change: the machine
   file, or the playbook YAML. Also read `docs/OPS.md`, section
   "Machines and envs", for the fields.
2. Change only what the note asks. Do not tidy, reorder or reword other
   fields.
3. Put each fact in the right field:
   - a running service and its port → `apps:` (`name`, `port`, `env:
     prod|shadow`, `path`);
   - a folder and what it holds → `folders:` (`path`, `purpose`);
   - a database file → `databases:`;
   - "never …", "only …", "do not …" → `rules:`;
   - the agent or skill that handles the machine → `handled_by:`;
   - "X deploys to Y", "X is the shadow of Y", "X talks to Y" →
     `edges:` (`deploy` with `to: machine/app` and `repo:`, `shadow_of`,
     `talks_to`, `sync`);
   - "reachable from X only on network N" → a `reach` edge in the env
     file, not in the machine file. If the env file is not in your
     Touches, ask.
4. Write a rule as one short STE sentence, but keep the human's meaning.
   When you are not sure of the meaning, keep the human's words.
5. Never write a password, a token or key text into a file. If the note
   holds one, do not copy it. Ask the human to keep it outside the
   plans repo, and write only a reference (a key path, an env var name).
6. When the note is unclear, or has two meanings, `ask` on the task. Do
   not guess.
7. Keep the human's note text in the file. Change only its mark from
   `pending` to `applied`. Keep the timestamp and the task id:
   `### note <ts> · applied · <task id>`.
8. Run `te validate`. It must be clean.
9. Submit. Put the unified diff of the changed file in the walkthrough
   (`git diff --no-index` of a copy, or `diff -u old new`), so the human
   sees the exact YAML change.

For a playbook note, also:

- never change a `run:` command, remove a `gate` step or change
  `start: human`, unless the note asks for that change in clear words;
- a new step goes where the note says. When the note does not say, ask;
- a job pins the playbook sha256. Do not edit a playbook while a job of
  it is live (`te ops jobs`) — wait, or ask the human;
- the human accepts every playbook change. Auto-accept does not take
  this task.

## Never

- edit a playbook file while a job of it is live — later results are
  refused with `OPS_PLAYBOOK_CHANGED`;
- post a result for a step that is not at the cursor — `OPS_ORDER`;
- approve a gate — it is human-only;
- put a secret value in `evidence` or `output` — the record syncs to
  every machine;
- start a `start: human` playbook;
- run playbook commands yourself outside `te ops exec` — the record
  loses the step proof.
