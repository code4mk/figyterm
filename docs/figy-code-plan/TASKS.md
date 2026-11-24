# Figy Code — tasks

The build order from [`TOOLS.md`](./TOOLS.md), as things to tick off. Checked
means written **and tested**; a task with no test is not done.

**Where it stands (2026-11-25):** sections 1–6, 7a, 8 and 10 are in, bar
the items still marked open. `cargo test --lib` is 430 passing (210 the
agent's own) and `npm test` carries 35 more over the window's reducer and
its diff. Twenty tools, a turn that runs end to end, and nothing scripted
left in the window. What is left is the panel itself — 7b to 7d.

The shape of the thing being built, decided and not re-opened here:

- **The loop and every tool live in Rust**, in `src-tauri/src/agent/`. The two
  front ends send messages and render events, and neither holds a turn loop.
- **The wire format is OpenAI-compatible** — `/v1/chat/completions` with
  `tools: [{ type: "function", function: { name, description, parameters } }]`
  — so the provider is a base URL and a key, not a rewrite.
- **No Rig.** Settled 2026-11-25; the reasoning is in `CODE-AGENT.md`.
  The provider is ~500 lines of `reqwest` behind a trait, and the trait
  is the insurance: a second implementation is a day's work the moment a
  wire format appears that we do not speak. See 3b for the two
  conditions that would make it one.
- **Tool picking goes through typesafe.ai.** The registry below emits the
  schema it needs and dispatches whatever comes back by name; the picker is
  behind a trait so the model choosing directly and a router choosing for it
  are the same code path.
- **Exa is the search provider**, behind the `search_web` tool.

---

## 1 · Foundations

- [x] `agent/workspace.rs` — one project root per window, and a `resolve` that
      keeps every tool inside it
- [x] Reconcile that root with `figy_files.rs`, which had its own
- [x] `agent/tools/mod.rs` — `Tool` trait, registry, OpenAI schema emission,
      dispatch by name, permission classes
- [x] `agent/tools/output.rs` — the caps, the truncation notices, the line
      formatting every tool shares
- [x] `commands/agent.rs` — `agent_tools()` and `agent_call_tool()`, so tools
      can be exercised before a model exists

## 2 · The three tools that make an agent

- [x] `read(path, offset, limit)` — ranged, numbered, says what it did not show
- [x] `grep(pattern, glob, limit)` — locations, not content
- [x] `edit(path, old, new, all)` — exact match, encoding and line endings
      preserved, refuses an ambiguous match
- [ ] **The dirty-buffer handshake.** An edit to a file with unsaved changes in
      the editor must go through the editor's save path, not around it. This is
      the one failure in the whole plan that costs work rather than money
- [ ] The file-state map: `path → (ranges, mtime)`, so a re-read of unchanged
      lines answers `already in context` instead of the file

## 3 · The loop

- [x] `agent/message.rs` — the conversation, and its OpenAI form. Tool
      arguments kept as the bytes the model wrote, because those bytes are
      the cache prefix of every later turn
- [x] `agent/policy.rs` — which classes run in which mode, and what
      "don't ask again" remembers (a command, never a class)
- [x] `agent/provider.rs` — an OpenAI-compatible streaming client behind a
      trait, key from the keychain, cancellable through `tokio::select!`
- [x] `agent/session.rs` — the turn loop: tool round trips, the permission
      handshake, a step limit, and a frozen prefix with tests that fail if
      the system message or any earlier message ever moves
- [x] `agent/ledger.rs` — per-turn tokens, cached reads, cost and the
      largest tool result, into SQLite
- [x] `commands/agent.rs` — configure, send, approve, cancel, usage, with
      the turn narrated over one `agent://event` stream
- [ ] **typesafe.ai as the tool picker.** The `Picker` seam is in and the
      default offers the whole registry; the router implementation needs its
      API. Note the tension first: narrowing the tool list per turn changes
      the first bytes of the request, which is the worst place to change
      them. Measure it against the cache saving before believing it wins
- [ ] Explicit cache breakpoints for endpoints that take them (Anthropic's
      `cache_control`). Prefix stability is done; breakpoints are an
      Anthropic-shaped extra
- [ ] Hit rate and `$ this session` on screen — the ledger has both, nothing
      draws them yet

### 3b · When a second provider implementation becomes worth it

Not a to-do. Two conditions, written down so the decision is not taken
again from scratch:

- A provider is wanted that is **not OpenAI-compatible and not reachable
  through OpenRouter**. Everything we have pointed at so far — the Modal
  endpoint, OpenAI, OpenRouter, vLLM, llama.cpp, Ollama — speaks the one
  wire format.
- **OpenRouter's `cache_control` passthrough will not carry Anthropic's
  1-hour TTL.** That TTL is the cost argument this whole plan rests on,
  and going direct to Anthropic is the only other way to get it. Worth
  testing before it is needed rather than after.

Whichever arrives first, the work is a second `impl Provider` beside
`OpenAiProvider` and nothing above it moves. What it must prove before
anything depends on it: that **`Usage.cached` survives it**. A layer that
reports zero cached tokens is worse than no layer, because zero is also
what a destroyed cache prefix looks like.

## 4 · Tool hygiene

- [x] Every tool capped, every truncation announced — and `bash` keeps the
      head *and* the tail, because the first lines say what ran and the last
      ones say what went wrong
- [x] `write`, which refuses to overwrite and points at `edit`: an agent
      rewriting a file to change one line is an agent deleting what it
      forgot to repeat
- [x] `ls`, sorted so that the same listing twice is the same bytes
- [x] `move`, which refuses to land on something — `fs::rename` would
      destroy it silently
- [x] `delete`, to the trash, with no flag to go past it
- [x] `bash`, `bash_output`, `bash_kill` over `agent/shell.rs`: output
      drained while the process runs so a full pipe cannot deadlock it, a
      timeout that kills rather than abandons, and background jobs that die
      with the window that started them
- [x] The shell is optional in `ToolContext`, so a surface without one
      cannot run commands by construction rather than by remembering
- [ ] **Background commands in a real visible terminal tab.** The job runs
      and its output is readable; what is missing is the frontend creating
      the tab to show it, which is section 5's work
- [ ] `$ per completed task` measured either side of this section — the 5×
      is claimed here and unproven until real sessions are run through the
      ledger
- [ ] A narrower registry for the editor panel. The shell seam covers
      `bash`; `write`, `move`, `delete` and `glob` still need a surface to
      be filtered by

## 5 · The window, told the truth

- [x] `figycode-demo.ts` is deleted. The scripted runs, the invented
      projects, the fake checkpoints and the notice gallery are gone
- [x] `figycode-session.ts` — the transcript as `(state, event) => state`,
      pure and tested: streamed text becoming one paragraph, a tool row
      filled in two seconds after it appears, a refusal that must not look
      like a crash
- [x] Permission prompts are the real ones: the card is built from the
      pending call, the answer goes back through `agent_approve`, and
      "allow all edits" switches the mode rather than remembering a key
- [x] Interrupt actually interrupts — Escape calls `agent_cancel`, which
      drops the connection rather than draining it
- [x] `/model` configures a real provider; the key goes to the keychain
- [x] `/usage` and the status bar show the ledger's own numbers, including
      the cache hit rate
- [x] `!` runs one tool with no model and no prompt. Its output stays out
      of the conversation: the loop owns the history
- [x] **Every tool row opens.** The result is already in the conversation
      and already paid for; a transcript of one-line summaries is one you
      have to take on trust. The triangle says what opening it will show
- [x] An edit renders as a **line diff** with context — `figycode-diff.ts`,
      an LCS with long unchanged runs elided — rather than as everything
      removed then everything added, which on a six-line replacement that
      changed one word was twelve lines of noise. A diff opens itself; a
      build log does not
- [x] A new file shows the content it wrote, as added lines. The content
      rides in `detail` rather than in the tool result: the model wrote
      that text and it is already in the conversation as the call's
      arguments, so returning it would be paying twice on every later turn
- [x] The permission card for an edit shows the same diff the row will,
      so saying yes does not change what you were looking at
- [x] The token meter moves while the answer streams. The provider's own
      count arrives at the end of the turn and replaces the estimate
- [ ] Six block renderers were deleted with the scripts — plans, to-do
      lists, command-output cards, the task summary. They come back with
      the `plan` and `todo_write` tools in section 8, out of the history
- [ ] Background commands in a visible terminal tab (carried from 4)
- [x] **More than one model.** The settings held a single provider,
      which was wrong about how this is used: a cheap model for the
      panel and an expensive one for a refactor, a local endpoint and a
      hosted one, two providers while deciding between them. Switching
      meant retyping a base URL and a key, which nobody does twice.
      Now a list, each with its own prices, window and temperature, and
      a dot for the one that answers
- [x] Settings are a tabbed dialog over the window — Models, Web
      search, Behaviour, Session — rather than a screen instead of the
      transcript. Changing a setting is something you do *to* a
      conversation
- [x] An old settings file is read and forwarded into one model rather
      than ignored, because an upgrade that silently loses somebody's
      endpoint and key is the worst kind
- [x] Switching model mid-conversation re-costs the session. The
      provider was already rebuilt per turn, so answers came from the
      new model straight away while the prices stayed at the old
      model's — the exact failure the ledger exists to catch. The
      window says what the switch costs in cache, once, where it happens
- [ ] **The API key is in plain text.** `figycode-agent.json` in the app
      data directory, 0600 where the platform understands it, and the
      window states the path when it saves. Deliberate while the agent is
      being built against a throwaway token on a self-hosted endpoint —
      a keychain prompt per launch of a debug build is friction with
      nothing behind it yet. `secrets::store(Credential::Key, …)` is the
      three-line change back, and it happens before anyone else runs this

## 6 · The differentiator

- [x] `definition`, `references`, `diagnostics`, through the language
      server **this process is already running**. The obvious build — an
      LSP client in Rust beside the loop — was the wrong one: it would
      start a second `rust-analyzer`, which is gigabytes and half a minute
      of indexing on exactly the projects where these tools are worth
      having. So the tool emits `agent://lsp-request`, the app shell
      answers with the client the editor already owns, and
      `agent/code.rs` is the bridge between them
- [x] Tool dispatch moved to `spawn_blocking`. A thirty-second wait for a
      cold server on a runtime worker would stall the command delivering
      the answer it is waiting for — a deadlock rather than a stall
- [ ] `workspace/symbol` in the client, then `find_symbol` — the gap worth
      closing first, and the one request `lsp/client.ts` does not implement
- [ ] `rename_symbol` through `lsp/edits.ts`'s `WorkspaceEdit` applier
- [ ] The bridge needs the webview alive and the language-server switch on.
      Each tool says so rather than failing in a way the model would retry,
      but it is a real limit and belongs in the window's own copy one day

## 7 · The editor panel

The second front end, and the one `CODE-AGENT.md` warns about twice: its
whole value is being **short and cheap**, and if it grows compaction, a
shell and thirty-turn conversations we have built the window twice and
made the cheap one expensive. Four pieces, in this order.

### 7a · The backend can host two surfaces

- [x] Sessions keyed by window **and surface**. They were keyed by window
      alone, which is the same thing right up until the panel exists —
      the editor is a modal in the same Tauri window as FigyCode, so both
      would have been writing to one conversation
- [x] A tool set per surface. The panel gets read, grep, edit and the
      three language-server tools; no shell, no git, no network, no
      filesystem rearranging. Decided once at session start, because the
      tool list is the first thing in the cache prefix
- [x] Its own ledger rows, under `surface = panel`, which is how we find
      out whether the panel is paying for itself

### 7b · The panel itself

- [ ] A second mode for the column opposite the explorer — {Preview,
      Agent} — so the editor ends with one symmetric idea: two columns,
      each with modes, flanking the buffer
- [ ] The transcript and composer, reusing the window's components
- [ ] **The selection and the open tabs are seeded into the first user
      message**, not offered as tools. The cheapest turn an agent can
      have is the one where the context was free, and a round trip to ask
      "what am I looking at" is not free
- [ ] A system prompt of its own. Not the window's: a different preamble
      is a different cache prefix, and sharing one would pay 1.25× to
      destroy something that was saving 10×

### 7c · Edits land in the buffer

- [ ] `apply_hunk`, into the open buffer with the change-gutter marks
      that already exist, accepted or rejected per hunk. No separate
      review step — this is the panel's whole reason for being in the
      editor rather than beside it
- [ ] Which also settles the dirty-buffer handshake open since section 2

### 7d · Promotion

- [ ] "This is getting long. Open in FigyCode →", carrying the
      conversation across
- [ ] **One way.** Panel → window works because the window's context
      policy is a superset. The reverse does not and is not offered

## 8 · Outside

- [x] `search_web` through Exa. The extract comes back in the same call —
      `contents.text` with a small `maxCharacters` — because the extract
      is what decides whether a result is worth fetching whole, and asking
      for it separately is a second round trip to learn the same thing
- [x] `fetch_url`, returning the text Exa extracted rather than 40K of
      HTML. Capped at 200 lines with a note, because a page is re-sent on
      every later turn of the session
- [x] Both are `net` class, so both are asked about every time with the
      query or the URL on the card. `acceptEdits` means edits
- [x] No Exa key means no web tools at all, rather than tools that attempt
      a request with an empty header and report a 401
- [x] git tools: `git_status`, `git_diff`, `git_log`, `git_blame`,
      `git_commit`. **Nothing pushes** — no push, no pull, no branch
      switching, no stash. The agent proposes and a human presses the
      button, and there is a test that fails if a `push` tool is ever
      added. `git_commit` stages and commits in one call, because as two
      tools an interrupted turn leaves a half-staged tree the model cannot
      see
- [x] They call `git::operations` directly rather than the `git_*`
      commands, which resolve through the *editor's* roots — the same
      fence that made the LSP tools go round the houses
- [x] Exa's per-call cost reaches the ledger. It is a column of its own
      rather than added to the model's: folding them together makes a
      search-heavy session look like an expensive model, and the two are
      bought from different people
- [ ] Locations in a `definition` or `references` result, and URLs in a
      search result, are text. Clicking a `path:line` to open the editor
      there, and a URL to open the browser window, is the obvious next
      thing the transcript should do

---

# The part that makes it a harness

Sections 1–8 build an agent that can take a turn: a loop, twenty tools, a
permission model, a ledger and two surfaces. That is not yet a harness.
A harness is what keeps a *long* task alive — across a context window,
across a rate limit, across a restart — and none of it is built.

These are in rough order of how soon their absence will be felt.

## 9 · Surviving a long task

This is phase 8 of `CODE-AGENT.md`, and it was missing from this list
entirely.

- [x] **The context window is tracked**, as a setting beside the model
      name — nothing on the wire reports it. `ctx 34%` rides on every
      turn event and sits in the status bar
- [x] **A hard per-session budget**, checked *before* a request rather
      than reported after one: the point is not to record the overspend
      but to not make it
- [x] **Compaction, once, late (85%), at a task boundary** — after a
      turn that asked for no tools, which is the only moment the model
      is not holding something half-finished. The summary is its own
      model call, with no tools offered, because offering them invites
      the model to go and look things up again
- [x] The split lands on a user message, so an assistant's tool calls
      are never separated from their results; the original request stays
      in front; the last two turns stay verbatim. A summary that comes
      back empty changes nothing
- [x] And the cost is admitted rather than hidden: rewriting the middle
      changes every byte after the system prompt, so the next request
      writes the whole prefix again. That is why the threshold is 85%
      and not 50%
- [x] **Sessions survive a restart.** `agent/store.rs`, one row per
      conversation, rewritten after every turn — not at shutdown, because
      the case this exists for is the one where there is no shutdown. The
      same SQLite file as the ledger, a different table: the ledger is an
      append-only record of what things cost and is never edited, this is
      a snapshot of right now
- [x] Resume: `/resume` lists what this folder was working on, newest
      first, and the first screen says how many there are rather than
      leaving it behind a command nobody types. The row's **system
      prompt** comes back with it — it is part of the cached prefix and
      part of what the model was told it was doing — while the price, the
      window and the budget come from the settings as they are now
- [x] The folder has to match. Every path in a conversation means
      something only in the repository it happened in, so one from
      elsewhere is refused rather than opened
- [x] And it is not free: the provider's cache is keyed on a prefix it
      saw minutes ago, not days, so the first message after a resume
      writes the whole conversation again at full price. Which is why
      resuming is chosen from a list rather than done on launch
- [ ] The file-state map goes with it, once there is one (section 2).
      Until then a resumed agent re-reads what it needs, which is correct
      and merely costs a turn
- [ ] A resumed edit row shows the result it reported rather than its
      diff. `detail` is the half of a tool's answer that never entered the
      conversation, and storing it would mean keeping a copy of every file
      the agent has touched

## 10 · Not falling over

- [x] **Retry with backoff**, four attempts, doubling from two seconds to
      a thirty-second ceiling, and the server's own `Retry-After` wins
      when it sends one — it knows, and ignoring it is how a client earns
      a longer ban
- [x] Retried only when the service *cannot right now* — 408, 429, 5xx, a
      connection that never opened. Not 401 or 400: retrying those is a
      way of getting rate-limited for having the wrong key
- [x] **Only before the answer has started.** The subtlety that makes it
      correct: once a token has been streamed it has been shown and
      counted, so restarting the request would replay the answer and the
      window would render it twice. A connection that drops mid-answer is
      reported with what arrived
- [x] The wait is interruptible. Escape during a thirty-second backoff
      means Escape, not "wait thirty seconds and then stop"
- [x] Said out loud in the spinner — "Rate limited — trying again in 8s
      (2 of 4)" — rather than as four notices for one hiccup. A silent
      thirty-second pause is indistinguishable from a hang
- [x] An interrupted turn offers "Carry on", which goes through `send`
      like any other message rather than being a second path into the loop
- [ ] Provider failover, which is only worth it once there is a second
      provider configured. Until then, a clear message beats a silent
      switch

## 11 · The agent's own mind

`TOOLS.md` group E. These are the tools with no side effect outside the
conversation, and the ones most often left out of a first draft.

- [x] **`FIGY.md` is read into the prefix at session start**, from the
      top of the project, with `AGENTS.md` as a second name because a
      repository that has one has already written down what we would
      otherwise ask for twice. `agent/rules.rs`
- [x] Appended *under* the surface's preamble, and said to win where
      they disagree: a model handed two sets of instructions with no
      order between them picks one at random
- [x] Read **once**, like everything else in the prefix. An edit applies
      to the next conversation; a file the user can touch to invalidate
      the cache of a session thirty turns deep is a worse surprise than
      the one it fixes, and `/clear` is the way to pick a change up
- [x] Capped at 12K characters, cut on a character boundary, and the cut
      announced in the prompt itself — an agent silently given half a
      rule is worse than one given none
- [x] The first screen names the file and says what carrying it costs on
      every turn. The whole argument for a file over a memory tool is
      that behaviour should be reviewable, which means admitting the
      price of it
- [x] `todo_write` — on a twenty-turn task the list is the only thing
      keeping the model's own intent in the prefix without restating it
      in prose every turn. `agent/tools/todo.rs`
- [x] No state on this side: each call carries the whole list and the
      last one wins. A server-side list mutated by `add` and `complete`
      is a second source of truth that a compaction, a resume or a
      retried turn can silently desynchronise from the conversation
- [x] At most one item `running`, refused with the fix in the message.
      A plan where four things are in progress has stopped being a
      sequence, and a model allowed to say so will
- [x] One block in the window, moved to the end when it changes rather
      than stacked — the list is a state, not an event. The renderer
      came back out of the history, as planned
- [x] And it survives a resume: `detail` is not stored, but the tool
      writes its list into the text the model reads, so the window
      recovers it from the one copy that is kept
- [x] `plan` — ends plan mode with something to approve. The refusal
      half was built on the first day; this is the other one. Steps, a
      card, three answers, and approving it **lifts plan mode in the
      turn that proposed it** rather than in the next message
- [x] Which needed the mode to be reachable while a turn runs:
      `policy.rs` grows a `ModeCell`, shared between the session and the
      command that answers the card. It also makes "Yes, allow all edits
      this session" keep its promise, which it did not before — granted
      mid-turn, it applied from the next message
- [x] The three answers are the tool's, not the model's. It has to know
      what the answer *meant*, and comparing against labels it wrote
      itself is the only version of that a rephrasing cannot break
- [x] The plan goes into the tool result as well as the card: the steps
      went out in an event the conversation never sees, and a model
      re-reading its own history needs to find what it agreed to do
- [x] `ask_user` — a structured question, asked *inside* the turn.
      `agent/ask.rs` is `code.rs` with a person on the other end: the
      question goes out on the turn's own event channel, the tool blocks
      on a rendezvous channel, and `agent_answer` hands the answer back
- [x] Drawn by the card a permission question uses, because it is one
      interaction — here is the situation, here are the few ways out —
      and two cards would have drifted apart within a month
- [x] The way out the model did not think of is always offered, last, so
      Escape means something. A card with three options and no fourth is
      a trap
- [x] Released when the turn is cancelled or the window goes: a tool
      thread parked on a card nobody can see is a turn that never ends
- [x] Offered in the panel too. It is the one tool on that list which is
      not about the buffer, and the reason is that a panel which cannot
      ask has to guess — the same wrong guess, made faster
- [x] `task` — a sub-agent with its own context, returning a few hundred
      tokens instead of the forty files it read. `agent/delegate.rs`
- [x] Read-only, and the reason is not caution: its conversation is
      thrown away, so an edit it made would reach the parent as a
      sentence claiming an edit — no diff, no path, no row to open. It
      also has nobody to ask, and cannot spawn another of itself
- [x] Its turns land in the same ledger under the parent's session id,
      and its total comes back as `costUsd` — the hook the loop already
      reads for Exa — so the parent's budget covers it rather than
      stopping at the one call that can spend the most
- [x] Twelve steps, not forty, because **nothing can interrupt it**:
      Escape cancels the parent's turn and the sub-agent keeps going
      underneath it. The step limit is the whole of the protection
- [ ] A cheaper model for it. `CODE-AGENT.md`'s lever 4, and this is the
      only safe place for one — off the main thread, forfeiting no cache
      — but it needs a second provider in the settings first
- [ ] Interruptible sub-agents: a cancel channel that reaches into the
      tool call, which the synchronous `Tool` trait has nowhere to put
