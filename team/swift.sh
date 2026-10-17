#!/usr/bin/env bash
# swift — run one TeamEngage task on Devin's SWE-2 (headless), print one line.
# usage: swift.sh <ID> [work|review]     (run from the task folder)
set -euo pipefail
id="${1:?usage: swift.sh <ID> [work|review]}"
mode="${2:-work}"
model="${SWIFT_MODEL:-swe-2-high}"
case "$mode" in
  work)   skill="te-work to implement $id";  reply="$id in_review | $id handed off: <problem> | $id waiting: <question>" ;;
  review) skill="te-review to review $id";   reply="$id ok | $id bounced: <acceptance item> | $id issues: <summary>" ;;
  *) echo "mode must be work|review" >&2; exit 2 ;;
esac
exec devin -p --model "$model" --permission-mode accept-edits -- \
"Use $skill. Say hello as {\"agent\":\"swift\",\"tier\":\"standard\"}.
Do only this task, within its Touches and acceptance. If it is in_review with an issues verdict, claim it (takeover), read ## Review and fix that. If brief shows failed attempts, read handoff notes and ## Review first.
When stuck (same error twice, no progress) call handoff with problem/tried/state/next and stop.
Never edit .teamengage/ or te: lines, never git push, never approve or accept.
Final reply: exactly one line — $reply"
