# AGENTS.md — installing and deploying TeamEngage

You are an AI agent asked to install TeamEngage on a machine, connect it to a
task folder, and make it usable by the human and by other agents. Follow the
steps in order. Every step ends with a **check** — run it; do not continue
on a failed check, report it.

Two things to keep straight the whole time:

| | What | Where | Git |
|---|---|---|---|
| **the tool** | this repository (code) | e.g. `~/teamengage` | `github.com/HefnySco/teamengage` (public) |
| **the plans** | the task folder TeamEngage tracks | e.g. `~/drone_engage/Tasks` | **the human's own private repo** |

Plan data never goes into the tool repository (`.teamengage/` is gitignored
here on purpose). The plans are shared between machines **through their own
git repo** — that is the only sync channel.

---

## 0. Ask the human first

Get these answers before running anything (don't guess):

1. **Task folder path** on this machine (e.g. `~/drone_engage/Tasks`).
2. **Is it already tracked by TeamEngage?** — on another machine, i.e. does
   the task folder's git repo already contain `.teamengage/workspace.yaml`?
   - **yes** → this is a *second machine*: you'll clone/pull and register.
   - **no** → this is the *first machine*: you'll create the workspace and
     the shared git repo.
3. **Git remote for the task folder** (e.g. `git@github.com:<owner>/<repo>.git`,
   private). If none exists yet and this is the first machine, ask the human
   to create an **empty private repository** and give you its SSH URL.
4. **A name for this machine** (e.g. `desktop`, `laptop`) — must differ from
   every other machine using the same plans.
5. Which **agents** will use it here: Claude Code, Devin/Windsurf, others.

## 1. Prerequisites

```bash
node --version        # must be v22 or newer
git --version
```

**Check:** Node ≥ 22 and git present. If Node is older, stop and tell the human.

Linux only — file watching needs enough inotify instances (IDEs use many):

```bash
cat /proc/sys/fs/inotify/max_user_instances     # 128 is too low with several IDEs open
```

If it is ≤ 256, tell the human to run (needs sudo — don't run it yourself):

```bash
echo 'fs.inotify.max_user_instances=1024' | sudo tee /etc/sysctl.d/60-inotify.conf && sudo sysctl --system
```

## 2. Install the tool

```bash
git clone https://github.com/HefnySco/teamengage.git ~/teamengage
cd ~/teamengage
npm ci
npm run build
npm link            # puts `te`, `teamengage`, `teamengaged` on PATH
```

If `npm link` fails on permissions, don't use sudo; use the full path instead
everywhere below:

```bash
te() { node ~/teamengage/dist/cli/main.js "$@"; }
```

**Check:** `te --version` prints a version.

## 3. Name this machine

```bash
mkdir -p ~/.teamengage
echo "name: <machine-name>" > ~/.teamengage/machine.yaml
```

**Check:** `cat ~/.teamengage/machine.yaml` shows the name from step 0.
Claims, events and History lines carry this name — it is how the human sees
which machine an agent worked on.

## 4. Connect the task folder

### 4a. First machine — create the workspace and the shared repo

The task folder must be a git repository with a private remote, so other
machines can share it:

```bash
cd <task-folder>
git rev-parse --show-toplevel 2>/dev/null || git init -b main
git remote -v        # no remote? → add the private repo the human created:
git remote add origin <private-ssh-url>
```

Then create the workspace **in overlay mode** (the task files stay where they
are; TeamEngage adds `.teamengage/` with its tracking state):

```bash
te init --overlay --root <task-folder> --name <workspace-name> --prefix <XX>
```

Open `<task-folder>/.teamengage/workspace.yaml` and add one project per
sub-folder that holds tasks (each gets an ID prefix), e.g.:

```yaml
projects:
  global:          { prefix: GL }
  mission_planner: { prefix: MP }
  webclient:       { prefix: WC }
ignore: [AGENTS.md, CLAUDE.md]
```

Import the existing task files, one project at a time — **dry run first**,
show the human the summary, then apply:

```bash
te import <task-folder>/global --project global            # dry run: what would be created
te import <task-folder>/global --project global --apply
```

This adds one `te: <ID>` line at the top of each task file — expected.

Commit and push **the task folder** (not the tool):

```bash
cd <task-folder>
git add -A . && git commit -m "Track tasks with TeamEngage"
git push -u origin HEAD
```

### 4b. Second machine — clone and register

```bash
git clone <private-ssh-url> <task-folder-parent>     # or `git pull` if already cloned
grep '^name:' <task-folder>/.teamengage/workspace.yaml   # the workspace's name
te init --overlay --root <task-folder> --name <that-name>   # keeps workspace.yaml, registers it here
```

Do **not** run `te import` here — the items already exist in `.teamengage/`.

**Check (both cases):**

```bash
cat ~/.teamengage/workspaces.yaml      # lists the workspace with root = <task-folder>
te validate | head                     # loads; findings are fine, errors about parsing are not
```

## 5. Start the daemon

One daemon per machine, on `127.0.0.1:4747` (loopback only). Any `te`
command that needs it starts it in the background automatically (that's why
`te import` worked) — before installing the service below, stop that one:

```bash
[ -f ~/.teamengage/daemon.json ] && kill "$(node -e 'console.log(require(process.env.HOME+"/.teamengage/daemon.json").pid)')" 2>/dev/null; sleep 1
```

```bash
te daemon            # foreground — fine for a first test, Ctrl+C to stop
```

To keep it running, install a user service (Linux):

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/teamengaged.service <<EOF
[Unit]
Description=TeamEngage daemon
[Service]
ExecStart=$(command -v node) $HOME/teamengage/dist/daemon/main.js
Restart=on-failure
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now teamengaged
```

**Check:**

```bash
curl -s http://127.0.0.1:4747/agent | head -3      # the agent protocol text
te status                                          # inbox counts for the human
te ui                                              # prints (and opens) the web UI URL
```

The web UI link contains a login token that changes on every daemon restart;
`te ui` always prints a fresh one.

## 6. Tell the agents how to work

Agents talk to TeamEngage over plain HTTP — **no MCP needed**:
`curl http://127.0.0.1:4747/agent` prints the full protocol.

In the task folder (skip if already committed there from the first machine):

```bash
cd <task-folder>
{ echo '<!-- generated by `te agents-md` — regenerate rather than hand-edit -->'; te agents-md; } > AGENTS.md
echo '@AGENTS.md' > CLAUDE.md          # Claude Code reads CLAUDE.md, which imports AGENTS.md
```

Make sure `workspace.yaml` has `ignore: [AGENTS.md, CLAUDE.md]` (so they are
not treated as tasks), then commit both files.

### Skills (recommended)

Three skills ship in `skills/`, same `SKILL.md` format for Claude Code and
Devin:

| Skill | Use |
|---|---|
| `te-work` | implement / continue / pick up a task (hello → claim → log/ask → submit) |
| `te-plan` | break a goal into tasks with one `propose` call |
| `te-tag` | tag untagged tasks with domains (plan → human's OK → apply) |

```bash
mkdir -p ~/.claude/skills
ln -s ~/teamengage/skills/te-work ~/teamengage/skills/te-plan ~/teamengage/skills/te-tag ~/.claude/skills/
# Devin: link the same three folders into the Devin skills folder (~/.config/devin/skills/)
```

### Claude Code guard (recommended)

Enforces the rules even when an agent ignores the instructions (no hand
edits to `.teamengage/`, no changing `te:` lines, no moving files into
`done/`, no `git push` from the task folder):

```bash
te hooks --install          # merges into ~/.claude/settings.json, keeps other settings
```

Takes effect in new Claude Code sessions. `te hooks --uninstall` removes it.

### Devin / Windsurf

Add a short section to the global rules (`~/.codeium/windsurf/memories/global_rules.md`)
telling Devin that tasks in `<task-folder>` are tracked by TeamEngage, to read
`<task-folder>/AGENTS.md` first, to use `curl http://127.0.0.1:4747/agent`, and
to use the skills above. Show the human the text before saving it.

**Check:** start an agent session and have it run

```bash
curl -s -X POST http://127.0.0.1:4747/agent/hello -d '{"agent":"setup-check"}'
```

It should print a session token, the workspace, and a `rules:` line.

## 7. Daily sync between machines (tell the human)

Work is coordinated through the task folder's git repo:

- **Before working:** `git pull` in the task folder. An agent's `hello`
  prints `plans behind … — STOP` when this machine is behind.
- **After working:** commit `<task-folder>` (task files + `.teamengage/`)
  and `git push`. TeamEngage never commits or pushes on its own in overlay
  mode — the human decides.
- The human can do both from the web UI: **Sync** page → **Pull**
  (fast-forward only) and **Commit & Push** (commits only the task folder,
  refused while behind). The `sync` tab shows a badge when there is
  something to pull or push. Agents must not press these or push themselves.
- Work isn't meant to run on two machines at the same time on the same
  task; claims show which machine holds what.

## Updating the tool later

```bash
cd ~/teamengage && git pull && npm ci && npm run build
systemctl --user restart teamengaged      # or stop/start `te daemon`
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| web UI shows `{"error":"unauthorized"}` | the daemon restarted; open a fresh link from `te ui` |
| `EMFILE: too many open files, watch` | inotify limit — see step 1 |
| `te: command not found` | `npm link` didn't run or isn't on PATH — use `node ~/teamengage/dist/cli/main.js` |
| `no plans repo with workspace.yaml under …` | wrong `--root`, or the task folder wasn't pulled yet |
| an agent says `plans behind upstream` | `git pull` in the task folder, then `hello` again |
| a task file isn't shown / "untracked task file" in the inbox | it has no `te:` line — `te import <file> --project <p> --apply`, or add it to `ignore:` |

## Never

- put plan data (`.teamengage/`, task files) into the tool repository;
- push the task folder's repo, or anything, without the human's OK;
- run `te import` again on a machine whose plans came from git;
- edit files under `.teamengage/` by hand — use `te` / the web UI / the agent API;
- run commands with `sudo` — hand those to the human.

More: `docs/DESIGN.md` (concepts), `docs/AGENTS-SETUP.md` (agent protocol
details), `docs/TASK-FORMAT.md` (task file format).
