---
name: te-work
description: Implement, continue or pick up a task from a TeamEngage-tracked task bank (e.g. drone_engage/Tasks) — find it, claim it, do the work, ask when unsure, and submit with evidence, all over plain curl (no MCP). Use when asked to "implement TASK-13", "work on GL-0019", "do the next task", "continue the task", "pick up a task", or when a task file under Tasks/ is the thing to execute. For breaking a goal into new tasks use te-plan instead.
---

# te-work — execute a task through TeamEngage

**Writing rule — ASD-STE100, always.** Every text you write in TeamEngage —
`note`, `log`, `ask`, `simple`, `walkthrough`, `review` summaries
and notes, `handoff`, `flag_drop` — is written in ASD-STE100 Simplified
Technical English: short sentences, one idea each, active voice, plain
approved words, one word per meaning. Technical names (files, functions,
field names) stay as-is. This applies to everything the human reads and
everything another agent works from — no vague prose.

The task bank is shared with the human and with other agents (Claude Code,
Devin, Gemini, …) on this and other machines. TeamEngage records who is
working on what. Work **only** through it: claim before you touch code, hand
back with evidence, and let the human decide when something is done.

Everything is plain HTTP on the local daemon — no MCP needed:

```bash
B=http://127.0.0.1:4747/agent
curl -s $B            # full protocol + examples, if you need it
```

## 1. Start a session

```bash
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>","model":"<your-model-id>","label":"<task-id>"}' | tee /dev/stderr | sed -n 's/^token //p')
H="X-TE-Session: $T"
```

Keep `agent` your **stable name** (`devin`, `claude` — never the task id);
put the task you work on in `label` so the metrics scorecard can group your
runs under one row. `model` is your model id (e.g. `swe-2-high`) — recorded
on your submits.

**Started by `te run`?** It already opened your session: use
`H="X-TE-Session: $TE_SESSION"` and do **not** call `hello`. It also checked
that the plans are in sync. The task is in `$TE_ITEM`.

Read every line `hello` prints before going on:

| Line | Do |
|---|---|
| `plans behind … — STOP` | Stop. Ask the human to pull the Tasks repo, then `hello` again. |
| `resume: GL-0019` | You already hold that task (earlier session) — continue it, don't claim another. |
| `held on laptop: …` | That task is being worked on elsewhere — leave it. |
| `rules: …` / `tiers: …` | The rules. They are enforced. |
| `to vet (light-authored drafts): …` | Drafts a light-tier model wrote. If the human asked you to, check them with `vet` (see te-plan §8). |

**Tier (optional).** Only if the human uses model tiers: add
`"tier":"light|standard|heavy"` to hello, and be honest about it. Either
way, a `brief` line `tier: … · N failed attempt(s)` means others already
tried. Read `handoff notes:` and `## Review` **before** anything else, and
don't repeat what they ruled out.

Keep `$T` for the whole task. After a daemon restart, `hello` again — your
claims come back to the new session.

## 2. Find the task

- The human named one: an id (`GL-0019`) → use it. A legacy name or file
  (`TASK-13`, `global/TASK-13-mission-rerun-reset.md`) → the id is the
  `te:` line at the top of that file, or search:
  `curl -s "$B/query?text=mission%20rerun" -H "$H"`.
- "Do the next one" → `curl -s $B/next -H "$H"` and take the first id,
  unless the human said otherwise.

## 3. Read the brief

```bash
curl -s $B/brief/GL-0019 -H "$H"
```

You get the task file itself (summary, `**Touches:**`, `## Acceptance`),
dependency status, decisions already made, and resolved targets.

- A dependency not `done` → don't start; tell the human which one blocks.
  Exception: a dependency `in_review` ("not accepted yet") does not block,
  unless brief marks it `[key task — wait for its acceptance]` —
  build on its submitted work, but read its evidence first and mention the
  dependency in your `log`; if it gets rejected, the inbox flags your task.
- Status `draft` or `hold` → not approved for agents; tell the human.
- Read the repo's own `AGENTS.md` for every repo the task touches.

## 4. Claim

```bash
curl -s -X POST $B/claim/GL-0019 -H "$H"
```

- Refused (`claimed on … by …`, target locked) → do **not** work on it.
  Report who holds it and pick something else only if the human agrees.
- **Stale claim fast path:** a refused claim where the holder's session is
  over (a closed conversation — `.teamengage/claims/<id>.yaml` names it)
  stays "live" in daemon memory until `bye` or a restart. Don't dig
  through daemon internals: restart the daemon
  (`kill "$(jq -r .pid ~/.teamengage/daemon.json)"` — any `te` command or
  MCP shim restarts it), then `hello` again with the **same agent name** —
  dead sessions' claims rebind to you (`resume: <id>` in the hello reply).
  Other agents' live MCP sessions reconnect and rebind on their own, so
  this is safe; their curl-minted sessions must `hello` again too. If in
  doubt the holder may be live, ask the human instead.
- Exception: an `in_review` item with an `issues` AI verdict can be claimed
  on the claim's machine — the claim and worktree move to you, so fix the
  findings there and `submit` again. Any other `in_review`/`held` item stays
  off-limits.
- The reply may return worktree paths — work there, not in the main checkout.
- Work only inside what `**Touches:**` / the claim names. Something outside
  that is needed → `ask` first. Never widen the task's own Touches or
  acceptance: extra work becomes a new task via `propose`, with
  `depends_on` set to this one, for the human to approve. (If `hello`
  prints `autonomy: solo`, such a follow-up lands `ready` at once — the
  propose reply lists it under `ready`; it is still a separate task, never
  folded into this one.) A task for a problem you found on the way gets
  `found_by` = this task, not `depends_on`: `found_by` is reference only.

## 5. Work

- Follow the task's own steps and the touched repos' rules (naming, build,
  commit style). Commit in the code repos as those rules say.
- Before each commit, check `git diff --name-only` (and `git diff --cached
  --name-only`) against the task's `**Touches:**` — a path outside Touches
  stays out of the commit; carry it in a new dependent task (`propose` with
  `depends_on` = this one, its own Touches + acceptance). Never widen the
  task's own Touches to make a commit fit.
- **Never rewrite or drop commits.** No `git reset --hard`, no
  `git reset HEAD^`, no `git rebase` that drops or rewrites commits, no
  `git checkout .` / `git restore .` that wipes the tree. A shared
  checkout or a claim worktree can hold commits and edits that are not
  yours (another claim's work, the human's uncommitted changes) — a reset
  erases them for everyone, and a cited Evidence commit goes missing.
  Committed the wrong files → `git revert <sha>` or restore single files
  (`git restore --source=HEAD -- <path>`). History looks wrong → `ask`
  the human; never repair history yourself.
- `log` at real milestones (not every step) — it is the human's record:

  ```bash
  curl -s -X POST $B/log/GL-0019 -H "$H" -d '{"note":"restart detection in handleMissionCurrentCount; unit test green"}'
  ```

- Learned something the task file should keep (a finding, a gotcha, a
  measurement)? Add it as a note — it is appended to the task's `## Notes`
  with a timestamp; markdown and several lines are fine:

  ```bash
  curl -s -X POST $B/note/GL-0019 -H "$H" -d '{"text":"mission_mode is 0 on ArduPilot < 4.5 — restart detection falls back to seq decrease"}'
  ```

  Never rewrite existing lines or touch the `te:` line.

### Plain-English version (STE)

Asked for a "simple" version (or the task has none and the human wants one)?
Write it with the tool — in STE (ASD-STE100 Simplified Technical English:
short sentences, active voice, plain approved words) — never create
`X.simple.md` by hand:

```bash
curl -s -X POST $B/simple/GL-0019 -H "$H" -d '{"text":"If you fly the same mission twice, the add-ons now react the second time too."}'
```

It creates (or replaces) the companion file next to the task, tags and links
it, and the web page shows it under "simple". No claim needed.

### Attaching files (mockups, screenshots)

A file worth showing on the task page goes into `## Artifacts` — never by
hand, never in `## Notes`. Put the file inside the task folder first, then:

```bash
curl -s -X POST $B/attach/GL-0019 -H "$H" -d '{"path":"mockups/home.png","caption":"home tab mockup","domains":["ui"]}'
```

The file is copied to `.artifacts/<project>/<id>-<name>` and the line is
added for you — no claim needed. `sensitive: true` marks `!sensitive` (the
file still goes into the plans repo — check the warning). `detach` removes a
line, keeps the file.

## 6. Unsure? Ask — don't guess

```bash
curl -s -X POST $B/ask/GL-0019 -H "$H" -d '{"question":"Reset de_comm dedup on restart too, or only de_mavlink?","options":["both","de_mavlink only"]}'
```

The task goes to `waiting` and it is the human's turn. Stop working on it
and tell the human there is a question. When it is answered the task comes
back to you (`brief` shows the decision).

**Ask a peer first when another agent could know.** With
`"to":"peer"` in the ask body the task stays `in_progress` and another
session at your tier or higher answers it (`answer_peer`). The answer
lands in `## Notes` and in your `brief`. A peer question that nobody
answers within `peer_answer_after` (default 30m) goes to the human on its
own. `next` lists the peer questions you may answer.

## 7. Prove it, then submit

Go through `## Acceptance` one item at a time and actually run each check.
When the task has a `## Checks` section, run `te verify <id>` first — it
runs each check in your claim worktree and posts the result. Submit is
refused while a check is missing, failed, or stale at the repo HEAD; only
use `unverified_reason` when a check genuinely cannot run here (it makes
the review needs_human, never auto-accepted).
Then submit with the evidence. **`what` and `how` are required** — the
human's two short lines under `## For the human`. Plain words, no file
names, no function names, no commit ids: `what` says what the task does
now (max 40 words), `how` says how you did it (max 60 words). The daemon
refuses a line over the limit — and the error names the count.

- **what, good:** `"the mission counter now survives an autopilot reboot"`
- **what, weak:** `"changed handleMissionCurrentCount in de_mavlink.cpp
  and fixed the dedup flag"` (code names, says what you touched not what
  the task does)
- **how, good:** `"set a restart flag when the FC reboots and reset the
  dedup cache on it; ran the rerun test twice"`
- **how, weak:** `"edited the code, added a flag, ran tests"` (says
  nothing — where? what kind of flag?)

The `walkthrough` is the **optional agent layer** — the longer STE
explanation (what you changed, how it works, where to look first) written
like a chat reply. Depth goes in `walkthrough`, `notes`, `report` and
`findings` — those have no limit. It lands in the item's `## Walkthrough`:

```bash
curl -s -X POST $B/submit/GL-0019 -H "$H" -d '{
  "commits": ["droneengage_mavlink@3f2a1c9", "droneengage_comm@8be0d14"],
  "tests": "ctest -R mission_restart: 4/4 passed; SITL tests/rerun.sh: second AUTO run fired all 6 module events",
  "notes": "acceptance 1–3 verified as above; de_comm dedup reset behind the new restart flag",
  "what": "the mission counter now survives an autopilot reboot",
  "how": "set a restart flag on FC reboot and reset the dedup cache on it; ran the rerun test twice",
  "walkthrough": "de_mavlink already knew when the FC restarted; the new part is a restart flag that de_comm also resets its dedup cache on, so the second run of the same mission is not swallowed as a duplicate. Worth looking at first: the flag is set in handleMissionCurrentCount and read in the dedup path — everything else is plumbing."
}'
```

Send `cost` when your runner reports it — `"cost": {"model": "swe-2-high",
"tokens_in": 12345, "tokens_out": 678, "usd": 0.12}` (every field is optional;
send what you have). It lands as one `cost:` line in `## Evidence` and feeds
`te metrics`.

When the last review left a findings checklist (the item page
shows it, `brief` lists them), answer every entry in `finding_states` —
`{"finding": <1-based number>, "state": "done"|"skipped", "reason": "…"}`.
A `must` finding left unanswered refuses the submit; a `skipped` should
say why in `reason`.

Name what your task now provides in `provides` — `"provides": ["GET
/api/lessons route", "lessons/<domain>.md files", "lesson MCP tool"]`. One
short line each: an API, a file, a message id, a command. Tasks that
depend on yours see the list in their brief's dep block, so the next
agent knows what it can build on instead of hunting for it.

Then tell the human it is in review. An acceptance item you could not verify
→ say so in `notes` (and why); never claim it passed.

Before you submit, every commit you cite must exist where you claim it is —
run `git cat-file -e <sha>` in each repo; a missing commit means fix the
Evidence (or make the commit) first, never submit a citation that isn't
there. Commits live on this machine only — you never push: if the reviewer
works on another machine, ask the human to push, or write a patch
(`git format-patch` / `git bundle`) and cite its path in `notes`.

## 8. Reviewing someone else's submission

The human may ask you to review what another session submitted (a second
opinion before they accept). List what is waiting, then read the brief, the
Evidence and the task file, and actually run the acceptance checks:

```bash
curl -s "$B/query?status=in_review" -H "$H"
curl -s -X POST $B/review/GL-0019 -H "$H" -d '{"verdict":"ok","summary":"Acceptance 1–3 rerun locally, all green — the change does what the task asked.","note":"acceptance 1–3 rerun locally, all green"}'
```

- `verdict` is `ok` or `issues`; `summary` is required — in STE, for
  the human: what you verified and why the verdict. `needs_human: true`
  marks "ok, but the human should decide" — never auto-accepted.
- A broken submission goes back to its holder with `verdict:"issues"`
  (claim kept — they fix and resubmit); the `note` is what they see,
  `summary` and `ask_human` are required too:

  ```bash
  curl -s -X POST $B/review/GL-0019 -H "$H" -d '{"verdict":"issues","note":"acceptance 2 fails: restart counter never resets","summary":"The restart counter never resets — it goes back for fixes.","ask_human":{"problem":"acceptance 2 fails — the restart counter never resets","recommendation":"let the holder fix it and submit again"}}'
  ```

  Name concrete fix points in `findings` — `[{"text":"…","where":"f.ts:1","severity":"must"}]` —
  so the resubmit answers them one by one instead of reading long prose.

- Never review **your own** submission. After 2 `issues` verdicts in a row
  the task stays in review for the human.

## 8b. Stuck? Stop and hand off — don't spiral

You are **stuck** when any of these is true:

- the same error came back twice after you "fixed" it;
- many tool calls since the last new passing test or real progress;
- you are about to "try another approach" for the third time.

Then stop editing. Write down what you know and hand the task to a fresh
session — a clean context with your note beats a long one full of failed
tries:

```bash
curl -s -X POST $B/handoff/GL-0019 -H "$H" -d '{
  "problem":"de_mavlink build fails: undefined ref to MissionState::reset (exact error)",
  "tried":"1) added reset() to header — linker still fails; 2) rebuilt from clean — same",
  "state":"branch te/GL-0019, mission.cpp changed, unit tests 12/14 pass",
  "next":"reset() may be in a source file missing from CMakeLists — check SRCS"}'
```

The claim is released (your branch is kept) and the task goes back to
`ready`; your note lands in `## Handoff`. Every handoff and every `issues` verdict is
one failed **attempt**: after `escalate_after` (default 2) the task's tier
goes up a step so a stronger model takes it, and at `max_attempts`
(default 5) it goes on hold for the human. After a handoff **end this
task** — don't claim it again in the same session.

## 8c. Leave a lesson when a trap cost you time

Lost real time on a repo trap, a build command nobody wrote down or a
test rule you had to discover? Leave a lesson for the domain so the next
agent doesn't lose the same time — `brief` shows it the newest lessons of
its item's domains:

```bash
curl -s -X POST $B/lesson -H "$H" -d '{"domain":"mavlink","text":"de_mavlink tests need SITL running first — sim/bin/sitl.sh, then ctest"}'
```

One line, in STE, only what is not obvious from the code. The domain must
already exist (an unknown one is refused). Wrong or stale lessons are the
human's to delete on the domains page — if one misleads you, say so in a
`note` on your task instead of editing the file.

## 8d. Fix the repo context card when it lies

`brief` shows the context card of each repo your task touches
(`repos/<repo>.context.md` — what the repo is, structure, build, test,
rules). A build or test command in it failed, or a path does not exist?
Correct that section so the next agent does not hit it:

```bash
curl -s -X POST $B/repo_context -H "$H" -d '{"repo":"de_mavlink","section":"Build","text":"cmake -B build && cmake --build build"}'
```

One section per call; the daemon writes the card and logs the change.
Keep the card under 80 lines — `te validate` reports a card that outgrows it.
Missing a section you need (Build, Test, Rules)? The call creates it.

## 9. Giving it back

Can't finish (blocked, out of time, wrong approach)? Release it with what
you learned so the next agent starts from there:

```bash
curl -s -X POST $B/release/GL-0019 -H "$H" -d '{"note":"blocked: needs firmware ≥4.5 for mission_mode; branch kept"}'
```

Submitted already but spotted a mistake before the human looked? Pull it
back — `withdraw` is holder-only, `in_review` → `in_progress`, claim and
worktree kept:

```bash
curl -s -X POST $B/withdraw/GL-0019 -H "$H"
```

## Never

- mark a task done, approve, or accept — the human does;
- review your own submission — second opinions only;
- `git push`, or move files (into `done/` or anywhere);
- `git reset --hard`, `git reset HEAD^`, or any command that drops or
  rewrites commits — `git revert` / file-level `git restore` instead,
  or `ask` (§5);
- edit files under `Tasks/.teamengage/` or a task's `te:` line;
- start without a claim, or keep working after `ask` until it is answered;
- create task files by hand — new work found along the way → `propose`
  (see te-plan) and mention it in your `log`.

In Claude Code these rules are enforced by a guard hook; a refused edit
comes back with the reason — follow it rather than working around it.
