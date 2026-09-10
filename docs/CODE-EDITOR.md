# Embedded Code Editor

An in-app code editor, the way `BrowserModal` is an in-app browser.

**Status: built.** CodeMirror 6, modal-only, with the terminal integration.
Git decorations and the `figy edit` CLI shim were deliberately deferred — see
[Decisions](#decisions) for what was settled and [Phases](#phases) for what is
and isn't done.

Reference: the screenshot in [`issues/`](./issues) — Cursor's editor pane with a
file tree pinned to the right, file tabs across the top, and a breadcrumb bar
under them. That's the shape we're copying. What follows is how it should be
built here, and what it needs to be worth opening twice.

Related: [`WINDOWS-SUPPORT.md`](./WINDOWS-SUPPORT.md) and
[`LINUX-SUPPORT.md`](./LINUX-SUPPORT.md) for the per-platform assumptions any
filesystem-touching feature has to respect.

---

## Decisions

Settled before the build started, and recorded here because each one closes off
a direction the rest of the document still discusses.

| Question | Decision |
|---|---|
| Editing engine | **CodeMirror 6.** Monaco's 5 MB and worker wiring aren't worth the VS Code feel here. |
| Modal or pane | **Modal only.** Docking it as a `PaneContainer` pane is not planned. |
| Git integration | **Later.** No tree decorations, no gutter marks, no diff view. |
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
- **TS IntelliSense** — Monaco ships it free. For us that's an LSP client, and
  it is explicitly a later phase (see [Non-goals](#non-goals)). Highlighting,
  bracket-aware indent and word/path completion cover the "peek and patch a
  file next to my shell" case this is for.

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

The git columns the screenshot shows in the tree, and a branch name in the
status bar, are the deferred part — the layout leaves room for both.

- **Modal frame** — drag, resize, maximize, Escape-to-close, backdrop click,
  the same manners as `BrowserModal`, minus every native-webview workaround. The
  drag/resize logic in `BrowserModal.tsx:258-327` is worth extracting to a shared
  `useDraggableModal` hook rather than copied; the browser then loses ~70 lines.
- **File tabs** — dirty dot, middle-click close, drag to reorder, overflow
  scroll, `⌘1-9` to jump. Cap at 12 open buffers, LRU-evict clean ones.
- **Breadcrumb** — path segments from the workspace root, each a click target
  that opens a directory picker for its siblings. Back/forward navigate the
  *file* history, not the directory.
- **Explorer, right side** — as in the screenshot, and resizable via
  `react-resizable-panels`, already a dependency (`PaneContainer.tsx` uses it).
  Collapsible to zero with `⌘B`; width persisted.
- **Status bar** — language, encoding, line ending, cursor position, indent
  setting, git branch, and the resize grip. Clicking language, encoding, line
  ending or indent opens a picker for it.

---

## State and services

```
src/stores/editorStore.ts        buffers, tabs, explorer expansion, dirty state
src/services/editor-fs.ts        typed wrappers over the new Tauri commands
src/services/editor-lang.ts      extension → dynamic language import + icon
src/services/editor-session.ts   persistence (open tabs, cursors, tree state)
src/components/Editor/
  EditorModal.tsx                frame, tabs, breadcrumb, status bar
  EditorSurface.tsx              the only file that imports @codemirror/*
  FileExplorer.tsx               virtualized tree
  FileExplorerRow.tsx
  QuickOpen.tsx                  fuzzy file finder
  GlobalSearch.tsx               ripgrep-style results panel
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
| `git_status(cwd)` | registers the existing function |
| `git_diff_file(cwd, path)` | unified diff vs HEAD for `DiffView` |

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
  marks in the gutter, and `DiffView` against HEAD. Staging is Phase 6.
- **Quick open (`⌘P`)** over the workspace, using the same fuzzy scoring the
  autocomplete engine already implements in `services/figy-autocomplete-engine.ts`
  rather than a second ranking algorithm with different manners.
- **Global search (`⌘⇧F`)** with streamed results grouped by file, and
  "open all matches as tabs".
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
| Quick open | `⌘P` | `Ctrl+P` |
| Find / replace in file | `⌘F` / `⌥⌘F` | `Ctrl+F` / `Ctrl+H` |
| Global search | `⌘⇧F` | `Ctrl+Shift+F` |
| Go to line | `⌘G` | `Ctrl+G` |
| Close tab | `⌘W` | `Ctrl+W` |
| Toggle explorer | `⌘B` | `Ctrl+B` |
| Toggle comment | `⌘/` | `Ctrl+/` |
| Add next occurrence | `⌘D` | `Ctrl+D` |
| Move / copy line | `⌥↑↓` / `⇧⌥↑↓` | `Alt+↑↓` / `Shift+Alt+↑↓` |
| Run file in pane | `⌘↵` | `Ctrl+Enter` |
| Nth tab | `⌘1-9` | `Ctrl+1-9` |

Escape closes the innermost thing — search panel, then quick open, then the
modal — and a dirty buffer prompts instead of closing.

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
- **Lazy git status** per expanded directory, not per keystroke, refreshed on
  watcher events.

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

**Phase 5 — Git and polish** — deferred by decision
- [ ] Tree decorations, gutter change marks, diff against HEAD
- [x] Language, encoding and line-ending pickers; go-to-line; word wrap toggle
- [x] Scratch buffers with save-as
- [ ] Outline, multi-root workspaces, a keymap section in Settings, minimap

**Phase 6 — Later**
- [ ] Stage/revert hunks, dock-as-pane, LSP client

---

## Non-goals

Worth naming so they don't creep in.

- **Not an IDE.** No debugger, no test runner UI, no extension host. There's a
  terminal right there.
- **No LSP before Phase 6.** It's a language-server lifecycle manager, a
  protocol client and a per-language install story — a project of its own.
- **No AI features here.** Whatever comes later, it shouldn't ride in on the
  editor's first version.
- **No remote/SSH editing.** The path-confinement model assumes local paths.
- **Not a `vim`/`nano` replacement.** People with a `.vimrc` will keep using it;
  this is for the times you don't want to.

---

## Verification

There's no test runner in the repo, so this is a manual matrix, run per platform
(macOS, Windows, Linux):

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
