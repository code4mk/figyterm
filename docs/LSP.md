# Language Server Protocol in the editor

**Status: built.** This document is the design and the argument behind it;
[`LSP-TASKS.md`](./LSP-TASKS.md) is what was built and what is still unproven.
The decisions below were all kept, with one correction noted under
[Features](#features-in-the-order-they-should-land).

> **[`CODE-INTELLIGENCE.md`](./CODE-INTELLIGENCE.md) is still worth reading.**
> It sets out four cheaper tiers — the syntax tree CodeMirror already parses, a
> ctags-style project index, diagnostics harvested from the build you already
> run in the terminal, and one-shot formatters. They were not built first, as
> that document suggested; a language server was. But they have not been
> superseded, because they are the tiers that work for the languages no server
> in the table covers, and the terminal-output one is still the only diagnostic
> source that *is* your actual build.

`docs/CODE-EDITOR.md` defers LSP — *"a language-server lifecycle manager, a
protocol client and a per-language install story — a project of its own."* This
is that project, written down so the argument can happen before the code does.
Nothing in it is wrong; it is simply expensive, and worth reaching for only
after the cheap tiers have been lived with.

Related: [`CODE-EDITOR.md`](./CODE-EDITOR.md) for what the editor already is,
and [`WINDOWS-SUPPORT.md`](./WINDOWS-SUPPORT.md) / [`LINUX-SUPPORT.md`](./LINUX-SUPPORT.md)
for the per-platform assumptions anything that spawns a process has to respect.

---

## The question to settle first

Not "can we", but **"should a terminal do this at all?"** The honest case
against is strong enough to write down:

- `rust-analyzer` on a repository of any size is one to four gigabytes resident
  and minutes of indexing before it answers anything. FigyTerm is a ~10 MB
  terminal that starts fast — the same argument that ruled out Monaco.
- The editor exists for "peek and patch a file next to my shell". Clicking a
  `tsc` error in terminal output and landing on the right line is the headline
  feature; none of it needs a language server.
- There is a real editor one `⌘T` away. Nobody has to do their refactor here.

The case for is narrower but real: **the file you opened from a stack trace is
the file you want to understand**, and "what is this symbol, where is it
defined, what did I just break" is exactly what you cannot answer from
highlighting alone. Word completion from the open document — which is what the
editor has instead today — is most of the value for "finish this identifier"
and none of it for anything else.

But note *which* of those questions actually needs a server. "Where is this
defined" is a project index. "What did I just break" is the compiler you are
already running in the pane behind. Only "what **type** is this" needs the
thing this document describes — which is why
[`CODE-INTELLIGENCE.md`](./CODE-INTELLIGENCE.md) should be read first and
probably built first.

So: **yes, eventually, but never by default and never silently.** Every decision
below follows from that sentence. A language server starts because the user
asked for that language, not because a file happened to open.

---

## Decisions

Settled up front, because each one closes off a direction the rest of the
document would otherwise keep re-opening.

| Question | Decision |
|---|---|
| Bundle or download servers? | **Neither.** Use what is on `PATH`. This is a terminal; the user's toolchain is already installed and already configured. Same reasoning as shelling out to `git` rather than linking libgit2. |
| Where does the client live? | **Split.** Rust owns the *process and the framing*; TypeScript owns the *protocol and the editor integration*. See [Architecture](#architecture). |
| Start automatically? | **No.** Opt in per language, and never on a file opened from a terminal link — that path exists to be fast. |
| One server per what? | Per `(workspace root, language)`. Lazily started, idle-stopped. |
| Position encoding | **UTF-16**, requested explicitly and honoured as negotiated. See [The encoding trap](#the-encoding-trap). |
| Document sync | **Incremental.** CodeMirror already produces exactly the change shape LSP wants. |
| Semantic tokens | **Out.** They would fight the Lezer highlighting that is already there and already good. |
| A protocol library? | **Types only** (`vscode-languageserver-protocol`), not a client. The clients in the wild assume Node's `child_process` and a `vscode` host. |

---

## Architecture

The webview cannot spawn a process, and a Tauri command is request/response
while a language server is a duplex stream. So the split is forced in one place
and chosen in the other.

```
┌──────────────────────────── webview ─────────────────────────────┐
│  EditorSurface ──► services/lsp/client.ts                        │
│    (CodeMirror)      • initialize handshake, capabilities        │
│                      • document sync, versions                   │
│                      • request/response correlation, cancels     │
│                      • LSP ⇄ CodeMirror position mapping         │
│                              │            ▲                      │
└──────────────────────────────┼────────────┼──────────────────────┘
                    invoke     │            │   event
                  lsp_send()   │            │   "lsp://message"
┌──────────────────────────────▼────────────┴──────────────────────┐
│  commands/lsp.rs  ──►  lsp/server.rs                             │
│    • spawn, PATH resolution, cwd, env                            │
│    • Content-Length framing both ways                            │
│    • a reader thread per server, emitting one event per message  │
│    • kill, restart, reap                                         │
└──────────────────────────────────────────────────────────────────┘
```

**Rust knows nothing about LSP.** It does not parse a `textDocument/hover`; it
parses a `Content-Length` header and emits the body as an opaque JSON value.
That line is deliberate: adding a new request type is then a TypeScript change,
and the Rust side has one job it can be tested on.

The precedents are already in the tree and should be followed rather than
reinvented:

- **`terminal/pty.rs`** for child-process lifetime — in particular splitting a
  killer off the `Child` so the process can be terminated without holding the
  whole handle, and a reader thread that owns the pipe.
- **`terminal/manager.rs`** for a `HashMap` of live children behind a `Mutex`,
  and a callback that turns reads into events.
- **`commands/fs.rs`'s search** for streaming many results out as events with a
  generation counter, so a superseded stream can notice and stop.
- **`commands/shell_exec.rs`'s `resolve_program`** for finding a program on
  Windows, where `PATHEXT` means `typescript-language-server` is really
  `typescript-language-server.cmd` and `Command::new` will not find it. Every
  Node-based server hits this. It is already solved; reuse it.

### Rust surface

```
src-tauri/src/lsp/
  mod.rs
  server.rs        one child: spawn, framing, reader thread, shutdown
  registry.rs      HashMap<ServerKey, Server>, lazy start, idle stop
src-tauri/src/commands/lsp.rs
```

| Command | Notes |
|---|---|
| `lsp_start(dir, language)` | Resolves the program, spawns it, returns a server id. Idempotent per key. |
| `lsp_send(id, message)` | One JSON value, framed and written to stdin. Fire and forget — replies arrive as events. |
| `lsp_stop(id)` | Polite `shutdown`/`exit` first, then kill after a deadline. |
| `lsp_status()` | What is running, what it costs, what failed. For the status bar. |

Events: `lsp://message` (one per server message), `lsp://exit` (with the code,
so the client can decide whether to restart).

`lsp_send` takes a whole message rather than a method and params so that Rust
never has to know which messages exist.

### The framing is the part that bites

Language servers speak JSON-RPC over stdio with an HTTP-ish header:

```
Content-Length: 143\r\n
\r\n
{"jsonrpc":"2.0", ... }
```

Three things go wrong here and all three are worth a test:

- **The header is ASCII, the body is UTF-8, and `Content-Length` counts
  *bytes*.** Reading "143 characters" off a stream containing a single
  non-ASCII identifier desynchronises the parser permanently, and the symptom
  is a server that appears to hang halfway through a session.
- **`\r\n` is mandatory** and some servers are lax about what they accept while
  being strict about what they send. Write exactly what the spec says.
- **stderr is not the protocol.** Servers log to it freely, and a server that
  dies usually explains why there. It should be captured and surfaced, not
  merged into stdout — merging them is how a log line ends up parsed as a
  header.

---

## The encoding trap

LSP positions are `{ line, character }` where `character` is, by default,
**UTF-16 code units** — not bytes, not codepoints. CodeMirror's offsets are
into a JavaScript string, which is also UTF-16. That is a gift: with UTF-16
negotiated, converting is line arithmetic and nothing else.

```ts
// CodeMirror offset → LSP position
const line = state.doc.lineAt(offset);
return { line: line.number - 1, character: offset - line.from };
```

Two ways to lose the gift:

- **LSP 3.17 added `positionEncoding` negotiation** and some servers prefer
  UTF-8 — `rust-analyzer` among them. Ask for `["utf-16"]`, but *honour what
  comes back*: if a server insists on UTF-8, every conversion needs a
  byte-length walk over the line. Get this wrong and everything is subtly
  off by one on any line containing an emoji or an accented character, which
  is the kind of bug that gets reported as "hover is wrong sometimes".
- **Astral-plane characters are two code units.** A line containing one makes
  codepoint counting and code-unit counting disagree. `Array.from(line).length`
  is the wrong tool here; `line.length` is the right one.

This deserves a test with a line containing `é`, `👋` and a tab, against both
encodings, before any feature is built on top of it.

---

## Document sync

Incremental, and CodeMirror hands over precisely the right shape:

```ts
update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
  changes.push({
    range: { start: pos(startDoc, fromA), end: pos(startDoc, toA) },
    text: inserted.toString(),
  });
});
```

The ranges must be in the **pre-change** document — `fromA`/`toA` are exactly
that, and `update.startState.doc` is the document to resolve them against.
Resolving them against the new document is the single most common way to
corrupt a server's view, and the corruption is silent until a completion comes
back describing a file that no longer exists.

Other rules, each of which is a bug if skipped:

- **A version per document, monotonically increasing,** sent on every
  `didChange`. A server that sees versions go backwards is entitled to do
  anything.
- **`didOpen` on buffer open, `didClose` on buffer close** — tied to the
  editor's buffer lifecycle, not to the tab strip. A background tab is still
  open.
- **The watcher's reload path must send a `didChange`.** When a file changes on
  disk under a clean buffer the editor reloads it silently; a server told
  nothing would answer about the old text forever.
- **Batch per animation frame.** Every keystroke does need to reach the server,
  but three keystrokes in one frame can be one message.
- **Large and read-only buffers are not synced at all.** Over the existing
  `LARGE_FILE_BYTES` threshold the editor opens read-only with highlighting
  off; a server has nothing to add and a great deal to consume.

---

## Which servers, and how they are found

No bundling, no downloading, no install wizard. A table of what to look for,
and an honest message when it is not there.

| Language | Program | Install |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server --stdio` | `npm i -g typescript-language-server typescript` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| Python | `pyright-langserver --stdio` | `npm i -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| JSON / CSS / HTML | `vscode-json-language-server` etc. | `npm i -g vscode-langservers-extracted` |

The user can override any of them, and add their own, in editor settings —
program, arguments, and which file extensions it claims.

**A missing server is a first-class state, not a silent no-op.** The status bar
should say "No language server for Rust" and offer the install line, because the
alternative is a feature that appears broken to everyone who has not already
read this document.

One consequence worth stating: a user-editable table of programs to spawn is a
user-editable table of programs to spawn. It is the same trust level as the
shell the terminal already runs, and it should be kept clearly in the settings
UI rather than somewhere a stray import could reach.

---

## Lifecycle, which is where this gets expensive

The protocol is the easy half. Keeping a heavyweight child process honest is the
half that decides whether this is worth shipping.

- **Lazy start.** On the first buffer of that language in that root — never on
  the editor opening, never on a file opened from a terminal link.
- **Idle stop.** No buffer of that language open for N minutes → `shutdown`,
  `exit`, then kill on a deadline. The deadline matters: `git_network` in
  `git/operations.rs` already has the shape, and the lesson is the same one —
  a child that will not die must not become a process nobody can see.
- **A cap.** Two or three servers at once. A fourth waits or refuses, loudly.
- **Restart with backoff, and a ceiling.** A server that crashes on a particular
  file will crash again immediately; three restarts inside a minute should stop
  and say so rather than fork-bombing quietly.
- **Every request has a timeout** and issues `$/cancelRequest` when the user
  moves on. Hover and completion are asked for constantly and abandoned
  constantly.
- **Visible cost.** The status bar should be able to say which servers are up
  and what they are doing — "rust-analyzer: indexing" is the difference between
  a slow editor and a broken one.
- **Shutdown on quit.** `lib.rs` already reaps PTYs on `RunEvent::Exit` for
  exactly this reason; language servers join that list or they outlive the app.

---

## Features, in the order they should land

Each phase is shippable on its own, and each one is chosen for what it teaches
rather than for what it looks like.

**Phase 1 — Diagnostics.** `textDocument/publishDiagnostics` is a *push*: no
request correlation, no cancellation, no position mapping in the outbound
direction. It is the highest-value feature and the lowest-risk one, and it
proves the transport, the framing, the lifecycle and the encoding end to end.
Rendered through `@codemirror/lint`, which already has the gutter and the
tooltip. If Phase 1 is not pleasant to use, stop here — the rest is more of the
same machinery for less benefit.

**Phase 2 — Hover, then completion.** The first request/response, so this is
where correlation, timeouts and `$/cancelRequest` arrive. Hover first because
it is one request and one tooltip. Completion is deceptively large: trigger
characters, `isIncomplete` re-querying, `completionItem/resolve` for
documentation, sort/filter text that must override CodeMirror's own matching,
and snippets. It replaces the word-completion source rather than sitting beside
it — two completion sources in one list is a worse experience than either alone.

**Phase 3 — Go to definition and references.** Navigation across files, which
the editor already knows how to do: `openPath(path, line, column)` and the
existing go-to queue. Mostly plumbing, and a good demonstration that the editor
is a real one.

**Phase 4 — Rename, formatting, code actions.** These *edit files*, including
files that are not open, and that is a different risk class entirely. A
`WorkspaceEdit` touching a closed file must go through the same atomic write,
mtime conflict check and line-ending preservation as a save — see "Not losing
the user's work" in `CODE-EDITOR.md`. Anything less and a rename across forty
files becomes forty chances to lose one.

**What changed when this was built:** all four phases landed, and Phase 4's
"applied atomically or not at all" turned out to be a promise the filesystem
cannot keep. What `services/lsp/edits.ts` does instead is pre-flight — every
file read, every range resolved, every new text built *before* anything is
written — so the failures that can be caught are caught while nothing has
changed, and a write that fails halfway says which files changed rather than
pretending it rolled back. A cross-file journal would have been a larger project
than the feature it was protecting.

**Deliberately out:**

- **Semantic tokens.** They would fight the Lezer highlighting already in place,
  which is fast, incremental and good.
- **Inlay hints, call hierarchy, workspace symbols.** Each is a feature of its
  own and none is why somebody opened a terminal.
- **Multi-root workspaces.** The editor has one root at a time by design.

---

## What will go wrong

Written now so that nobody is surprised later.

- **Memory.** `rust-analyzer` on a large repository will dwarf the rest of the
  app. Opt-in is the mitigation; a visible number in the status bar is the
  honesty.
- **Cold start.** Minutes before the first useful answer on a big project, and
  during it the editor must not appear frozen or, worse, answer wrongly.
- **Windows.** `PATHEXT` again, and Node servers needing `node` on `PATH`.
  `resolve_program` solves the first; the second needs a clear error.
- **Node-based servers are slow to start** and there are three of them in the
  table above.
- **Servers that lie about their capabilities**, or announce one and reject the
  request. Claim only the capabilities we implement, and treat every response
  as untrusted input — it is another program's output being rendered into a
  tooltip.
- **The editor is a modal that gets closed.** Closing it must not kill a server
  that was mid-index if it is about to be reopened, and must not keep one alive
  forever if it is not. The debounce belongs on the *stop*, not the start.

---

## The smallest thing that proves it

Before any of the above is built in full, one walking skeleton:

> `typescript-language-server`, diagnostics only, one workspace root, started
> from a button in editor settings and killed when the editor closes.

That exercises the spawn, the framing, the encoding, the document sync, the
lifecycle and the rendering — every part that can be fundamentally wrong —
while being small enough to throw away. Everything after it is addition rather
than discovery.

---

## Verification

`cargo test` for the parts that are silently wrong when wrong, which is the
same standard the git parsers are held to:

- Framing round-trips, including a body with multi-byte characters where
  `Content-Length` and character count differ.
- A message split across reads, and two messages in one read.
- `resolve_program` against a `.cmd` shim.

Manual, per platform:

- Open a TypeScript file with an error: the squiggle appears, and disappears
  when fixed, without the editor stuttering while typing.
- A line containing `é` and `👋`: hover and diagnostics land on the right
  characters, under both negotiated encodings.
- Kill the server from the terminal behind: the editor says so and does not
  hang, and the next edit either restarts it or says it will not.
- Open the editor on a large Rust repository with the server off: nothing
  starts, nothing slows down.
- Quit the app with a server running: no orphaned process.
