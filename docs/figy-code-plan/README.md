# Figy Code — the plan

Working notes for the agent [`../CODE-AGENT.md`](../CODE-AGENT.md) argues for.
That document is the argument: why build one at all, why the two surfaces are
separate sessions, and why the whole thing is governed by what a turn costs.
This folder is the detail underneath it, one subject per file.

| File | What it settles |
|---|---|
| [`TOOLS.md`](./TOOLS.md) | Every tool the agent gets, what backs it, what it may return, and what it is not allowed to do |
| [`TASKS.md`](./TASKS.md) | The order it is built in, and what is actually done. Sections 1–8 are the agent; 9–11 are what makes it a harness |

**Status (2026-11-25): the agent runs, and it now survives a long task.**
Sections 1–8 of `TASKS.md` are in — a turn loop in `src-tauri/src/agent/`,
twenty-four tools, a permission model, a ledger, and a window with
nothing scripted left in it. Sections 9 and 10 are in: the context window is
tracked, the budget stops a run before it overspends rather than after,
a conversation compacts itself once, late, at a task boundary, a rate
limit no longer ends the turn, and a conversation is written down after
every turn so `/resume` can pick it back up. Section 11 is in too: the agent
has `FIGY.md` for the project's rules, a to-do list, a plan it can put
up for approval, a question it can ask with an answer shape, and a
sub-agent whose context is thrown away. What is left is the editor panel
in section 7, and the open items under each section above.

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
