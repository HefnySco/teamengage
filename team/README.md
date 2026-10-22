# team/ — your agent team is two commands

`te run` is the team. It needs two agent CLIs on this machine, set in
`~/.teamengage/machine.yaml`:

- a **coder**, which implements a task and submits it
- a **reviewer** (optional), which checks the submission against the task's
  acceptance before you see it

```yaml
name: work-pc
run:
  coder: devin -p --model swe-2-high --permission-mode accept-edits --
  reviewer: claude -p "$TE_PROMPT" --model sonnet --permission-mode acceptEdits --allowedTools Bash Read Edit Write Glob Grep
  concurrency: 1   # agents at once
  fix_rounds: 1    # an "issues" review goes back to the coder this many times
```

Use a different model for the reviewer than for the coder: the point is a
second opinion. Each command gets its prompt as the last argument, or
wherever you write `"$TE_PROMPT"`. Use `"$TE_PROMPT"` when a flag takes a
list of values, like Claude's `--allowedTools`, or the prompt ends up in
that list. Any CLI that takes a prompt and can run
`curl` and `git` works.

## What `te run` does

```
ready task ─▶ coder (claim → work → submit) ─▶ reviewer ─ ok ─────▶ you accept
                ▲                                  │                (solo: auto after 30m)
                └──── fix (fix_rounds times) ◀── issues
coder asks a question ─▶ you: te answer ─▶ next te run resumes it
```

It stops when only you can move things forward and prints what needs you.
Leave it running with `te run --watch`; in another terminal,
`te wait --notify` pings you when something needs you.

Agents still do every state change themselves over the daemon's HTTP
interface (`curl http://127.0.0.1:4747/agent`), with the same claims, target
locks and evidence as a session you start by hand. `te run` opens each
agent's session and closes it when the process exits. Work that was bounced
or abandoned goes back to `ready` and doesn't sit on a dead claim.

Agents need the `te-work` and `te-review` skills (`skills/`, linked during
install; see [AGENTS.md](../AGENTS.md)).

## Two machines

`te run` works on the machine you run it on. Before you leave:

```bash
te sync --leave
```

Unfinished tasks are released, with their work committed to their branches,
and everything is pushed. On the other machine, `te sync` and then `te run`
carry on from those branches.
