# Figy Code — the plan

Working notes for the agent [`../CODE-AGENT.md`](../CODE-AGENT.md) argues for.
That document is the argument: why build one at all, why the two surfaces are
separate sessions, and why the whole thing is governed by what a turn costs.
This folder is the detail underneath it, one subject per file.

| File | What it settles |
|---|---|
| [`TOOLS.md`](./TOOLS.md) | Every tool the agent gets, what backs it, what it may return, and what it is not allowed to do |
| [`TASKS.md`](./TASKS.md) | The order it is built in, and what is actually done. Sections 1–8 are the agent; 9–11 are what makes it a harness |

**Status (2026-11-25): the agent works, and the panel does not exist.**
Sections 1–6 and 8–11 of `TASKS.md` are in: a turn loop in
`src-tauri/src/agent/`, twenty-five tools, a permission model, a ledger,
compaction, retry, conversations that survive a restart, `FIGY.md`, a
to-do list, a plan it can offer, a question it can ask, a sub-agent,
images on a message, and an optional tool router that is off by default
and argued against in its own file.

**Section 7 — the editor panel — is the one that has not been started**,
and it is the one `CODE-AGENT.md` says the product exists for: a
file-focused agent answering in one to five turns is a different and
cheaper thing from the window, and it is what justifies an editor over
a terminal. Everything under it is open except the plumbing.

The other open items worth naming: the **dirty-buffer handshake** (an
edit to a file with unsaved changes in the editor), **keys in plain
text** — three of them now — and **`$ per completed task`, never
measured**, which is the number every cost decision in this project
rests on.

The line that used to be here said nothing was built, which stopped being
true some time ago. A status line nobody updates is worse than none,
so: if this one disagrees with `TASKS.md`, `TASKS.md` is the document
that gets maintained.

## How to read a document in here

Each one is written to be disagreed with. A table that lists a tool is not a
decision that the tool ships; the column that matters is the reasoning beside
it. Where something is genuinely undecided it says so rather than picking the
first plausible answer and leaving it to be discovered in code six weeks
later.

Two constraints run through all of it and are not re-argued each time:

1. **A tool result is a permanent subscription.** The API is stateless, so
   everything a tool returns on turn 3 is re-sent on every turn until the
   session ends. Three thousand tokens on turn 3 of a thirty-turn session is
   about eighty thousand input tokens.
2. **The tool list is part of the cache prefix.** Order is
   `tools → system → messages`, and any byte that changes invalidates
   everything after it. A tool set that varies with what happens to be running
   is a cache that is rewritten every turn.
