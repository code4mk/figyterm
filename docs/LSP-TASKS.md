# Language Server Protocol — Plan and Task List

The working checklist for building LSP into the editor. The *argument* — why a
terminal should do this at all, what it costs, and what will go wrong — lives in
[`LSP.md`](./LSP.md) and is not repeated here. This document is what gets built,
in what order, and how far along it is.

Status: `[x]` done · `[~]` done but unproven on a real server · `[ ]` todo

Pairs with [`LSP.md`](./LSP.md) the way [`WINDOWS-TASKS.md`](./WINDOWS-TASKS.md)
pairs with [`WINDOWS-SUPPORT.md`](./WINDOWS-SUPPORT.md): rationale there,
checkboxes here.

---

## The shape of it

```
┌──────────────────────────── webview ─────────────────────────────┐
│  EditorSurface                                                   │
│    └─ lsp/              CodeMirror ⇄ LSP: sync, diagnostics,     │
│         │                hover, completion, signature, actions   │
│    services/lsp/                                                 │
│      client.ts           one server: handshake, sync, requests   │
│      manager.ts          many servers: keyed, lazy, idle-stopped │
│      position.ts         offset ⇄ {line, character}, both        │
│                          encodings                               │
│      servers.ts          the table: language → program           │
│      protocol.ts         the slice of LSP types we use           │
└──────────────────────────────┬────────────▲──────────────────────┘
                     invoke    │            │   event
                   lsp_send()  │            │   "lsp://message"
┌──────────────────────────────▼────────────┴──────────────────────┐
│  commands/lsp.rs  ──►  lsp/{server,registry,framing}.rs          │
│    spawn · PATH resolution · Content-Length framing · reader     │
│    thread · stderr capture · kill · reap on quit                 │
└──────────────────────────────────────────────────────────────────┘
```

**Rust never parses a request.** It reads a `Content-Length` header and emits the
body as an opaque JSON value. Adding `textDocument/foo` is then a TypeScript
change and the Rust side keeps one job it can be tested on.

## Decisions

Carried from [`LSP.md`](./LSP.md), plus the three this document settles.

| Question | Decision |
|---|---|
| Bundle or download servers? | **Neither.** Use what is on `PATH`, like `git`. |
| Where does the client live? | **Split.** Rust owns process and framing; TypeScript owns protocol. |
| Start automatically? | **No.** Off by default; on per language once the master switch is on. |
| One server per what? | Per `(workspace root, server id)`. Lazy start, idle stop. |
| Position encoding | Ask for **UTF-16**, honour what comes back. |
| Document sync | **Incremental**, batched per animation frame. |
| Semantic tokens | **Out** — they would fight the Lezer highlighting. |
| A protocol library? | **No.** `protocol.ts` declares the ~200 lines of types we use. A dependency for types we delete 95% of is not worth the install. |
| *Which* servers? | **Official first-party ones only** — the list below. No community forks, no "best of" opinions to maintain. |
| Where is the switch? | **Editor Settings → Language Server.** Master toggle, then one per language, then what was detected on `PATH`. |

## Which servers

The bar is: the implementation its own ecosystem ships or has settled on, it
speaks stdio, and it needs **no bespoke bootstrapping**. That last clause is
what keeps `jdtls` out (a per-workspace data directory), Roslyn's
`Microsoft.CodeAnalysis.LanguageServer` (a non-standard `solution/open`
notification before it will analyse anything), and Vue (a TypeScript plugin to
wire in) — they need handling, not a table row.

PHP and C# are the two places the "first-party" rule is relaxed. Neither has a
first-party server that a generic client can drive: `intelephense` is what the
PHP ecosystem uses, and `csharp-ls` is a plain stdio server that finds the
`.sln` or `.csproj` itself — where the official Roslyn server is a NuGet payload
that has to be told about the solution out-of-band.

| Language | Program | Install |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server --stdio` | `npm i -g typescript-language-server typescript` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| Python | `pyright-langserver --stdio` | `npm i -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| C / C++ / Objective-C | `clangd` | Ships with LLVM |
| PHP | `intelephense --stdio` | `npm i -g intelephense` |
| Ruby | `ruby-lsp` | `gem install ruby-lsp` |
| Swift | `sourcekit-lsp` | Included with Xcode or a swift.org toolchain |
| Zig | `zls` | `brew install zls` |
| Dart | `dart language-server` | Included with the Dart and Flutter SDKs |
| Kotlin | `kotlin-language-server` | `brew install kotlin-language-server` |
| C# | `csharp-ls` | `dotnet tool install --global csharp-ls` |
| Svelte | `svelteserver --stdio` | `npm i -g svelte-language-server` |
| Terraform | `terraform-ls serve` | `brew install hashicorp/tap/terraform-ls` |
| TOML | `taplo lsp stdio` | `brew install taplo` |
| Markdown | `marksman server` | `brew install marksman` |
| Dockerfile | `docker-langserver --stdio` | `npm i -g dockerfile-language-server-nodejs` |
| JSON | `vscode-json-language-server --stdio` | `npm i -g vscode-langservers-extracted` |
| CSS / SCSS / Less | `vscode-css-language-server --stdio` | as above |
| HTML | `vscode-html-language-server --stdio` | as above |
| YAML | `yaml-language-server --stdio` | `npm i -g yaml-language-server` |
| Shell | `bash-language-server start` | `npm i -g bash-language-server` |
| Lua | `lua-language-server` | `brew install lua-language-server` |
| **Tailwind CSS** (companion) | `tailwindcss-language-server --stdio` | `npm i -g @tailwindcss/language-server` |

A missing server is a **first-class state**, not a silent no-op: the settings
panel says "not on PATH" against it and shows the install line, and the status
bar says so when a file of that language is open.

---

## 1. Transport — Rust owns the process

- [x] **`lsp/framing.rs`** — `Content-Length` read and write. Counts **bytes**,
      not characters; `\r\n` exactly; handles a message split across reads and
      two messages in one read.
- [x] **`lsp/server.rs`** — spawn one child, reader thread per server emitting
      one event per message, stderr on its own thread, write to stdin, polite
      `shutdown`/`exit` then kill on a deadline.
- [x] **`lsp/registry.rs`** — `HashMap<id, Server>` behind a `Mutex`, a cap on
      how many run at once, `shutdown_all`.
- [x] **`commands/lsp.rs`** — `lsp_start`, `lsp_send`, `lsp_stop`, `lsp_status`,
      `lsp_detect`.
- [x] **Reuse `resolve_program`** from `shell_exec.rs` for Windows `PATHEXT` —
      every Node-based server in the table above is a `.cmd` shim there.
- [x] **Repair a truncated `PATH`** the way `execute_shell_command` does, or a
      bundled app finds none of these.
- [x] **Reap on quit** — join `shutdown_terminals` on `RunEvent::Exit`, or a
      `rust-analyzer` outlives the app.
- [x] **`cargo test`** for framing: multi-byte body, split read, coalesced read,
      oversized header refused.

## 2. The client — TypeScript owns the protocol

- [x] **`protocol.ts`** — the slice of LSP we use, hand-declared.
- [x] **`position.ts`** — offset ⇄ `{line, character}` under both UTF-16 and
      UTF-8, and `Range` ⇄ CodeMirror offsets.
- [x] **`servers.ts`** — the table above, plus user overrides from settings.
- [x] **`client.ts`** — `initialize` handshake and capability record, request
      correlation with timeouts and `$/cancelRequest`, incremental document sync
      with monotonic versions, `didOpen`/`didChange`/`didClose`.
- [x] **`manager.ts`** — one client per `(root, server)`, lazy start, idle stop,
      restart with backoff and a ceiling, a cap, and a status snapshot for the UI.
- [x] **Batch `didChange` per animation frame** — every keystroke reaches the
      server, but three in one frame are one message.
- [x] **Skip large and read-only buffers** — over `LARGE_FILE_BYTES` the editor
      is read-only with highlighting off, and a server has nothing to add.
- [x] **The watcher's reload path sends `didChange`** — a file changed on disk
      under a clean buffer, or the server answers about the old text forever.

## 3. Settings — the switch the user asked for

- [x] **`EditorSettings.lsp`** — master toggle, **off by default**.
- [x] **`EditorSettings.lspServers`** — per-server overrides, keyed by the ids
      in `servers.ts`: on/off, and the program and arguments. One field rather
      than two, because "turn Rust off" and "point Rust at my own build" are the
      same kind of change to the same row. Absent means on, with the defaults.
      Checked on the way out of `localStorage` by `sanitizeLspServers`, since
      these become a process to spawn.
- [x] **Editor Settings panel section** — master toggle, per-language rows each
      showing detected / not on PATH with its install line, and a Restart button.
- [x] **Status bar item** — which server is attached, what it is doing
      (starting, indexing, ready, failed), click to restart or stop.

## 4. Phase 1 — Diagnostics

The push direction: no correlation, no cancellation. Highest value, lowest risk,
and it proves the transport end to end.

- [x] `textDocument/publishDiagnostics` into `@codemirror/lint`.
- [x] Severity, source and code rendered in the tooltip.
- [x] Cleared on `didClose`, on the server dying, and on the toggle going off.
- [x] `@codemirror/lint` promoted to a direct dependency (it is currently
      transitive via `lang-javascript`).

## 5. Phase 2 — Hover, completion, signature help

The first request/response, so correlation, timeouts and cancellation arrive
here.

- [x] **Hover** — `textDocument/hover`, markdown or plaintext, rendered as a
      CodeMirror tooltip. Untrusted input: another program's output going into a
      tooltip, so no raw HTML.
- [x] **Completion** — `textDocument/completion`, replacing the word-completion
      source rather than sitting beside it. Trigger characters, `isIncomplete`
      re-query, `completionItem/resolve` for documentation, `sortText`/
      `filterText` overriding CodeMirror's own ranking, `textEdit` applied as
      the server wrote it, snippets.
- [x] **Signature help** — `textDocument/signatureHelp` on `(` and `,`.

## 6. Phase 3 — Navigation

- [x] **Go to definition** — `textDocument/definition`, through the existing
      `openPath(path, line, column)` and the go-to queue.
- [x] **Find references** — `textDocument/references`, into the same keyboard
      picker as go-to-definition (paths shown relative to the workspace root),
      not the project-search panel. `GlobalSearch` drives its own `fs_search` and
      owns its results; feeding it a list from elsewhere would have meant taking
      that apart for a second caller.
- [x] **Document symbols** — `textDocument/documentSymbol`, as a go-to-symbol
      picker (⌘⇧O) rather than an outline panel. The question people actually
      ask is "where is `parseHunk` in this file", and a picker answers it from
      the keyboard without taking a fourth slot on the side of the modal that
      already holds the explorer, search and git.
- [x] **⌘-click and a context-menu item** for go-to-definition, plus F12,
      ⇧F12, F2, ⌘. and ⌘⇧O — all only offered when a server is attached, since a
      menu item that silently does nothing is worse than its absence.

## 7. Phase 4 — Edits

These write files, including files that are not open. Different risk class: a
`WorkspaceEdit` must go through the same atomic write, mtime conflict check and
line-ending preservation as a save.

- [x] **Format** — `textDocument/formatting` and `rangeFormatting`, applied as
      one undoable edit.
- [x] **Rename** — `textDocument/rename`, previewed as a file/count summary
      before it is applied.
- [x] **Code actions** — `textDocument/codeAction` on the diagnostic under the
      cursor, offered from the lint tooltip.
- [x] **`WorkspaceEdit` applier** — open buffers through CodeMirror (one undo
      step), closed files through `fs_write_text` with the mtime check. **Not
      transactional, and does not claim to be:** every file is read and every
      range resolved before anything is written, so the failures that can be
      caught are caught while nothing has changed — but a write that fails
      halfway reports which files changed rather than pretending it rolled back.
      A cross-file journal would be a larger project than the feature.

## 8. Verification

Automated, and what they found:

- `cargo test` covers the framing against the three things that go wrong — a
  multi-byte body where `Content-Length` and character count differ, a message
  split at *every* byte offset, and two messages in one read — plus the refusals
  (endless header, unparseable length, implausible length).
- `npm test` covers the encoding trap: `é`, `👋` and a tab, round-tripped at
  every code-unit boundary under all three encodings, including the case where
  a UTF-8 byte offset lands inside a surrogate pair.
- `cargo test --test lsp_real_server` spawns whatever servers are installed and
  completes a real handshake with each. It distinguishes three outcomes, and the
  distinction is the whole point: a reply that arrives at all — framed,
  parseable, carrying our id — has proven the spawn, the pipes, the framing, the
  reader thread and the correlation. Only `-32700`, `-32600` and `-32602` mean we
  sent something malformed, and only those fail the test. A server that declines
  the *workspace* is counted and reported, not failed.

  On the development machine: `clangd` completes and negotiates UTF-16;
  `typescript-language-server` replies and declines a bare temp directory, which
  is correct of it. Both were found through the repaired `PATH` rather than the
  process's own, which is the mechanism a bundled app depends on entirely.

  It also found something worth writing down: **`rust-analyzer` on `PATH` is
  often rustup's shim rather than the program.** With the component not
  installed the shim exits immediately with *"Unknown binary 'rust-analyzer' in
  official toolchain"*. Detection cannot see this — the file is there and it is
  executable — so it is exactly the case the stderr capture in `lsp/server.rs`
  exists for, and the user sees those words in the settings panel rather than a
  server that silently never starts.


- [x] `cargo test` — framing round-trips, split and coalesced reads, multi-byte
      bodies, `resolve_program`.
- [x] `cargo test` — position conversion under both encodings against a line
      containing `é`, `👋` and a tab (mirrored in the TS unit under `position.ts`).
- [x] `tsc` clean, `cargo check` clean.
- [x] **Manual, macOS** — opening a `.ts`/`.tsx` file with a server attached.
      **This failed the first time and is worth recording.** The buffer opened
      *blank*, with only `Config merge conflict for field override` in the
      console. Two `autocompletion()` extensions — the word list and the
      server's — were both in the state, and CodeMirror refuses to merge two
      `override` configs. The word list *was* being cleared when a server
      attached, but by a `reconfigure` applied **after** `EditorState.create`,
      which never ran because the create itself threw. Fixed by choosing the
      one source before the state is built, pinned by
      `completion-exclusive.test.ts`, and `activate()` now falls back to a
      read-only view instead of leaving an empty pane if anything else ever
      throws there.
- [ ] **Manual, macOS** — TypeScript file with an error: squiggle appears and
      clears without stuttering while typing.
- [ ] **Manual** — a line with `é` and `👋`: hover and diagnostics land on the
      right characters under both negotiated encodings (`rust-analyzer` is the
      UTF-8 case).
- [ ] **Manual** — kill the server from the terminal behind: the editor says so,
      does not hang, and restarts on the next edit.
- [ ] **Manual** — open a large Rust repository with the toggle off: nothing
      starts, nothing slows down.
- [ ] **Manual** — quit with a server running: no orphaned process.
- [ ] **Manual, Windows** — a Node-based server resolves through `PATHEXT`.

---

## 9. Production polish

The features worked; they did not yet *look* like the rest of the app. This
section is the pass that closes that gap.

**On the positioning library.** Popper.js was suggested and is the wrong thing
to add: `@floating-ui/dom` is already a dependency, already positions the
terminal's suggestion popup, and *is* Popper's successor — same author, Popper
v3 renamed. A second positioning library would be two answers to one question.

- [x] **`@floating-ui/dom` under every LSP overlay** — `computePosition` with
      `offset`/`flip`/`shift`/`size`, matching `SuggestionPopup.tsx`. The
      hand-rolled `anchor()` in `popup.ts` flips only vertically, cannot shift
      horizontally off a narrow modal, and does not follow the text when the
      editor scrolls under it.
- [x] **`autoUpdate`** so an overlay tracks its character position through
      scrolling, resizing and the modal being dragged, rather than being placed
      once and left behind.
- [x] **⌘-hover definition underline** — the VS Code affordance: hold ⌘ (Ctrl
      elsewhere) and the symbol under the pointer underlines and takes a
      pointer cursor **only when the server actually has a definition for it**,
      so the underline is a promise rather than a guess. Clicking follows it.
      Debounced, cancelled on move, cleared on keyup, blur and scroll.
- [x] **Completion list** — a kind glyph per item the way every editor has one,
      the server's `detail` right-aligned and dimmed, deprecated items struck
      through, and a documentation panel that doesn't jump as items are
      arrowed through.
- [x] **Hover** — the signature rendered as code in a header, ruled off from
      the prose below it, instead of one undifferentiated block of text.
- [x] **Diagnostics** — severity-coloured tooltip and gutter that match the
      editor's own palette rather than `@codemirror/lint`'s defaults.
- [x] **Status bar and settings** — quiet when healthy, loud when not: a ready
      server shows a dot and no text, because the language is already named by
      the picker beside it, while indexing, starting, missing and failed all say
      so in words. Servers that aren't installed stay listed but dimmed, and
      Restart is only offered where a process exists to restart.
- [x] **Both themes** — every new rule has a `.light` counterpart.
- [x] **The picker closes three ways** — Escape, a close button, and a click
      outside it. The outside click was missing and is the one most people reach
      for first; it listens on `mousedown` so the panel is gone before the press
      reaches the editor behind, and it is registered a tick late so the gesture
      that opened the panel cannot immediately close it.
- [x] **References read as results, not line numbers** — file name, directory,
      line badge, and **the source line itself** under each row. Open buffers
      answer from memory; closed files are read in parallel, capped at 40.
      `axios-server.ts:13` does not tell you which of twelve results you want;
      `const authHeaders = getAuthenticatedHeaders(session)` does.
- [x] **Opening a result lands on the line** — it often didn't. `activate()`
      restored the buffer's saved scroll offset in a `requestAnimationFrame`
      while the modal applied the queued `goTo` in one of its own; whichever ran
      second won, and when it was the restore you got the right file scrolled to
      the top. The restore is now cancellable and an explicit `goTo` cancels it.
- [x] **One owner per surface** — `editorTheme.ts` owns the tooltip box, which
      it can colour from the palette; `styles.css` owns the content and the row
      layout. Both were setting backgrounds with different hardcoded greys,
      which is why the hover tooltip in `docs/issues` did not match the
      completion list beside it.
- [ ] **Manual** — ⌘-hover an import, a local variable and a keyword: only the
      first two underline, and only where the server resolves them.
- [ ] **Manual** — a completion list at the bottom edge of a short modal, and a
      code-action menu at its right edge: both stay inside the window.

---

## 10. Python interpreters

Pyright is only as useful as the environment it resolves imports against. Point
it at the system Python and every third-party import in a project with a `.venv`
is reported as missing — which looks exactly like a broken language server.

**Why it did not work before:** the client answered every
`workspace/configuration` request with an empty object. That is a legal answer
and a useless one — it is the request pyright uses to ask "which interpreter?",
and the empty answer means "the default".

- [x] **Detect interpreters in the workspace** — `.venv`, `venv`, `env`,
      `.virtualenv`, and the `Scripts` rather than `bin` layout on Windows. `uv`,
      `python -m venv`, `virtualenv` and `poetry --in-project` all produce one of
      these, which is why the list is short.

      **This did not work on the first attempt and the reason is worth keeping.**
      Detection went through `fs_stat`, which canonicalises a path and checks it
      against the workspace roots — and `.venv/bin/python` is a *symlink to the
      base interpreter*, which uv points at
      `/opt/homebrew/opt/python@3.13/bin/python3.13`. It resolved out of the
      project, the confinement check rejected it, and the only interpreter the
      user actually wanted was the only one that could never be listed. It goes
      through `lsp_detect` now — the same executable lookup the servers use,
      which has no notion of roots.
- [x] **Show the version, and mark the recommended one** — `Python 3.13.3
      ('.venv')` with a Recommended badge, asked of the binary rather than
      inferred from its path. With three Pythons listed and no guidance, the one
      that resolves the project's imports is indistinguishable from two that
      don't.
- [x] **Detect once, not twice** — the modal owns the list and the picker reads
      it. Both were detecting independently, which with version probes meant two
      rounds of subprocesses for one answer.
- [x] **Detect interpreters on `PATH`** — `python3` and `python`, through the
      existing `lsp_detect`, as the fallback when a project has no environment.
- [x] **Auto-select** the in-project one when there is exactly one, because that
      is the answer in the overwhelming majority of cases and asking would be
      asking a question with one possible answer.
- [x] **Let the user pick** — a status-bar item beside the language, shown only
      for Python files, listing what was found. VS Code's placement, because it
      is where people already look for it.
- [x] **Serve it to the server** — real answers to `workspace/configuration` for
      `python` and `python.analysis`, not `{}`.
- [x] **Remember it per workspace** — an interpreter is a property of a project,
      not of the editor.
- [x] **Restart pyright when it changes** — it resolves the environment once, at
      startup, and will not notice a new one otherwise.

## 11. Ignored files

- [x] **`git ls-files --others --ignored --exclude-standard --directory`** — one
      call per workspace, giving ignored paths with directories collapsed, so
      `node_modules` is one entry rather than forty thousand.
- [x] **Dim them in the explorer**, the way every editor does, so the tree says
      what is and is not part of the project without being read.
- [x] **No change marks when one is open.** Git reports an untracked file as
      wholly new, so the gutter paints every line as added — on a build artefact
      or a `.env` that is forty thousand green bars describing nothing. An
      ignored file is not "new work"; it is not work at all.

### What is deliberately not here

- **No `uv`/`poetry`/`pipenv` integration.** All four produce a directory in the
  project with `bin/python` in it, so detecting the *directory* covers every one
  of them and stays correct when the next tool arrives. Shelling out to each to
  ask where its environment lives would be four subprocesses, four output
  formats, and a list that goes stale.
- **No conda or pyenv enumeration.** Both live outside the project and neither
  has a stable place to look. They are reachable by picking the interpreter, and
  guessing wrong is worse than not guessing.
- **Ignored state is refreshed on a slow timer** (10s) rather than on every
  watcher burst. It only changes when someone edits a `.gitignore`, while
  `git status` changes on every save — one process per keystroke pause for a
  fact that moves once a month is not a trade worth making.

---

## 12. Overlays that would not go away

Three separate leaks, one symptom: something floating over the code that the
user could not dismiss. Two are visible in `docs/issues`.

- [x] **Hover tooltips survived edits and cursor moves.** `hoverTooltip`'s
      `hideOnChange` defaults to **false** — CodeMirror deliberately keeps one
      open across changes unless told otherwise. A hover describes what is under
      the pointer at a moment, and the moment ends when the document or the
      selection changes.
- [x] **Signature tooltips survived the call they described.** The field cleared
      only on `docChanged`, on the theory that the plugin would replace it when
      the cursor moved. It does — *when the request succeeds*. Cancelled, timed
      out, or moved somewhere that is not a call, nothing replaced it. It now
      clears on any document **or selection** change and lets the answer
      re-show; a late answer for a position the cursor has left is dropped.
      Escape dismisses it, and falls through when there is nothing to dismiss.
- [x] **The pickers survived a tab switch** — and this is the "I opened `b.py`
      and it is showing `a.py`" report. The references list, the code-action
      menu and the rename box are plain DOM appended to the editor, because they
      anchor to a character position; swapping the view's state does not remove
      them. Closed now on every buffer switch and on teardown.
- [x] **Diagnostics could paint one file onto another.** Subtler and worse than
      the rest: the surface swaps states in a *single shared* `EditorView`, so a
      dispatch arriving after the swap lands on whichever file is in front —
      squiggles at offsets resolved against the wrong text. The plugin now marks
      itself gone on destroy and drops anything that arrives after.
- [x] **`signature.test.ts`** pins the clearing rule, which is one line and
      exactly the kind of thing that gets quietly reverted.

---

## 13. Settings, retabbed

The Language Server section had outgrown the panel it was in: a master toggle, a
format-on-save toggle and a table of eleven servers with their state and install
lines, wedged into a single scrolling column between "word wrap" and "show
hidden files". That is not where a feature with a table in it belongs.

- [x] **Five tabs** — Appearance, Editing, **Language Server**, Files, Diff —
      with a left rail rather than a strip along the top: five labels do not fit
      across a modal this narrow without truncating to initials, and a rail is
      what the app's own Settings dialog already uses.
- [x] **The modal grew** from 420px wide and free-height to 620×440, so the
      server table has room and switching tabs does not resize the window.
- [x] **A real `tablist`** — `role`, `aria-selected`, `aria-controls`, arrow-key
      navigation with wrapping, Home/End, and roving `tabIndex` so Tab moves
      past the rail into the controls instead of through five buttons first.
- [x] **The server table got a header** — a count answering the question people
      open the tab with ("is anything going to happen?") and the re-check button
      beside it rather than stranded under the last row.
- [x] **And a search box**, once the table reached twenty-four rows — past the
      point where scanning beats searching. It matches the label, the program,
      the id **and the files each server claims**, because the thing people
      arrive knowing is usually the file: "what handles `.tsx`" is a far more
      common question than "is `typescript-language-server` installed", and
      searching by name requires already knowing the answer. A leading dot is
      ignored, several terms narrow rather than widen, and Escape clears the box
      only while there is something in it — otherwise it falls through and
      closes the dialog, which is what Escape does everywhere else.
- [x] **`search.test.ts`** — eleven cases, including two that hold the *table*
      to account rather than the matcher: every server must be reachable by its
      own label, and by one of its extensions. An entry that can be seen but
      never found is a bug the matcher alone would never reveal.

---

## 14. Matching on files, and companions

Twelve more servers went in, and two structural problems had to be fixed first
— both of which the eleven-entry table had been hiding.

- [x] **The table keys on file extensions, not the editor's language ids.**
      Those ids pick a *highlighting grammar* and are approximate: `.kt` is
      highlighted as `cpp`, `.svelte` as `html`, `.scala` as `cpp`. A Kotlin
      server keyed on `cpp` would have started on C++ files. Nothing caught it
      because until now every server's language happened to have its own
      grammar.
- [x] **Each extension carries the language id to *send*.** `didOpen` speaks the
      protocol's vocabulary, not ours — `typescript-language-server` wants
      `typescriptreact` for a `.tsx` file and does the wrong thing with `tsx`.
      That was already wrong for every `.tsx` file before these servers arrived.
- [x] **Companion servers**, so Tailwind can work at all. It completes class
      names *inside* HTML, CSS and JSX, all of which already have a server; the
      one-server-per-file model would have forced it to replace one of them.
      Now a file can have a primary and any number of companions, and the two
      are treated differently on purpose: anything producing a **list** —
      diagnostics, completion, hover — merges across all of them; anything
      producing **one answer** — go to definition, rename, format — goes to the
      primary alone, because a companion would answer null and lose the real one.
- [x] **Diagnostics merge per session.** `setDiagnostics` replaces everything in
      a document, so two servers publishing independently each wiped the other's
      — whichever spoke last would have been the only one you ever saw.
- [x] **Tailwind's configuration is served.** It asks for `tailwindCSS` and
      `editor` through `workspace/configuration` and offers *nothing* without
      them: no completions, no lint, no swatches. Another empty-`{}` answer that
      would have looked like our bug.
- [x] **The cap went from 3 to 6.** A React project with Tailwind is four
      servers before anything unusual happens, and a cap that refuses the
      ordinary case just looks broken.
- [x] **`servers.test.ts`** — 12 cases, including the two silent failures above
      and an invariant that no two primaries may claim one extension.

---

## 15. Overlays inside the editor, and a legible completion list

Both from `docs/issues`.

- [x] **Tooltips no longer cover the breadcrumb.** CodeMirror considers the
      **whole window** available when deciding where a tooltip fits, so a hover
      on line 1 flipped upward onto the breadcrumb bar — which is not part of
      the editor's DOM, so nothing stopped it and it hid the file path.
      `tooltips({ tooltipSpace })` bounds them to the scroller, which makes them
      flip down instead, and keeps the completion list off the status bar at the
      other end.
- [x] **The same boundary for the LSP pickers.** Floating UI was flipping and
      shifting against the viewport for the same reason; it now gets the
      scroller as its `boundary`.
- [x] **The completion list is scannable.** CodeMirror's kind icons are bare
      italic letters at 90% size and 0.6 opacity — in a list of forty Tailwind
      classes that is a column of grey specks. They are now filled, rounded
      badges with a colour per family, which is the entire job of an icon
      column.
- [x] **Every completion kind is mapped.** Nine of them fell through to `text`,
      including `Constant` and `Color` — which is *almost the whole* of a
      Tailwind class list, so that list rendered as undifferentiated plain text.
- [x] **The matched text stopped being underlined.** It was told not to be, and
      the rule was losing: the library's styles are plain single-class selectors
      injected into the head, so which won depended on load order. Weight and
      colour instead of an underline, which also stops it colliding with the
      ⌘-hover link underline.
- [x] **`tooltipClass` and `optionClass`** — a class on the dialog and one per
      row, so scoping is guaranteed rather than a specificity race, and the
      deprecated treatment stops reaching the label through a sibling selector
      on its icon.
- [x] **Built to the pickers' standard** — bordered card, 14px kind badges,
      a 2px accent bar on the selected row, thin scrollbars, a bounded
      documentation panel using the same renderer as the hover tooltip, and a
      keyboard hint along the bottom.

      No header, though, and that is the one place it deliberately departs from
      the pickers: a completion list opens on almost every keystroke, and a
      title bar on something that transient reads as heavy rather than
      considered. The footer is generated content because CodeMirror has no
      per-dialog slot — `addToOptions` injects per *option* — and a static hint
      loses nothing by not being real text.
- [x] **Light theme ordering** — the neutral badge rule sat *after* the
      per-kind colours at equal specificity, which flattened every icon in the
      light theme back to grey.

---

## 16. Finding the .NET runtime

`csharp-ls` installed cleanly and then refused to start:

```
You must install .NET to run this application.
App host version: 10.0.11
.NET location: Not found
```

On a machine where `dotnet --list-runtimes` printed a perfectly good
`Microsoft.NETCore.App 10.0.11`.

**Two things compounding.** A tool installed by `dotnet tool install --global`
is an **apphost** — a native launcher that must locate a runtime before it can
run anything. It checks `DOTNET_ROOT`, a couple of fixed system paths, and
`/etc/dotnet/install_location`. It does *not* look next to the `dotnet` on your
`PATH`. Homebrew installs to `/opt/homebrew/opt/dotnet/libexec` and sets no
`DOTNET_ROOT`; the `dotnet` CLI copes because it knows where it is, an apphost
does not. And `/etc/dotnet/install_location_arm64` on this machine still named
`/usr/local/share/dotnet` from an official installer that is long gone — a
pointer that outlived what it pointed at.

- [x] **Derive `DOTNET_ROOT` from the `dotnet` binary we would actually run.**
      Canonicalise it, then look for `shared/Microsoft.NETCore.App` beside it,
      under a sibling `libexec`, or one level above `bin`. That covers Homebrew,
      the official installer and a tarball unpacked anywhere, because in every
      layout the runtime sits beside the SDK.
- [x] **Only when the user hasn't set it.** Someone who pinned a runtime or
      pointed at a private build must not be second-guessed.
- [x] **Four unit tests** over synthetic layouts, including the "no runtime
      nearby" case — which must yield nothing rather than a directory that would
      make the apphost fail more confusingly.
- [x] **`csharp-ls` added to the real-server handshake test**, so a .NET apphost
      is exercised rather than only servers that need no runtime lookup. Five
      servers now complete the handshake on this machine.

This generalises: it fixes any `dotnet tool`, not just this one.

---

## Out, deliberately

- **Semantic tokens** — they would fight the Lezer highlighting, which is
  already fast, incremental and good.
- **Inlay hints, call hierarchy, workspace symbols** — each a feature of its
  own, and none is why somebody opened a terminal.
- **Multi-root workspaces** — the editor has one root at a time by design.
- **Bundling or downloading servers** — the user's toolchain is already
  installed and already configured.
