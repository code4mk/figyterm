# The tool surface

**Status: proposal.** Every tool here is unbuilt. What is real is the column
saying what would back it — those are commands this repository already ships,
checked against `src-tauri/src/lib.rs` on **2026-11-24**.

[`../CODE-AGENT.md`](../CODE-AGENT.md) makes the case that tool design is the
lever you keep pulling: caching is a one-time piece of engineering, and tools
separate two agents by 5× on the same task with the same model. This is that
argument spent in detail.

---

## The sentence the whole document follows from

> **The model cannot see anything. It can only read what a tool hands it, and
> it pays for that again on every subsequent turn.**

Everything below is downstream of those two facts. A tool that returns a
whole file has not been generous, it has signed a subscription. A tool that
returns 7 exact locations where `grep` would have returned 200 lines has not
saved 193 lines, it has saved them *times the number of turns left in the
session*.

---

## The rules every tool obeys

These are not style. Each one is a bug we would otherwise ship.

**1. Ranged by default.** No tool returns a whole file unless the caller asked
for a range that covers it. `read(path, offset, limit)` with a default of ~200
lines, and the result states the file's total length so the model knows what
it has not seen.

**2. Search returns locations, not content.** `path:line: the matched line`.
The model then reads the ranges it chooses, which is usually two of forty.

**3. Everything is capped, and says that it capped.** A silent truncation
makes the model re-run the command with a narrower query it has to guess at:

```
[bash] cargo test  (exit 101)
… 40 lines …
--- truncated: 1,847 more lines. re-run with `| tail -50`, or grep it ---
```

**4. Edits are diffs, never rewrites.** `edit(path, old, new)` — a failed exact
match is a visible error, where `write(whole_file)` silently drops whatever
the model forgot to repeat. It is also where output tokens go: a 500-line
rewrite is ~6K output at several times the input rate, against ~80 for the
hunk that changed.

**5. Errors are short and actionable.** `no such file: src/mian.rs — did you
mean src/main.rs?` beats fifty lines of backtrace, and costs 1% of it.

**6. Every tool declares a permission class.** `read`, `write`, `exec`, `net`.
The class decides what the permission prompt says and what "accept edits"
actually accepts. A tool whose class is a judgement call is a tool that has
been designed wrong.

**7. Every tool is cancellable.** Escape interrupts a turn, and a walk, a
build or a request in flight must stop with it — `tokio::select!`, the way the
API client's send path already does it.

**8. One tool per *question*, not per command.** Twenty-six git commands exist
in this repo; the agent gets four tools. Every tool definition sits in the
cached prefix of every request in the session, so a tool nobody calls is a tax
on every turn that does not call it.

**9. The description is the API.** The model never sees the implementation.
A parameter whose description is missing is a parameter that gets guessed, and
a tool whose description is three paragraphs is three paragraphs on every
turn.

---

## A. Files

The floor. Nothing works without these four, and nothing else in the list
matters if they are wrong.

| Tool | Signature | Backed by | Class |
|---|---|---|---|
| `read` | `(path, offset?, limit?)` | `fs_read_text` + ranging | read |
| `grep` | `(pattern, glob?, path?, limit?, context?)` | `fs_search` | read |
| `glob` | `(pattern, limit?)` | `fs_list_files` | read |
| `edit` | `(path, old, new, all?)` | **the editor's save path** | write |
| `write` | `(path, content)` | `fs_create` + the save path | write |
| `ls` | `(path, depth?)` | `fs_list_dir` | read |
| `move` / `delete` | `(from, to)` / `(path)` | `fs_rename`, `fs_delete` | write |

**`edit` must go through the editor's atomic-save path, not `fs_write_text`.**
That machinery already does atomic writes with conflict detection, CRLF and
BOM preservation and crash-safe drafts — and a file rewritten under an open
tab is exactly the conflict it exists for. Writing around it makes the agent
the one thing in this app that can silently destroy unsaved work. It is the
only failure in this document that costs data rather than money.

**`grep` is streamed and cancellable already.** `fs_search` emits batches over
an event channel and stops on a cancel; the tool wrapper collects to a cap
rather than re-implementing the walk.

**Track what has been read.** Not a tool — a policy the loop owns. Keep
`path → (ranges, mtime)`; asked for a range it already has, unchanged, answer
`already in context (lines 40–120)`. Eight tokens instead of eight hundred,
and it stops the commonest loop in a long session.

**`delete` is the one to think twice about.** It is the only tool here whose
mistake is unrecoverable without git. Either it goes to the trash
(`fs_delete` already takes that flag) or it is not offered.

---

## B. Execution

| Tool | Signature | Backed by | Class |
|---|---|---|---|
| `bash` | `(cmd, timeout?, background?)` | `execute_shell_command` | exec |
| `bash_output` | `(id, from?)` | the job's captured output | read |
| `bash_wait` | `(id, seconds?, from?)` | the job registry | read |
| `bash_kill` | `(id)` | the job registry | exec |

**Background processes are not optional.** A dev server, a watch build and a
test runner all have to start and keep running while the agent does something
else; a `bash` that only returns when the process exits cannot start any of
them. The window already draws the background-task chip for this.

**This is the one place the product beats a CLI agent outright.** Figylo
*is* a terminal: a background command can run in a real pty, in a real tab,
with the user watching it and able to type into it. A CLI agent's background
process is a pipe nobody can see. Make `bash(background: true)` open a tab.

**The timeout has a default and the default is short.** Two minutes. A command
that needs longer is a command that should have been backgrounded, and an
agent waiting ten minutes on a hung process is an agent burning a session.

**`bash_wait` exists because of what a model does without it.** Asked to build
a Docker image in the background and report back when it is done, a model with
only `bash_output` polls: it calls it, reads *"still running, 7 lines"*, and
calls it again. Each of those is a whole round trip — request, tool call,
result, request — and each request re-sends the entire conversation. A
four-minute build came back as **forty rows that each said nothing**, forty
times the input bill, and a transcript nobody could read.

Waiting belongs on this side of the wire. The backend holds the process handle,
already polls its buffer every fifteen milliseconds, and can block a thread for
four minutes for nothing. One call in, one answer out — and the new lines stream
onto the row as they arrive, so the single waiting row says what the build is
doing *now*.

Three things it has to get right, each of which is a test:

- **A deadline.** A dev server never exits, and a wait with no end holds the
  turn open until somebody presses Escape. Timing out is not failing, and the
  two get different sentences: *still running after 300s, wait again or leave
  it* against *FAILED, exit 1*.
- **Exit code in the headline.** "Finished" for a build that exited 1 is how an
  agent tells somebody their image built when it did not.
- **Interruptible.** The turn loop already selects on the cancel channel around
  every tool call, so Escape lands during a wait. The child keeps running, which
  is the point of it being a background job.

---

## C. Code intelligence

> **The reason to build this agent inside this app rather than as a CLI.**

Figylo hosts language servers. No CLI coding agent does, because warming one
per invocation is not viable. The client already speaks `definition`,
`references`, `hover`, `documentSymbol`, `codeAction`, `rename`, `formatting`
and `publishDiagnostics` — see `src/services/lsp/protocol.ts`. The tools are
thin wrappers over requests that already work.

| Tool | Signature | LSP request | Class |
|---|---|---|---|
| `definition` | `(path, line, col)` | `textDocument/definition` | read |
| `references` | `(path, line, col, limit?)` | `textDocument/references` | read |
| `diagnostics` | `(path?)` | `textDocument/publishDiagnostics` | read |
| `symbols` | `(path)` | `textDocument/documentSymbol` | read |
| `find_symbol` | `(query)` | `workspace/symbol` — **not implemented yet** | read |
| `explain` | `(path, line, col)` | `textDocument/hover` | read |
| `rename_symbol` | `(path, line, col, newName)` | `textDocument/rename` | write |
| `quick_fix` | `(path, line, col)` | `textDocument/codeAction` | write |
| `format` | `(path)` | `textDocument/formatting` | write |

The saving is not incremental:

| Question | grep answers with | LSP answers with |
|---|---|---|
| "Where is `claimFront` used?" | ~200 matches, comments and strings included | **the 7 real references** |
| "What is this symbol?" | read the file to find out | **the definition, one range** |
| "Did my edit break anything?" | run the whole build | **diagnostics for the file, instantly** |

A `references` returning 7 ranges instead of 200 grep hits is closer to 30×
than 2×, **on the operation an agent performs most often**. And `diagnostics`
closes the slowest loop an agent has — edit, build, read errors, fix — into a
few hundred tokens instead of a build log.

**`rename_symbol` is the one that is qualitatively different.** The model
cannot do a correct rename with `edit`; it can only do a textual one and hope.
A server that knows the language returns a `WorkspaceEdit` across every file,
and `src/services/lsp/edits.ts` already knows how to apply one.

**`find_symbol` is the gap worth closing first.** `workspace/symbol` is the
single best "find the thing" an agent can have — it answers *"where is the
function that does X"* in one call with no walk and no guessing at a filename
— and it is the one request in this list the client does not implement.

**The capability problem, which is a caching problem.** The tool set varies by
what servers are running: LSP tools exist only when a server is up for that
language. That is a cache invalidator. **Decide the tool set once at session
start and keep it fixed**, even if a server comes up later; a tool that is
defined but currently unbacked returns `no language server for .rs in this
session` and costs nothing.

---

## D. Version control

Twenty-six git commands exist in `commands/git.rs`. The agent gets five,
because the rest answer questions it does not ask.

| Tool | Signature | Backed by | Class |
|---|---|---|---|
| `git_status` | `()` | `git_status` | read |
| `git_diff` | `(path?, staged?, ref?)` | `git_file_diff`, `git_commit_diff` | read |
| `git_log` | `(limit?, path?)` | `git_log` | read |
| `git_blame` | `(path, line)` | `git_blame` | read |
| `git_commit` | `(message, paths?)` | `git_stage` + `git_commit` | write |

**`git_blame` earns its place** for one question that comes up constantly and
is otherwise unanswerable: *why is this line like this?* It turns into a
commit message and a diff, which is often the whole answer.

**Committing is one tool, not three.** Stage-then-commit as separate tools
invites a half-staged tree when a turn is interrupted between them.

**Nothing pushes.** No `git_push`, no `git_pull`, no branch switching. The
agent proposes; a human presses the button. This is a rule about blast radius,
not about capability — `git_push` is one line away, and that is the problem.

**The forge is a later tier.** `git-forge.ts` already parses remotes, so
`open_pr(title, body)` and `ci_status()` are reachable. They are also the
first tools that make a mistake public.

---

## E. The agent's own mind

Tools with no side effect outside the conversation, and the ones most often
left out of a first draft.

| Tool | Signature | Why it exists |
|---|---|---|
| `todo_write` | `(items[])` | The user can see the plan, and the model can see what it has not done yet |
| `plan` | `(steps[], note)` | Ends plan mode with something to approve |
| `ask_user` | `(question, options[])` | A structured question beats a sentence that reads as rhetorical |
| `task` | `(prompt, tools[])` | A sub-agent with its own context |

**`todo_write` is not decoration.** On a twenty-turn task the list is the only
thing keeping the model's own intent in the prefix without re-stating it in
prose every turn. It is also the window's best status display.

**`ask_user` must be structured.** A model that asks a question in prose gets
answered in prose, which is a turn. A model that asks with three options gets
answered with a number, and the window can draw the card the design already
has.

**`task` is the cost lever hiding in this group.** A sub-agent explores with
its own context and returns a few hundred tokens — *"the handler is in
`src/net/api.rs:88`; it ignores the timeout"* — instead of the forty files it
read to find out. Those forty files never enter the main session's prefix, so
they are never paid for again. This is also the only safe place for a cheaper
model (see Lever 4): it is off the main thread, so it forfeits no cache.

**A memory tool is deliberately absent.** Rules live in `FIGY.md`, read into
the prefix at session start; a tool that writes notes to a hidden file is a
second, invisible source of behaviour that nobody can review in a diff.

---

## F. The world outside

| Tool | Signature | Backed by | Class |
|---|---|---|---|
| `fetch_url` | `(url)` → markdown | `api_send` | net |
| `search_web` | `(query)` | a provider, unchosen | net |
| `http_request` | `(method, url, headers, body)` | `api_send` | net |

**`fetch_url` returns markdown, not HTML.** A documentation page is 40K tokens
of HTML and 3K of text, and the agent is reading it for one function
signature.

**`http_request` is the one that needs a boundary.** It is the API client's
own send path, which is a general-purpose HTTP client with the user's saved
environments behind it — including their tokens. An agent that can read
`{{apiKey}}` out of an environment and `POST` it somewhere is not a feature,
it is an exfiltration path. Either the tool is denied the environment
substitution entirely, or it is not built.

**Net class is never auto-approved.** `acceptEdits` means edits. A request to
a URL the model composed is asked about every time, with the URL shown.

---

## G. The tools only this app can offer

The ones that justify a window over a terminal. None of them exist in any CLI
agent, because none of them have anywhere to put the result.

| Tool | What it does | Backed by |
|---|---|---|
| `show_diff` | Opens a change in the real diff viewer | the editor's diff view |
| `open_file` | Puts a file on screen at a line | `EditorModal` open request |
| `apply_hunk` | Lands an edit as a reviewable hunk in the open buffer | the change gutter |
| `selection` | What the user has highlighted, right now | the editor panel |
| `open_tabs` | What they are looking at | `editorStore` |
| `run_in_tab` | A command in a visible terminal tab | `create_terminal_session` |
| `screenshot` | What the embedded browser is showing | `browser_*` |
| `console_logs` | What the page logged | the embedded browser |

**`selection` and `open_tabs` are context, not actions.** They are how the
editor panel's turns stay one-to-five turns long: the model does not have to
search for the thing you are looking at, because it was told. The cheapest
turn an agent can have is the one where the context was free.

**`screenshot` + `console_logs` close a loop nothing else can.** "Make the
button blue" → edit → reload → look. A CLI agent cannot look. This is phase
"much later", and it is the most interesting thing on the list.

---

## One tool set, after trying two

`CODE-AGENT.md` argues the window and the editor panel are different sessions
with different caches. That is still true — different preambles, different
conversations, different ledger rows. For a while they were also different
*tool sets*, and that part has been reversed.

The panel was given seven: `read`, `grep`, `edit`, `definition`, `references`,
`diagnostics`, `ask_user`. No shell, no git, no network, no `write`. The
reasoning was that every definition sits in the cached prefix of every request
in that session, and that a panel answering "fix *this*, here" does not need a
repository's worth of tools to do it.

**What went wrong with it.** Seven tools did keep the panel's turns short, and
the way it kept them short was by refusing work. The question that starts
beside an open file does not stay inside the buffer: "why does this test fail"
needs to run the test. The panel would get to that point and say so — and the
person would re-ask in the FigyCode window, rebuilding the context by hand.
That is not a cheaper agent. It is the same agent with a worse first attempt,
plus a routing decision nobody asked to make.

The cost the narrowing protected was a two-minute wait in a sidebar. That is a
cost somebody can *see*, and stop with Escape.

So both surfaces carry the whole registry. `tools::PANEL_TOOLS_WAS` keeps the
original list and the argument beside the code.

**What makes the panel cheap now**, and what always did: the **seed**. The open
file and the selection ride in the first user message, so a panel turn starts
with the context a window turn spends a round trip discovering. Everything else
that was called cheapness was a restriction. What is left of "short" is a
preamble that asks for short answers and a column that makes long ones
uncomfortable — both of which shape the answer rather than forbidding the work.

The prefix argument stands on its own, for both surfaces: the registry is held
under 6,000 tokens by a test, because past that, picking a subset per session
starts to be worth its complexity.

---

## What we deliberately do not build

- **A tool per git subcommand.** Twenty-six definitions in the prefix of every
  request, for the three anybody calls.
- **`write` as the normal way to change a file.** It exists for new files.
  An agent that rewrites a file to change a line is an agent deleting the
  parts it forgot.
- **A database tool.** The sync layer has credentials in the keychain, and
  "run this SQL" is a tool whose worst case has no undo.
- **A generic `invoke(command, args)`.** Every Tauri command in one tool is
  not a tool, it is a hole in the permission model.
- **MCP, for now.** Someone else's tools in our prefix, with descriptions we
  did not write and token costs we do not control, before our own ten work.
  Revisit once the ledger can show what a server costs per session.
- **Anything that writes outside the granted roots.** `fs_set_roots` is the
  guard and it is already enforced — though note that it is *per window and
  replaces the list*, which is why `figy_files.rs` keeps its own root today.
  Reconciling those two is a prerequisite for the read tool, not a detail.

---

## Order of work

Tied to the phases in `CODE-AGENT.md`, which is also roughly the order of how
much each one is worth.

| Phase | Tools | Why here |
|---|---|---|
| 2 | `read`, `grep`, `edit` | Three tools is a working agent. Add the ledger in the same phase or the next one's results are unmeasurable |
| 4 | caps, truncation notices, the file-state map, `write`, `ls`, `bash` | The 5× lives in this row, not in the tool count |
| 5 | `todo_write`, `plan`, `ask_user` | The window has the UI for all three already |
| 6 | `definition`, `references`, `diagnostics`, then `find_symbol` | The differentiator, and worthless without phases 2–4 under it |
| 7 | `selection`, `open_tabs`, `apply_hunk` | The panel's whole context budget |
| 8 | git tools, `task`, `show_diff` | Each one is a day once the loop is settled |
| later | forge, net, `screenshot`, `console_logs` | Public mistakes, and the loop nothing else can close |

Phases 2 and 4 are unglamorous and are the entire product. An agent that is
correct and cheap beats one that is clever and expensive, because the
expensive one stops getting used.
