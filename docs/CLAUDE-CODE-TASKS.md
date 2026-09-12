# Claude Code window — Plan and Task List

The working checklist for building the Claude Code child window. The *argument* —
why a terminal should host an agent at all, what was settled and what it costs —
lives in [`CLAUDE-CODE.md`](./CLAUDE-CODE.md) and is not repeated here. This
document is what gets built, in what order, and how far along it is.

Status: `[x]` done · `[~]` built but unproven at runtime · `[ ]` todo

Pairs with [`CLAUDE-CODE.md`](./CLAUDE-CODE.md) the way
[`LSP-TASKS.md`](./LSP-TASKS.md) pairs with [`LSP.md`](./LSP.md): rationale
there, checkboxes here.

---

## The shape of it

```
┌──────────────────────────── webview ─────────────────────────────┐
│  ClaudeModal            frame, project switcher, conversation    │
│    │                    tabs, folders strip                      │
│    ├─ ClaudeSetup       new project: folder + additional folders │
│    ├─ ProjectPicker     switcher (WorkspacePicker's shape)       │
│    └─ ClaudeSurface     one xterm per conversation, kept alive   │
│                         while hidden                             │
│  services/claude.ts     probe, argv, transcript titles           │
│  services/claude-session.ts   projects in localStorage           │
│  stores/claudeStore.ts  projects, conversations, live ptys       │
└──────────────────────────────┬────────────▲──────────────────────┘
             invoke            │            │   event
   create_terminal_session({   │            │   "terminal-output"
     command: {program, args}) │            │
┌──────────────────────────────▼────────────┴──────────────────────┐
│  commands/terminal.rs ──► terminal/pty.rs                        │
│    a pty that runs a *program*, not only a login shell           │
│  commands/claude.rs                                              │
│    claude_probe · claude_transcript_head                         │
│  spawn.rs (existing)                                             │
│    find_program + login-shell PATH — already solved              │
└──────────────────────────────────────────────────────────────────┘
```

**The pty layer gains one capability and no knowledge.** It learns to run a
named program with an argv; it never learns what `claude` is. Everything
Claude-specific is a string built in TypeScript and two small commands.

## What changed from the design

Three corrections the code forced, recorded here rather than quietly applied.

- **`claude_probe` does not need to capture the environment.** The design said
  one login shell for `command -v` plus `env -0`, VS Code style. `spawn.rs`
  already does the hard half — `login_path()` runs `$SHELL -lic` with a 2s
  timeout and caches the result, `find_program()` resolves through it and
  handles Windows `PATHEXT` — and it is used by the LSP client and the
  autocomplete generators already. So the probe is `find_program("claude")` plus
  `claude --version`, and the pty gets `spawn::search_path()` as its `PATH`.
  A third copy of shell-environment archaeology would have been the wrong thing
  to add.
- **Argv, not a command string, came for free** as a result. There is no quoting
  code anywhere in this feature, which is what the design wanted and did not
  expect to get so cheaply.
- **The transcript directory name is guessed twice.** Claude mangles the project
  root into a directory name and the scheme is not a documented interface; the
  observed form replaces path separators with `-`. Both the broad reading
  (every non-alphanumeric becomes `-`) and the narrow one (separators only) are
  tried, and a miss costs a tab title and nothing else.

---

## Phase 0 — Groundwork ✅

- [x] `PtyCommand { program, args }`; `PtyInstance::new` takes `Option<PtyCommand>`
- [x] Program launches get `spawn::search_path()` as `PATH`, so Claude's own
      subprocesses (`git`, `rg`, `node`) resolve like the user's shell
- [x] `create_terminal_session` grows an optional `command`; every existing
      caller behaves identically
- [x] It also takes an optional `sessionId` — `--session-id` has to be decided
      before the process starts, so the backend can no longer be the one to mint
      it *(not in the design; found while writing the spawn path)*
- [x] `commands/claude.rs`: `claude_probe` — resolved path, version, or why not
- [x] `commands/claude.rs`: `claude_transcript_head` — first user message, for
      tab titles
- [x] Registered in `lib.rs`; `cargo check` clean
- [x] `claude-project.ts`: names, folder arithmetic, argv construction — no
      imports, so `npm test` can run it
- [x] Unit tests: argv (including a `$(rm -rf ~)` folder name), transcript
      directory mangling, session ids that try to escape the projects directory
      — `cargo test` 5 passing, `npm test` passing

## Phase 1 — One project, one conversation

- [x] `claude-session.ts`: projects in `localStorage`, versioned, merged over
      defaults, every stored string checked before it becomes a cwd or an
      argument
- [x] `claudeStore.ts`: projects, conversations, which are live
- [x] `ClaudeSetup`: folder prefilled from the focused pane's cwd, additional
      folders, no name field
- [x] `ClaudeSurface`: xterm bound to a pty session; fit on show only
- [x] `ClaudeModal`: frame reusing `useDraggableModal`, `OverlayPortal`,
      `claimFront`/`releaseFront`, PiP and maximize
- [x] Spawn with `--session-id`, `--name basename(root)`, `--add-dir`
- [x] Not-installed state: what was looked for, where, and how to fix it
- [x] `⌘⇧A` / `Ctrl+Shift+A`, the Shell menu item, the command palette entry
- [x] Lazy-loaded like the editor; mounted once, then hidden rather than
      unmounted — `dist/assets/ClaudeModal-*.js` is its own chunk
- [ ] **Verify `/add-dir` exists and behaves** in the installed CLI

## Phase 2 — Projects and live conversations

- [x] Project switcher (`ProjectPicker`)
- [x] Conversation tabs; several ptys alive, one visible, no cap
- [x] Reduced scrollback (3000 lines, against a shell pane's default)
- [x] `terminal-bus.ts`: one listener per event, dispatching by session id
- [x] `terminal-exit` event — the pty layer had no way to say a child had died,
      and a conversation has to stop being drawn as live *(not in the design;
      found while wiring the tab dot)*
- [x] Window close hides, never kills; project switch neither
- [ ] An exited conversation drops its pty — currently the pty is already gone
      by definition, but its xterm is kept mounted; revisit with a real memory
      measurement
- [x] Quit confirmation when conversations are live — a native dialog on
      `onCloseRequested`, then `destroy()` so confirming doesn't raise the same
      event again. Needed `dialog:allow-confirm` and `core:window:allow-destroy`
      in the capability file

## Phase 3 — Folders as a live thing

- [x] Folders strip: primary folder, a chip per granted folder, `+` to add
- [x] `/add-dir` injection on explicit click, with the visible note
- [x] Chips reflect `launchedWith`, not the project; ungranted folders are
      dashed chips that send `/add-dir` when clicked
- [x] Resume an exited conversation via `--resume` — a Resume button in the
      folders strip, which remounts the surface through a generation counter in
      its key. Clicking the tab alone could not do it: same key, same component,
      same already-started guard *(found while re-reading the code, not from
      the design)*
- [ ] Resume across launches (the conversations survive in storage; the tab
      strip offers them, but this is unproven)

## Phase 4 — Belonging to the terminal ✅

- [x] Clickable `path:line:col` in Claude's output → the embedded editor. The
      provider moved out of `Terminal.tsx` into `services/xterm.ts` and both
      terminals share it; relative paths resolve against the project root here
      rather than a live cwd, because Claude's cwd doesn't move the way a
      shell's does
- [x] Attention: **`onBell` only** → a pulsing tab dot, and a count in the
      status bar while the window is closed. The design also said
      `onTitleChange`, and that is wrong: the CLI rewrites the title as its
      status changes, so a conversation quietly working would claim to need you
      every few seconds. A bell is a request; a title is a status
- [x] Tab titles from the transcript, asked for twice on a delay
- [x] "Ask Claude about this" in the editor's tree — types an `@` mention into
      the conversation and leaves it unsent, because what to ask is the user's
      to write. Routed as a request prop through `AppShell`, like the editor's
      clicked-path, so it can't race the window being mounted
- [ ] The same from the git panel — the tree covers the common case; revisit
- [x] `claude_past_conversations` + `HistoryPicker`: conversations FigyTerm
      never launched, read from `~/.claude/projects`, resumable by id

## Fixes, from the first real run

Four things the user hit the first time the window was opened for real. Kept as
a list rather than folded silently into the phases above, because three of them
were design mistakes rather than slips.

- [x] **The first tab could not be closed.** `✕` on a live conversation ended it
      but left the tab; pressing `✕` again forgot it, which emptied the list,
      which tripped the "a project with no conversation starts one" effect — so
      a new tab appeared and the old one seemed never to close. Now `✕` closes
      the tab once and for all: the process stops if it is running, and the tab
      goes. Nothing is destroyed, since the transcript is the CLI's and the
      conversation is still in *Earlier conversations*.
- [x] **Nothing auto-starts any more.** The same effect meant opening a project
      began talking to Claude before being asked to. Opening a project now shows
      what the project is and offers *New conversation*; starting one is always
      the user's action.
- [x] **`Error: Session ID … is already in use.`** The first build remembered
      whether to `--resume` in a flag set when the tab was opened, and a flag
      like that goes stale — the conversation can run and exit in between.
      `claude_session_exists` now answers it from the filesystem immediately
      before the spawn, so `--session-id` against `--resume` cannot be wrong.
      Both CLI errors were reproduced directly to confirm the wording:
      `Session ID <id> is already in use.` and `Invalid session ID. Must be a
      valid UUID.`
- [x] **An empty state.** With auto-start gone there has to be somewhere to
      land: a project with nothing open now offers *Resume "<title>"* and
      *New conversation*. It also covers the first launch after a restart, when
      the tabs are remembered but none of them has a process yet.

## Picking up where you left off

The three changes that came out of using the empty state for real.

- [x] **Each past conversation shows the branch it was on.** The CLI stamps
      `gitBranch` onto its transcript entries, so this is read out of the same
      bounded head-scan as the title rather than worked out — no `git` process,
      no guess about which repository a folder belongs to. Two conversations
      about one repository are told apart by their branch far more often than
      by their opening line, so it takes the session id's place in the row when
      there is one. An empty `gitBranch` (a folder outside a repository) shows
      nothing rather than an empty chip
- [x] **The folder's history is in the empty state**, as a scrollable panel
      under the two buttons, rather than behind a button of its own. Opening a
      project with nothing running is exactly the moment "what was I doing here
      last time" is the question, and the answer is more often one of these than
      a blank conversation. `HistoryPicker` now exports `useFolderHistory` and
      `HistoryList` so the inline panel and the modal are one list
- [x] **New project opens the Projects modal**, where both answers live — pick
      one you already have, or make one from its footer. Going straight to the
      setup dialog made "I want my other project" the long way round, which is
      the commoner of the two. With no projects yet there is nothing to pick, so
      the first one still goes straight to setup
- [x] **The project field is a "working on" menu.** Clicking it lists only the
      projects with a live conversation, plus the one on screen — which is the
      parallel-work question, and the one the full list buries. "All projects…"
      at the bottom opens the modal
- [x] **Working on is its own state, not a derived one.** The first attempt
      built the menu from "projects with a live conversation, plus the current
      one", and put a *forget* button on it — both wrong. The working set is
      the bench: projects open right now, which a project can join with nothing
      running in it and leave while still being remembered. `working: string[]`
      in the window, seeded from the project that was open last time
- [x] **Close ≠ forget.** Closing takes a project off the bench and stops its
      conversations, keeping the project, its folders and every transcript;
      reopening is one click. Forgetting is permanent and lives only in the
      Projects modal, where a live conversation is the one thing that blocks it
- [x] **The bench can be emptied**, the project on screen included, which lands
      on a "Nothing open" screen listing recent projects to pick from — a
      reasonable end to a day's work rather than a state to defend against.
      `switchProject` takes `null` for it
- [x] **Closing work asks first.** A project with live conversations opens a
      consent dialog naming how many; nothing stops until it is answered
- [x] **`/exit` rather than a hangup.** On yes, each conversation is sent
      Claude Code's own exit command and given `GRACEFUL_EXIT_MS` to take it,
      after which the surfaces unmount and any remaining pty is closed anyway.
      Ask-then-insist, like `lsp/server.rs`'s `EXIT_DEADLINE`. `/exit` was
      confirmed present in the 2.1.269 binary before being relied on

## Opening a file from a conversation

- [x] **The editor adopts the right folder.** Clicking a path in a Claude
      conversation failed with *"…is outside the folders open in the editor"*
      whenever the editor was rooted somewhere else — true, unhelpful, and not
      something the user can act on. `editor://open-path` now carries the folder
      the link came from, and the editor switches workspace to it before
      opening when the file is outside its current root. The request is not
      consumed while that happens, so the unsaved-changes prompt can intervene
      and a declined switch simply does nothing rather than swallowing the file
- [x] **The link names the folder that actually contains the file.** A Claude
      project can reach folders outside its root, so `pathLinkProvider` takes an
      optional `rootFor` and the conversation picks whichever of its granted
      folders the path is under — naming the root for a file in an added folder
      would fail the same way again
- [x] **Containment is segment-aware.** A plain `startsWith` makes
      `/work/api-old` look like it is inside `/work/api`, which would send the
      editor to the wrong workspace and then fail to read the file anyway

## Header

- [x] Rebuilt in the browser's shape, reusing `browser-chrome`,
      `browser-tabstrip`, `browser-toolbar`, `browser-tab` and `browser-btn`
      rather than a second set of classes: a tab strip that doubles as the title
      bar and drag handle, and a toolbar under it whose "address" is the project
- [x] Both marks in the brand — `/logo.png` and `/claude-code.png` — with the
      title *Claude Code*
- [x] The toolbar carries the project field (click to switch), earlier
      conversations, add-folder and new-project; the strip carries the tabs and
      the window buttons
- [x] Per-project tabs are visible in the shape itself: the tabs belong to the
      toolbar's project, so switching project changes the whole strip while the
      other project's conversations keep running behind it

## Phase 5 — Docking, only on evidence

- [ ] A conversation as a `PaneContainer` leaf — see `CLAUDE-CODE.md`

---

## Verification

Filled in as phases land. Nothing is ticked here from reading the code.

**Done, against the real CLI (2.1.269):**

- [x] The exact argv this builds is accepted:
      `claude --session-id <uuid> --name argv-check --add-dir <dir> -p "hi"`
      ran and answered. A nonexistent `--add-dir` is tolerated rather than
      fatal, which is worth knowing
- [x] The transcript landed where the code looks for it — `/private/tmp`
      became `~/.claude/projects/-private-tmp/<session-id>.jsonl`, confirming
      the mangling scheme
- [x] The transcript's real shape is what the parser expects: metadata and
      queue entries first, then a `user` entry whose content is a bare string.
      Both that and the content-block shape are now unit tests
- [x] `cargo test` (64 passing), `npm test`, `npx tsc --noEmit`, `npm run build`
      — and the window is its own lazy chunk

**Still to do, and needs a person at the keyboard:**

- [ ] `claude` resolved when FigyTerm is launched from Finder (the case
      `search_path` exists for)
- [ ] A project folder containing a space and a `$(`
- [ ] Switch project mid-turn, come back: output complete, no redraw damage
- [ ] Window closed and reopened mid-turn
- [ ] Ten live conversations: memory measured, switching still instant
- [ ] Quit with conversations live
- [ ] `/add-dir` injection into a running conversation
- [ ] The bell actually arriving when Claude asks a permission question
