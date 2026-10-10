# TeamEngage — Design

> One human, many local LLM agents (Claude Code, Gemini CLI, Cursor, Devin,
> Windsurf, …) on one or more of the human's machines, planning and executing
> together on shared plans — concurrently, without corrupting each other's
> tasks or each other's code.

Status: **draft v0.3** (2026-10-08)

---

## 1. Problem

Today plans live in folders of Markdown (e.g. `~/de_code/Tasks`, ~450 files).
They are good *content* but poor *coordination*:

- Status is implied by folder (`done/`, `partially-done/`), dependencies by prose
  (`**Depends on:** TASK-12`), IDs collide across folders.
- Nothing stops two agents from picking the same task, or two agents from
  editing the same repo/files at the same time — on the same machine or on
  two machines (desktop + laptop) that share plans through git.
- The human/agent loop is informal: agents guess instead of asking, claim
  "done" without evidence, and lose context between sessions, IDEs and machines.

Prior art solves pieces: **Backlog.md** (md+frontmatter tracker with MCP),
**Beads** (git-backed agent issue graph), **Task Master** (spec → task tree).
None is built around *multiple heterogeneous agents + one human* working the
same plan concurrently. That is TeamEngage's reason to exist.

## 2. Principles

1. **Files are the truth.** Plans are Markdown + YAML frontmatter in a git repo.
   Readable and editable without the tool. The tool indexes; it never hides data.
2. **One writer per machine; machines converge through git.** A local daemon
   serializes every write on its machine. Agents never write plan files directly.
3. **Claims before work.** No agent touches an item, or code, without a claim.
4. **The human releases.** Claims don't silently expire; stale ones are flagged
   and the human decides.
5. **Evidence before done.** Agents *submit*; the human *accepts*.
6. **Ask, don't guess.** Ambiguity becomes a recorded question; the agent moves on.
7. **Never push for the human.** TeamEngage commits and merges locally; pushing
   anywhere is the human's call. The one exception is the human pressing
   **Commit & Push** on the Sync page: it commits only the task folder and
   pushes the plans repo's branch to its upstream (refused while behind);
   **Pull** only fast-forwards. Agents can't reach either, and code repos
   are never pushed.
8. **Minimal agent output.** Tools return IDs and one-liners; detail on request.
9. **Small schema.** Add fields only when a real workflow needs them.

## 3. Concepts

| Concept | Meaning |
|---|---|
| **Workspace** | A root folder that is one plannable unit. `~/de_code` (many repos, one system) is one workspace; `~/code/foo` (a standalone project) is another. Registered per machine in `~/.teamengage/workspaces.yaml`. |
| **Plans repo** | The git repo holding a workspace's plan files. Can be an existing repo (e.g. `~/de_code/Tasks`). It is what desktop and laptop sync through. |
| **Machine** | A host running a daemon (`desktop`, `laptop`). Every claim, session and event records its machine. |
| **Resource** | Anything work touches, declared in `workspace.yaml`, **inside or outside** the workspace root: a local git repo, a remote git URL, an SSH folder on another machine (e.g. a Raspberry Pi), a plain local folder, a URL. See §6.3. |
| **Project** | Optional grouping inside a workspace (`mission_planner`, `andruav`) with its own ID prefix. |
| **Item** | Unit of plannable work. Types: `epic`, `task`, `bug`, `wish`, `spike`, `review`. Lives at workspace level (cross-cutting) or project level (detail). |
| **Edge** | `depends_on`, `parent`, `relates`. `blocks` is derived. Edges may cross projects and workspaces (§4.1). |
| **Turn** | Whose move it is on an item: `human` or `agent`. Drives both inboxes. |
| **Claim** | A session (agent **or human**) holding an item + its targets. Stored as a file in the plans repo so every machine sees it. No auto-expiry: inactive claims become **stale** and wait for the human. |
| **Evidence** | Commits, test output, logs, snapshot diffs, notes attached on submit. |
| **Question / Decision** | Agent asks → human answers → answer becomes a decision inherited by dependent items. |
| **Session** | A registered agent instance: `claude-code@laptop#a1f3`, `gemini-cli@desktop#77b0`. |
| **Event** | Append-only record of every change (who, where, what, when, why). |

## 4. On-disk layout

```
~/.teamengage/                     # per machine, never synced
  machine.yaml                     # machine name (desktop / laptop)
  workspaces.yaml                  # registry: name → root path
  daemon.json                      # pid, port, token (written by daemon)
  clones/                          # managed clones of remote-git resources
  snapshots/                       # pre-claim snapshots of ssh/folder targets

~/de_code/                         # a workspace root
  .teamengage/  (or plans: ~/de_code/Tasks)   # the plans repo — synced via git
    workspace.yaml                 # name, prefixes, projects, resources, links
    items/
      DE/DE-0003.md                # workspace-level item (cross-cutting epic)
      MP/MP-0042.md                # project-level item
      GL/GL-0013.md
    claims/GL-0013.yaml            # one file per live claim (§6.5)
    decisions/D-0007.md
    events/desktop/2026-10.jsonl   # append-only, one stream per machine
    events/laptop/2026-10.jsonl    #   → never a git merge conflict
    .gitignore                     # worktrees/, local state
    worktrees/                     # agent worktrees, machine-local
  droneengage_mavlink/             # repos, untouched by TeamEngage except via worktrees
  droneengage_comm/
```

### workspace.yaml

```yaml
name: droneengage
prefix: DE                       # workspace-level items: DE-0001…
plans: Tasks                     # plans repo path (default: .teamengage)
sync: manual                     # manual | auto  (§6.5)
stale_after: 24h                 # inactive agent claim → flagged stale
projects:
  mission_planner: { prefix: MP }
  global:          { prefix: GL }
  andruav:         { prefix: AN }
resources:
  mavlink:   { kind: git,    path: droneengage_mavlink, base: master }
  comm:      { kind: git,    path: droneengage_comm,    base: master }
  andruav:   { kind: git,    path: ~/AndroidStudioProjects/andruav, base: main }   # outside root
  sdk:       { kind: git,    url: git@github.com:HefnySco/de_sdk.git, base: main } # pull-only
  rpi-field: { kind: ssh,    host: pi@rpi4.local, path: /home/pi/drone_engage, snapshot: true }
  docs:      { kind: folder, path: ~/Documents/de_specs }
  wiki:      { kind: url,    url: https://cloud.ardupilot.org/ }
links:                           # other workspaces this one may reference
  mcp: ~/code/mcp
```

Paths are per machine: if the laptop keeps a repo elsewhere, `~/.teamengage/workspaces.yaml`
on the laptop may override any resource `path`.

### 4.1 Addressing objects

Every object has a stable address; references are flexible:

| Reference | Resolves to |
|---|---|
| `MP-0042` | item in the current workspace (prefix is unique per workspace) |
| `mcp:SL-0007` | item in linked workspace `mcp` |
| `@mavlink` | resource |
| `@mavlink:src/mission/**` | path(s) inside a resource |
| `@rpi-field:/home/pi/drone_engage/config` | path on the Pi |
| `D-0007` | decision |

So a workspace-level epic `DE-0003` ("Protocol v2") can parent
project tasks `GL-0002`, `MP-0110`, `AN-0009`, and depend on an item in
another workspace — all one graph.

### Item file

```markdown
---
id: GL-0013
type: task
title: Mission re-run resets sequence tracking
status: in_progress      # see §5
project: global
targets: ["@mavlink:src/mission/**", "@comm:src/**", "@rpi-field:config/**"]
depends_on: [GL-0012]
parent: DE-0003          # workspace-level epic
priority: 2
version: 7               # bumped by daemon on every write (CAS)
created: 2026-09-20
updated: 2026-10-08
---

## Summary
...technical description for agents...

## Simple
...plain-English version for the human (replaces *.simple.md)...

## Acceptance
- [ ] second AUTO run fires module commands
- [ ] SITL rerun test passes

## Log
<!-- daemon-appended, newest last -->
- 2026-10-08T09:12Z claude-code@desktop#a1f3 claimed
```

`turn` and `blocked` are derived, not stored. The claim itself lives in
`claims/GL-0013.yaml`, so claiming never edits the item file.

## 5. State machine

```
draft ──approve_plan──▶ ready ──claim──▶ in_progress ──submit──▶ in_review ──accept──▶ done
  ▲                       ▲                │    │                    │
  │                       │                │    └─ask──▶ waiting ────┘ (answer → in_progress)
  └──────── reject ───────┴──── release ◀──┘                         reject → in_progress
hold     = human only; draft|ready ──hold──▶ hold ──unhold──▶ ready
                       ready|hold ──to_draft──▶ draft
blocked  = derived: any depends_on not done (in_review counts as done
           unless workspace.yaml review_unblocks: false)
dropped  = human only; ──undrop──▶ draft (re-approval required)
done     = terminal
```

- `turn`: `draft`, `hold`, `in_review`, `waiting` → **human**; `ready`, `in_progress` → **agent**.
- `review_unblocks` (default `true`): a dependency that is submitted
  (`in_review`) unblocks its dependents, so approved work can go on in
  sequence without waiting for each acceptance. `brief` marks such a
  dependency "not accepted yet"; if it is rejected while a dependent is
  started, the inbox shows a `started_on_open_dep` warning. Set `false` to
  require `done`.
- Per task, `unblocks_on` overrides that for the task's dependents:
  `done` makes it a **key task** (🔑 — dependents wait for its acceptance;
  `te key <ID>`, the toggle on the item page), `review` lets them start at
  review even in a strict workspace; unset follows the workspace.
- `hold` parks an item: it is not a draft (the plan is fine), but not for
  agents yet — `next` skips it and `claim` refuses it. `te hold` / `te unhold`
  / `te draft`, or hold / resume / to draft in the UI. A claimed item must be
  released before it can be held.
- `archived` is a **tag, not a status** (`te archive` / `te unarchive`, the
  Archive page in the UI). The item keeps its real status, so dependency
  chains still resolve (an archived `done` dep is still done) and agents see
  it tagged `[archived]` in `brief`. Archived items leave the board, inbox,
  graph, `query` and `next`, and cannot be claimed. Claimed items must be
  released first.
- **Delete** (`te delete <ID> --yes`, delete in the UI) removes an item from
  TeamEngage, not from disk: the tracking file goes, the event log keeps a
  `delete` record, and in overlay mode the task file stays as plain Markdown
  (its `te:` line removed, its path added to `ignore:`). Deleting the file
  itself is the human's own git operation. Refused while claimed or while
  another item depends on it or names it as parent. Milder options first:
  drop (decided against, still listed) and archive (hidden, restorable).
- Only the human performs `approve_plan`, `accept`, `reject`, `drop`,
  `undrop`, `complete`, `hold`, `unhold`, `to_draft`, and `release` of
  someone else's claim.
- `complete` (`te done <ID>`, "mark done" / "already done" in the UI) moves
  any non-done item straight to `done` — for work finished outside
  TeamEngage. No review and no merge: a claim is released, branches are kept.
- `accept` **auto-merges** the item's branches locally (§6.3) — never pushes.
  A merge conflict sends the item back to `in_progress`, turn → agent, with the
  conflict as a log note.
- The human can `claim` too: held by `human`, `next` skips it, targets locked
  against agents until released.
- Agents may *create* items, but only as `draft` (plans and wishes need a human yes).

## 6. Concurrency — the core

### 6.1 One daemon per machine, many clients

```
 Claude Code ─┐ (stdio shim)
 Gemini CLI  ─┤ (stdio shim)          ┌───────────────────────────┐
 Cursor      ─┼──── MCP over HTTP ───▶│ teamengaged (1 per machine)│──▶ plans repo ⇄ git ⇄ other machine
 te CLI      ─┤                       │ index · claims · events    │──▶ worktrees, clones, snapshots
 Web UI      ─┘                       └───────────────────────────┘
```

- `teamengaged` listens on `127.0.0.1` with a token from `~/.teamengage/daemon.json`.
- It speaks **MCP Streamable HTTP**. For IDEs that only launch stdio servers,
  `teamengage mcp` is a thin stdio↔HTTP shim that **auto-starts the daemon** if needed.
- All writes go through one in-process queue → no two writers on this machine
  ever touch a file. Each daemon write is also a small git commit in the plans
  repo (`te: GL-0013 claimed by claude-code@desktop`), so history and sync are free.

### 6.2 Plan-level safety (within a machine)

- **Optimistic concurrency:** every mutating call carries the item's `version`;
  a mismatch returns `conflict` with the fresh item. Agents re-read and retry.
- **Atomic writes:** write temp file → fsync → rename.
- **Claims don't expire.** Every call from the holding session updates
  `last_seen` in the claim. After `stale_after` (default 24h, per workspace) with
  no activity the claim is shown as **stale** in the human inbox; it stays held
  until the human releases or reassigns it. Agent notes are kept on release.
- **Human edits:** the daemon watches files. A hand edit in VS Code is accepted
  as a write by `human`, version bumped, re-indexed. Invalid frontmatter is
  reported in the UI, never silently overwritten.

### 6.3 Code-level safety

Plan safety is not enough — two agents in the same checkout corrupt each other.

- Each item declares `targets`: resource + path globs.
- `claim` **refuses** if another claim (agent or human, any machine known after
  the last sync) has an overlapping target, and returns who holds it and where.
  `next` already skips such items. This logical lock works for every resource kind.
- Isolation and delivery depend on the resource kind:

| Kind | On claim | On accept (auto) |
|---|---|---|
| `git` (local path, in or outside root) | worktree on `te/<ID>-<session>` under `.teamengage/worktrees/`; paths returned to agent | merge into `base` (`--no-ff`), remove worktree, delete branch; mark **not pushed** |
| `git` (remote `url`) | managed clone in `~/.teamengage/clones/` (pulled from its source), then worktree as above | merge in the clone; mark **not pushed** |
| `ssh` (e.g. Raspberry Pi) | snapshot target paths to `~/.teamengage/snapshots/<ID>/<ts>/` + hashes; agent gets `host` + `path` | nothing to merge; evidence = diff vs snapshot + commands/output. `te rollback <ID>` restores the snapshot |
| `folder` | snapshot (optional, `snapshot: true`) | nothing to merge |
| `url` | reference only, never locked | — |

- **Push tracking, not pushing.** After a merge the item shows per-resource
  `not pushed`. The human pushes wherever they want (`git push origin_local`, a
  different remote than the one pulled from, or not at all). The daemon detects
  it by checking `git branch -r --contains <merge>` on fetch and records
  *which remote(s)* now contain the work.
- `submit` records per-target evidence (branch + commits, snapshot diff, test output).
- Merge conflicts on accept are never auto-resolved: item → `in_progress`,
  agent rebases in its worktree and re-submits.
- Worktrees can be disabled per resource (`worktree: false`); then the logical
  lock is the only protection and the agent works in the main checkout.
- The daemon refuses dirty main checkouts at merge time rather than stashing
  the human's uncommitted work.
- Worktrees, clones and snapshots are machine-local. An item claimed on the
  desktop is worked on the desktop; to move it, the agent submits or releases,
  the human pushes the branch, and the other machine re-claims.

### 6.4 Agents are local

Agents run on the human's own machines and reach that machine's daemon on
`127.0.0.1` (Claude Code, Gemini CLI, Cursor, Windsurf, Devin desktop, …).
Remote *hosts* like a Raspberry Pi are **resources** (ssh), not agent hosts.

### 6.5 Multiple machines (desktop + laptop)

Machines share the **plans repo** through git; nothing else is shared.

- **Conflict-free file design.** Claims are one file per item (`claims/<ID>.yaml`),
  events are one stream per machine, and claiming never edits the item file.
  Ordinary syncs therefore merge cleanly.
- **Sync modes** (`sync:` in `workspace.yaml`):
  - `manual` (**default**) — the human pulls/pushes the plans repo as today. The UI
    shows "N local plan commits not pushed / M behind" and claims made since the
    last push are marked *unsynced* — another machine can't see them yet.
    To narrow the race without changing anything local, `claim` first runs a
    read-only `git fetch` of the plans repo (if it has a remote and is reachable)
    and checks the fetched `claims/` for overlaps; it refuses with "claimed on
    laptop by gemini-cli — pull first" instead of creating a double claim.
    Offline, the claim proceeds and is marked *unsynced*.
  - `auto` — before `claim` the daemon pulls the plans repo; after it, it pushes
    the plans repo **only** (never code repos). This shrinks the race window to
    seconds. Applies only to the plans repo, which is TeamEngage's own data.
- **Double-claim race.** If both machines claimed the same item (or overlapping
  targets) before syncing, the merge shows two claims. The daemon keeps the
  earlier one, marks the other **conflicted**, tells that agent on its next call
  to stop and release, and puts it in the human inbox. Its worktree is kept so
  no work is lost.
- **Item edit conflicts** (rare, since claims serialize work on an item): a git
  conflict in an item file is surfaced in the inbox for the human to resolve;
  the daemon never rewrites a file containing conflict markers.

## 7. Agent interface (MCP tools)

All responses are compact text; IDs + one-line titles unless detail is asked for.

| Tool | Purpose |
|---|---|
| `hello(agent, workspace?)` | Register session; returns session id, machine, workspace summary, any claims this agent should resume. |
| `next(limit=3)` | Ready, unclaimed items whose targets are free, best first. |
| `brief(id)` | Exactly what's needed to work: item, outcomes of its deps, inherited decisions, resolved targets (worktree paths, ssh host/path). |
| `claim(id)` / `release(id, note)` | Take / give back an item (+ target locks, worktrees, snapshots). |
| `log(id, note)` | Progress note (also updates `last_seen`). |
| `ask(id, question, options?)` | Raise question → item `waiting`, turn → human. |
| `submit(id, evidence)` | Commits/tests/notes → `in_review`. |
| `propose(items[])` | Create `draft` items/edges (a plan for the human to approve). |
| `query(filter)` | Search by status/type/resource/project/text. |
| `graph(root?, depth?, filter?)` | Mermaid text of a scoped subgraph. |

Plus a generated instruction snippet (`teamengage agents-md`) to drop into
`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`: "call `hello`, then `next`, always
`claim` before editing code, work only in returned worktrees, `ask` instead of
guessing, `submit` — never mark done, never push."

## 8. Human interface

**Web UI** (served by the daemon):
- **Inbox** — questions to answer, drafts to approve, submissions to review,
  stale/conflicted claims, unresolved plan merge conflicts.
- **Graph** — Mermaid render, status-coloured, filter by project/resource/epic.
- **Board** — columns by status; who holds what claim on which machine, claim age.
- **Item** — Simple/technical tabs, log, evidence, decisions, push state per resource.
- **Sync** — plans repo ahead/behind; merged-but-not-pushed work per resource.
- **Activity** — live event stream across all agents and machines.

**CLI** `te`: `te ls`, `te show GL-0013`, `te approve`, `te answer`, `te accept`,
`te claim` / `te release` (human hands-off or freeing a stale claim),
`te rollback`, `te sync`, `te import <folder>`, `te graph`.

## 9. Import of existing plans

`te import ~/de_code/Tasks --dry-run`:
- folder → status (`done/` → done, `partially-done/` → in_progress, …)
- `Depends on:` / `Order: after` lines → `depends_on` (ambiguous ones flagged)
- `X.simple.md` (or `X-simplified.md`) merged into `X`'s `## Simple` section
- filename prefix → type (`TASK`→task, `PLAN`/`PHASE`/`MEGAPLAN`→epic, `REVIEW`→review)
- output: a diff and a list of items needing a human decision.

### 9.1 Overlay mode (track a task folder in place)

`te init --overlay --root ~/de_code/Tasks` makes the task folder itself the
workspace (`mode: overlay`, `commit: false`). Item files under
`Tasks/.teamengage/items/` hold only tracking state plus `source:` /
`simple_source:` — paths relative to the root, identical on every machine.
Content is never copied: `brief` reads the task file live.

- `te import` tags each task file with one frontmatter line, `te: <ID>`;
  that tag is how an item survives renames and moves (into `done/` …).
- The daemon watches the folder and rescans on any `.md` change or pull:
  moved files update `source` (logged), and the inbox shows untracked task
  files (`te import <file>` adopts one; `ignore:` globs silence the rest),
  vanished sources, one id tagged on two files (a copied task), and tags of
  ids this machine doesn't have (pull first).
- `commit: false`: the daemon writes plan files and the human commits them
  with their own Tasks edits. The daemon never commits task files.
- `hello` / `te status` report the handoff state after a best-effort fetch:
  plans behind upstream (agents stop and ask the human to pull), uncommitted
  plan files, and items held on other machines, including claims already
  pushed but not yet pulled.

## 10. Technology

- TypeScript, Node ≥ 22, `@modelcontextprotocol/sdk` (consistent with
  `agent_mcp_simple_list` / `agent_mcp_task_orchestrator`).
- `yaml` + small frontmatter parser, `chokidar` (watch), `fastify` (HTTP),
  plain `git` subprocess (commits, worktrees, merges, fetch), `rsync`/`ssh`
  subprocess (snapshots), Mermaid in the browser.
- Layout: `src/core` (model, state machine, index, validation, mermaid),
  `src/daemon`, `src/mcp`, `src/cli`, `web/`.

## 11. Milestones

| # | Deliverable | Proves |
|---|---|---|
| M1 | `core`: schema, parser, addressing, index, state machine, claims model, validate, mermaid; unit tests | model is right |
| M2 | daemon + MCP tools + stdio shim; claim files, CAS, plans-repo commits | two IDEs on one machine can't collide on tasks |
| M3 | `te import` on `~/de_code/Tasks/global` | real data fits |
| M4 | web UI: inbox, graph, board | human loop works |
| M5 | target locks + worktrees + local auto-merge + push tracking | agents can't collide on code |
| M6 | multi-machine: sync modes, double-claim resolution, per-machine paths | desktop + laptop |
| M7 | remote-git clones, ssh resources + snapshots/rollback, cross-workspace links | Pi, remote repos, `~/code/*` |

## 12. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Agent hosts | Local, on one or more of the human's machines (§6.4, §6.5). |
| 2 | Accept → merge? | Auto-merge locally; conflicts bounce back to the agent (§5, §6.3). |
| 3 | ID scheme | Both: workspace prefix for cross-cutting items, project prefixes for detail; cross-workspace via `ws:ID` (§4.1). |
| 4 | Resources outside root | Yes: local paths, git URLs, ssh folders, plain folders, URLs (§4, §6.3). |
| 5 | Human claims | Yes; human claims lock targets against agents. |
| 6 | Pushing code | Never. Merged work is marked *not pushed*; the human pushes to any remote; the daemon detects and records which remote has it. |
| 7 | Claim lifetime | No auto-expiry. Inactive claims become *stale* (default 24h) and only the human releases them. |
| 8 | SSH snapshots | Yes: snapshot before claim, diff as evidence, `te rollback`. |
| 9 | Plans repo sync | `manual` by default; daemon only does a read-only `fetch` to detect remote claims before claiming. `auto` stays available per workspace (§6.5). |

| 10 | Existing task folders | Tracked in place (overlay, §9.1): the folder is the workspace, files keep their content, one `te:` frontmatter line each. |

## 13. Open questions

None currently.
