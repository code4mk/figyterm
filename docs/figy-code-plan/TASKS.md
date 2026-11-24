# Figy Code — tasks

The build order from [`TOOLS.md`](./TOOLS.md), as things to tick off. Checked
means written **and tested**; a task with no test is not done.

**Where it stands (2026-11-25):** sections 1–6, 7a and 8 are in, bar the
items still marked open. `cargo test --lib` is 426 passing (206 the
agent's own) and `npm test` carries 33 more over the window's reducer and
its diff. Twenty tools, a turn that runs end to end, and nothing scripted
left in the window. What is left is the panel itself — 7b to 7d.

The shape of the thing being built, decided and not re-opened here:

- **The loop and every tool live in Rust**, in `src-tauri/src/agent/`. The two
  front ends send messages and render events, and neither holds a turn loop.
- **The wire format is OpenAI-compatible** — `/v1/chat/completions` with
  `tools: [{ type: "function", function: { name, description, parameters } }]`
  — so the provider is a base URL and a key, not a rewrite.
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
