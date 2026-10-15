---
name: te-review
description: Review a task another agent submitted to a TeamEngage task bank (status in_review) — verify the implementation's logic against the task and its acceptance criteria by reading the actual diff, then post findings as a note for the human who accepts or rejects. Use when asked to "review GL-0019", "review the submitted work", "check what's in review", or "look over TASK-13 before it's accepted". For doing work yourself use te-work; for splitting work use te-plan.
---

# te-review — review another agent's submitted work

An item in `in_review` means an agent claimed it, did the work, and submitted
evidence (commits + tests). The human accepts or rejects it — you advise.

The submitting agent already ran its tests and got its syntax right — that
passes almost always. Your job is the part it cannot grade itself: **whether
the logic actually does what the task asked**. Read the diff and reason about
it. Re-running the submitter's test suite is not a review.

Everything is plain HTTP on the local daemon — no MCP needed:

```bash
B=http://127.0.0.1:4747/agent
curl -s $B            # full protocol + examples, if you need it
```

## 1. Start a session

```bash
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>-review"}' | tee /dev/stderr | sed -n 's/^token //p')
H="X-TE-Session: $T"
```

Name the session `<you>-review` — the human sees who reviewed.

Read every line `hello` prints. `plans behind … — STOP` → stop, ask the
human to pull the Tasks repo, `hello` again.

## 2. Pick the item

- The human named one (`GL-0019`, or a file like `TASK-13-….md` → the id is
  its `te:` line) → use it.
- "Review whatever is waiting" →
  `curl -s "$B/query?status=in_review" -H "$H"` and take what they point at.

You do **not** claim it — an `in_review` item cannot be claimed and does not
need to be. Everything you do is read-only, plus one `note` at the end.

## 3. Read the task and the evidence

```bash
curl -s $B/brief/GL-0019 -H "$H"
```

You get the task file: what was asked (`# Title`, `## Acceptance`), what the
submitter claims it did (`## Evidence` — commits, tests, notes), decisions
made along the way, and the repos/paths it touched (`**Touches:**`).

Note the acceptance items — you will check each against the code.

## 4. Read the actual diff — this is the review

Evidence commits are `repo@sha`. Open the repo and look at the change:

```bash
git -C <repo> show <sha>                 # the commit
git -C <repo> log --oneline -8           # context around it
```

If the item is still claimed, the claim's `paths` (in `brief` output) point
at the worktree the code lives in — read there.

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
- **Scope.** Anything in the diff the task didn't ask for — drive-by
  refactors, unrelated cleanups — widens what must be reviewed and should be
  flagged.
- **Tests as claims.** Green tests can still assert the wrong thing. When an
  acceptance item says "verify X", check the test exercises X, not that a
  test exists.
- Spot-check a test run only when the diff gives you a reason to doubt it —
  never as a substitute for reading.

## 5. Post the verdict

One `note` on the item — markdown, findings numbered, worst first, each with
file:line or commit. End with a clear recommendation:

```bash
curl -s -X POST $B/note/GL-0019 -H "$H" -d '{"text":"## Review (<your-name>, <date>)\n\n1. **FAIL-OPEN**: loadRegistry() swallows parse errors and runs with defaults (registry.cpp:88) — a corrupt file silently disables validation; acceptance 2 required a rejection.\n2. handleFoo() caller in bar.cpp:141 still passes the old signature…\n\nVerified: acceptance 1 and 3 hold — diff matches spec.\n\n**Recommend: reject** — finding 1 is a correctness regression."}'
```

- Sound → "recommend accept" and say which acceptance items you verified.
- Issues → "recommend reject" with enough detail that whoever fixes it
  doesn't redo your analysis.
- "The code is right but the task was wrong" → say exactly that — it is the
  human's call, not yours to fix silently.

Then tell the human in chat: the id, the verdict, one line.

## Never

- accept, reject, or change the status — the human decides;
- claim the item or touch its code — a review that finds work to do is
  reported, not done (that's a te-work task);
- edit `.teamengage/` files or a task's `te:` line; never `git push`;
- write "looks good" without having opened the diff — an unverified review
  is worse than none.
