---
name: te-review
description: Peer-review a TeamEngage task another session submitted — list what is waiting (query status=in_review), verify it against the task's acceptance criteria (read the diff, judge the logic), then record an advisory verdict (review ok|issues) or bounce clearly broken work back to its holder, all over plain curl (no MCP). Use when asked to "review GL-0019", "check the review queue", "pre-review", "second opinion before I accept". Never for a task you submitted yourself.
---

# te-review — peer-review another session's submission

A second pair of eyes before the human looks. You are the reviewer — **not** the
holder of the claim and **not** the decider. What you produce is a verdict + note
the human reads, or a bounce reason the submitter reads. Final accept stays with
the human.

The submitting agent already ran its tests and got its syntax right — that
passes almost always. Your job is the part it cannot grade itself: **whether
the logic actually does what the task asked**. Read the diff and reason about
it. Re-running the submitter's test suite is not a review.

## 1. Start a session

Same as te-work. Plain HTTP, nothing else needed. If `te` is not found or the
daemon is not running, tell the user and stop.

```bash
B=http://127.0.0.1:4747/agent
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>-review"}' | tee /dev/stderr | sed -n 's/^token //p')
H="X-TE-Session: $T"
```

Name the session `<you>-review` — the human sees who reviewed.

The hello output shows workspace + your claims, then the full protocol — the
same rules as implementing (`plans behind … — STOP` → ask the human to pull
the Tasks repo, `hello` again; 409 → someone else is doing it).

## 2. Find submissions to review

```bash
curl -s "$B/query?status=in_review" -H "$H"
# → GL-0019 in_review "fix the restart edge case"  #cpp held:gemini-cli@dev-desktop#77b0
```

- The human usually names the task — use that id (a file like
  `TASK-13-….md` → the id is its `te:` line). If they said "review what's
  waiting", list the queue and pick one (say which).
- `held:<agent>` is the **submitter**. If it is your own session — skip it;
  you can never review your own submission (the daemon refuses).
- You do **not** claim the item just to review it — everything you do is
  read-only, plus one `review` or `bounce` call at the end. (To fix an
  AI-flagged submission yourself, see "take over the fix" below.)
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

## 4. Read the actual diff — this is the review

In each target worktree/branch from brief: `git log` / `git diff` the claim's
branch against its base. Evidence commits are `repo@sha`:

```bash
git -C <repo> show <sha>                 # the commit
git -C <repo> log --oneline -8           # context around it
```

Judge the **logic**:

- **Acceptance, item by item.** For each `## Acceptance` bullet, find the
  code path that makes it true — not the submitter's note saying it is.
  A checked-off item the code doesn't deliver is the most valuable finding.
- **Semantics.** Inverted conditions, off-by-one, wrong default, a flag read
  before it is set, a cache that never invalidates, a value in the wrong
  units. The compiler and tests don't catch these — you do.
- **Failure behavior.** What happens on bad/missing/empty input? A silent
  fallback to a plausible-looking default (fail-open) is usually worse than
  a loud error — name it.
- **The whole path.** Every caller updated? A second route to the same
  state that bypasses the change? Half-applied renames? Dead code left
  behind?
- **Scope.** The diff should implement what the task says and stay inside
  `**Touches:**`. Drive-by refactors and unrelated cleanups widen what must
  be reviewed — flag them.
- **Tests as claims.** Green tests can still assert the wrong thing. When an
  acceptance item says "verify X", check the test exercises X, not that a
  test exists. Spot-check a test run only when the diff gives you a reason
  to doubt it — never as a substitute for reading.
- **What you cannot verify is a finding, not a skip** — if a check needs
  hardware or a deploy you don't have, say so in the note rather than passing
  it silently.
- **Never edit the code.** The claim and its worktree belong to the holder.
  Review is read-only — found a bug, report it; the holder fixes it.

## 5. Record the verdict

```bash
curl -s -X POST $B/review/GL-0019 -H "$H" \
  -d '{"verdict":"ok","summary":"Restart counting works and survives a restart — the acceptance items check out.","note":"acceptance 1–3 verified; restarted with --debug twice, counter survives; ctest 4/4 green on the claim branch; diff confined to **Touches:**"}'
```

- `summary` is **required** — one plain-English sentence for the human, no
  jargon: what the verdict means. _"The fix works but error reporting was
  left out"_, not _"missing stderr propagation in run()"_. It is what the
  human reads on the item page.
- `note` is the technical detail for whoever fixes it — what you ran, what
  passed, over which diff. `"looks fine"` tells nobody anything.
- `ok` — verified, ready for the human to accept.
- `issues` — verified concerns the human should weigh before deciding (or
  checks you couldn't run). Number the findings in `note`, worst first, each
  with file:line or commit, so whoever fixes it doesn't redo your analysis.
  The item stays in review.
- "The code is right but the task was wrong" → say exactly that — it is the
  human's call, not yours to fix silently.

A clearly broken submission — acceptance not met, tests never run, spec
ignored — goes back to the holder rather than leaving the human to reject it:

```bash
curl -s -X POST $B/bounce/GL-0019 -H "$H" \
  -d '{"reason":"acceptance 2 unimplemented — restart flag ignored; Evidence lists no test run","summary":"The submission ignores the restart flag — it goes back for fixes."}'
```

`summary` is required on bounce too — the human reads it in `## Review`.

`bounce` moves the item to `in_progress` **keeping the same claim** — the
holder reads the reason in `brief`/`## Review`, fixes, and `submit`s again.
Write the reason for the holder: specific, actionable. After two bounces in a
row a third is refused — the item stays in review and the human decides; just
record a `review` verdict.

To **take over the fix** instead of sending it back: record the `issues`
verdict, then `claim` the item. An `in_review` item with an `issues` verdict
can be claimed by any session on the claim's machine — the claim and its
worktree move to you, so you continue on the same branch and `submit` again.
Cross-machine takeover is refused; there it stays `bounce`.

Tell the human the outcome: _"GL-0019 reviewed ok"_ or _"GL-0019 bounced —
acceptance 2 unimplemented"_.

## Never

- review or bounce **your own** submission — refused anyway; second opinions only;
- accept, reject, or treat your verdict as a status — it changes nothing; the human accepts;
- claim the task or touch its worktree just to review — found a bug → `bounce`/`issues`, the holder fixes (or take over: `issues` verdict, then `claim` on the same machine);
- edit `.teamengage/` files or a task's `te:` line; never `git push`;
- rubber-stamp — a verdict without verification degrades the marker for everyone.
