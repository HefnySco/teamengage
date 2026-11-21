---
name: te-discuss
description: Save a chat as a TeamEngage discussion — distill it into sections, capture it with its raw transcript, then find it later, plan from it with relates, or promote its guidelines and decisions to lessons and D-records the human approves. Use when asked to "save this chat", "capture this discussion", "what did we discuss", "plan from a discussion / DISC-...", or "promote this guideline".
---

# te-discuss — save chats and plan from them

**Writing rule — ASD-STE100, always.** Every text you write in TeamEngage —
the distilled `sections` of a capture, `note`, `ask`, `simple`, the titles
and summaries of tasks you propose — is ASD-STE100 Simplified Technical
English: short sentences, one idea each, active voice, plain approved
words, one word per meaning. Technical names (files, functions, field
names) stay as-is.

A **discussion** (`DISC-NN-<slug>.md`) is a saved chat: a distilled layer
(`## Summary`, `## Participants`, `## Context`, `## Key points`,
`## Decisions reached`, `## Open questions`, `## Guidelines`, `## Actions`,
`## Artifacts`, `## Notes`) plus the raw transcript in a linked
`DISC-NN-<slug>.transcript.md`. It is a **source document** like an idea —
it is never claimed and never goes to done; tasks plan from it through
`relates`.

Everything is plain HTTP on the local daemon — no MCP needed:

```bash
B=http://127.0.0.1:4747/agent
T=$(curl -s -X POST $B/hello -d '{"agent":"<your-name>"}' | tee /dev/stderr | sed -n 's/^token //p')
H="X-TE-Session: $T"
```

## 1. Save the current chat

Distill first, capture second. The distilled sections are what `search`
and `brief` see — write them well.

1. **Write the distilled sections in STE.** Read the chat and condense it:
   - `Summary` — 2–4 sentences: what the chat was about and where it ended.
   - `Participants` — who took part, with models: "devin (swe-2-high),
     claude (sonnet), the human".
   - `Context` — what the reader needs that is not in the chat.
   - `Key points` — the facts, options and trade-offs that came up.
   - `Decisions reached` — what was decided, one line each.
   - `Open questions` — what stayed unanswered.
   - `Guidelines` — rules the chat agreed agents should follow.
   - `Actions` — follow-ups worth tracking.

   Skip a section that has nothing to say. Never paste the raw chat into a
   section — the transcript covers that.
2. **Scan for secrets.** Look at the transcript for API keys, tokens,
   passwords and private keys. `capture` refuses on a hit and names the
   lines — fix them first, or pass `redact: true` (each hit becomes
   `[REDACTED]`) or `sensitive: true` (kept; the artifact is tagged
   `!sensitive`). Either way the transcript goes into the plans git repo —
   prefer `redact`.
3. **Capture.** Give the transcript as a file (preferred) or inline text.
   A Claude Code JSONL export converts to Markdown turns by itself — tool
   calls and tool results land as one-line summaries (name, first
   arguments, size), so the file that joins the plans repo stays small.
   `keep_raw: true` also writes the untouched export gzipped under
   `~/.teamengage/transcripts/<ws>/` — this machine only, never in git.

```bash
curl -s -X POST $B/capture -H "$H" -d '{
  "title": "Restart flag design chat",
  "project": "global",
  "domains": ["mavlink"],
  "summary": "We picked the latch design for mission restarts.",
  "participants": "devin (swe-2-high), the human",
  "sections": {
    "Key points": "- a counter survives a replay\n- the flag resets on upload",
    "Decisions reached": "- use the latch, not the counter",
    "Guidelines": "- always clear latched events on restart"
  },
  "transcript_path": "chats/2026-11-19-restart.jsonl",
  "redact": true
}'
```

The reply gives the `DISC-NN` id and the file. The transcript sits beside
it as `DISC-NN-<slug>.transcript.md`, linked under `## Artifacts`.

From a shell, the same thing is `te discuss save <file> --title <t>
[--project <p>]` — plain text, Markdown and Claude Code JSONL all work.

## 2. Find and read discussions

```bash
curl -s "$B/query?type=discussion" -H "$H"                    # list them
curl -s "$B/search?text=<words>" -H "$H"                      # distilled sections (default)
curl -s "$B/search?text=<words>&in=transcript" -H "$H"        # the raw transcripts
curl -s $B/brief/DISC-0003 -H "$H"                            # distilled + related + transcript size
curl -s "$B/brief/DISC-0003?more=transcript&page=2" -H "$H"   # a ~200-line transcript page
```

Read the distilled layer first. Page the transcript **only** when the
distilled layer does not answer your question — transcripts are long on
purpose.

## 3. Plan from one or more discussions

When the human asks you to plan from saved chats:

1. `brief` each discussion. Note the decisions, open questions and
   guidelines — they are the plan's raw material.
2. Page transcripts only where a distilled line needs its context.
3. `propose` the plan as usual (see te-plan), with
   `"relates": ["DISC-0003", "DISC-0007"]` on every item it grows from —
   the epic at minimum. `relates` is a reference only: no ordering, no
   gate. The discussion's page then lists the plan under "related items".

A discussion's open questions are task material; its guidelines are not —
those go through `promote` (§4), not into task text.

## 4. Promote a guideline or a decision

A `## Guidelines` or `## Decisions reached` line can become a real
project record — but the human always settles it:

```bash
curl -s -X POST $B/promote -H "$H" -d '{
  "id": "DISC-0003", "section": "guidelines",
  "line": "always clear latched events on restart",
  "to": "lesson", "domain": "mavlink"
}'
```

- `to: "lesson"` → a candidate for `lessons/<domain>.md` waits in the
  inbox and on the web board. Nothing is written until the human
  approves; then the lesson line names the discussion.
- `to: "decision"` → a decision draft; on approval a `D-NNNN` record
  names the discussion as its source.
- `line` must exist in that section — copy it exactly.
- Either way the discussion's `## Actions` links the result, so the
  provenance stays visible.

Never promote by hand — the call keeps the link and the gate.

## Never

- claim a discussion (it is refused — discussions are sources);
- write a `DISC-*.md` or `.transcript.md` by hand — use `capture`;
- skip the secret scan — a refused capture is a warning, not a nuisance;
- put transcript-only facts into task text — cite the `DISC-` id in
  `relates` instead.
