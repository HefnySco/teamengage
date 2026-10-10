# skills/ — agent skills

Ready-to-install skills (standard `SKILL.md` format, works for Claude Code
and Devin) that teach an agent how to work with a TeamEngage task bank over
plain HTTP.

| Skill | Use |
|---|---|
| `te-work/` | Implement / continue / pick up a task: hello → claim → log/ask → submit. |
| `te-plan/` | Break a goal into new tasks with a single `propose` call. |
| `te-tag/` | Tag untagged tasks with domains: propose a plan, get the human's OK, apply. |

Install by symlinking these folders into the agent's skills directory
(`~/.claude/skills/`, `~/.config/devin/skills/`).
