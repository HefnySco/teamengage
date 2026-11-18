# Ideas page — plan

Move ideas out of the inbox onto their own page (`#/ideas`), modeled on the
plans page (`#/plans`). Each idea row lists the plans and tasks that name it
in `relates`. The idea state becomes `draft | ready | done` — no
`in_progress` — with `dropped` and `archived` as the terminal states.

## Today

- `idea` is an item type. Its own `status` is already `draft → ready →
  done | dropped` plus the `archived` flag; `claim` refuses ideas, so an
  idea can never be `in_progress` itself (`machine.ts` ~L430).
- `idea_state` is **derived** from the statuses of the items that name the
  idea in `relates` — `unplanned | planned | in_progress | done`
  (`ideaStateOf`, `index.ts:51`). Served on idea rows as
  `idea_state`/`idea_progress` (`api.ts:117`).
- Where ideas surface now:
  - **Inbox**: `drafts` lists every `status === "draft"` item, ideas
    included (`api.ts:389` → `web/app.js` Drafts group).
  - **Board**: idea cards in the status columns + an "Ideas" filter chip
    row keyed by the old states (`app.js` ~L1362).
  - **Item page**: an "idea" progress bar with the `idea_state` chip and a
    "referenced by" chain (`app.js` ~L2718).
  - `te ideas` / `te ls --state`, MCP `search state=`, planner `next`
    (`ops.ts:254` offers `idea_state === "unplanned"`), feature brief
    `ideas` list (`ops.ts:668`), agent protocol text
    (`src/agent/http.ts:156`).

## State model (the core change)

Replace `IdeaState` with `"draft" | "ready" | "done" | "dropped"` —
the item status folded into the derived rule, `in_progress` removed:

```
status dropped                     → dropped
status draft                       → draft   (untriaged, status wins)
status done                        → done
≥1 live referrer ∧ all live done   → done    (derived, like plan_state)
otherwise                          → ready
```

`ready` covers today's `unplanned + planned + in_progress` — an approved
idea whose generated work is not all finished. `idea_progress` `{done,
total}` over live (non-dropped) referrers is unchanged and drives the
row's progress bar.

`archived` stays an orthogonal flag, not a state: archived ideas never
list on the page (the archive page owns them), same as items elsewhere.

Notes / edges:

- An idea whose only referrers were dropped counts no live referrers →
  `ready`, not `done` (today it reads `done`). Deliberate: a dropped plan
  means re-plan.
- `hold` collapses to `ready`.
- No auto-status sweep (`plan_auto_done` analogue) — derived state is
  display-only; `complete`/`drop`/`archive` still close an idea by hand.

## Changes

### Core — `src/core/index/index.ts`

- `ideaStateOf(status, referrerStatuses)` — new signature and rule above.
- In `derive()` the `named` map already collects referrer statuses; extend
  it to also keep referrer ids and set `it.idea_refs: string[]` on idea
  items (non-archived referrers, dropped included so the page can badge
  them). Add `idea_refs` to `IndexedItem`.
- `QueryFilter.idea_state` now matches against the new states.

### API — `src/daemon/api/api.ts`, `src/daemon/api/ops.ts`

- `/api/items`: idea rows gain `idea_refs` beside `idea_state` /
  `idea_progress`.
- `/api/inbox`: `drafts` excludes `meta.type === "idea"`. `questions`,
  `reviews`, `drop_flags`, `findings` unchanged (a flagged idea is a
  decision, not a listing).
- Planner `next` pool (`ops.ts:254`): "unplanned" no longer exists →
  `type === "idea" && (idea_progress?.total ?? 0) === 0` (nothing live
  names it; drafts included, same reach as before).
- Feature brief `ideas` list keeps returning `idea_state` — values just
  change.

### Web — `web/app.js`

- New route `ideas` in the `routes` table right after `plans` (nav is
  generated from the keys).
- New `Ideas` component, built like `Plans` on `/api/items`:
  - Root rows = `type === "idea"` items. Children = `idea_refs` (or the
    client-side `relates` reverse-lookup the board fallback already does),
    rendered with the existing `PlanNode` — an epic referrer gets its
    plan badge, progress bar and expandable subtree for free; tasks get
    status badges and the approve-draft action.
  - `IdeaNode` root row: fold caret, id, star, state chip, title, domain
    tags, `PlanBar`-style progress over `idea_progress`, approve action on
    drafts (same `act(id, "approve")`).
  - Toolbar mirrors Plans: search (subtree match), "finished ideas"
    toggle (done + dropped, hidden by default), `SortSeg` (created /
    completion / size — point `pctDone`/`size` at `plan_progress ??
    idea_progress`), expand/collapse all, "archive finished" bulk action,
    and the bulb `NewIdea` button (the modal moves here; keep the board's
    button too — quick capture).
  - State filter chips `draft | ready | done | dropped` with counts,
    replacing the board's old "Ideas" chip row.
- `IDEA_STATES` / `IDEA_STATE_CLS` / local `ideaStateOf` fallback
  (app.js ~L154): update to the new states; the fallback takes the item's
  own status too. Chip classes: draft→`ps-draft`, ready→`ps-decomposing`,
  done→`ps-done`, dropped→ new `--te-ps-dropped` var (or reuse the
  `Badge` style).
- Item page idea progress bar: chip labels follow automatically.
- Board: idea cards leave the board (same argument as plans — sources,
  not work) and the per-state filter row is replaced by a single
  `Ideas n` link chip to `#/ideas`. Decision point: alternatively keep
  the cards and only relabel the chips — smaller diff, but ideas keep
  filling work columns.
- Inbox: no code change needed beyond the API filter — the Drafts group
  shrinks. Optional: a one-line link under Drafts ("N draft ideas →
  #/ideas") so triage stays discoverable; cheap via an `idea_drafts`
  count in the inbox payload.

### CLI / MCP / agent text

- `te ideas`, `te ls --state`: state values are now
  `draft | ready | done | dropped` (update `--help` / usage strings).
- MCP `search` `state=` description (read.ts ~L296).
- Agent protocol text `src/agent/http.ts:156` — "unplanned ideas" →
  e.g. "ideas nothing references yet".
- `docs/DESIGN.md` §idea (L332–341, L441, L583) and `docs/TASK-FORMAT.md`:
  rewrite the lifecycle sentence and the `next` table vocabulary.
- `web/teamengage.css`: `--te-ps-dropped` variable if a distinct chip
  colour is wanted.

## Tests to update

- `src/core/index/index.test.ts` (L319–334): rewrite the state matrix —
  draft/ready/done by status and referrer mix, dropped, dropped-only
  referrers.
- `src/daemon/api/api.test.ts` (L1616–1658): `idea_state` values +
  new `idea_refs`; non-idea rows still carry none.
- `src/daemon/api/ui.test.ts` / inbox tests: idea drafts absent from
  `drafts`.
- `src/agent/http.test.ts`: planner pool comment/fixture (no "unplanned").
- `overlay.test.ts`, `read` paths: expectations that mention old states.

## Acceptance

- `#/ideas` lists every idea; expanding a row shows the plans/tasks that
  name it, plans expandable into their subtrees.
- Idea chips read only draft / ready / done / dropped; `in_progress`
  appears nowhere.
- The inbox Drafts group contains no ideas; an idea draft is approved
  from the Ideas page (or its item page).
- `te ideas --state ready` and MCP `search state=ready` work; old state
  names are gone from help, protocol text and docs.
- `npm test` green.
