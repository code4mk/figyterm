# Figy Code — tasks

The build order from [`TOOLS.md`](./TOOLS.md), as things to tick off. Checked
means written **and tested**; a task with no test is not done.

**Where it stands (2026-11-24):** sections 1 and 2 are in, bar the two items
still open at the end of 2. `cargo test --lib` is 271 passing, of which 51 are
the agent's own. Nothing calls a model yet.

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

- [ ] `agent/provider.rs` — an OpenAI-compatible client behind a trait, key
      from the keychain, cancellable through `tokio::select!`
- [ ] typesafe.ai as the tool picker, behind the same trait
- [ ] `agent/loop.rs` — turn loop, tool-call round trips, streaming events to
      the window
- [ ] `agent/ledger.rs` — per-turn tokens, cache reads and writes, cost, into
      SQLite. **Before the features, not after**
- [ ] Cache breakpoints and a frozen prefix; hit rate on screen

## 4 · Tool hygiene

- [ ] Every tool capped, every truncation announced
- [ ] `$ per completed task` measured either side of this section — the 5×
      lives here
- [ ] `write`, `ls`, `move`, `delete` (to the trash, never past it)
- [ ] `bash`, `bash_output`, `bash_kill`, with background commands in a real
      visible terminal tab

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
