# Embedded Code Editor

An in-app code editor, the way `BrowserModal` is an in-app browser.

**Status: built,** including git. CodeMirror 6, modal-only, with the terminal
integration. The `figy edit` CLI shim is still not wanted — see
[Decisions](#decisions) for what was settled and [Phases](#phases) for what is
and isn't done.

Reference: the screenshot in [`issues/`](./issues) — Cursor's editor pane with a
file tree pinned to the right, file tabs across the top, and a breadcrumb bar
under them. That's the shape we're copying. What follows is how it should be
built here, and what it needs to be worth opening twice.

Related: [`WINDOWS-SUPPORT.md`](./WINDOWS-SUPPORT.md) and
[`LINUX-SUPPORT.md`](./LINUX-SUPPORT.md) for the per-platform assumptions any
filesystem-touching feature has to respect, and
[`CODE-INTELLIGENCE.md`](./CODE-INTELLIGENCE.md) for how the editor gets
smarter without one.

---

## Decisions

Settled before the build started, and recorded here because each one closes off
a direction the rest of the document still discusses.

| Question | Decision |
|---|---|
| Editing engine | **CodeMirror 6.** Monaco's 5 MB and worker wiring aren't worth the VS Code feel here. |
| Modal or pane | **Modal only.** Docking it as a `PaneContainer` pane is not planned. |
| Git integration | **Reversed — built.** Tree decorations, gutter marks, a diff view, file-level staging, history and fetch/push. See [Git](#git). Hunk-level staging, branch switching and pull are still out. |
| `figy edit` CLI shim | **Not wanted.** |
| Existing browser modal | **Left alone.** The drag/resize hook was written for the editor and the browser keeps its own copy; see the note in `useDraggableModal.ts`. |

Three things the plan below got wrong, corrected in the build:

- **There is no fuzzy scorer to reuse.** The plan said quick open should borrow
  the autocomplete engine's ranking. That engine matches command-line tokens by
  prefix (`matchesPrefix`), which is right for shell completion and useless for
  a file finder — nobody types `src/components/Editor/EditorModal.tsx` to find
  it, they type `edmod`. `services/fuzzy.ts` is a small scorer written for this.
- **Cursor positions aren't restored across launches.** Open tabs and the active
  tab are; a per-buffer cursor would have meant either writing text into the
  store on every keystroke or a second persistence path, and neither earned it.
  Within a session, switching tabs preserves cursor, selection, folds and undo.
- **No image preview.** Binary files get a card naming the file and its size
  with a way out to the file manager. Showing the image itself needs Tauri's
  asset protocol enabled, which is a config and capability change this feature
  shouldn't smuggle in.

---

## Verdict

**The editor must not be a native child webview.** That is the one decision
worth making before any code is written, and it goes the opposite way to the
browser.

`BrowserModal` positions a real platform webview *underneath* React chrome
because it has to render arbitrary web content it does not control. Everything
awkward about that file is a consequence: `rectToBounds` shipping a DPI factor
because Rust and WebView2 disagreed about scale, the modal hiding the webview
mid-drag because a one-way IPC hop can't keep up with a pointer, the
placeholder that only ever shows while moving, the resize grip exiled to its own
status bar because the webview paints over anything above it, and
`browser_layout.rs` existing at all because GTK stacks child webviews instead of
floating them.

A code editor renders *our own* content. Put it in the app's own webview as
ordinary React and every one of those problems disappears — no bounds
arithmetic, no scale factor, no Linux container, no repaint lag, no z-order
fights, no focus handoff across process boundaries, and the theme tokens in
`styles.css` apply directly. It also means the editor works identically on all
three platforms on day one, which the browser did not.

So: React component tree, a text-editing engine bundled as JS, and a small set
of new Rust filesystem commands. The interesting risks move from "can we
position it" to "can we not lose the user's work" — which is the right place for
them to be.

---

## Engine: CodeMirror 6

Two real candidates.

| | CodeMirror 6 | Monaco (VS Code's editor) |
|---|---|---|
| Bundle | ~250–400 KB min for core + a few languages, tree-shakeable, per-language dynamic import | ~5 MB, plus separate worker bundles |
| Build integration | Plain ESM, Vite handles it with no config | Needs `vite-plugin-monaco-editor` or hand-rolled worker wiring; AMD legacy leaks through |
| Offline | Trivially self-contained | Self-contained, but only after the worker paths are right in dev *and* in the Tauri bundle |
| Theming | Extension-based; a theme is a data structure, so `--ft-*` tokens map straight in | Own token/theme system; CSS vars need a bridge |
| Feel out of the box | Excellent editing primitives; some VS Code chrome (minimap, peek) doesn't exist | Literally VS Code, minimap and all |
| Language support | Lezer grammars, ~30 first-party packages | TextMate grammars + full TS/JS IntelliSense built in |
| Mobile/IME/accessibility | First-class, rebuilt for CM6 | Adequate, desktop-shaped |

**Recommendation: CodeMirror 6.** FigyTerm is a ~10 MB terminal that starts
fast; a 5 MB editor engine with a worker fleet is the wrong trade for a modal
that opens beside a shell. CM6 gives us multi-cursor, folding, bracket matching,
autoclose, incremental highlighting, a real search/replace panel, undo grouping
and a proper extension system, and it lets languages arrive by dynamic import so
opening a `.tsx` doesn't pay for Rust and Python.

What we give up, and the honest answer for each:

- **Minimap** — no first-party equivalent. Community add-ons exist
  (`@replit/codemirror-minimap`); Phase 5 at the earliest, and arguably not
  missed in a modal this size.
- **TS IntelliSense** — Monaco ships it free. For us it was an LSP client, and
  it is now written: [`LSP.md`](./LSP.md) for the design,
  [`LSP-TASKS.md`](./LSP-TASKS.md) for what was built. It is off unless asked
  for, so the default experience is still highlighting, bracket-aware indent and
  word/path completion — which cover the "peek and patch a file next to my
  shell" case this is for. [`CODE-INTELLIGENCE.md`](./CODE-INTELLIGENCE.md)
  remains the cheap tier, and is the only one that works for languages no server
  covers.

If we later decide the VS Code feel is non-negotiable, the swap is contained:
everything CM6-specific should live behind `src/components/Editor/EditorSurface.tsx`
and nothing else should import from `@codemirror/*`.

---

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● Cta.tsx ×  │ Features.tsx ×│ Faq.tsx ×│ +          ⟲  ⤢  ×  ← drag bar │
├──────────────────────────────────────────────────────────────────────────┤
│ ← →  frontend › components › Cta.tsx        ⌕  ⌥  ⊞ (toggle explorer)    │
├────────────────────────────────────────────────┬─────────────────────────┤
│  1  import { Icon } from "./Icon";             │  ▸ .github              │
│  2  import { site } from "@lib/site";          │  ▾ frontend             │
│  3                                             │    ▾ components         │
│  4  export function Cta() {                    │      Cta.tsx            │
│  5    return (                                 │      Faq.tsx            │
│     ⋮                                          │      Hero.tsx           │
│                                                │  ▸ src                  │
│  (CodeMirror surface — gutter, folds,          │  ▸ src-tauri            │
│   multi-cursor, search panel)                  │  (virtualized tree)     │
├────────────────────────────────────────────────┴─────────────────────────┤
│ Ln 18, Col 12 · TSX · LF · UTF-8 · ⏎wrap · 3 files                  ◢    │
└──────────────────────────────────────────────────────────────────────────┘
```

The git columns the screenshot shows in the tree, and the branch name in the
status bar, are both there now — the layout had left room for them.

- **Modal frame** — drag, resize, maximize, Escape-to-close, backdrop click,
  the same manners as `BrowserModal`, minus every native-webview workaround. The
  drag/resize logic in `BrowserModal.tsx:258-327` is worth extracting to a shared
  `useDraggableModal` hook rather than copied; the browser then loses ~70 lines.
- **File tabs** — dirty dot, middle-click close, drag to reorder, overflow
  scroll, `⌘1-9` to jump. Cap at 12 open buffers, LRU-evict clean ones. The
  diff gets a tab here too — see [Diff view](#diff-view).
- **Breadcrumb** — path segments from the workspace root, each a click target
  that opens a directory picker for its siblings. Back/forward navigate the
  *file* history, not the directory.
- **Explorer, right side** — as in the screenshot, and resizable via
  `react-resizable-panels`, already a dependency (`PaneContainer.tsx` uses it).
  Collapsible to zero with `⌘B`; width persisted. It shares that column with
  Source Control and folder search, picked by a two-icon switcher in the
  toolbar rather than by a toggle each: with a toggle per panel the honest
  states were "tree shown", "source control shown" and "both buttons look off
  but a panel is open", which is what a radio group is for. Clicking the panel
  you are already on collapses the column, as an activity bar does.
- **Status bar** — language, encoding, line ending, cursor position, indent
  setting, git branch, and the resize grip. Clicking language, encoding, line
  ending or indent opens a picker for it. The indent picker sets what *new*
  indentation is and leaves the file alone: a file with mixed indentation
  usually has it for a reason somebody else decided, and rewriting every line
  on a menu click turns a setting into a whole-file diff.

---

## State and services

```
src/stores/editorStore.ts        buffers, tabs, explorer expansion, dirty state
src/services/editor-fs.ts        typed wrappers over the new Tauri commands
src/services/editor-lang.ts      extension → dynamic language import + icon
src/services/editor-session.ts   persistence (open tabs, cursors, tree state)
src/services/git.ts              typed wrappers over the git commands
src/services/diff.ts             unified diff → blocks, plus the word diff
src/hooks/useGitStatus.ts        one coalesced `git status`, shared by three views
src/components/Editor/
  EditorModal.tsx                frame, tabs, breadcrumb, status bar
  EditorSurface.tsx              the only file that imports @codemirror/*
  FindPanel.tsx                  find/replace, rendered into CodeMirror's panel
  GoToLine.tsx                   go to line, with a preview
  FileExplorer.tsx               virtualized tree, git-decorated
  ContextMenu.tsx                the shared right-click shell
  QuickOpen.tsx                  fuzzy file finder
  GlobalSearch.tsx               ripgrep-style results panel
  SourceControl.tsx              changes/history tabs, fetch and push, commit box
  CommitHistory.tsx              the history list, and which pane is on screen
  CommitDetail.tsx               one commit: title, body, files, Back
  ChangeTally.tsx                "24 edited · 6 new · 1 deleted", as chips
  EditorSettingsModal.tsx        the editor's own preferences
  editorIndent.ts                indentation guides and the active block
  DiffView.tsx                   working tree vs HEAD
src/hooks/useFileWatcher.ts      external-change subscription
```

`editorStore` is zustand, matching `terminalStore` / `workspaceStore`.
Persistence follows `services/settings.ts`: a versioned JSON blob in
`localStorage` under `figy-term-editor`, merged over defaults, so a schema
change degrades instead of throwing.

One rule worth stating up front: **buffer text does not live in zustand.** CM6
owns the document; the store holds metadata (path, dirty, cursor, language,
scroll). Putting a 5,000-line file in a React store and re-rendering the tree on
every keystroke is the standard way these editors end up feeling slow.

---

## Rust side

There is already dead code to wire up: `filesystem::operations::list_directory`
and `git::operations::get_git_status` both exist, are both complete, and neither
is registered in `lib.rs`'s `invoke_handler`. The frontend placeholders in
`services/filesystem.ts` and `services/git.ts` are stubs returning empty values.
Phase 1 mostly finishes something half-built.

New module `src-tauri/src/commands/fs.rs`:

| Command | Notes |
|---|---|
| `fs_list_dir(path, show_hidden)` | wraps the existing function; adds git status per entry and a `.gitignore` flag |
| `fs_read_text(path)` | returns content + detected encoding + line ending + whether truncated |
| `fs_write_text(path, content, line_ending, expected_mtime)` | atomic: temp file in the same directory, then rename. `expected_mtime` is the conflict check |
| `fs_stat(path)` | size, mtime, readonly, is_binary sniff |
| `fs_create(path, is_dir)` / `fs_rename` / `fs_delete(path, to_trash)` | explorer context menu |
| `fs_search(root, query, opts)` | walks with `ignore`, matches with `regex`, streams results as events |
| `fs_reveal(path)` | Finder / Explorer / `xdg-open` on the parent |

The git commands live in their own module, `src-tauri/src/commands/git.rs` over
`src/git/operations.rs`:

| Command | Notes |
|---|---|
| `git_status(dir)` | branch, upstream divergence and every changed file, from `status --porcelain=v2 --branch -z -uall` |
| `git_file_hunks(dir, path)` | which lines differ from HEAD, from the `@@` headers of a `--unified=0` diff |
| `git_file_diff(dir, path)` | the unified diff of the working tree against HEAD, for `DiffView` |
| `git_stage` / `git_unstage` / `git_discard` | `add`, `reset -q HEAD`, `checkout -q`; all take repo-relative paths |
| `git_commit(dir, message)` | commits the index, returning git's own summary line |
| `git_log(dir, skip, limit)` | one page of history, from a `%x1f`-delimited `--format` |
| `git_commit_detail(dir, sha)` / `git_commit_diff(dir, sha, path)` | a commit's message body and files, and one file's diff at it |
| `git_fetch(dir)` / `git_push(dir)` | the only two calls that leave the machine — see below |

New module `src-tauri/src/commands/fs_watch.rs` using `notify` — one recursive
watcher per open workspace root, debounced ~150 ms, emitting `editor://fs-change`.
`notify` maps to FSEvents, inotify and `ReadDirectoryChangesW`, which behave
differently enough (coalescing, rename pairs, inotify watch limits) that the
debouncer should emit *invalidations* ("this subtree changed") rather than
trying to replay precise events.

New crates: `notify`, `ignore`, `regex`. All small, all cross-platform, none
pulling a second GUI toolkit in the way the Linux browser container did.

No `tauri-plugin-fs`, and no new capability entries — these are our own commands
with our own path checks, which is the point of the next section.

---

## Not losing the user's work

The features that make an editor trustworthy are unglamorous, so they're listed
as requirements rather than left to Phase 5 good intentions.

- **Path confinement.** Every command takes a path and canonicalizes it, then
  rejects anything outside the open workspace roots. Symlinks are resolved
  before the check, not after.
- **Atomic writes.** Write to `.<name>.figytmp` in the same directory, `fsync`,
  then rename over the target. A crash mid-save must not truncate a file.
- **Conflict detection.** Saving sends the mtime the buffer was loaded at. If it
  no longer matches, the save is refused and the user is offered
  overwrite / reload / diff — never a silent clobber. The watcher raises the same
  prompt when a file changes under a *clean* buffer (auto-reload) or a dirty one
  (ask).
- **Encoding and line endings preserved.** Detect UTF-8/UTF-16 BOM and CRLF on
  load; write back what was there. A Windows user opening a CRLF file and saving
  it must not produce a whole-file diff. This is exactly the class of bug
  `WINDOWS-SUPPORT.md` is about.
- **Binary and large-file guards.** Sniff for NUL bytes in the first 8 KB;
  binaries get a "N MB binary file" card, images get a preview, nothing gets
  loaded into CM6 blind. Over 5 MB: open read-only with highlighting off, and
  say so in the status bar. Over 50 MB: refuse with a "reveal in Finder" out.
- **Read-only files** open read-only with the reason shown, rather than
  accepting edits that will fail at save.
- **Crash-safe drafts.** Dirty buffers are journalled to app data on a debounce
  and offered back on next launch.
- **Delete goes to the trash** by default, not `unlink`.

---

## What makes it a *terminal's* editor

A modal that only edits files is a worse VS Code. These are the features that
only make sense because there's a shell three inches away, and they're what
should make this the thing people open FigyTerm for.

- **Click a path in terminal output, open it here.** xterm's web-links addon is
  already loaded; a second link provider for `path`, `path:line`, and
  `path:line:col` turns every stack trace, `tsc` error, `grep -n` hit and
  `git status` line into a jump target. This is the headline feature.
- **The editor's root follows the focused pane.** `AppShell` already tracks
  `liveCwds` per pane; the explorer opens on the active pane's cwd, and switching
  panes offers (not forces) a root change.
- **Open in editor, from anywhere** — status bar path, explorer, palette, and a
  `figy edit <file>` shim alongside the existing installer, so the editor is
  reachable from inside the shell it's sitting next to.
- **Run this file in the focused pane.** `⌘↵` sends a sensible command for the
  buffer's language to the active terminal (`node`, `python`, `cargo run`,
  `sh`), after saving. It's a terminal — running things is the point.
- **Open a terminal here.** Explorer context menu → new pane rooted at that
  directory, using `createTab(cwd)`, which already exists.
- **Git-aware everywhere.** Modified/untracked badges in the tree, changed-line
  marks in the gutter, a unified diff against HEAD, and file-level staging with
  a commit box. See [Git](#git).
- **Quick open (`⌘P`)** over the workspace, using the same fuzzy scoring the
  autocomplete engine already implements in `services/figy-autocomplete-engine.ts`
  rather than a second ranking algorithm with different manners.
- **Global search (`⌘⇧F`)** with streamed results grouped by file.

  A hit carries two columns, and the difference matters. `column` indexes the
  match inside `text`, which is only a *window* around the hit on a long line;
  `lineColumn` is the real column in the file, and is what "go to" is given.
  Using one for the other put the caret in the wrong place on exactly the lines
  where precision is the point.

  The jump itself is queued rather than applied, because a buffer's CodeMirror
  state is built asynchronously — its grammar is a dynamic import. The effect
  that drains the queue is keyed on a counter (`goToToken`) and not only on
  which buffer is active: a jump within the file already in front changes
  neither the active buffer nor the tab count, so it never ran at all. Picking
  a second hit in the open file did nothing, and so did clicking the same
  `path:line` in terminal output twice.
- **Session restore.** Open tabs, cursor positions, scroll offsets, explorer
  expansion and modal geometry come back exactly as they were.
- **Scratch buffers.** `+` on the tab strip opens an untitled buffer with a
  language picker — for the paste-and-reformat case that currently means
  `vim /tmp/x`.

---

## Keyboard

App-level, added to the table in `services/shortcuts.ts` (and mirrored in
`menu.rs`, per the note at the top of that file):

| Action | macOS | Elsewhere |
|---|---|---|
| Toggle editor | `⌘⇧E` | `Ctrl+Shift+E` |

`E` is free in both schemes — worth re-checking against the table when this
lands, since it's the kind of thing that collides silently.

Editor-scoped bindings, handled inside the modal, which `stopPropagation`s like
`BrowserModal` does. **These may use plain `Ctrl` off macOS**, because no shell
has focus while the editor does — the reasoning in `shortcuts.ts` for avoiding
bare `Ctrl` doesn't apply here, and using anything other than the conventional
editor chords would be worse.

| Action | macOS | Elsewhere |
|---|---|---|
| Save / Save all | `⌘S` / `⌥⌘S` | `Ctrl+S` / `Ctrl+Alt+S` |
| Indent / outdent | `Tab` / `⇧Tab` | same |
| Quick open | `⌘P` | `Ctrl+P` |
| Cut / copy / paste | `⌘X` / `⌘C` / `⌘V` | `Ctrl+X` / `Ctrl+C` / `Ctrl+V` |
| Find / replace in file | `⌘F` / `⌥⌘F` | `Ctrl+F` / `Ctrl+H` |
| Next / previous match | `↵` / `⇧↵` in the find field | same |
| Match case / word / regex | `⌥⌘C` / `⌥⌘W` / `⌥⌘R` | `Alt+C` / `Alt+W` / `Alt+R` |
| Replace / replace all | `↵` / `⌘↵` in the replace field | `Enter` / `Ctrl+Enter` |
| Global search | `⌘⇧F` | `Ctrl+Shift+F` |
| Go to line | `⌘G` | `Ctrl+G` |
| Close tab | `⌘W` | `Ctrl+W` |
| Toggle explorer | `⌘B` | `Ctrl+B` |
| Toggle comment | `⌘/` | `Ctrl+/` |
| Add next occurrence | `⌘D` | `Ctrl+D` |
| Move / copy line | `⌥↑↓` / `⇧⌥↑↓` | `Alt+↑↓` / `Shift+Alt+↑↓` |
| Run file in pane | `⌘↵` | `Ctrl+Enter` |
| Nth tab | `⌘1-9` | `Ctrl+1-9` |

Escape closes the innermost thing — context menu, then find panel, then quick
open or go-to-line, then the diff, then the side panel, then the modal — and a
dirty buffer prompts instead of closing.

### None of that works if the editor doesn't have focus

Which it doesn't get for free. The modal is hidden rather than unmounted when it
closes, so on reopen the focused element is whatever had focus before — usually
the terminal underneath, which then swallows every keystroke, including ⌘C and
⌘V. `EditorModal` focuses the surface (or, with no file open, the modal itself,
which is why it carries `tabIndex={-1}`) on the transition to visible, and
`AppShell` hands focus back to the active pane on every route out.

Cut, copy and paste are the platform's: CodeMirror listens for the `copy`, `cut`
and `paste` DOM events and the webview delivers them — on macOS by way of the
Edit menu's predefined items, which is what makes those chords work in a WKWebView
at all. The context menu has no keystroke to ride on, so `EditorSurface` also
implements them against `navigator.clipboard`, following CodeMirror's own rules
(a bare cursor means the whole line; one clipboard line per cursor on paste when
the counts agree).

### Chords the native menu owns

A menu accelerator on macOS is translated before the key reaches the webview, so
a chord in the menu cannot be claimed here — it can only be given up or routed.
Three were being silently eaten.

- **`⌘H`** is the app menu's Hide item, and a system convention worth keeping.
  Replace is `⌥⌘F` on macOS for that reason, as it is in every macOS editor;
  `Ctrl+H` is free elsewhere and stays.
- **`⌘W`** was the Window menu's predefined Close item, which closed the whole
  window — unsaved buffers and all — where every editor closes the current tab.
  `menu.rs` replaces it with a custom item that emits `menu://close-window`;
  `AppShell` closes the editor's tab while the editor is up and the window
  otherwise. Off macOS the predefined item is `Alt+F4` and collides with
  nothing, so it is left alone.
- **`⌘Z` / `⇧⌘Z`** were the Edit menu's predefined Undo and Redo, so
  `historyKeymap` never ran: the chord became `undo:` on the WKWebView, which
  runs WebKit's undo manager over a DOM CodeMirror rewrites underneath it.
  Custom items now emit `menu://undo` and `menu://redo`, and `AppShell` gives
  the editor first refusal through `historyRef` — a callback rather than a
  counted prop, because undo is held down and two presses in one React batch
  would collapse into one undo. Declined when the text doesn't hold the
  keyboard (the caret is in the search field, say), and then
  `document.execCommand` gives the focused field the webview's own undo, which
  is what the menu item used to do for it. Off macOS the Edit menu carries only
  Copy and Paste, so `Ctrl+Z` reaches CodeMirror already.

Cut, copy, paste and select all stay predefined and untouched — those genuinely
are the webview's to perform.

### Indentation guides

`editorIndent.ts`, written rather than taken from
`@replit/codemirror-indentation-markers`. Partly one fewer dependency in what
is already the largest chunk of the bundle, but mostly because the whole of it
is two rules and both are judgement calls every implementation makes
differently.

**Which guides a line gets.**

> A line's guides come from its own indent. A **blank** line has none of its
> own, so it borrows the **smaller** of the indents either side of it.

Smaller, not larger: a blank line between a nested block and the statement
after it belongs to whichever is shallower, and drawing the deeper one runs a
guide past the end of the block it was describing. At the top or bottom of a
file there is no neighbour to borrow from and no block to describe, so a
trailing blank line gets nothing.

**Which guide is active.** The innermost block containing the cursor, drawn
several times brighter, along that block's **whole extent** rather than only on
the cursor's line — the point of it is to show where the block ends.

> A line that *opens* a block belongs to the block it opens.

Resting on `function outer() {` lights the guide running down its body, not the
one around the function itself, because the body is what you are about to be
looking at. The consequences are worth spelling out, because they are what
separates this from a highlight that is merely decorative:

| Cursor on | Lit |
|---|---|
| `function outer() {` | the function's body, all of it |
| a line inside an `if` | that `if`'s body |
| a blank line inside it | the same — the block does not break |
| the `}` closing the `if` | the enclosing function body, not the `if` |
| a **sibling** block at the same depth | nothing; only the block you are in |
| a top-level line | nothing; there is no guide to brighten |

Both rules go through one `effectiveColumns`, deliberately. When the drawn
guides and the active highlight worked the indent out separately they disagreed
around blank lines, and a highlight landing one level off the guide it is
supposed to be brightening reads as a rendering bug rather than as a different
answer to a hard question.

The block's extent is traced by walking out while the indent holds, bounded at
5,000 lines each way: in a file that is one enormous indented block that walk is
otherwise the whole file, on every cursor move.

It deliberately does **not** consult the syntax tree. Guides are a visual
summary of the whitespace, and a reader comparing them against the text expects
them to agree with what is in the file — including where the file's indentation
is inconsistent, which is exactly when they are most useful. A tree-driven
version would draw the indentation the parser thinks ought to be there.

Drawn as one pseudo-element per line carrying `--cm-indent-depth` and
`--cm-indent-width`: a repeating gradient steps a hairline every level, and the
element's own width is what stops it at the last one rather than ruling the
whole line. So a line twelve levels deep costs one style attribute instead of
twelve widgets. The width is in `ch`, which in a monospaced editor is exactly
one column at any font size. The active guide is a *second* pseudo-element
painted over the faint one at the same column — a repeating gradient cannot
colour one of its own stripes differently — and it exists only on the lines of
the block the cursor is in, so an idle file draws none.

Depth, width *and* the active level are all in one decoration, keyed on all
three. `Decoration.line` compares by identity, so a fresh one per line would
make every visible line's decoration distinct and defeat CodeMirror's diffing —
every line torn down and rebuilt on every keystroke. And they cannot be two
layered decorations, because both would want to set `style` and only one of
them can.

It rebuilds on `selectionSet` as well as the usual three, because moving the
cursor moves which guide is active — that is the whole feature. Over the visible
lines only, which is the same order of work as the active-line highlight drawn
beside it.

### Context menus

`ContextMenu` in `components/Editor/` is the shared shell: fixed positioning
clamped to the window after measuring, and dismissal on an outside press,
Escape, blur, resize or scroll. The press listener runs in the capture phase
because the modal stops mousedown propagation on its own container, and Escape
is stopped there rather than let through — otherwise one press closed both the
menu and the editor.

The text surface's menu carries cut/copy/paste, select all, undo/redo, find, go
to line, save and the path actions; the file tree's carries open, new file and
folder, rename, the two copy-path variants, reveal and move-to-trash.

---

## Git

Reversing the decision at the top of this document. It was made on the grounds
that git is a feature of its own, which is true — but a terminal's editor is
opened *because* something was wrong in a file, and the first question about a
file next to a shell is which lines you changed. Without that, the tree is a
file manager.

### Shelling out to `git`, not linking libgit2

`git/operations.rs` runs the `git` binary. This is a terminal: git is already
installed, already configured, and already the thing the user's credential
helper, `core.hooksPath`, worktrees, submodules, LFS filters and
`.gitattributes` are set up for. libgit2 would mean a C build on three
platforms and a second implementation that disagrees with all of it — for a
status list and a diff. A process per refresh is the cheaper mistake.

Porcelain **v2**, not v1. v1's `XY path` lines need the rename form guessed
from context and cannot say whether HEAD is detached; v2 states both and is
documented as stable for machine reading. `-z` because a filename can contain a
newline, `-uall` because a folder marked untracked with unmarked files inside it
reads as a bug, and `--no-optional-locks` on every invocation so a status
refresh can't take the index lock from a `git` the user is running in the pane
behind.

v2's records are **positional**, and getting the field count wrong is the one
mistake in this file that doesn't announce itself:

```
1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
```

Skip one field too few and the path comes back as
`4595984f3c8850d67e1b0496fe95ba7901dc9df4 src-tauri/src/lib.rs` — which is not a
path, but is a perfectly good `String`. Nothing errors, the tree shows a
plausible name, and then every `git` argument built from it fails: the diff, the
staging, all of it. That is exactly what happened, so the counts are named
constants with the record shapes above them, and there are tests at the bottom
of `git/operations.rs` for each shape plus a path with a space in it.

### The repository is not the open folder

Opening `~/project/src` on a repo rooted at `~/project` is normal, and git
reports paths relative to the top level either way. So the *directory* argument
is confined to a workspace root as every filesystem command is, and file
arguments cross as **repo-relative strings** — git's own output form, checked by
`relative_arg` for `..`, absolute paths and leading dashes. `repoRelative` in
`services/git.ts` is the inverse, and it matches case-insensitively off Linux
for the same reason `sameFolder` does.

That means git legitimately reports and acts on files the filesystem commands
would refuse. It's the repository the editor was opened inside; scoping status
to a subdirectory would report something no `git` command agrees with.

### One status, three consumers

`useGitStatus` runs it and everything reads from there: the tree's badges, the
panel's lists and the gutter's fetch. Three components each running `git status`
on the same watcher event would be three processes for one answer. It coalesces,
because the watcher fires in bursts — a `git rebase` or an `npm install` under a
watched tree would otherwise fork a hundred times.

The refresh trigger is the file watcher, not a poll — but that took two fixes,
both of which had the panel showing a repository state that was no longer true.

**`.git` was excluded from the watcher outright**, on the grounds that it churns
and that none of it is a file anybody has open. Both true, and the conclusion
was still wrong: nothing under `.git` being reported meant the panel only ever
refreshed after an action taken in the editor itself, so a commit in the pane
behind left it listing files that were already committed. Four things inside it
are now let through and the rest is not — `HEAD`, `index`, `refs/…` and
`packed-refs`, which are the four `git status` reads. `objects/` and `logs/` are
the churn and say nothing a ref does not; `*.lock` is excluded by name, because
`index.lock` appears and vanishes around every single git command. There are
tests, because too narrow means a commit goes unnoticed and too wide means every
`git status` feeds the watcher back into itself.

That last risk is closed from the other end too: our `git status` runs with
`--no-optional-locks`, so reading the repository cannot rewrite the index.

**And `refresh` starved.** It re-armed its 250 ms window on every call, so a
burst of requests closer together than the window pushed the run out
indefinitely — which is exactly what a commit produces, git writing the index,
the refs and the reflog in quick succession. A run already scheduled is now left
alone. There is nothing to coalesce: the run reads the repository as it finds
it, so a later request wants precisely what the pending one is already going to
fetch. A ceiling brings it forward if it has somehow been waiting a second.

`gitTick` still covers the gap between the editor's *own* action finishing and
the watcher event landing, which is long enough to look broken.

One case the watcher cannot see: a worktree or a submodule, where `.git` is a
*file* pointing elsewhere and the repository's state lives outside the watched
tree. The editor's own actions still refresh; an outside commit needs the panel's
refresh button.

### The change gutter

Its own column between the line numbers and the fold arrows, driven by the `@@`
headers of `git diff --unified=0 HEAD`. Only the headers are read, so a file
with a large diff stays cheap. A hunk covering no lines of the working file is a
pure deletion — there is nothing left of it to mark, so it gets a wedge on the
line the gap is now above.

Marks are a `GutterMarker` with an `elementClass` rather than a `toDOM`: on a
new file where every line is added, that's the difference between one CSS rule
and twenty thousand divs. They're *mapped* through edits rather than dropped —
stale the moment you type, but a mark that slides with its line is much closer
to the truth than one anchored to a byte offset, and the next save refetches.

Untracked files are the one case the backend doesn't answer: it returns
`untracked: true` and the surface marks every line, because it has the document
in front of it and the backend would have to read the file again just to count.

### The panel: GitHub Desktop's model, not VS Code's

`SourceControl` is shaped like GitHub Desktop's Changes pane, which means **the
index is not on screen**. One flat list of what changed, a checkbox per file
saying whether it goes in the next commit, and a summary/description box at the
bottom with `Commit N files to <branch>`. No staged/unstaged groups, no stage
and unstage buttons.

Rows show the file's **name only**, not its folder. The path is in the tooltip
and in the diff header above, which is where you are once a file is open;
carrying a dim `src/components/Editor` on every row of a 300px column spends
most of the width on the part that repeats.

That is a real trade and it costs something. Git's index is a genuine third
state, and a file half-staged from the terminal cannot be represented here —
this panel commits all of that file or none of it. What it buys is the question
most people actually have, "which of these am I committing right now", answered
without first having to learn what an index is. VS Code's two-group layout
answers a different question well; this answers the common one.

So committing has to *make* the index match the checkboxes: `commitFiles` in
`EditorModal` unstages everything unticked, stages everything ticked, then
commits. The unstage half is the one that's easy to forget and the one that
matters — without it, a file staged from the terminal and then unticked here
would still end up in the commit.

The checkbox state is tracked as the **excluded** set, not the included one.
With `included`, a file appearing while you type a commit message — a build
touching something, a save in another tab — would arrive unticked and be
silently left out. Excluding by exception means anything new is in by default,
which is both what GitHub Desktop does and the safer direction to be wrong in.

**Discard** is the only action here that destroys work, so it confirms, and it
says which of two different things it is about to do: `git checkout` for a
tracked file, and a move to the **trash** for an untracked one. `git clean`
would be the obvious spelling and it is the wrong one — it unlinks, which would
make "discard" the only unrecoverable button in the editor.

Deliberately absent:

- **Hunk-level staging.** A diff editor with selectable ranges, a patch builder
  and an `apply --cached` round-trip. A feature of its own, and a bad fit for a
  300px column — and with the index hidden there is nowhere to put the result.
- **Branch switching, and pull.** Checkout fails in a dozen interesting ways
  and a pull can leave a conflict needing a merge editor; both belong in the
  shell that is three inches away, and both would need a UI for the failure
  modes rather than for the happy path. Fetch and push are here — see
  [Fetch and push](#fetch-and-push).
- **A chord for the panel.** `⌘⇧G` is CodeMirror's find-previous and `⌃⇧G` is
  not free everywhere; the toolbar button and the status-bar branch are the way
  in.

### History

A second tab in the panel, `CommitHistory`, and a **drawer** a commit opens
into: the subject as a heading, the author and date, any branch or tag pointing
at it, the message body, then the files with their `+`/`−` counts — and a Back
button.

The drawer replaced an expanding row, which is what this was first. Folding a
commit open in place looked like the cheaper interaction and wasn't: a commit
message is a paragraph, so unfolding one pushes every commit below it off a
300px column. The list you were reading is gone either way — but with none of
the room the message needs, and no way back except finding the row again.
Replacing the pane admits what is happening, gives the message the full width,
and has somewhere to put a Back button.

It slides in from the right, which is not decoration: two panes with no
transition between them read as "the panel was replaced", and the movement is
what says the list is still behind this. Under `prefers-reduced-motion` it
simply appears, which is the correct behaviour there rather than a degraded one.

The body is **folded** above six lines or four hundred characters — both,
because either alone gets it wrong: six lines of prose that wrap three times
each is a wall of text by any measure, and one 900-character line is a wall of
text with one newline in it. `Read more` unfolds it. Folded by `max-height`
rather than by cutting the string: slicing at 400 characters lands mid-word,
mid-list and mid-code-fence, and expanding it then reflows everything below it.
A height with a fade over the bottom shows a real partial line, which is what
says there is more. A thorough commit message is the *reason* to open a commit
and also the thing that pushes its file list off the bottom of a 300px column.

Clicking a file in the drawer opens its diff in the same `diff-check` tab, with
the short SHA in the header — without it, "what I changed" and "what that commit
changed" are the same file with the same counts and no way to tell them apart.
A commit that disappears under an amend or a rebase closes the drawer rather
than describing an object that no longer exists.

Paged, not infinite. `git log` will hand over forty thousand commits and nobody
is scrolling to the end of them, so it is a page and a button. A reload starts
from the top and **discards** what was already loaded rather than splicing: a
new commit shifts the whole list down by one, so "refetch page 0 and merge"
duplicates a row at every page boundary.

The log format is `%x1f`-delimited with `%x1e` between records — unit and record
separator, not anything printable, because a commit subject can contain any
character a person can type and every delimiter that looks safe turns out to be
in somebody's commit message. A merge is detected from `%P` having more than one
parent, which is also why its diff and file list are asked for with
`--first-parent`: `git show` on a merge prints nothing at all by default.

`commit_detail` gets the body and the file list from one `git show` — the format
output first, terminated by `%x1e`, then the `--name-status` records — and the
line counts from a second, `--numstat`, joined on the path. Two calls because
those are two output formats rather than two columns of one; asking for both at
once prints one block after the other, which is more parsing than running it
twice.

Both of those shapes were checked against real output rather than assumed, and
both had a trap in them:

- With a **non-empty `--format`**, git separates the two outputs with a NUL
  *and a newline*, so the first name-status record arrives as `"\nM"`. `'\n'`
  is not a status letter, so it fell through to the default and reported the
  first file of every commit as modified whatever it really was. The status is
  trimmed before its letter is read, and there is a test for exactly that
  string.
- `--numstat -z` puts a **rename's** paths in their own fields and leaves the
  inline path *empty* — `1\t0\t\0old\0new\0` — which is not what the
  non-`-z` format looks like. A binary file is `-` on both counts, meaning
  "no lines to count", not "nothing changed".

`revision_arg` refuses anything that isn't hex before it becomes a git argument.
These SHAs come from this module's own output, so like `relative_arg` it is
there for the abnormal case — and it is what stops a revision ever being read as
an option.

### Counting files by what happened to them

`tally` in `services/git.ts`, drawn by `ChangeTally`, shown under both the
Changes list and a commit's file list — one place decides the grouping, so a
working tree and a commit of the same shape read identically.

Git has eight status letters and nobody wants a legend for them, so they
collapse into the four things people say out loud:

| Shown | From | Why |
|---|---|---|
| **new** | `added`, `untracked`, `copied` | A copy is a file that wasn't there before, whatever git knows about where its contents came from |
| **edited** | `modified`, `typeChanged` | A file becoming a symlink is a strange edit, not a fifth category |
| **deleted** | `deleted` | |
| **renamed** | `renamed` | Kept apart: a rename is neither new nor edited, and folding it into either overstates what changed — `R100` moved a file and touched nothing in it |

`conflicted` gets its own count, being a state to resolve rather than a change
that has happened. Empty counts are dropped, and the whole row is suppressed
when one kind accounts for everything: "3 files changed · 3 edited" is the same
sentence twice.

The chips are coloured by `GitChange` through the same `git-*` row classes the
tree uses, so "new" is the green the change gutter draws an added line in.
One palette, three places.

The Changes tab counts *every* changed file rather than the ticked ones: the
tally describes the working tree — "this is what you have done" — while the
checkboxes are about the next commit, and recounting on each tick would have
the two answering the same question.

### Saying what has not been pushed

`git log` marks each commit `unpushed`, from `rev-list @{upstream}..HEAD`. Asked
of git rather than inferred from the `ahead` count and the list's order: "the
newest N are the unpushed ones" holds only while the history is linear, and a
branch that has merged its upstream back in is exactly the case where somebody
wants to know what is still local.

Nothing is marked when there is no upstream. On an unpublished branch every
commit is unpushed, which is a true fact about five hundred rows and a useful
one about none of them — the Publish button says it once instead.

It is one colour in the four places it is mentioned — the history row's arrow,
the drawer's tag, the branch counter and the Push button — so they read as one
fact rather than four. Amber rather than red: it is something to do, not
something wrong.

### Fetch and push

Two buttons, not one "sync". They do different things — one reads, one writes —
and a single button that guesses which you meant is a button that occasionally
pushes when you wanted to look. Push publishes the branch when it has no
upstream, choosing `origin`, or the only remote, and otherwise refusing: picking
between three remotes on the user's behalf is how a branch ends up on the wrong
one.

**Pull is deliberately absent.** A pull merges, a merge conflicts, and a
conflict needs somewhere to be resolved — a merge editor is a feature of its
own and not one this panel has. Fetch tells you that you are behind and the
shell is three inches away.

These are the only calls in the module that can block forever: a credential
prompt with no terminal to show it in, an SSH passphrase, a host that accepts
the connection and then says nothing. So they go through `git_network` rather
than `git`, which differs in exactly two ways, both of them the point:

- **`GIT_TERMINAL_PROMPT=0`**, so git fails fast instead of waiting for a
  username nobody can type. A configured credential helper still works, which
  is the case that matters.
- **A 120-second deadline**, because that cannot stop *ssh* prompting, and a
  panel stuck on "Pushing…" with no way out is worse than one that says it gave
  up and suggests running it in the terminal once. `GIT_SSH_COMMAND` with
  `BatchMode=yes` would prevent that one cause specifically, and was rejected:
  it overrides a user's own `core.sshCommand`, and a timeout covers every cause
  rather than the one we thought of.

Output is returned on success too, not just on failure. Git reports a
successful push on **stderr** — `3b11460..a1b2c3d  main -> main` is the
confirmation — and "Everything up-to-date" is an answer. It lands in a row that
is always mounted and animates open, because inserting it into the flow snapped
the tabs and the whole file list down by its height the instant a fetch
finished. The buttons' labels do not change while they run either: a centred
icon-and-text group re-centres itself as "Fetch" becomes "Fetching…", so the
icon slides sideways and the button appears to twitch. The spin and the
disabled state say it is working without moving anything.

### Linking to the forge

A commit's SHA and the branch name open on the remote. `git-forge.ts` turns a
remote URL into web addresses, and it is kept apart from `git.ts` because it is
guesswork of a particular kind: a remote URL says where to *fetch* from, and
nothing in git says what a commit looks like in a browser. So it is a table of
conventions with a fallback, and it is honest about what it cannot answer — a
local-path clone has no web page behind it, `parseRemote` returns null, and the
SHA renders as plain text. A link that 404s is worse than no link.

The four spellings a remote arrives in are all handled, including the SSH
shorthand `git@host:user/repo.git`, which is not a URL and cannot be given to
`new URL()` — the colon there is a separator, not a port. GitLab's `/-/commit/`
and Bitbucket's `/commits/` differ from GitHub's `/commit/`; an unrecognised
host gets GitHub's, which Gitea and Forgejo also use, so the fallback is right
more often than it is wrong.

`origin/` is stripped from a tracking ref before it becomes a branch URL — the
remote has no branch called that — but only when the prefix matches a remote we
know, so `feature/code-editor` keeps both halves.

The SHA gets a **background**. Monospace hex on its own does not read as
something you can press; the chip is what says "this is an object, and it goes
somewhere". It opens in the system browser rather than the app's own, because a
commit page is something people send to a colleague and open beside four other
tabs.

### Diff view

`DiffView` renders `git diff`'s own output rather than recomputing one. The diff
on screen is then exactly the one `git diff` prints in the pane behind,
including whatever `diff.algorithm` and `.gitattributes` have to say about it —
and the first thing anyone does when a diff looks wrong is check it against
`git diff`. It takes the editor's whole column, not the side panel's: 300px of
unified diff is not reading, it's guessing.

Always the working tree against **HEAD**, with no staged/unstaged toggle. That
follows from the panel: the question is "what would committing this record?",
and the index isn't something the panel exposes, so a control for switching
between two halves of it would be answering a question nothing else here asks.

#### Which words changed

`services/diff.ts` turns the output into blocks and marks the words inside a
changed line. This is the one thing computed locally rather than asked of git,
because git's *line* diff simply doesn't contain it: `--word-diff` is a
different output format, not an addition to this one, so using it would mean
running and parsing a second diff per file — and then lining its runs up with
rows that came from the first.

It matters more than it sounds. A line whose only difference is `a` → `the`
reads as two entirely different lines when the whole row is tinted; the point of
marking the words is that the eye goes straight to them. Three details make the
difference between that and noise:

- **Token granularity.** Words, runs of whitespace, and every other character
  on its own. Splitting by word alone reports `foo.bar` → `foo.baz` as one
  changed token covering the lot; splitting per character marks `a` → `the` as
  three separate specks.
- **Runs are joined.** The subsequence legitimately matches the spaces
  *between* words, so `the deferred part` → `both there now` comes back as
  three highlights with two gaps punched through them — accurate, and it reads
  as stripes. `joinRuns` absorbs whitespace that sits between two changed
  tokens, which is what every tool that does this does.
- **Dissimilar lines aren't paired.** A removal and an addition that happen to
  be adjacent are not necessarily versions of each other, and highlighting the
  handful of tokens a deleted function shares with an unrelated new one
  (`const`, `(`, `)`) picks out noise and hides the fact that the whole line is
  different. Below 30% shared non-whitespace, both lines are left plainly added
  and removed.

The comparison is an LCS table over tokens, capped at 400 per side; past that
it trims the common ends and calls the middle changed, which is the same answer
for one edit in the middle of a line and is instant. A minified bundle on one
line would otherwise lock the window up to highlight something nobody can read.

#### Two layouts, five styles

Both remembered in the session, both changed from the diff's own header.

**Unified or split.** Neither is better — unified is compact and reads top to
bottom, split shows what a line *was* beside what it *is*, which matters when
both sides are long. This is why the parser produces *blocks* rather than a
flat row list: a run of removals followed by a run of additions is one change,
and split needs it as one thing to zip the two sides together. A flat list can
be rendered unified but not split. Each layout then flattens the blocks its own
way — and unified groups the removals before the additions rather than
alternating them, because `-`, `-`, `+`, `+` is how a diff reads while
`-`, `+`, `-`, `+` makes a two-line change look like two one-line changes. The
blank on one side of a split row is not a gap to skip; it is where lines were
added or removed rather than changed, so it's drawn hatched.

**Style** is not a colour scheme. The presets differ in what they *show*, so
that whichever tool someone already reads diffs in, this can look like it:

| | Rows | Words | Signs | Numbers |
|---|---|---|---|---|
| `github` (default) | tinted | darker tint | `+` / `−` | old and new |
| `gitlab` | tinted | tint + underline | `+` / `−` | old and new |
| `vscode` | stronger band, text left alone | stronger band | none | new only |
| `delta` | tinted | tint + bold | none | both, boxed |
| `plain` | none | none | `+` / `−` | none |

`plain` is `git diff` in a terminal, and deliberately has no word highlight: a
terminal has none, and a preset that adds one isn't this preset.

Each preset sets a handful of custom properties and the structural rules read
them. `--diff-cols` is the grid, and it lists one track per *visible* item —
a preset that drops a column also removes it from layout with `display: none`,
because an item in a `0px` track still spills its text over its neighbour.

It lives in the **tab strip**, as a tab called `diff-check` — deliberately
extension-free, because it is not a file and a tab reading `lib.rs` beside the
tab for `lib.rs` would be two tabs claiming to be the same thing. It is a tab
and not a buffer: it has no document, nothing to save and nothing to reorder,
and putting it in the store alongside real files would mean every path that
iterates buffers first asking whether this one is really a file. What it needed
from being a tab was somewhere visible to live and a way to be closed — before
this it covered the editor with no representation at all, so clicking a file
tab lost it with nothing to click to get it back.

Hence two pieces of state rather than one: `diffTarget` is whether the tab
exists, `diffFocused` is whether it is in front. Collapsing them would mean
switching to a file *destroyed* the diff, which is not what a tab does. Every
route that opens a file clears the focus flag, which is why it is done inside
`openPath` rather than at each of the six call sites.

The toolbar above is scoped to the file pane, and while the diff is in front
the file-scoped half of it goes quiet: the breadcrumb crumbs, Save, and the
Markdown preview toggle. All three describe or act on the *active buffer*, so
with a diff on screen they were naming and saving the tab you had before it —
the breadcrumb most visibly, reading out a path for a file you are not looking
at. The workspace chip stays, because it is the workspace switcher rather than
part of a path, and Previous/Next file now step *out* of the diff rather than
paging a hidden pane.

Side-by-side is what that gives up. In a modal this size, two gutters and two
40-column panes is worse than one readable column.

---

## Find, replace and go to line

Both were CodeMirror's stock dialogs, recoloured. Both are now the editor's own
markup, for the same reason: the library's versions are correct and say nothing.

**`FindPanel`** is still *CodeMirror's* panel where it matters — `createPanel`
hands the component the panel's DOM to render into, so the search state, the
highlighting of every match, the open/close lifecycle and the `⌘F`-while-open
behaviour stay the library's. What's reimplemented is what you can see, and the
part worth having is the count: without "3 of 17" there is no way to know
whether Enter is about to wrap. Going through `createPanel` rather than floating
a widget over the editor keeps two things that are easy to lose — the match
highlighting, which CodeMirror only draws while its panel is registered as open,
and the layout, since a panel pushes the text down instead of covering the first
two lines of it.

Two details that are not obvious:

- **Typing must not walk the selection forward.** `findNext` steps from the
  selection, so driving it per keystroke means typing `foo` lands on the third
  `f`. Each edit of the query re-searches from where the caret was when the
  panel opened; only Enter moves that mark on.
- **The count needs a re-render on every keystroke,** which is the one thing
  `EditorSurface` otherwise refuses to do. It's gated on the panel existing.

**`GoToLine`** replaces a dialog that was an unstyled text field and a "go"
button. It says where it will land ("Line 412 of 890"), says when a number is
past the end before Enter rather than after, and scrolls the editor as you type
without moving the caret — cancelling puts the view back. The accepted syntax is
CodeMirror's own and kept deliberately: `412`, `412:8`, `+20`, `-20`, `50%`.

---

## Settings

`EditorSettingsModal`, opened from the gear in the toolbar or the text's context
menu. Its own modal rather than a page in the app's Settings dialog, for two
reasons that both come down to where it lives:

- That dialog is **Headless UI's**, which makes `#root` inert while it is open
  — the exact problem `OverlayPortal` exists to work around. Opening it from
  inside the editor would freeze the editor behind it.
- These settings are **judged by looking at the thing they change.** Font size
  and line height are decided by reading the code next to them, which needs the
  code still on screen rather than covered by a full-window dialog.

Every control applies immediately and there is no Save button: there is nothing
to batch, and a checkbox you have to confirm is a checkbox that lies about what
the editor currently looks like.

**There is no chord for it.** `⌘,` is the app's own Settings, and on macOS that
is a native menu accelerator — translated before the webview sees the key — so
the editor could not claim it even if that were the right call. See
[Chords the native menu owns](#chords-the-native-menu-owns).

### The font was the reason to build it

The editor was rendering in the **terminal's** font at the terminal's size.
That is a setting chosen for reading a shell; code usually wants a different
size and often a different face, and a preference that can only be right for
one of two panes is not one setting, it is two.

So the editor has its own, with a sentinel: an empty family or a zero size
means "follow the terminal". A sentinel rather than copying the terminal's
value in at first run, because then changing the terminal's font still moves
the editor for anyone who never chose one — which is what somebody who never
chose would expect.

### Applying a setting without rebuilding every buffer

Each toggle that changes an extension gets a **compartment** — guides, bracket
closing, word completion. The alternative is rebuilding every open buffer's
`EditorState` when a checkbox moves, which throws away its undo history, its
folds and its selection to change the colour of some hairlines.

Only the buffer in front is reconfigured. The others are immutable states in a
map, and they carry a `settingsVersion` so one notices on activation that it
missed a change — the same trick `themeVersion` already used for the theme.
Both paths go through one `settingEffects`, so they cannot drift apart and
leave one buffer with guides and another without.

**Word wrap** is seeded from the setting and then owned by the session, because
the status bar's toggle is a per-file override: changing the default must not
undo a toggle made two minutes ago.

**Indentation** is the fallback, not an override. A file's own indentation
still wins — `detectIndent` now returns *null* rather than guessing two spaces
when a file has nothing indented in it, which is the one case where the user's
preference is the only evidence there is.

### Reading it back

The stored blob is user-editable, so `loadSession` merges field by field over
the defaults rather than taking `settings` whole: a session written by an older
build has none, and a missing field must become a default rather than an
`undefined` reaching a CSS property. Numbers are clamped for the same reason —
a hand-edited `lineHeight: 0` would collapse every line to nothing.

---

## Theming

CM6 themes are data, so the whole thing is one `EditorView.theme` built from the
existing `--ft-*` tokens plus a syntax palette, subscribed to `themeStore` the
way `BrowserModal` subscribes for `setBrowserTheme`. New CSS goes in
`styles.css` as an `.editor-*` block following the existing `.browser-*`
convention — same file, same naming, no CSS modules introduced for one feature.

The syntax palette needs picking deliberately for both themes rather than
lifting One Dark, since the light theme here is a genuinely light UI and most
ported dark palettes are illegible on it.

---

## Performance

- **Virtualize the tree.** A `node_modules` expansion is 40,000 rows.
- **Lazy languages.** `editor-lang.ts` maps extension → `() => import(...)`, so
  the initial chunk carries no grammars.
- **Never re-render the surface.** `EditorSurface` mounts once per buffer and
  talks to CM6 through effects and refs; store subscriptions are selector-scoped.
- **Debounce the watcher** and coalesce to subtree invalidations.
- **Cap the search stream** at ~2,000 results with a "showing first N".
- **One `git status` per watcher burst,** coalesced in `useGitStatus`, read by
  the tree, the panel and the gutter alike. Capped at 5,000 changed files.
- **Only the `@@` headers** of a per-file diff are parsed for the change
  gutter, so a file with a large diff costs the same as one with a small one.

---

## Cross-platform

Mostly the same list `WINDOWS-SUPPORT.md` and `LINUX-SUPPORT.md` already warn
about, applied to a feature that touches files harder than anything else in the
app.

- `is_hidden` in `operations.rs:28` is a dot-prefix check. That's right on
  macOS/Linux and wrong on Windows, where hidden is a file attribute. Needs a
  `#[cfg(windows)]` branch reading `FILE_ATTRIBUTE_HIDDEN`.
- Path separators in the breadcrumb and in every path we display or join.
- Case-insensitive filesystems: two tabs must not open for `Cta.tsx` and
  `cta.tsx`. Compare canonicalized paths.
- Windows file locking — a save can fail because something else holds the file.
  Surface the real error; don't retry forever.
- Windows long paths (>260 chars) need the `\\?\` prefix or the operation fails
  in ways that read as "file not found".
- inotify watch limits on Linux: a big tree can exhaust them. Detect the error
  and fall back to polling the visible subtree with a warning.
- Trash: `NSFileManager` / Shell API / `gio trash`. If it isn't available, say
  "permanently delete" in the prompt rather than quietly doing it.

---

## Phases

What was built, against the plan above.

**Phase 0 — Groundwork** ✅
- [x] `useDraggableModal`, written for the editor (the browser keeps its own copy — deliberate)
- [x] CodeMirror 6 dependencies; production bundle confirmed
- [x] `filesystem/operations.rs` finished and registered — it was complete but unwired

**Phase 1 — Read-only editor** ✅
- [x] `fs.rs`: `fs_list_dir`, `fs_read_text`, `fs_stat`, plus path confinement
- [x] `EditorModal` frame: tabs, breadcrumb, status bar, drag/resize/maximize
- [x] `EditorSurface` with highlighting, gutter, folding, fold placeholders
- [x] `FileExplorer`, virtualized, right side, resizable, hidden-file toggle
- [x] Theme bridge; `⌘⇧E` in the shortcut table, the native menu and the palette
- [x] Binary and too-large cards

**Phase 2 — Editing that can be trusted** ✅
- [x] `fs_write_text`: temp-file-and-rename, `fsync`, permissions preserved, mtime conflict check
- [x] Encoding (UTF-8/BOM/UTF-16) and line endings detected and written back unchanged
- [x] Dirty state, close prompts, save / save-all, crash-safe drafts with a recovery prompt
- [x] `fs_watch.rs` + `useFileWatcher`: reload clean buffers, flag dirty ones
- [x] Multi-cursor, autoclose, comment toggle, indent detection, find/replace
- [x] Word completion from the open document, in place of an LSP

**Phase 3 — Terminal integration** ✅
- [x] xterm link provider: `path`, `path:line`, `path:line:col` in output open here
- [x] Root defaults to the focused pane's cwd; a button offers it when they diverge
- [x] "Open in Terminal" from the tree; `⌘↵` saves and runs the file in the focused pane
- [x] Palette entry; session restore of the open folder and tabs
- [ ] `figy edit` shim — not wanted

**Phase 4 — Finding things** ✅
- [x] Quick open (`⌘P`) with its own fuzzy scorer, over a `.gitignore`-aware file list
- [x] `fs_search` streamed to `GlobalSearch`, grouped by file, with case/word/regex
- [x] Context menu: new / rename / delete-to-trash / copy path / reveal / open terminal
- [x] Drag-and-drop move within the tree
- [ ] Replace-in-files — not built

**Phase 5 — Git and polish** ✅ (the git half was deferred, then built)
- [x] `commands/git.rs` over porcelain v2: status, per-file hunks, diff, stage, unstage, discard, commit
- [x] Tree decorations, gutter change marks, branch in the status bar
- [x] `DiffView`: unified and split layouts, word-level highlighting inside changed lines, five presets (GitHub, GitLab, VS Code, Delta, plain `git diff`)
- [x] `SourceControl` panel, GitHub Desktop-shaped: one changes list, a checkbox per file, summary/description, `Commit N files to <branch>`
- [x] History tab: paged `git log`, a commit opening a drawer with its message and files, each file opening a diff at that revision
- [x] Fetch and push, with a deadline so a credential prompt can't hang the panel
- [x] A find/replace panel with a match count, and a go-to-line overlay that previews
- [x] Language, encoding, line-ending and indent pickers; word wrap toggle
- [x] Indentation guides, with the cursor's block highlighted
- [x] An editor settings modal, with the editor's own font rather than the terminal's
- [x] The active tab scrolls into view
- [x] Scratch buffers with save-as
- [ ] Outline, multi-root workspaces, a keymap section in Settings, minimap

**Phase 6 — Later**
- [ ] Stage/revert *hunks*, branch switching, pull, dock-as-pane
- [x] **Language servers** — diagnostics, hover, completion, signature help, go-to-definition, references, rename, formatting and code actions, off by default and opt-in per language. Design in [`LSP.md`](./LSP.md), build in [`LSP-TASKS.md`](./LSP-TASKS.md)
- [ ] Code intelligence without a server — [`CODE-INTELLIGENCE.md`](./CODE-INTELLIGENCE.md): outline, project index, diagnostics harvested from the build already running in the pane behind. Still worth having, and now *alongside* LSP rather than instead of it — it is the tier that works for languages no server covers

---

## Non-goals

Worth naming so they don't creep in.

- **Not an IDE.** No debugger, no test runner UI, no extension host. There's a
  terminal right there.
- **LSP is opt-in, and stays that way.** It was Phase 6 and it is now built —
  see [`LSP.md`](./LSP.md) and [`LSP-TASKS.md`](./LSP-TASKS.md) — but the
  argument that kept it out for so long still holds: a language server is a
  heavyweight child process, `rust-analyzer` on a large repository is measured
  in gigabytes, and this is a terminal that starts fast. So it is **off by
  default**, started per language on the first buffer that needs one, stopped
  when idle, and never on a file opened from a terminal link — that path exists
  to be fast. Nothing starts because a file happened to open.
- **No AI features here.** Whatever comes later, it shouldn't ride in on the
  editor's first version.
- **No remote/SSH editing.** The path-confinement model assumes local paths.
- **Not a `vim`/`nano` replacement.** People with a `.vimrc` will keep using it;
  this is for the times you don't want to.

---

## Verification

`cargo test` covers the two things in here that are silently wrong when wrong:
the porcelain v2 field counts and the unified-diff hunk headers. Everything else
is a manual matrix, run per platform (macOS, Windows, Linux):

- Open a 5,000-line file: highlighting correct, scrolling smooth, no jank on
  keystroke.
- Save a CRLF file: `git diff` shows only the line you changed.
- Edit a file in `vim` in the pane behind, with the buffer clean, then dirty:
  reload / prompt behave as specified.
- Expand `node_modules`: no freeze.
- `kill -9` the app with a dirty buffer: the draft comes back.
- Click a `tsc` error path in terminal output: correct file, correct line.
- Try to open `/etc/hosts` with a workspace root of `~/project`: refused.
- Theme toggle with the editor open: both themes legible, no flash.
- Change the font size in editor settings: the open buffer and every background
  tab follow, and none of them loses its undo history or its folds.
- Set a font in editor settings, then change the terminal's: the editor keeps
  its own. Clear it again and the editor follows the terminal once more.
- Twenty files open, then `⌘1-9` and Previous/Next file: the tab you land on
  scrolls into view, and does it visibly rather than teleporting.
- Browser and editor both in picture-in-picture, side by side: clicking the
  editor must not blank the browser's page. Then drag the editor over it — it
  must blank, and come back when the editor moves off.
- Indentation guides line up with the text at every font size, continue through
  a blank line inside a block, and stop at the shallower level between blocks.
- The active guide follows the cursor, covers the whole block rather than one
  line, and does **not** light a sibling block at the same depth.
- In a repo: a changed file is badged in the tree, its changed lines marked in
  the gutter, and its name in the panel is a *name* — not a name with an object
  hash in front of it.
- Untick a file, commit, and check `git log --stat`: only the ticked files are
  in it, including when one of the unticked ones was staged from the terminal.
- Discard an untracked file: it is in the trash, not gone.
- Commit from the panel: the file list empties and the history gains a row
  without touching Refresh. Then commit from the terminal behind it: the same.
- A commit that has not been pushed is marked in the history, and the Push
  button says so.
- History: a commit's subject, author and relative date are right, a merge is
  marked, and its files open a diff at that revision rather than the working
  copy's.
- The drawer's first file shows the status it actually has — an **added** first
  file must not read as modified — and its `+`/`−` totals match
  `git show --shortstat` for the same commit.
- The tally adds up to the file count, a rename is counted as neither new nor
  edited, and the row disappears when every file changed the same way.
- A long commit body folds with a fade and `Read more`; a three-line one shows
  whole, with no button.
- Push on a branch with no upstream publishes it; push with no remote, and with
  two remotes and no `origin`, both say so rather than doing something.
- A one-word change shows one highlight, not one per word with the spaces
  punched out, and its `+`/`−` counts agree with `git diff --numstat`.
- Every diff preset in both themes, unified and split: no column spilling into
  the next, and the hatched filler only where a side genuinely has no line.
