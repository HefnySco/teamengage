---
name: te-tag
description: Go over TeamEngage tasks that have no domain and tag each with the right domains by reading and understanding it (AI judgement, not keyword matching) — propose a plan, get the human's OK, then apply. Use when asked to "tag untagged tasks", "add domains to tasks", "classify the tasks", "fill in missing domains", or after many new tasks were proposed or imported.
---

# te-tag — tag untagged tasks with domains

Domains are hashtag-like labels (`#mavlink`, `#webclient`, `#security` …).
A task can have several; the human filters the board and agents pick work
by them (`next?domain=…`). Keyword suggestions already ran — what is left
needs a reader: you.

Everything goes through the `te` CLI (any agent with a shell; no MCP):

```bash
te() { node /home/mhefny/TDisk/out_gits/mcp/teamengage/dist/cli/main.js "$@"; }   # if `te` isn't on PATH
```

## 1. Learn the vocabulary

```bash
te domains --json      # name, description, keywords, counts
```

Read every domain's description and keywords — that is what each one
*means* here. Use these domains. Do **not** invent near-duplicates
(`web-client` when `webclient` exists, `sec` for `security`).

## 2. Get the untagged tasks

```bash
te domains untagged --json     # id, title, status, project, source file
```

Archived tasks are not included. Work in batches of ~20.

## 3. Read and decide — per task

```bash
te show GL-0042        # the task file itself (title, Touches, summary, acceptance)
```

Decide **1–3 domains** (rarely more) from what the task *changes or is
about*:

- The `**Touches:**` line, the repos/modules named in the summary, and the
  problem being solved weigh most. A module mentioned once in passing
  ("unlike the webclient…") is not a domain of the task.
- Cross-cutting concerns count when they are the point: a TLS fix is
  `#security`, a backpressure fix is `#performance`, a message-format change
  is `#protocol` — in addition to the module.
- The project folder is already shown separately; don't add a domain just
  because of the folder.
- Empty or placeholder task file → tag from the title only, or leave it
  untagged and list it as "nothing to go on".
- Not sure between two? Pick the clearer one and say why in the plan.

**New domains:** only when several tasks clearly share a theme no existing
domain covers. Never create one silently — propose it in the plan with a
one-line description, and wait for the human's OK.

## 4. Show the plan — wait for OK

Present one table, then stop and ask:

| id | title | domains | why (short) |
|---|---|---|---|
| GL-0042 | Comm server outbound backpressure | server, performance | outbound queue in comm server; load protection |
| WC-0026 | Profile array-view row | webclient, performance | React row render cost |
| AN-0002 | 02 deeper investigation | — | empty file, nothing to go on |

Plus: proposed **new domains** (if any, with description), and a count
("41 of 55 tagged, 14 left untagged").

The human may change rows. Apply exactly what they approve.

## 5. Apply

```bash
te tag GL-0042 server performance
te tag WC-0026 webclient performance
```

`te tag <ID> a b` adds; `-a` removes. A new domain name is added to the
vocabulary automatically — so only use one the human approved; then give
it a description:

```bash
te domain add <name> "one-line description" --keywords "word1,word2"
```

## 6. Report

- How many tagged, by domain; which stayed untagged and why.
- Keyword ideas: if you noticed words that clearly indicate a domain
  (a module name, a file prefix), suggest adding them as keywords — the
  human can add them on the Domains page so future suggestions catch them.
- The changes are files under `Tasks/.teamengage/` — the human commits them.

## Never

- tag without the human's OK on the plan;
- remove or replace domains a task already has (this skill only fills gaps);
- create a domain the human didn't approve;
- edit task files — tagging only touches TeamEngage's tracking state.
