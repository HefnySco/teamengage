# team/ — a token-lean Claude Code team for TeamEngage

Six Claude Code **subagents**, each pinned to a model and effort and built on
a `te-*` skill. TeamEngage enforces the tiers they declare at `hello`.

| Name | Model · effort | Tier | Job | Skill |
|---|---|---|---|---|
| **scout** | Haiku · low | light | dispatcher — run as the main session | — |
| **sketch** | Sonnet · medium | standard | plans a direct feature / fix (1–3 tasks) | te-plan |
| **atlas** | Opus · medium | heavy | plans large scope; fixes tasks escalated to heavy; vets light drafts | te-plan, te-work |
| **forge** | Sonnet · medium | standard | codes one task | te-work |
| **lens** | Haiku · low | light | first-pass logic review | te-review |
| **judge** | Sonnet · medium | standard | escalated review | te-review |

## Flow

```
you → scout: "I want X"
scout → sketch | atlas → propose → "GL-0042 created — approve?"
you approve (web UI / te approve)
scout → forge (code) → lens (review) ─ ok ─────────────→ accept (you, or auto under solo)
                                      ├ bounce (names an acceptance item) → forge
                                      └ "needs standard review" → judge
stuck → forge hands off (problem/tried/state/next) → a fresh session continues
each bounce/handoff = 1 attempt · every 2 → tier +1 (→ atlas) · at 5 → hold for you
```

Tunable in `.teamengage/workspace.yaml`: `escalate_after` (2), `max_attempts` (5).
The human can override per task: `te tier GL-0042 heavy [--reset]`.

## Install

```bash
mkdir -p ~/.claude/agents && ln -s ~/teamengage/team/{scout,sketch,atlas,forge,lens,judge}.md ~/.claude/agents/
claude --agent scout          # start the dispatcher as your session
```

## Other LLMs

Any tool that can `curl` joins by declaring its tier at hello — e.g. a small
local model as `{"agent":"qwen","tier":"light"}`. It only sees `light` (or
untiered) tasks, and drafts it proposes wait for a stronger session's `vet`
before they become ready.
