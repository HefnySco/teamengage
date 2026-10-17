# swift — Devin SWE-2 coder (not a Claude subagent)

**swift** is the team's main coder: Devin's SWE-2 High (free on the
account), tier `standard` — Sonnet-class. It runs as a headless Devin process,
so Scout calls it with Bash instead of the Agent tool:

```bash
te-swift GL-0042          # code it
te-swift GL-0042 review   # or review it (a second model's opinion)
```

Run from the task folder. It prints one line (`GL-0042 in_review`, `… handed off: …`,
`… waiting: …`). `SWIFT_MODEL=swe-2-max` for a harder task (also free).

Not covered by the Claude Code guard hook — the daemon still refuses illegal
state changes, and the prompt forbids `.teamengage/` edits and pushes.
Resume a run to look inside: `devin list`, then `devin -r <session-id>`.

Install (puts `te-swift` on PATH; needs `devin` on PATH and `devin auth login`):

```bash
ln -s ~/teamengage/team/swift.sh ~/.local/bin/te-swift
```
