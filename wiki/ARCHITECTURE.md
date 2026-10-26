# TeamEngage — How It Works

A technical walkthrough of the system as implemented. For the *why* see
[docs/DESIGN.md](../docs/DESIGN.md) — this document is about the *how*:
processes, data flow, files, and where each piece lives in `src/`.

---

## 1. The big picture

TeamEngage is a coordination layer between **one human** and **many local AI
agents** (Claude Code, Devin, Gemini, Cursor, …) working on the same plans.
Plans are Markdown files in a git repo. Agents never edit plan state
directly — every state change goes through a single local daemon that
serializes writes, enforces claims, and records events.

```
 agents (CLI processes on this machine)
   ├── plain HTTP   ──► /agent/*        (curl; no setup)
   ├── MCP stdio    ──► te mcp (shim) ──► /mcp  (Streamable HTTP)
   └── te CLI       ──► /api/*          (bearer token)
                        │
              ┌─────────▼──────────┐
              │  teamengaged       │   one per machine, 127.0.0.1:4747
              │  Fastify server    │
              │                    │
              │  PlansStore ───────┼──► plans repo (files + git commits)
              │  PlansWatcher      │      ⇅ git remote ⇅ other machines
              │  OverlayTracker    │
              │  SessionRegistry   │──► worktrees, clones, snapshots
              │  EventBus (SSE)    │──► web UI (web/ served by daemon)
              └────────────────────┘
```

Two invariants hold the design together:

- **Files are the truth.** Items, claims, decisions and events are plain
  files in the plans repo. The daemon indexes them; the repo is also the
  sync channel between machines.
- **One writer per machine.** All mutations funnel through one in-process
  queue inside `PlansStore`. Agents never write plan files.

## 2. Process model

Three entry points ship from `package.json` `bin`:

| Binary | Entry | Role |
|---|---|---|
| `te`, `teamengage` | `src/cli/main.ts` | Human CLI; thin client over HTTP |
| `teamengaged` | `src/daemon/main.ts` | The daemon — does everything |
| `te mcp` | `src/mcp/shim/shim.ts` | stdio→HTTP MCP shim for IDEs |

### 2.1 Daemon lifecycle

`src/daemon/main.ts` boots:

1. Ensures `~/.teamengage/` exists; creates `machine.yaml` from the hostname
   on first run.
2. Loads `workspaces.yaml` (the per-machine registry of workspace name →
   root path) and, for each workspace: resolves config, opens a
   `PlansStore` (builds the in-memory `Index` from the plans dir), loads
   linked workspaces, starts a `PlansWatcher`, and — in overlay mode — an
   `OverlayTracker`.
3. Checks `~/.teamengage/daemon.json` — if a healthy daemon already answers
   `/health`, the second instance prints its URL and exits (this makes
   "auto-start the daemon" idempotent for the CLI and shim).
4. Starts the Fastify server via `startDaemon()` in
   `src/daemon/server/server.ts`.

`startDaemon()`:

- Reads or mints a stable auth token in `~/.teamengage/token` (0600), so
  browser sessions survive daemon restarts.
- Installs a global `onRequest` hook: everything except `/health` and
  `/agent/*` requires the token — as `Authorization: Bearer`, `?token=`,
  or the `te_token` cookie the UI plants after a `?token=` login.
- Binds **loopback only** on port 4747 (`TE_PORT` overrides; a busy port
  falls back to a random one).
- Writes `{pid, port, token}` to `daemon.json` (0600) and removes it on
  clean shutdown. SIGTERM/SIGINT drain queued writes before exit
  (`forceCloseConnections` so SSE clients can't hold shutdown open).

Route registration then layers the interfaces on one Fastify app
(`main.ts` `register` callback): `registerApiRoutes` (human API),
`registerEventRoutes` (SSE), `registerUiRoutes` (static web UI),
`registerAgentRoutes` (plain-HTTP agent API), `registerMcpRoutes` (MCP).

A 60-second timer runs `WorkspaceOps.autoAccept()` per workspace — in
`solo` autonomy this accepts submissions whose `ok` peer review has aged
past `auto_accept_after`.

### 2.2 CLI and shim auto-start

Both `src/cli/client.ts` and the shim share the same pattern:
`runningDaemon()` reads `daemon.json`, probes `pid` liveness, and GETs
`/health` with the token. If nothing answers, they spawn
`dist/daemon/main.js` detached and poll for up to 30 s. Any `te` command
therefore "just works" — no service is strictly required.

## 3. Data on disk

```
~/.teamengage/                     per machine, NEVER synced
  machine.yaml                     name + run: { coder, reviewer, ... }
  workspaces.yaml                  registry: name → root path (+ path overrides)
  daemon.json, token               pid/port/token (0600)
  clones/<ws>/<res>/               managed clones of url-type git resources
  snapshots/<item>/<ts>/           pre-claim snapshots of ssh/folder targets

<plans repo>/                      the synced state — usually .teamengage/
                                   under the workspace root, or the task
                                   folder itself in overlay mode
  workspace.yaml                   name, prefixes, projects, resources,
                                   links, sync mode, autonomy, stale_after
  items/<PREFIX>/<ID>.md           item meta (frontmatter) + sections
  claims/<ID>.yaml                 one file per live claim
  decisions/D-NNNN.md              answered questions
  events/<machine>/<YYYY-MM>.jsonl append-only event log, one stream per
                                   machine so merges never conflict
  worktrees/                       agent worktrees (gitignored, local)
```

Two workspace **modes**:

- **Canonical**: TeamEngage owns `items/` — the Markdown files are the
  records themselves.
- **Overlay** (`mode: overlay`): an existing task folder (e.g.
  `~/drone_engage/Tasks`) is tracked in place. Files under
  `.teamengage/items/` hold only tracking meta plus `source:` /
  `simple_source:` relative paths; `brief` reads the real task file live.
  `te import` tags each task file with a one-line `te: <ID>` frontmatter —
  the tag is what lets an item survive renames and moves (into `done/`, …).
  With `commit: false` the daemon *stages* (`git add`) but never commits;
  the human commits via the Sync page or their own git.

### 3.1 Item

An item file is Markdown with YAML frontmatter (`id`, `type`, `status`,
`targets`, `depends_on`, `parent`, `priority`, `version`, …) plus `##`
sections (Summary, Simple, Acceptance, Notes, Review, Evidence, Walkthrough, Log).
`turn` and `blocked` are derived, never stored. `version` is a CAS counter
the store bumps on every write.

Item types: `epic` (a plan — parents children, never claimable), `task`,
`bug`, `wish`, `spike`, `review`, and `idea` (a source document — plan
*from* it, never claim it).

### 3.2 Claim

`claims/<ID>.yaml` records: item, holder session (`agent@machine#hex`),
machine, resolved per-resource paths, `created`/`last_seen`, sync flag.
Claims **never expire**: after `stale_after` (default 24 h) with no
activity they show as *stale* in the human inbox but stay held until
released. Claiming never touches the item file — one reason sync merges
stay clean.

### 3.3 Events

Every committed mutation appends JSON lines to
`events/<machine>/<YYYY-MM>.jsonl`. Because streams are per-machine, git
merges of the log are conflict-free. Events get ids `machine|ts|seq` and
feed the SSE bus and the human's Activity view.

## 4. The write path

`PlansStore` (`src/daemon/store/store.ts`) is the only code allowed to
change plan files. Every mutation follows the same pipeline:

```
API/tool call
  → store.enqueue(job)            single promise-chained queue per workspace
    → CAS check: caller's version vs indexed meta.version   → ConflictError
    → state machine transition()  (src/core/state/machine.ts — PURE)
        returns { meta', logLines, events, effects, writes, deletes }
    → writeFileAtomic()           temp → fsync → rename (store/atomic.ts)
    → append events to this machine's .jsonl stream
    → git commit in the plans repo ("te: GL-0013 claimed by claude@desktop#a1f3")
        — skipped/staged-only under overlay commit:false
    → bus.publish(event)          → SSE clients
    → return { effects, external } → WorkspaceOps executes external effects
        (worktree add/remove, snapshot, merge) OUTSIDE the queue
```

Key properties:

- **Optimistic concurrency**: mutating calls carry `version`; mismatch →
  `ERROR CONFLICT` with the fresh item, agent re-reads and retries.
- **Pure state machine**: `transition(actor, action, item)` decides
  legality and emits *effects* — declarative descriptions of side effects.
  The daemon executes them after the commit, so the plans repo is never
  half-written if a worktree or merge fails.
- **Daemon writes are invisible to the watcher**: `store.onFileWrite`
  records a sha256 of every file the store writes/deletes; `PlansWatcher`
  suppresses its own change events by hash (a `DELETED` sentinel marks
  daemon deletes).

## 5. The state machine

Statuses: `draft → ready → in_progress → in_review → done`, plus
`waiting` (question pending), `hold` (parked), `dropped`. `archived` is a
tag, not a status — dependency resolution still sees the real status.

Actors: `human`, `agent`, `daemon`. The machine enforces the split —
`approve_plan`, `accept`, `reject`, `drop`, `hold`, `archive`, `star`,
`close_plan`, `change_answer` are human-only; agents get `claim`,
`release`, `log`, `ask`, `submit`, `review`, `bounce`, `withdraw`,
`propose`, `edit` (drafts, planner tiers), `flag_drop`, `handoff`, `vet`.

Notable mechanics (`src/core/state/machine.ts` + DESIGN §5):

- **AI peer review** (`ai_review`): a *non-holder* session records
  `ok|issues` on an `in_review` item — advisory only, status untouched.
  `bounce` sends clearly broken work back to `in_progress` (claim kept),
  capped at 2 in a row, then only verdicts are allowed.
- **Takeover**: an `in_review` item carrying an `issues` verdict can be
  `claim`ed by any session *on the claim's machine* — the worktree is
  machine-local, so cross-machine takeover is refused (such items get
  released to `ready` instead).
- **Dependency gating**: `blocked` = any `depends_on` not done, where
  `in_review` counts as done unless `review_unblocks: false`. Per item,
  `unblocks_on: done` marks a *key task* (dependents wait for acceptance).
- **Tiers & attempts**: agents declare a model tier at `hello`; items can
  require a tier. Bounces/handoffs count as attempts — past
  `escalate_after` the required tier rises, at `max_attempts` the item
  waits for the human.
- **Solo autonomy** (`autonomy: solo`): dependent follow-up proposals land
  `ready` without approval; `ok`-reviewed submissions auto-accept after
  `auto_accept_after` — the same local merge, never a push. Key tasks and
  `auto_accept_off` are exempt.

## 6. Code-level safety — targets, claims, worktrees

Plan-level locking isn't enough; two agents in one checkout corrupt each
other. So items declare `targets` = `@resource:path-glob`, and `claim`:

1. Checks the in-memory index for overlapping claims (any machine known
   after last sync) → `CLAIM_REFUSED` naming the holder.
2. In `manual` sync mode, runs a **read-only `git fetch`** of the plans
   repo first and re-checks the fetched `claims/` (`checkRemoteClaims` in
   `src/daemon/sync/sync.ts`) — refuses with "pull first" if another
   machine already holds it. Offline → claim proceeds, flagged *unsynced*.
3. Emits effects that `src/daemon/effects/effects.ts` executes per
   resource kind:

| Kind | On claim | On accept |
|---|---|---|
| `git` (local path) | `git worktree add` on branch `te/<ID>-<session>` under `worktrees/` | `merge --no-ff` into `base`, remove worktree, delete branch, mark **not pushed** |
| `git` (`url:`) | managed clone in `~/.teamengage/clones/`, then worktree | merge inside the clone; not pushed |
| `ssh` | rsync snapshot of target paths + hashes into `~/.teamengage/snapshots/` | nothing to merge — evidence is diff-vs-snapshot; `te rollback` restores |
| `folder` | optional snapshot | — |
| `url` | reference only, never locked | — |

- Accept **auto-merges locally but never pushes**. The daemon detects
  pushes afterwards via `git branch -r --contains <merge>` on fetch and
  records which remote(s) carry the work.
- Merge conflicts are never auto-resolved: item → `in_progress`, turn →
  agent, conflict recorded in the log; the agent rebases and resubmits.
- A dirty main checkout refuses merge rather than stashing the human's
  work. `worktree: false` on a resource disables isolation (logical lock
  only, agent works in the main checkout).

## 7. Agent interfaces — two surfaces, one implementation

All agent tools are registered once by `registerReadTools` /
`registerWriteTools` (`src/mcp/tools/*.ts`) against a `registerTool`
interface. Both surfaces reuse the same handlers:

- **MCP** (`src/mcp/server/mcp.ts`): mounted at `/mcp`, bearer auth via the
  global hook. One Streamable-HTTP transport = one `AgentBinding` keyed by
  `mcp-session-id`; `hello` binds a TeamEngage session to the connection —
  tools never take credentials. Server `instructions` carry the workflow
  rules into the client's system prompt. Transport `onclose` disconnects
  the session (claims stay, becoming rebindable).
- **Plain HTTP** (`src/agent/http.ts`): `/agent/<tool>[/<id>]`, GET or
  POST with a JSON body (a catch-all content-type parser accepts whatever
  curl sends). `collectTools()` harvests the same registrations through a
  fake `McpServer`. `POST /agent/hello` runs the real `hello` handler,
  then mints an `X-TE-Session` token into an in-memory map. No daemon
  token needed — instead the routes **refuse browsers**: non-loopback
  `Host` (DNS rebinding) or any `Origin` header → 403. `GET /agent`
  renders the whole protocol as copy-paste text.
- **stdio shim** (`te mcp`, `src/mcp/shim/shim.ts`): IDEs that only spawn
  stdio servers get a proxy that forwards JSON-RPC verbatim over
  Streamable HTTP, auto-starts the daemon, reconnects and replays the last
  `hello` after a daemon restart, and sends `x-te-client-pid` so the
  daemon can probe IDE liveness (`SessionRegistry.isLive` — a dead pid
  makes the session dead and its claims rebindable; transport close or
  `bye` does it cleanly).

Responses are compact text: `claimed WS-0001 v2`, or
`ERROR <CODE>: msg` mapped to HTTP status (`CONFLICT`→409, `USAGE`→400,
`NO_SESSION`→401, `FORBIDDEN`→403…). `brief` is the only verbose tool —
it returns everything needed to work: meta, summary, acceptance, dep
outcomes, inherited decisions, resolved target paths.

## 8. Watchers — human edits and file moves

Two chokidar watchers run per workspace (`src/daemon/main.ts`):

- **`PlansWatcher`** (`watch/`): watches the plans dir. Own-writes are
  suppressed by content hash; anything else is a *human edit* — parsed,
  accepted as a write by `human` (version bump + event + reindex). Files
  with parse errors or git conflict markers are marked invalid in the
  index and surfaced as findings — never silently rewritten. Claim-file
  add/unlink triggers `reconcile()` (double-claim resolution, §9). Delete
  of an item file removes it from the index.
- **`OverlayTracker`** (`overlay/`): overlay mode only — watches the task
  folder itself (non-dot `.md` files). On any add/change/unlink it
  debounces then **rescans the whole tree** (`scanTaskTree` +
  `overlayReport` in `src/core/files/source.ts`): files moved by `te:`
  tag update their item's `source` (logged); untracked task files,
  vanished sources, duplicate tags and unknown tags become inbox
  findings. A full rescan is a few hundred reads — simpler and more
  robust than pairing unlink/add into moves.

Findings flow through `EventBus.notify()` (typed SSE events: `watch`,
`reconcile`, `auto_accept`) so the web inbox refreshes live.

## 9. Multi-machine sync

Machines share only the **plans repo**, through its own git remote.

- **manual** (default): human pulls/pushes. The UI shows ahead/behind;
  claims made since the last push are marked *unsynced*. Fetch-before-claim
  (§6) narrows the race.
- **auto**: daemon pulls the plans repo before `claim` and pushes it after
  — only the plans repo, which is TeamEngage's own data.
- **`te sync`** (`src/daemon/sync/`): the human's one-command bridge.
  Pulls/commits/pushes the plans repo, then for every git resource and
  `repos:` entry pushes the base branch (accepted merges) and every open
  `te/<ID>-*` branch, and prunes remote branches of merged tasks.
  Fast-forward only — diverged branches and dirty checkouts are reported,
  never merged. `sync_remotes:` pins which remotes are used (never a
  public `upstream`). `--leave` first releases this machine's in-progress
  claims, WIP-committing their worktrees so the next machine's claim
  resumes on those commits. `--dry-run` reports without changing.
- **Double-claim reconciliation**: when a pull merges two claims for the
  same item (or overlapping targets), `resolveDoubleClaim` keeps the
  earlier claim, marks the loser *conflicted*, tells that agent on its
  next call to stop and release, and puts it in the human inbox. The
  loser's worktree is kept — no work lost.

## 10. `te run` — the foreman

`src/cli/commands/run.ts` drives the configured agent CLIs (from
`machine.yaml` `run:` — a `coder`, an optional `reviewer`, `concurrency`,
`fix_rounds`). The policy is the pure function `pickNext`: **reviews
first** (they unblock the human), then fixes for `issues` verdicts, then
resumes of this-machine coder claims, then new `ready` work. It spawns
the CLI with a generated prompt (`promptFor`) that points it at
`127.0.0.1:4747/agent` — the agents perform hello/claim/submit/review
themselves over plain HTTP, so the same locks and rules apply as in a
hand-started session. `te run` stops when only the human can move things;
`te run --watch` + `te wait --notify` keep it running and ping the human.

## 11. Enforcement in depth

Instructions are soft; three layers make rules hard to bypass
(`te hooks --install` merges these into `~/.claude/settings.json`):

- **Every session sees the rules**: MCP `instructions` + the `rules:` line
  in every `hello` reply.
- **PreToolUse guard** (`src/cli/commands/guard.ts`): Claude Code hook
  that refuses writes under `.teamengage/`, hand-created task files,
  `te:`-line edits, non-additive task edits, `sed -i`/`git push`-style
  shell commands in the workspace. Fails open on error; `TE_GUARD=off`
  disables per session.
- **The watchers** still report whatever slips through (untracked files,
  duplicate `te:` tags, vanished sources).

## 12. Source map

| Path | Contents |
|---|---|
| `src/core/model/` | Zod-free plain types: item, claim, session, event, workspace, decision, errors |
| `src/core/state/machine.ts` | Pure transition function — all legality, effects out |
| `src/core/index/` | In-memory index of items/claims/graph; `blocked`/`turn`/plan derivation |
| `src/core/files/` | Markdown/frontmatter parser+serializer, source-file ops (te: tag, sections), task template + `AUTHORING_RULES` |
| `src/core/claims/` | Claim file format, target-overlap check, double-claim resolution |
| `src/core/address/` | `@res:glob`, `ws:ID` ref parsing; renumbering |
| `src/core/events/` | Per-machine append-only JSONL log |
| `src/core/config/` | `~/.teamengage` config, workspace.yaml loading, links |
| `src/core/{validate,mermaid,domains}` | Consistency findings, graph rendering, domain tags |
| `src/daemon/store/` | PlansStore (single-writer queue, CAS, commits) + atomic write |
| `src/daemon/watch/` | Plans dir watcher (human edits, invalid files, claim changes) |
| `src/daemon/overlay/` | Task-folder tracker (moves, findings) |
| `src/daemon/server/` | Fastify bootstrap, token auth, daemon.json, graceful shutdown |
| `src/daemon/api/` | Human REST API, ops (claim/submit/accept pipeline, auto-accept), SSE bus, UI statics |
| `src/daemon/sessions/` | Session registry, pid-liveness, rebind |
| `src/daemon/effects/` | Effect executor: worktrees, clones, ssh/folder snapshots, merges |
| `src/daemon/links/` | Cross-workspace references |
| `src/daemon/sync/` | Plans-repo fetch/push, remote-claim check, `te sync` code sync, handoff |
| `src/mcp/` | MCP server on `/mcp`, tool registrations, stdio shim, output format |
| `src/agent/http.ts` | Plain-HTTP agent API reusing the same tool handlers |
| `src/cli/` | `te` commands: daemon client, init/import/run/guard/domains/actions/read |
| `src/resources/git/` | git subprocess wrapper: worktrees, merges, fetch, contains |
| `src/import/` | Legacy Markdown task-folder importer |
| `web/` | Preact+htm SPA (no build framework; esbuild bundle), served by the daemon |
| `skills/` | Agent skill packs: te-work, te-review, te-plan, te-tag, te-analysis |
| `team/` | `te run` setup docs and prompts |

## 13. Technology choices (and why)

- **TypeScript / Node ≥ 22**, ESM, `tsc` build; `vitest` tests sit next to
  sources (`*.test.ts`).
- **Fastify** — one HTTP server hosting API + MCP + agent routes + UI.
- **`@modelcontextprotocol/sdk`** — Streamable HTTP server + client (shim).
- **chokidar** — file watching with `awaitWriteFinish` debounce.
- **yaml** + a small hand-rolled frontmatter parser — item files stay
  human-diffable.
- **zod** — tool input schemas shared verbatim between MCP and `/agent`.
- **git / rsync / ssh as subprocesses** — no libgit2; every operation maps
  to what the human would type, and *never* pushes on its own.
- **Preact + htm + mermaid**, bundled by esbuild — the UI ships as static
  files inside the daemon, no separate frontend server.
