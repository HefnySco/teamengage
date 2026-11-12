# OPS — repeatable playbooks, jobs and targets

Ops turns a runbook (deploy, sync, migrate) into a **playbook**: a YAML
file the daemon can check and `te ops` can run. Each run is a **job**:
TeamEngage records every step in order, the exit code, and the last 100
lines of output. The record lives in the plans repo, so every machine
sees the same history.

The daemon never runs playbook commands. `te ops exec` runs them on the
machine you call it on and posts each result back.

## Concepts

- **Playbook** — `<task folder>/ops/<name>.playbook.yaml`. Ordered
  steps, a default target, who may start it.
- **Target** — a named deployment slot in `workspace.yaml` (`targets:`).
  One live job per target across all machines — a target lock in
  `.teamengage/ops/locks/` enforces it.
- **Job** — one run of a playbook. Stored at
  `.teamengage/ops/jobs/<machine>/<job-id>.yaml`. Job ids are
  `<machine>-<NNNN>`.
- **Steps** — `cmd` and `check` run under bash. `agent` waits for an
  agent to post evidence. `gate` waits for the human. Each step has a
  strict order: results only count at the cursor, in order.
- **Secrets** — env names in `secret_env` are masked (`***`) in the
  output a job posts. The full local log under
  `~/.teamengage/ops-logs/<job>/<step>.log` keeps the real output; it
  never leaves the machine.
- **Pinning** — the job stores the playbook's sha256. Change the file
  mid-job and later results are refused (`OPS_PLAYBOOK_CHANGED`).

## Writing a playbook

```yaml
name: demo-deploy            # required — matches the file name
title: Deploy the demo service
description: Pull, build, deploy, verify
start: human                 # human | agent — who may start a job
min_tier: standard           # least agent tier (only for start: agent)
target: prod                 # default target id from workspace.yaml
cwd: .                       # step working dir, relative to the task folder
secret_env: [DEPLOY_TOKEN]   # env names masked in posted output
version_from: verify         # step whose last output line is the version
params:
  - {name: ref, default: master}
  - {name: build_id, required: true}
steps:
  - id: pull
    kind: cmd                # cmd | check | agent | gate
    run: git pull --ff-only
  - id: build
    kind: cmd
    run: npm ci && npm run build
    timeout: 15m             # default 10m
  - id: deploy
    kind: cmd
    run: ./deploy.sh $ref $build_id
    rollback: ./deploy.sh --undo $ref   # shell run by `te ops rollback`
  - id: smoke
    kind: check              # a check must exit 0 — a probe, not a change
    run: curl -fsS localhost:8080/health
    on_fail: stop            # fail | stop — "stop" ends cleanly, not failed
    optional: true           # optional steps may be skipped with a reason
  - id: signoff
    kind: agent
    instruction: Post the smoke output and the diff range as evidence.
  - id: gate
    kind: gate               # human-only approval
    instruction: Check the dashboard, then approve on the Ops page.
  - id: verify
    kind: check
    run: curl -fsS localhost:8080/version | jq -r .version
```

Field rules `te validate` enforces:

- `run` is required on `cmd`/`check`, forbidden on `agent`/`gate`.
- Step ids are unique.
- `target` names a `targets:` key in `workspace.yaml`.
- `version_from` names a step id.
- `expect_exit` (default 0), `timeout` (default `10m`), `on_fail`
  (`fail` | `stop`, default `fail`), `optional`, `rollback`,
  `instruction`.

Targets in `workspace.yaml`:

```yaml
targets:
  prod:
    title: production host
    service: myapp
    env: prod
    probe: ssh prod 'systemctl is-active myapp'   # read-only version probe the daemon may run
    ssh_opts: -i ~/.ssh/prod_key
```

## Running a job

```bash
te ops list                      # playbooks
te ops targets                   # declared targets
te ops jobs                      # all jobs, every machine
te ops start <playbook> [--target t] [--param k=v]…
te ops exec <job> [--step id]    # run the steps — the only executor
te ops status <job> [--json]     # job + step states
te ops approve <job>             # approve the cursor gate (human only)
te ops resume <job>              # retry a failed job at the cursor
te ops abort <job>               # abort a live job
te ops rollback <job>            # roll back a failed/finished job
te ops exec <job> --json         # machine-readable end state
```

A typical run:

```bash
te ops start demo-deploy --param build_id=214
te ops exec de-laptop-0007       # runs cmd/check; stops at agent/gate
# ... agent posts its step, then:
te ops exec de-laptop-0007       # continues
te ops approve de-laptop-0007    # human gate
```

A failed job keeps its target lock. `te ops resume <job>` retries the
failed step; `te ops abort <job>` ends it; `te ops rollback <job>`
starts a rollback job that runs each passed step's `rollback` command
in reverse order.

## Exit codes (for scripts and CI)

| Code | Meaning | Suggested handling |
|---|---|---|
| 0 | succeeded, stopped, or single-step done | continue |
| 1 | a step failed | alert; inspect `te ops status <job>` |
| 2 | waiting on an agent or gate step | poll later or notify the human |
| 3 | refused — bad order, changed playbook, busy target, usage | retry later or escalate |

## systemd timer example

Runs a nightly job and uses the exit code for service state:

```ini
# /etc/systemd/system/te-ops-nightly.service
[Unit]
Description=TeamEngage nightly ops job
After=network-online.target

[Service]
Type=oneshot
User=deploy
Environment=HOME=/home/deploy
# start the job, then exec it — the service result is the exec exit code
ExecStart=/bin/sh -c 'job=$(te ops start nightly --json | jq -r .id) || exit 3; exec te ops exec "$job"'
# 2 = waiting on an agent/gate — do not count it as a service failure
SuccessExitStatus=0 2
```

```ini
# /etc/systemd/system/te-ops-nightly.timer
[Unit]
Description=Nightly ops job

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now te-ops-nightly.timer
systemctl status te-ops-nightly.service   # shows the exec exit code
```

Treat exit 2 as "parked for a human or an agent" — `te ops status <job>`
says which step waits. Treat 3 as a transient refusal (busy target) or a
real rejection (changed playbook) — `te ops status <job> --json` has the
error field.

## CI example (GitHub Actions)

```yaml
- name: Run ops playbook
  id: ops
  run: |
    job=$(te ops start deploy-staging --param ref=$GITHUB_SHA --json | jq -r .id)
    echo "job=$job" >> "$GITHUB_OUTPUT"
    te ops exec "$job"; code=$?
    [ "$code" -eq 2 ] && { echo "::warning::job waits on a gate — approve it in the Ops page"; exit 0; }
    exit "$code"
- name: Roll back on failure
  if: failure() && steps.ops.outputs.job != ''
  run: |
    te ops rollback "${{ steps.ops.outputs.job }}"
    rb=$(te ops jobs --json | jq -r '.[] | select(.rollback_of=="${{ steps.ops.outputs.job }}") | .id')
    te ops exec "$rb"
```

The pattern: code 1 fails the step and rolls back; code 2 warns and
waits for a human gate; code 3 retries later or fails as a misconfig.

## Machines and envs

Machines and envs record where ops work lands — one file each, synced
with the plans repo. They are documents: no status, no claim.

A machine file is `machines/<id>.machine.md` — frontmatter plus free
markdown notes:

```markdown
---
id: cloud                    # lowercase kebab — 'Cloud-ArduPilot' becomes 'cloud-ardupilot'
title: cloud.ardupilot.org VPS
host: cloud.ardupilot.org
tier: prod
ssh: { user: root, key: ~/.ssh/ardupilot_cloud_key }   # references only — never secrets
roles: [auth-server]
apps:
  - { name: de_auth_2026, port: 19408, env: prod, path: /home/ap_cloud/de_server/droneengage_authenticator }
  - { name: de_auth_shadow, port: 19409, env: shadow, path: /home/ap_cloud/de_server_shadow/droneengage_authenticator }
folders:
  - { path: /home/ap_cloud/de_server, purpose: production app root }
rules:
  - never overwrite server.config in de_server
handled_by:
  skills: [de-cloud-deploy]
edges:
  - { kind: shadow_of, to: rpi5, note: rpi5 is the shadow/demo machine }
---

The auth VPS. The webclient shadow sits on :8002 next to the auth
shadow. See the de-cloud-deploy skill for the full path map.
```

`<id>.machine.local` next to the file is git-ignored (`*.local`) — put
per-runner paths and key paths there; its values replace the shared
file's.

An env file is `envs/<id>.env.md` — one diagram: the expected network,
the machines with their positions, and the reach edges true there:

```markdown
---
id: home
network: [MHEFNY4G]
machines:
  - { id: laptop, row: 0, col: 0 }
  - { id: mhefnydt, row: 0, col: 2 }
  - { id: cloud, row: 1, col: 1 }
reach:
  - { from: laptop, to: mhefnydt, via: ssh }
  - { from: laptop, to: cloud, via: ssh }
---

The home network: laptop reaches the desktop and the VPS.
```

One machine can be in many envs — reach differs per network
(mhefnyDT is only reachable on MHEFNY4G). `te validate` reports an
unknown machine id in an env or an edge, duplicate ids, a secret in an
ssh field and a kind/via outside the lists.

## Where the records live

| What | Path |
|---|---|
| Playbooks | `<task folder>/ops/*.playbook.yaml` |
| Machines | `<task folder>/machines/*.machine.md` (+ git-ignored `*.machine.local`) |
| Envs | `<task folder>/envs/*.env.md` |
| Job records | `.teamengage/ops/jobs/<machine>/<job-id>.yaml` |
| Target locks | `.teamengage/ops/locks/<target>.yaml` |
| Full step logs (local only) | `~/.teamengage/ops-logs/<job>/<step>.log` |

Job files, locks and events sync through the plans repo like every other
TeamEngage record — `te sync` carries them. The ops-logs folder stays on
the machine that ran the steps.
