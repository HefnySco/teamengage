---
name: te-review
description: Peer-review a TeamEngage task another session submitted — list what is waiting (query status=in_review), verify it against the task's acceptance criteria (read the diff, run the checks), then record an advisory verdict (review ok|issues) or bounce clearly broken work back to its holder, all over plain curl (no MCP). Use when asked to "review GL-0019", "check the review queue", "pre-review", "second opinion before I accept". Never for a task you submitted yourself.
---

# te-review — peer-review another session's submission

A second pair of eyes before the human looks. You are the reviewer — **not** the
holder of the claim and **not** the decider. What you produce is a verdict + note
the human reads, or a bounce reason the submitter reads. Final accept stays with
the human.

## 1. Start a session

Same as te-work. Plain HTTP, nothing else needed. If `te` is not found or the
daemon is not running, tell the user and stop.

```bash
B=http://127.0.0.1:4747/agent
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>"}' | tee /dev/stderr | sed -n 's/^token //p')
H="X-TE-Session: $T"
```

The hello output shows workspace + your claims, then the full protocol — the
same rules as implementing (plans behind on push → `git pull` first; 409 →
someone else is doing it).

## 2. Find submissions to review

```bash
curl -s "$B/query?status=in_review" -H "$H"
# → GL-0019 in_review "fix the restart edge case"  #cpp held:gemini-cli@dev-desktop#77b0
```

- The human usually names the task — use that id. If they said "review what's
  waiting", list the queue and pick one (say which).
- `held:<agent>` is the **submitter**. If it is your own session — skip it;
  you can never review your own submission (the daemon refuses).
- An item already showing `ai_review:` in its brief was reviewed once — your
  verdict would replace the marker, so only re-review if you actually re-check
  everything. Don't stack opinions.

## 3. Read the brief and the record

```bash
curl -s $B/brief/GL-0019 -H "$H"
```

You get: the task's summary, `## Acceptance`, dep statuses, resolved target
paths (the claim's **worktrees** — where the submitted work lives), and an
`ai_review:` line if a verdict exists.

Then read the submission record — the item file
`.teamengage/items/<XX>/<id>.md` inside the task folder. `## Evidence` is what
the submitter says they did (commits, tests, notes), `## Review` the earlier
verdicts, `## Log` the full history. Reading `.teamengage/` files is fine —
just never edit them.

## 4. Actually verify it

The note is only worth what you checked:

- **For each `## Acceptance` line** — find the change and confirm it. In each
  target worktree/branch from brief: `git log` / `git diff` the claim's branch
  against its base. The diff should implement what the task says — and stay
  inside `**Touches:**`. Scope creep or half-done acceptance = issues.
- **Run what is runnable** — build, tests, whatever Evidence claims was run.
  Reproduce it if you can; "claimed" is not "passed".
- **What you cannot verify is a finding, not a skip** — if a check needs
  hardware or a deploy you don't have, say so in the note rather than passing
  it silently.
- **Never edit the code.** The claim and its worktree belong to the holder.
  Review is read-only — found a bug, report it; the holder fixes it.

## 5. Record the verdict

```bash
curl -s -X POST $B/review/GL-0019 -H "$H" \
  -d '{"verdict":"ok","note":"acceptance 1–3 verified; restarted with --debug twice, counter survives; ctest 4/4 green on the claim branch; diff confined to **Touches:**"}'
```

- `ok` — verified, ready for the human to accept. The note is the whole value:
  what you ran, what passed, over which diff. `"looks fine"` tells the human
  nothing.
- `issues` — verified concerns the human should weigh before deciding (or
  checks you couldn't run). The item stays in review.

A clearly broken submission — acceptance not met, tests never run, spec
ignored — goes back to the holder rather than leaving the human to reject it:

```bash
curl -s -X POST $B/bounce/GL-0019 -H "$H" \
  -d '{"reason":"acceptance 2 unimplemented — restart flag ignored; Evidence lists no test run"}'
```

`bounce` moves the item to `in_progress` **keeping the same claim** — the
holder reads the reason in `brief`/`## Review`, fixes, and `submit`s again.
Write the reason for the holder: specific, actionable. After two bounces in a
row a third is refused — the item stays in review and the human decides; just
record a `review` verdict.

Tell the human the outcome: _"GL-0019 reviewed ok"_ or _"GL-0019 bounced —
acceptance 2 unimplemented"_.

## Never

- review or bounce **your own** submission — refused anyway; second opinions only;
- accept, reject, or treat your verdict as a status — it changes nothing; the human accepts;
- claim the task or touch its worktree while reviewing — found a bug → `bounce`/`issues`, the holder fixes;
- rubber-stamp — a verdict without verification degrades the marker for everyone.
