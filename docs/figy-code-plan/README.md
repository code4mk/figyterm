# Figy Code — the plan

Working notes for the agent [`../CODE-AGENT.md`](../CODE-AGENT.md) argues for.
That document is the argument: why build one at all, why the two surfaces are
separate sessions, and why the whole thing is governed by what a turn costs.
This folder is the detail underneath it, one subject per file.

| File | What it settles |
|---|---|
| [`TOOLS.md`](./TOOLS.md) | Every tool the agent gets, what backs it, what it may return, and what it is not allowed to do |

**Status: nothing here is built.** The window in `src/components/FigyCode/` is
a design prototype over a scripted transcript — it has no agent behind it, and
the only thing in it that touches the disk is the `@` file index
(`src-tauri/src/commands/figy_files.rs`). These notes describe what would have
to exist for that window to be telling the truth.

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
