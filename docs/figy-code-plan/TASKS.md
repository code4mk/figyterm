# Figy Code — tasks

The build order from [`TOOLS.md`](./TOOLS.md), as things to tick off. Checked
means written **and tested**; a task with no test is not done.

**Where it stands (2026-11-24):** sections 1–4 are in, bar the items still
marked open. `cargo test --lib` is 369 passing, of which 149 are the agent's
own. Ten tools, and a turn that runs end to end against any
OpenAI-compatible endpoint. Nothing in the window is wired to it yet, which
is section 5.

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

- [ ] Replace `figycode-demo.ts` with real events
- [ ] Permission prompts wired to the real permission classes
- [ ] Interrupt actually interrupts

## 6 · The differentiator

- [ ] `definition`, `references`, `diagnostics` over the LSP client
- [ ] `workspace/symbol` in the client, then `find_symbol` — the gap worth
      closing first
- [ ] `rename_symbol` through `lsp/edits.ts`'s `WorkspaceEdit` applier

## 7 · The editor panel

- [ ] `selection`, `open_tabs` — context for free
- [ ] `apply_hunk` into the open buffer
- [ ] Promotion to the window, one way

## 8 · Outside

- [ ] `search_web` through Exa
- [ ] `fetch_url`, returning markdown rather than 40K of HTML
- [ ] git tools: `git_status`, `git_diff`, `git_log`, `git_blame`,
      `git_commit`. Nothing that pushes
