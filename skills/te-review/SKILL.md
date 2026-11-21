---
name: te-review
description: Peer-review a TeamEngage task another session submitted — list what is waiting (query status=in_review), verify it against the task's acceptance criteria (read the diff, judge the logic), then record a verdict (review ok|issues — issues sends clearly broken work back to its holder), all over plain curl (no MCP). Use when asked to "review GL-0019", "check the review queue", "pre-review", "second opinion before I accept". Never for a task you submitted yourself.
---

# te-review — peer-review another session's submission

**Writing rule — ASD-STE100, always.** `summary` and `findings` are ASD-STE100
Simplified Technical English: short
sentences, one idea each, active voice, plain approved words. Review text
must read like a chat reply to the human — no vague text, no
compressed log dumps. file:line and commit shas only where they pin a
finding down.

A second pair of eyes before the human looks. You are the reviewer — **not** the
holder of the claim and **not** the decider. What you produce is a verdict +
summary the human reads; an `issues` verdict's findings the submitter reads
too. Final accept stays with the human.

**Review the request, not the build.** The build stage already did the
mechanical checks: compile, lint, syntax, and the test run. The submit gate
refuses an item whose `## Checks` have no passing `te verify` result at the
claim HEAD. Do not do that work again. Your job is the part the submitter
cannot grade itself, because the same agent wrote the code and the tests
from the same idea of the task:

- **In scope:** missed requirements, a wrong interpretation of the task,
  wrong logic, scope outside **Touches:**, and tests that prove the wrong
  thing.
- **Out of scope:** lint, formatting, style, compile errors, and running the
  test suite again. These are not findings and not review work.

Rule of thumb: **if a compiler, a linter or a test run can catch it, skip
it. If only a reader who knows the task can catch it, report it.** A logic
bug that breaks a requirement is in scope — it is the main thing you look
for.

## 1. Start a session

Same as te-work. Plain HTTP, nothing else needed. If `te` is not found or the
daemon is not running, tell the user and stop.

```bash
B=http://127.0.0.1:4747/agent
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>-review","model":"<your-model-id>","label":"review"}' | tee /dev/stderr | sed -n 's/^token //p')
H="X-TE-Session: $T"
```

Started by `te run`? Use `H="X-TE-Session: $TE_SESSION"` and skip `hello`.
The task to review is in `$TE_ITEM`.

Name the session `<you>-review` — the human sees who reviewed. Always
declare `model` — TeamEngage refuses a review from the same
model that submitted the work (a session with no model falls back to its
agent name). `next` already hides those items from you.

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
  read-only, plus one `review` call at the end. (To fix an
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
`.teamengage/items/<XX>/<id>.md` inside the task folder. `## Walkthrough` is
the submitter's own STE explanation of the change (read it, then
check it against the diff — it is a claim, not proof), `## Evidence` is what
they cite (commits, tests, notes), `## Review` the earlier verdicts,
`## Log` the full history. Reading `.teamengage/` files is fine —
just never edit them.

## 4. Read the actual diff — this is the review

In each target worktree/branch from brief: `git log` / `git diff` the claim's
branch against its base. Evidence commits are `repo@sha`:

```bash
git -C <repo> show <sha>                 # the commit
git -C <repo> log --oneline -8           # context around it
```

### 4a. Make the requirement list

Before you read the code, write down what the task asks. Use two sources:

1. Each `## Acceptance` bullet — one requirement each.
2. The task's title and summary. Find the requirements they state or imply
   that no acceptance bullet covers (for example "the counter survives a
   restart" implies "the counter is saved somewhere"). Mark these as
   *implied*.

### 4b. Trace each requirement

For each requirement, find three things:

| Requirement | Code that makes it true | Proof |
|---|---|---|
| acceptance 1 | `src/x.ts:42` | test `restart keeps count` asserts the saved value |

- **Code.** The code path that makes it true — not the submitter's note
  or Walkthrough saying it is. A checked-off item the code does not deliver
  is the most valuable finding.
- **Proof.** A test, a `## Checks` result or an Evidence item that really
  exercises this requirement. Read the test — do not run it. A requirement
  with no proof is a finding (`should`), unless it is `unverifiable:`
  (below).
- **Missing.** A requirement with no code is `must`. An implied
  requirement with no code is a finding too; say that it is implied, so the
  human can decide whether the task meant it.

Put the trace (short form) in `findings`.

### 4c. Judge the interpretation and the logic

- **Interpretation.** Does the code do what the task *meant*, or a
  different thing that also passes its own tests? Read the task as the
  human wrote it, then read the Walkthrough. When they describe two
  different features, that is a finding — and if the task text is
  ambiguous, it is the human's call (`needs_human`).
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
  be reviewed — flag them. Changes outside Touches are an `issues` finding;
  if that work is genuinely needed, the fix is a new dependent task
  (`propose`, `depends_on` = this one), never a wider Touches on this task. A bug you find
  in review gets its own task with `found_by` = this task (reference only),
  not `depends_on`.
- **Tests as claims.** Green tests can still assert the wrong thing. When an
  acceptance item says "verify X", read the test and check that it
  exercises X, not only that a test exists. A test that asserts what the
  code does instead of what the task asks is a finding. You read tests;
  you do not run them.
- **Test evidence — read, do not run.** For an item with `## Checks`, the
  submit gate already refused anything without a passing result at HEAD —
  trust it. For an item with no `## Checks`, read `## Evidence`: it must
  cite a test run or a manual check at a named commit. Do not run the tests
  to fill the gap. Two cases, and both go to the human — never `issues`,
  because the fix loop cannot add evidence or hardware:
  - **No evidence, but a test is available or needed** (a test exists for
    this code, or an acceptance item asks for one). First check whether the
    target is reachable (for example `ping -c1 rpi5.local`). If it is
    reachable, or the test runs locally, the holder skipped it. Record `ok`
    with `needs_human: true`, the summary "The task needs a test, but
    Evidence shows no test run.", and `ask_human` options
    `["accept", "create follow-up task", "send back"]`.
  - **A test exists, but no machine here can run it** (Pi hardware, a
    camera, SITL, a second host — and the target is not reachable). This is
    a flag, not a pass. Record `ok` with `needs_human: true`, start the
    summary with "Not verified on hardware:", put the exact manual check in
    `unverifiable: …` (for example `unverifiable: acceptance 3, run
    tracker_rss.sh on rpi5.local — host offline`), and give `ask_human`
    options `["accept", "run it on the Pi first", "send back"]`.
  `needs_human` is never auto-accepted, so the human always decides and
  can always accept.
- **Risk exception (deep reviewers only).** On a `tier: heavy` item, or a
  diff in a risky area (auth, flight control, mission upload, data
  migration), a deep reviewer may run **one targeted** check when the diff
  gives a concrete reason to doubt a requirement — `te verify <id>` or one
  test. Never the full suite. Say in `note` what you ran and why.
- **What you cannot verify is a finding, not a skip** — if a check needs
  hardware or a deploy you don't have, say so in the note rather than passing
  it silently. For missing hardware, SITL, a live browser or a human-only
  manual step, write the note as `unverifiable: <acceptance item>, <why it
  cannot be checked here>` — it goes straight to the human, no fix round —
  and when the rest is otherwise ok, record `ok` with `needs_human` (below)
  so it is never auto-accepted. Use the "Not verified on hardware:" summary
  and options from **Test evidence** above.
  A cited commit that isn't in the repo (`git cat-file -e <sha>` fails) is
  **not** unverifiable: record `issues` naming the machine where the commit
  should exist and stop.
- **Never edit the code.** The claim and its worktree belong to the holder.
  Review is read-only — found a bug, report it; the holder fixes it.

## 5. Record the verdict

```bash
curl -s -X POST $B/review/GL-0019 -H "$H" \
  -d '{"verdict":"ok","summary":"Restart counting works and survives a restart — every acceptance item has code and a test that proves it."}'
```

- `summary` is **required** — one or two sentences in STE for the human,
  no jargon: what you verified and why the verdict follows. _"The fix works
  but error reporting was left out"_, not _"missing stderr propagation in
  run()"_. It is what the human reads on the item page.
- `findings` is the **numbered list** the holder answers — one entry per
  point, `{text, where, severity: "must"|"should"}`. `where` pins it down
  (`file:line`, a test name). A `must` blocks the next submit until the
  holder marks it done or skipped.
- `note` and `report` are **accepted for one release** — they render inside
  the findings list; put fix detail in `findings` instead. If you still give
  a `report`, use this layout in STE, number the items across sections, and
  leave out a section that has no items (never leave out `Verdict` or
  `Bottom line`):

  ```text
  Verdict: OK — but the human must decide.

  What the reviewer checked:
  1. Acceptance 1: the removed code is really gone. The search finds no V1 names in `src`.
  2. Acceptance 2: the new path handles an empty list. A test asserts it.
  3. The tests and the build passed in the build stage. The reviewer did not run them again.

  What the reviewer could not check:
  4. One acceptance item stays open, because <why>. <What this means>.

  Small notes:
  5. <A point that needs no action now.>

  Bottom line: <one or two sentences: what the human must decide>.
  ```

  Say what each item means for the decision. Say clearly when you trust the
  submitter's report and did not run a check yourself.
- `ask_human` is the **human's decision card** — required on `issues` and
  on `ok` + `needs_human`. Plain words the human
  reads first; no file names, no code names, no commit ids:
  - `problem` — what is wrong or what needs deciding, max 40 words.
  - `recommendation` — what you would do, max 30 words.
  - `options` — 2–3 short labels (max 4 words each), shown as text on the
    card; accepted for one release and folded into the findings list.
  Depth goes in `findings` — no limit there.

  ```text
  problem, good:        "the change touches the auth path; the reviewer could not fully verify it"
  problem, weak:        "checkSessionToken() in auth.ts looks wrong"        (code names, no decision)
  recommendation, good: "look at the session edge cases yourself before accepting"
  recommendation, weak: "review the code"                                    (says nothing)
  ```
- **Write `summary` and `note` in STE** (ASD-STE100 Simplified Technical
  English) — prose a human who did not watch the work can follow. Open
  the note with a sentence or two on what you actually did and the
  outcome ("I traced all 4 acceptance items to code — 3 have a test that
  proves them, and the mission-resume item has no code"), then numbered findings, each one or
  two sentences saying what it *means*, not only what it *is*. Put a
  file:line or commit sha only where it pins a finding down. Never a
  compressed log dump (`mt-1075 -> OnMissionACK 0`, `src ai`, `cache-hit`)
  or field names as shorthand — when a technical term is needed for
  precision, keep it and put the plain meaning next to it. These comments
  are read by the human on the item page, not parsed by a machine.
- `ok` — verified, ready for the human to accept. Under `autonomy: solo`
  (the `hello` rules line says so) an `ok` is **not** advisory only: the
  daemon accepts and merges the submission after `auto_accept_after`
  unless the human steps in. Give `ok` only when you traced every
  acceptance item (and every implied requirement) to code and proof; when
  in doubt, `issues`.
- `ok` **with `needs_human: true`** — "ok, but…". The work looks right, yet
  the call is not yours: a risky area, an acceptance item you could not
  fully verify, or a judgement the human should make. Such a review is
  **never auto-accepted** — it always waits for the human. Say what needs
  their eyes in `summary`:

  ```bash
  curl -s -X POST $B/review/GL-0019 -H "$H" \
    -d '{"verdict":"ok","needs_human":true,"summary":"The change does what the task asked, but it touches the auth path — worth your own look before accepting.","note":"acceptance 1–3 verified; diff inside Touches; auth/session edge cases are the part I cannot fully judge","ask_human":{"problem":"the change touches the auth path and some session edge cases could not be fully verified","recommendation":"check the session edge cases yourself before accepting","options":["accept","keep in review"]}}'
  ```

- `issues` — verified concerns that send the work back (or checks you
  couldn't run). Number the findings in `note`, worst first, each
  with file:line or commit, so whoever fixes it doesn't redo your analysis.
  An `issues` verdict is also the send-back path: a holder live on this
  machine gets the item back as `in_progress` with the claim kept; a dead
  holder's claim goes to `ready` (branch kept); a holder on another machine
  is left untouched — the item stays `in_review` for that machine. After
  two `issues` verdicts in a row the item stays in review for the human.
- `findings` — optional structured list for the holder to answer:
  `[{"text": "…", "where": "src/x.ts:42", "severity": "must"}]` (`where`
  is optional, `severity` is `must` or `should`). The item page shows them
  as a checklist, and the next `submit` must set every `must` to `done` or
  `skipped` (with a reason) or it is refused. Use it for concrete fix
  points instead of burying them in prose:

  ```bash
  curl -s -X POST $B/review/GL-0019 -H "$H" \
    -d '{"verdict":"issues","summary":"Two fix points before this can go in.","note":"1. acceptance 2 fails — see findings","findings":[{"text":"restart counter never resets","where":"src/counter.ts:88","severity":"must"},{"text":"name the flag `restarted` not `rst`","severity":"should"}],"ask_human":{"problem":"two acceptance items are not met yet — the restart counter never resets","recommendation":"keep it in review; the holder fixes the findings and submits again"}}'
  ```

- "The code is right but the task was wrong" → say exactly that — it is the
  human's call, not yours to fix silently.

A clearly broken submission — acceptance not met, task misread, spec
ignored — goes back to the holder rather than leaving the human to reject
it. That is `review` with verdict `issues` — the same call as above.
(Missing test evidence alone does not send it back: it goes to the human,
see **Test evidence**.)

```bash
curl -s -X POST $B/review/GL-0019 -H "$H" \
  -d '{"verdict":"issues","note":"acceptance 2 unimplemented — restart flag ignored on AUTO start","summary":"The submission ignores the restart flag — it goes back for fixes.","findings":[{"text":"restart flag ignored on AUTO start","where":"src/main.ts:114","severity":"must"}],"ask_human":{"problem":"the submission ignores the restart flag — it went back to the holder","recommendation":"let the holder fix it and submit again"}}'
```

Give `findings` on `issues` when you can name the exact fix points — the
holder cannot resubmit until every `must` is marked done or skipped.

**An `issues` verdict must name the acceptance item it fails** ("acceptance 2: …") or
a concrete break (a red result in Evidence, a crash the logic causes,
Touches violated). Style, naming, lint or "I'd have done it differently" is
not an `issues` finding — at most one line in a `review ok` note.

**Light-tier reviewers (Haiku-class).** You check the logic against the
acceptance criteria. Don't approve what you can't judge: when the change
touches concurrency, security/auth, data formats or migrations, or the item
is `tier: heavy`, record `review issues` with
`"note":"needs a standard-tier review: <why>"` instead of `ok` — a stronger
reviewer picks it up. (A light `ok` on a heavy task is never auto-accepted.)

An `issues` verdict moves the item to `in_progress` **keeping the same
claim** — the holder reads the note in `brief`/`## Review`, fixes, and
`submit`s again. Except when the holder can't act: a dead local session's
claim goes to `ready` (branch kept) so the fix is never stranded on a
session that won't answer; a holder on **another machine** keeps its
claim — the item stays `in_review` for that machine to pick up.
Each `issues` verdict counts as a failed attempt: when it escalates the
task above the holder's tier, the claim is released instead (`→ ready`)
and a stronger agent takes it; at `max_attempts` the task waits for the
human. Write the note for the holder: specific, actionable — and in the
same STE style, since the human reads it too. After two `issues` verdicts
in a row the item stays in review and the human decides.

To **take over the fix** instead of sending it back: record the `issues`
verdict, then `claim` the item. An `in_review` item with an `issues` verdict
can be claimed by any session on the claim's machine — the claim and its
worktree move to you, so you continue on the same branch and `submit` again.
Cross-machine takeover is refused — record `issues` there; the claim stays
for the holder's own machine. Taking over
fixes the submission within its approved scope — the task's Touches and
acceptance don't change. Anything wider → `propose` a dependent task.

**Colliding commits on a shared branch.** When the branch or worktree holds
commits that belong to another task (a wrong merge, a shared checkout, a
claim that resumed on top of the wrong base), never remove them with
`git reset --hard`, `git reset HEAD^`, or by rewriting the branch — the
other task loses its work and its Evidence commits go missing. Report it
in `note` / an issues finding naming the commits. The safe fixes, when you
take over the fix yourself: `git revert <sha>` to undo a foreign commit
while keeping history, `git cherry-pick` of the task's own commits onto a
fresh branch from the base, or `git restore --source=<sha> -- <path>` to
put single files back. History repair is the human's call — name the
commits and let them decide.

Tell the human the outcome: _"GL-0019 reviewed ok"_ or _"GL-0019 sent back
with issues — acceptance 2 unimplemented"_.

## Never

- review **your own** submission — refused anyway; second opinions only;
- accept, reject, or treat your verdict as a status — it changes nothing; the human accepts;
- claim the task or touch its worktree just to review — found a bug → `review issues`, the holder fixes (or take over: `issues` verdict, then `claim` on the same machine);
- edit `.teamengage/` files or a task's `te:` line; never `git push`;
- `git reset --hard` / `git reset HEAD^` or dropping commits — even to fix
  a colliding branch; revert, cherry-pick, or file-level restore instead,
  and let the human repair history;
- rubber-stamp — a verdict without verification degrades the marker for everyone;
- spend the review on lint, formatting or a full test re-run — the build
  stage owns those; your time goes to the requirement trace.
