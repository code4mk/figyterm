# Claude Code in FigyTerm

A project-shaped child window for the `claude` CLI, the way `BrowserModal` is an
in-app browser and `EditorModal` is an in-app editor.

**Status: built, through Phase 4.** This began as a proposal to argue with
before any code was written, and the argument is what the document still is —
[`CLAUDE-CODE-TASKS.md`](./CLAUDE-CODE-TASKS.md) is the checklist of what was
actually made, including the handful of places the build corrected the design.
Everything here about the CLI was checked against **Claude Code 2.1.269**,
installed at `~/.local/bin/claude`; the flags quoted are from that build's
`--help` and from running it, not from memory.

Related: [`CODE-EDITOR.md`](./CODE-EDITOR.md) for the modal, drag/resize and
overlay-stack conventions this borrows wholesale, and
[`WINDOWS-SUPPORT.md`](./WINDOWS-SUPPORT.md) /
[`LINUX-SUPPORT.md`](./LINUX-SUPPORT.md) for the per-platform assumptions any
process-spawning feature has to respect.

---

## The brief

From the request, restated so the design can be checked against it:

1. **Shell → Claude Code** opens a child window, like Browser and Code Editor.
2. On first open it asks for a **project**: a **primary folder** (defaulting to
   the working directory of the focused pane), and then any **additional
   folders**. No name is asked for — the project is called whatever the primary
   folder's last path segment is called.
3. Once a conversation is running, additional folders can be **added** without
   starting over. They are not removed — see
   [Decisions](#decisions).
4. The user can **switch projects**, and **any conversation that is running keeps
   running**.
5. What is inside the window is **the Claude Code CLI as it ships**. FigyTerm
   draws the frame and nothing else.

Point 4 is the load-bearing one. It is what turns this from "a terminal tab with
`claude` typed into it" into a feature, and it is what the rest of this document
is mostly about.

---

## Verdict

**Embed the CLI. Do not build a chat UI.** Settled, not proposed.

It goes the same way the editor's first decision did — for the opposite reason.

The editor was built as our own React because it renders *our* content. This
renders **Claude Code's** content, and Claude Code is a full terminal
application: a prompt box with its own autocomplete and history, permission
dialogs, plan mode, streamed diffs, todo lists, `/`-commands, `@`-mentions, a
resume picker, a spinner that reports token spend. Reimplementing that over
`--print --output-format=stream-json` means owning a second front-end for a
product that ships changes weekly, and being a version behind forever. Every
feature Anthropic adds would land in FigyTerm as a regression.

So the window hosts a **pty running `claude`**, drawn with the xterm.js instance
the app already builds for every pane. FigyTerm's job is the part the CLI
deliberately doesn't do:

- **Projects** — a primary folder plus a set of additional folders, saved,
  switchable, and reusable.
- **Conversations that outlive the view** — several sessions alive at once, only
  one of them on screen.
- **Folders you can see and add to** while talking.
- **Belonging to the terminal** — a path Claude prints opens in the embedded
  editor; a file Claude changes shows up in the git panel that is already there.

That is a session manager with a terminal in it, not a chat client. It is also
perhaps a tenth of the code the other reading would take.

---

## Decisions

Everything marked **settled** came back from a review of this document and is
not open again. The rest are proposals about mechanism, and are the rows to
disagree with.

| Question | Decision |
|---|---|
| Chat UI or the real CLI | **Settled: the real CLI in a pty**, exactly as it ships. See [Verdict](#verdict). |
| Project name | **Settled: there isn't one.** A project is called `basename(root)` — no field, no prompt, no rename. |
| Removing an additional folder | **Settled: not a feature.** Folders are add-only. A different folder set is a different project. |
| One window or one per project | **Settled: one window**, with projects switched inside it. A second OS window is a different feature (see [Non-goals](#non-goals)). |
| How many conversations may be live | **Settled: as many as you like.** No cap, no prompt at some number — the cost is managed instead of rationed. |
| Background sessions (`claude --bg`) | **Settled: no.** Quitting stops conversations; the next launch resumes them. |
| Modal or dockable pane | **Modal, with picture-in-picture, for v1** — docking is allowed later and is Phase 5. See below. |
| Native child webview | **No.** Same argument as the editor — we draw our own chrome, xterm draws the rest. None of `browser_layout.rs`'s problems apply. |
| How `claude` is found | **Resolve it through a login shell once, cache it, spawn by argv.** Not a command string — see [Launching `claude`](#launching-claude). |
| Conversation identity | **We mint the UUID** and pass `--session-id`. That makes resume exact and tells us where the transcript lives. |
| New session or resume | **Asked, never remembered.** Immediately before starting, check whether the transcript exists; that decides `--session-id` against `--resume`. See below. |
| Keeping a conversation alive while hidden | **Keep the pty and its xterm instance alive; hide the view.** The pty manager already outlives any React tree. |
| Adding a folder mid-conversation | **Type `/add-dir <path>` into the session**, on an explicit click, and say in the UI that it was sent. |
| Changing a project's primary folder | **Not an edit.** It changes the cwd, the name, the `CLAUDE.md` that is discovered and where transcripts live. Offer "duplicate as a new project" instead. |
| Auth, login, model config | **The CLI's, untouched.** FigyTerm never sees a token. |
| Installing the CLI | **Detect, don't manage.** If `claude` isn't found, say so and link the install docs. |

### On asking rather than remembering

`--session-id <id>` starts a conversation; `--resume <id>` continues one. Which
of the two is right is a fact about the filesystem, and the first build carried
it as a flag set when a tab was opened instead — which is how it ended up
passing `--session-id` for a conversation that had already run. The CLI is
blunt about it:

```
Error: Session ID 923adca6-…-2a0928f3efbc is already in use.
```

and exits, so the window opened onto a dead terminal showing an error about an
id the user never chose. Every way of getting the flag wrong ends there, and a
flag decided earlier can always go stale — the conversation may have started
and exited in between.

So nothing remembers. `startConversation` asks the backend whether the
transcript exists and picks the flag from the answer, one IPC call before a
process spawn that costs far more. `claude_session_exists` is three lines over
the path derivation that was already there.

### On docking

Docking as a `PaneContainer` pane was left to this document's judgement, so:
**not in v1, and not because it's a bad idea.**

The case for it is real and better than the editor's was — you *watch* a Claude
conversation while working, where you dip in and out of an editor. But the case
is already most of the way answered by picture-in-picture, which
`useDraggableModal` gives for free and which both other modals already use: a
small window pinned in a corner beside a full-height shell is the shape people
actually want, and it costs nothing to build.

Docking costs a great deal more. `PaneContainer` is a split tree of *terminal
sessions* — `AppShell` keys cwds, clear refs, focus refs and session records by
pane id, and `TabBar` counts panes per tab. A pane that is a Claude window
rather than a shell means every one of those maps grows a second kind of member,
and that is the most load-bearing code in the app. It is a Phase 5 change made
deliberately, on evidence that PiP wasn't enough — not a v1 flourish.

Three of the settled rows are simplifications with a cost, recorded so nobody
has to rediscover them:

- **No name** means two checkouts of the same repository — `~/work/api` and
  `~/scratch/api` — are both called `api`. The switcher already draws the
  collapsed path under the name (that is `WorkspacePicker`'s existing row), so
  they are told apart there rather than by a field nobody wants to fill in.
- **No removal** means a folder granted to a project stays granted for that
  project's future conversations. Getting rid of one is a new project against
  the same primary folder, which takes one dialog and no typing. That is a fair
  trade for deleting the entire grant-revocation story below, which was the most
  intricate thing in the first draft and bought very little.
- **No background sessions** means quitting FigyTerm ends every conversation.
  Softened by resume rather than by a daemon: the ids are ours and the
  transcripts are on disk, so the next launch picks any of them back up with its
  history intact. What is genuinely lost is a turn that was in flight, which is
  why quitting with live conversations asks first.

---

## What it looks like

```
┌─ figy ▸ Claude Code ──── ● api refactor ✕  ○ flaky test ✕  + ── ⟡ ⛶ ✕ ─┐
│  ~/GitHub/nexus-re                                ▾ │  ⟲  +folder  +proj │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   ▐ the pty: claude's own TUI, xterm.js                                │
│                                                                        │
│   > _                                                                  │
├────────────────────────────────────────────────────────────────────────┤
│ ~/GitHub/nexus-re    +design-system    +shared-types                    │
└────────────────────────────────────────────────────────────────────────┘
```

Three pieces of chrome, and the rest is Claude's.

**The header is the browser's**, and deliberately so — `browser-chrome`,
`browser-tabstrip` and `browser-toolbar` are reused rather than reimplemented.
A tab strip that doubles as the title bar and drag handle, and a toolbar under
it holding the thing the tabs belong to. In a browser that is the address of
the page; here it is the project the conversation runs in, which is the same
question and the same answer to *where am I?*. It also makes the per-project
behaviour legible: switch project and the whole strip changes, because those
tabs belong to that toolbar's project.

The brand carries **two** marks, FigyTerm's and Claude Code's, because that is
exactly what the window is — FigyTerm hosting somebody else's program, and the
header should say whose.

### Working on, and Projects

Two lists, and they answer different questions. Conflating them was the first
version's mistake, so they are named apart in the code as well as in the UI.

| | **Working on** | **Projects** |
|---|---|---|
| What it is | The bench: projects open *right now*, in parallel | Every project ever made |
| Where | A menu under the project field, one click away | A modal, from the toolbar's `+` or "All projects…" |
| Lives for | The window's session | Forever, in `localStorage` |
| Its action | **Close** — takes it off the bench, keeps everything | **Forget** — deletes the project record for good |
| Can be empty | **Yes**, and that is a screen, not an error | Yes, on a fresh install |

A project can be on the bench with nothing running in it — you opened it to
look — and it can have three conversations going. Neither fact puts it on the
bench or takes it off; opening and closing do. That is the whole difference
between the working set and "projects with a live conversation", which is what
the first build wrongly used instead.

**Closing is not forgetting.** Closing takes a project off the bench and stops
its conversations, because a project you are not working in is not one that
should still be running; everything else — the folder set, the history, the
transcripts — is untouched and reopening is one click. Forgetting is the
permanent one and lives only in the Projects modal, guarded by the one rule that
matters: a project with a live conversation cannot be forgotten, because that
would leave a pty nothing can reach.

**Closing work asks first, then asks Claude.** A project with nothing running
closes on the click. One with live conversations puts the question up instead —
*"2 conversations are still running. Closing asks them to exit. The project is
kept, and every conversation resumes with its full history."* — and stops
nothing until it is answered.

On yes, each conversation is sent **`/exit`**, Claude Code's own way out, rather
than having its pty pulled out from under it. It is the difference between a
clean shutdown and a hangup mid-write, and it costs one line. The window comes
off the bench immediately so the click feels like it worked, and the surfaces
are unmounted a second and a half later — at which point anything still alive
has its pty closed regardless. Ask, then insist, with a deadline: the same shape
`lsp/server.rs` uses to stop a language server and `git_network` uses for a
credential prompt that never comes.

**The bench can be emptied completely**, including the project on screen, which
lands on a "Nothing open" screen listing recent projects to pick from. That is a
reasonable place to be at the end of a day's work, not a state to be defended
against.

**The project switcher** is `WorkspacePicker`'s shape, near enough to reuse:
a filterable list, pins, the current one checked, "New project…" in the footer.
It already solves "I have twelve folders and want the one I was in yesterday",
and it already draws each row as a folder name over its collapsed path — which
is exactly what a nameless project needs.

**Conversation tabs** are per project. A filled dot means the pty is live, a
hollow one means it exited and the tab is now a scrollback you can read or
resume. A dot that pulses means that conversation wants you — see
[Attention](#attention-knowing-when-claude-wants-you).

Two rules about them, both learned by getting them wrong first:

- **✕ closes the tab. Once.** It stops the process if one is running and the tab
  goes away. An earlier version made ✕ mean "end" on a live conversation and
  "forget" on an ended one, which read as a close button that did nothing the
  first time you pressed it. Nothing is destroyed either way — the transcript is
  the CLI's file, so a closed conversation is still in *Earlier conversations*
  and still resumes in full.
- **Nothing starts by itself.** Opening a project does not open a conversation;
  the window shows what the project is and offers to start one. The version that
  auto-started made the last tab impossible to close — closing it emptied the
  list, which immediately started another — and meant the window began talking
  to Claude before it was asked to.

**The folders strip** is the primary folder on the left and a chip per
additional folder, with a `+` that opens the folder dialog. Chips are read-only:
they are a statement of what this conversation can reach, not a control. It
stays visible during a conversation on purpose — the set of folders Claude can
touch is the thing you most want to be sure of while it is editing your code.

**The setup dialog**, shown on first open and from "New project…":

```
┌─ New Claude project ───────────────────────┐
│  Folder   [ ~/GitHub/nexus-re     ] Browse │  ← prefilled with the focused pane's cwd
│                                            │
│  Additional folders                        │
│    ~/GitHub/design-system              ✕   │
│    + Add folder…                           │
│                                            │
│  Model [ default ▾ ]  Permissions [ ask ▾ ]│  ← optional, collapsed by default
│                          [ Cancel ] [Start]│
└────────────────────────────────────────────┘
```

One field, and it is usually already right. The prefilled folder is the "pwd"
from the brief: `AppShell.getActiveCwd()` already tracks the focused pane's live
directory, and it is passed to the editor the same way. Opening Claude while
sitting in a repo should be `⌘⇧A`, `Enter` — not a form.

The ✕ in *this* dialog is not a contradiction of the add-only rule. Nothing has
been granted yet; it is undoing a click you just made, the way any list-builder
works. Once the project exists, the folder set is fixed.

---

## The project model

```ts
/** A folder set, and the conversations that have run against it. */
export interface ClaudeProject {
  id: string;               // ours, uuid
  root: string;             // primary folder; claude's cwd. Immutable — see Decisions
  extraDirs: string[];      // → `claude --add-dir a b c`. Append-only
  conversations: Conversation[];
  createdAt: number;
  lastUsedAt: number;       // orders the switcher
  pinned?: boolean;
  /** Launch options, per project because they are a property of the work. */
  model?: string;           // → --model
  permissionMode?: PermissionMode; // → --permission-mode
  effort?: string;          // → --effort
}

/**
 * The display name, everywhere one is needed: the switcher row, the window
 * header, `claude -n`.
 *
 * Derived rather than stored, because a stored copy is a thing that can
 * disagree with the folder — and there is no UI that could ever put them back
 * in step, since nothing names a project.
 */
export const projectName = (p: ClaudeProject) => basename(p.root);

export interface Conversation {
  /** The uuid we minted and passed as --session-id. Also names the transcript. */
  sessionId: string;
  title: string;            // first user message, or "Conversation 2" until there is one
  startedAt: number;
  endedAt: number | null;   // null while the pty is alive
  /**
   * The folder set this session was *launched* with.
   *
   * Not the same as the project's: a folder added while this conversation was
   * running is in the project but was never granted here, and one added to the
   * project from another conversation is in neither. This is what the folders
   * strip draws, and what tells us which chips to offer `/add-dir` for.
   */
  launchedWith: { root: string; extraDirs: string[] };
}
```

Persisted in `localStorage` under `figy-term-claude`, read through a merge over
defaults, versioned and discarded on mismatch — exactly the contract
`services/editor-session.ts` already documents. Nothing large goes in there:
**no transcript text, ever.** Claude already writes the transcript to
`~/.claude/projects/<mangled-root>/<session-id>.jsonl`, and duplicating it into a
synchronous few-megabyte browser store would be both slow and wrong.

That path is worth stating plainly, because two features fall out of it for
free: FigyTerm can list a project's past conversations without having launched
them, and it can read the first user message to title a tab.

---

## Launching `claude`

The unglamorous part, and the one most likely to produce a bug report that says
"it works in a normal tab".

### Finding it

`terminal/pty.rs` spawns a **login shell** on POSIX after `env_clear()`, with a
hand-built `PATH` of the system directories plus `~/.local/bin`. The shell then
sources the user's profile, which is what puts `nvm`, `mise`, `asdf`, Homebrew
and `~/.local/bin` back. Claude Code's native installer lands in `~/.local/bin`
— covered — but an npm install under `nvm` lands somewhere only the profile
knows about, and `Command::new("claude")` from Rust would simply not find it.

So one of two things, and they differ more than they look:

| | Resolve-then-spawn | Spawn through the shell |
|---|---|---|
| Shape | `$SHELL -lc 'command -v claude'` once at startup, cache; then spawn that path with argv | `$SHELL -lc "claude --add-dir '…' …"` every time |
| Quoting | **None.** argv is a list all the way down | A folder path becomes shell source. `$(…)`, backticks and quotes all have to be neutralised, correctly, on three platforms |
| Env for Claude's own subprocesses (`git`, `rg`, `node`) | Needs the profile's environment captured too — `$SHELL -lc 'env -0'` — and applied | Free; it *is* a login shell |
| Extra process in the tree | No | Yes, unless `exec` |

**Proposed: resolve-then-spawn, with the login-shell environment captured in the
same pass.** Run one `$SHELL -lc 'command -v claude; env -0'` at first open,
cache the result for the session, spawn `claude` directly with that environment
and a real argv. It is what VS Code does for the same reason, it removes shell
quoting from a feature whose inputs are user-chosen filesystem paths, and it
keeps the process tree honest — the pty's child is Claude, so `foreground_pid()`
and the exit code mean what they say.

There is a tempting middle road — `$SHELL -l -c 'exec "$0" "$@"' /path/to/claude
--add-dir …`, which sources the profile *and* passes argv untouched, because sh,
bash and zsh all assign the trailing operands to `$0`/`$@`. It is genuinely
neat. It is also wrong under `fish`, whose `-c` puts everything in `$argv`, and
a user with `fish` as their login shell is not an edge case. If we want the
one-liner it needs a fish branch; the environment capture needs one anyway
(`env -0` is fine there, `command -v` is not).

On Windows there is no `env_clear()` to undo — the inherited environment *is* the
environment — so resolution is `where.exe claude` plus `PATHEXT`, and the
`.cmd`/`.ps1` shim that npm installs has to be run the way Windows expects
rather than exec'd.

### The command line

```
claude
  --session-id <uuid we minted>
  -n "<basename of the primary folder>"
  --add-dir <extra…>            # only if there are any
  [--model …] [--permission-mode …] [--effort …]
```
with the pty's cwd set to the project's primary folder — that is what makes the
primary folder primary, and what makes its last path segment the project's name.
Resuming a conversation whose process has exited replaces `--session-id` with
`--resume <uuid>` and re-passes everything else.

`-n` is worth passing even though nothing forces it: it names the session in
Claude's own `/resume` picker and in the terminal title, so a conversation
started in FigyTerm is still recognisable from a plain shell later. Since the
name is the folder name, this costs a string concatenation and no UI at all.

### What we do not pass

Not `--dangerously-skip-permissions`, and not via a settings toggle either. If
someone wants it they can type it; a terminal emulator should not be the thing
that makes it one click away. `--permission-mode` is exposed because every value
it takes is a mode the CLI itself offers in-session.

---

## Conversation identity, and why we mint the UUID

`--session-id <uuid>` lets the caller choose the conversation's id. Passing our
own rather than scraping Claude's buys three things at once:

1. **Resume is exact.** `claude --resume <uuid>` reopens precisely that
   conversation — no picker, no "most recent in this directory" guessing, which
   is what `--continue` would give us and is wrong the moment two conversations
   share a folder.
2. **We know where the transcript is** before Claude has written a byte:
   `~/.claude/projects/<root with separators turned to dashes>/<uuid>.jsonl`.
   That is how a tab gets a real title instead of "Conversation 3", and how the
   project remembers conversations FigyTerm never had open.
3. **The mapping survives us.** A project's conversation list is a list of
   uuids; nothing depends on a process still being alive for the list to be
   meaningful.

The transcript path is derived from Claude's own directory-mangling scheme,
which is not a documented interface. Treat it as a **nice-to-have**: if the
directory isn't where we expect, tabs fall back to "Conversation N" and nothing
else breaks. Never write into that directory.

---

## Conversations that keep running

Requirement 4. Three ways to do it, and the first is nearly free.

### The pty manager already does the hard part

`TerminalManager` holds sessions in a `HashMap<String, PtyInstance>` with a
reader thread per pty that emits `terminal-output` events. It has never known
anything about React. A session lives until `close_session` is called, and
nothing in the UI's lifecycle calls it by accident.

What is *not* free is the client end. Today the bytes land in an xterm instance
that exists only while a component is mounted. For this window the rule is the
same one the editor already follows, and for the same reason:

> **Mounted stays mounted.** Switching project hides a conversation; it does not
> unmount it. One xterm instance per live conversation, kept in a ref map,
> disposed only when the conversation is closed.

`AppShell` already renders every terminal tab at once with the inactive ones
`invisible`, so the pattern is in the codebase twice over.

**No cap, and no "you have too many conversations" dialog.** Open as many as the
work needs. That is a decision about what the app is allowed to nag about, not a
claim that memory is free, so it comes with three things that keep the cost
small instead of a number that gets in the way:

- **Scrollback is smaller here than in a terminal pane.** A shell's buffer is the
  only record of what happened; a Claude conversation's record is the transcript
  on disk, and the buffer is just what you can scroll back through. A few
  thousand lines, not the terminal's default.
- **An exited conversation drops its pty** and keeps only its buffer. The tab
  stays readable and resumable; the process and its reader thread are gone.
- **The count is visible** in the switcher, per project, so "why is this using
  memory" is answerable by looking rather than guessing.

If this turns out to be wrong it becomes a setting, not a hard-coded eight.

### What it does not survive

FigyTerm quitting. The pty's child dies with the app, exactly as a shell in a
pane does, and that is the accepted behaviour — **no background sessions**.
`claude --bg`, `attach`, `agents` and `stop` exist and would survive an app
restart, but they buy a detach/attach model, a second kind of session to reason
about, and scrollback we never saw, in exchange for a case that has a much
cheaper answer here.

The cheaper answer is that a conversation is not *lost* when it is stopped, only
stopped. Every session id is ours, every transcript is on disk, so the next
launch offers each recent conversation a **Resume** that runs
`claude --resume <uuid>` with the project's folder set and picks the thread back
up with its full history. What is lost is a turn that was in flight — which is
worth one dialog on quit:

> **3 conversations are running.** Quitting stops them. You can resume each one
> next time — their history is kept.  `[Cancel]  [Quit]`

A terminal does not normally ask, but a shell sitting at a prompt is not an
agent halfway through editing files, and the difference is the whole reason the
prompt is worth the interruption.

### Switching projects

Switching is therefore: hide the current conversation's surface, show the target
project's, focus its xterm, re-fit. Nothing is spawned, nothing is killed,
nothing is asked. A conversation mid-turn keeps streaming into a hidden xterm
and the work is all there when you come back — visibly so, because the tab's dot
stays lit and the switcher row shows a count.

Closing the **window** is the same: hide, never kill. The pty outlives the
modal, and reopening `⌘⇧A` lands back exactly where you were. Only an explicit
"End conversation", or quitting the app, stops a session.

---

## Folders, during a conversation

### Adding

`/add-dir <path>` is a slash command the running session accepts, so adding a
folder is: write `/add-dir <path>\r` into the pty, and record it in the project.
No restart, no lost context.

Two honest caveats, both of which shape the UI:

- **It types into someone's prompt box.** If there is half-written text on the
  input line, injecting a command mangles it. From outside the pty we cannot
  know. So this happens only on an explicit click, never as a side effect, and
  the UI says what it did — a line in the folders strip reading
  *"sent `/add-dir ~/x` to this conversation"* — so a surprising result is
  explicable rather than spooky.
- **`/add-dir` must be verified against the installed CLI.** It is in 2.1.269 as
  far as this document's author knows, but it was not proven by running it while
  writing this. Phase 1 verifies it. If it is absent, the fallback is to relaunch
  the process as `claude --resume <session-id> --add-dir <the full set>` in the
  same xterm buffer: a new process, the same conversation, every message kept.
  Worth knowing that escape hatch exists — it is the other thing minting our own
  `--session-id` buys.

A folder added to the project while *no* conversation is running is simply an
append to `extraDirs`, and lands via `--add-dir` next launch.

### Not removing

There is no `/remove-dir` in the CLI, and there is none here either. A grant
given to a running session stays given; pretending otherwise would be the worst
possible bug in a feature about which folders an agent may write to, and the
machinery to do it honestly — revoke, relaunch, re-grant the remainder — was
more intricate than the problem deserved.

So `extraDirs` is append-only, and the chips have no ✕. To work against a
narrower set of folders, make a new project on the same primary folder; the
setup dialog is one keystroke and one click. Projects are cheap on purpose.

---

## The traps in hosting a hidden terminal

The editor does not have these. A terminal does, and they are all the same bug
wearing different hats: **a hidden element has no size.**

- **Never fit while hidden.** `FitAddon.proposeDimensions()` on a
  `display:none`/zero-height container returns nonsense, and a `resize` to
  1×1 makes Claude's TUI redraw its whole interface into a single column.
  Recovering from that needs another resize *and* a redraw the app cannot ask
  for. So: skip every fit while the surface is hidden, and fit once on show,
  before focusing. Hide with `visibility`/`invisible` as `AppShell` does, not
  `display:none`, so measurement stays possible.
- **Do not resize on project switch.** Only on show, on window resize, and on
  drag-resize end — matching what `BrowserModal` learned about mid-drag work.
- **One `terminal-output` listener, dispatching by session id.** One listener
  per conversation means N listeners each filtering N streams; with ten
  conversations that is a hundred comparisons per chunk of output on the UI
  thread, and nothing caps N.
  A single listener and a `Map<sessionId, Terminal>` is the same code and does
  not degrade.
- **Focus.** The editor's rule applies unchanged: every route out of the window
  hands the keyboard back to the focused pane, or it belongs to nothing.
- **⌘W.** The Claude window is a second thing that must claim it while it is up,
  alongside the editor — closing a conversation tab, not the OS window. See the
  comment in `menu.rs`; this makes the routing three-way and that routing wants
  to live in one place rather than two `if`s.

---

## Attention: knowing when Claude wants you

A conversation you switched away from will eventually need a permission answer,
and the point of a hidden-but-live session is that you are not watching it.

The cheap, wrong answer is scraping output for prompt text. It breaks the first
time the CLI rewords anything.

The right answer is in the terminal protocol, where the CLI already speaks it.
Claude Code notifies through the terminal — a **BEL** and an **OSC title
change** — and xterm.js surfaces both as `onBell` and `onTitleChange`, with no
parsing and no coupling to wording. A bell from a hidden conversation lights its
tab dot and, if the window is closed, puts a count on the Shell menu item and the
status bar. Clicking it goes straight there.

Two things to check in Phase 4 rather than assume: which notification channel
the CLI uses by default (it is configurable, and the terminal bell is one of
several), and whether FigyTerm should set it explicitly for sessions it starts.
If neither signal arrives, the fallback is `foreground_pid()`, which
`TerminalManager` already computes — it distinguishes "Claude is working" from
"Claude is sitting at a prompt", which is most of the value.

---

## What makes it *FigyTerm's* Claude window

A modal with a pty in it is worth about as much as a tab. These are the reasons
to build it here rather than type `claude` into a pane, and they should be in
Phase 4 at the latest, not "later":

- **It starts where you are.** The primary folder defaults to the focused pane's
  live cwd.
- **Paths it prints are clickable.** `Terminal.tsx` already has a link provider
  turning `path:line:col` into an `editor://open-path` event, and the editor
  already listens. A `file.ts:42` in Claude's output opening the embedded editor
  at line 42 is one reused provider away.
- **The diff is already on screen.** Claude edits; the Source Control panel in
  the editor shows the change, per hunk, with the same diff view the rest of the
  app uses. No other terminal can offer that.
- **The folder set is visible and revocable.** In a plain terminal, which
  directories a session can write to is something you remember. Here it is a row
  of chips with ✕ on them.
- **"Ask Claude about this" from the editor** — the file tree's context menu and
  the git panel both have obvious entries. Later than the above, but it is the
  direction the whole thing points in.

---

## Rust side

Small, and mostly generalising what exists.

**`terminal/pty.rs` and `commands/terminal.rs`** — `create_terminal_session`
grows an optional program and argv:

```rust
pub fn create_terminal_session(
    cols: u16, rows: u16, cwd: Option<String>,
    /// None = the login shell, exactly as today.
    command: Option<TerminalCommand>,   // { program: String, args: Vec<String>, env: Vec<(String,String)> }
) -> Result<TerminalSession, String>
```

Every existing caller passes `None` and behaves identically — that property is
worth keeping deliberately, because this is the code path every pane in the app
depends on.

**`commands/claude.rs`** — new, and thin:

- `claude_probe()` → `{ found: bool, path: String, version: String, env: Vec<(String,String)> }`.
  One login shell, `command -v` plus `env -0`, cached for the process lifetime.
  This is the only new thing with real platform variance in it.
- `claude_transcript_head(session_id, root)` → the first user message from the
  transcript jsonl, for tab titles. Reads at most a few KB; returns `None` on
  anything unexpected, because this is decoration.

No new filesystem surface: the folder picker is `plugin-dialog`, already a
dependency, and nothing here reads project files. The confinement model in
`fs.rs` is untouched — **Claude's file access is Claude's, governed by its own
permission system, and FigyTerm neither extends nor constrains it.** Worth
writing down because the opposite assumption would be a security claim we cannot
honour.

---

## Keyboard

One new chord: **`⌘⇧A` / `Ctrl+Shift+A`** — A for Ask. Free in both schemes
(`shortcuts.ts` has T, D, W, K, P, M, B, E, F, R, C, V, L, `[`, `]`, `,` and Tab
spoken for) and claimed by no shell.

Inside the window, chords are scoped to the modal the way the editor's are, and
the list is short because **almost every key belongs to Claude**:

| Chord | Action |
|---|---|
| `⌘⇧A` | Toggle the window |
| `⌘T` | New conversation in this project |
| `⌘W` | Close conversation tab |
| `⌘P` | Project switcher |
| `⌘⇧[` / `⌘⇧]` | Previous / next conversation |
| `Esc` | **Goes to Claude**, not to us — it is how you interrupt a turn |

That last row is a rule, not an exception: anything the CLI binds, we do not.
The window closes on the chord, the menu item and its own button.

---

## Cross-platform

- **macOS** — the reference. `~/.local/bin/claude`, login shell resolution.
- **Linux** — same, plus the existing `SESSION_PASSTHROUGH` list, which Claude
  needs for the same reasons the shell does (`xdg-open`, the session bus).
- **Windows** — the one with real work in it. No `env_clear()` to undo, but the
  npm shim is a `.cmd`, `where.exe` replaces `command -v`, and
  `ClosePseudoConsole` blocking on a live child (documented at length in
  `pty.rs`) applies to every conversation the app shuts down at once. With no
  cap on live conversations this matters more here than anywhere else in the
  app: ending a dozen on quit must not become a dozen blocking waits, which is
  the close-the-writer-first ordering `PtyHandles` already encodes — and the
  reason the quit dialog is answered *before* any of them is stopped.

Unlike the browser, nothing here is unsupported anywhere: it is a pty and our
own React, so it works on all three the day it works on one.

---

## What will go wrong

Named up front, in rough order of likelihood.

1. **`claude` is not on PATH** for the spawned process even though it is in the
   user's shell. The single most likely bug report, and the reason for
   resolve-through-a-login-shell rather than `Command::new("claude")`.
2. **A hidden terminal gets fitted** and Claude's TUI redraws into one column.
   See [the traps](#the-traps-in-hosting-a-hidden-terminal).
3. **`/add-dir` collides with typed input**, or does not exist in the installed
   version. Mitigated by explicit-click-only, a visible note, and the restart
   fallback.
4. **The transcript path scheme changes** and tab titles go generic. By design,
   costs nothing else.
5. **Memory** with many long conversations alive, since nothing caps them.
   Bounded by a smaller scrollback than the terminal's default, and by exited
   conversations dropping their ptys — a Claude conversation's history is in the
   transcript, not in the buffer. Watch it before deciding it is fine.
6. **CLI version drift**: a flag we pass is renamed. Mitigated by passing very
   few, all of them long-established, and by `claude_probe` recording the version
   so the failure says "your Claude Code is 3.x and FigyTerm expects…" rather
   than showing a dead pane.
7. **Two conversations editing the same repo at once.** Ours to warn about, not
   to prevent: the project view should say when a folder is already live in
   another conversation.

---

## Phases

Nothing built. This is the proposed order, each phase shippable on its own.

**Phase 0 — Groundwork**
- [ ] `create_terminal_session` takes an optional program/argv/env; every existing caller unchanged
- [ ] `claude_probe`: login-shell resolution of the binary and the environment, cached, per platform
- [ ] Detection UI: found / not found / version, with a link to the install docs

**Phase 1 — One project, one conversation**
- [ ] The modal frame: `useDraggableModal`, `OverlayPortal`, overlay-stack claim, PiP/maximize — the editor's chrome, reused
- [ ] Setup dialog: primary folder prefilled from the focused pane's cwd, additional folders, no name field
- [ ] Spawn with `--session-id`, `-n basename(root)`, `--add-dir`; xterm surface; fit-on-show only
- [ ] `⌘⇧A`, the Shell menu item, the command palette entry
- [ ] Verify `/add-dir` against the installed CLI

**Phase 2 — Projects and live conversations**
- [ ] Persisted projects; the switcher (`WorkspacePicker`'s shape)
- [ ] Conversation tabs; as many ptys alive as asked for, one visible, no cap
- [ ] Reduced scrollback; an exited conversation drops its pty and keeps its buffer
- [ ] Single output listener dispatching by session id
- [ ] Window close hides, never kills; reopening lands where you left
- [ ] Quit confirmation when conversations are live, naming them

**Phase 3 — Folders as a live thing**
- [ ] The folders strip: primary folder, a chip per granted folder, `+` to add
- [ ] `/add-dir` injection with the visible note; chips reflect `launchedWith`, not the project
- [ ] Resume a conversation whose process has exited, via `--resume` in the same xterm buffer
- [ ] Resume across launches: past conversations offered on the project, history intact

**Phase 4 — Belonging to the terminal**
- [ ] Clickable `path:line:col` in Claude's output → the embedded editor
- [ ] Attention: `onBell` / `onTitleChange` → tab dot, menu badge, status bar
- [ ] Tab titles from the transcript's first user message
- [ ] "Ask Claude about this" from the editor's tree and git panel
- [ ] Conversations FigyTerm never launched, listed from `~/.claude/projects` and resumable

**Phase 5 — Docking, if picture-in-picture proves not to be enough**
- [ ] A Claude conversation as a `PaneContainer` leaf, beside a shell rather than over it
- [ ] The pane-keyed maps in `AppShell` taught about a second kind of pane
- [ ] Only on evidence, and only as its own change — see [On docking](#on-docking)

---

## Non-goals

- **Not a chat UI.** Restating it because it is the thing that will be proposed
  again in six months, and the answer will still be no. What is in the window is
  the CLI, unmodified, with FigyTerm's chrome around it.
- **No naming, renaming or removing.** A project is a folder plus the folders it
  may also touch, and both halves are decided once, in one dialog. Every feature
  that would let them be edited later is a feature that has to explain itself to
  a running conversation.
- **Not an API client.** FigyTerm never holds a key, never makes a request, never
  counts a token. Auth is `claude auth`'s.
- **No FigyTerm-side permission policy.** We do not add allow-lists, we do not
  pre-approve tools, and we do not expose `--dangerously-skip-permissions`.
  Claude's permission model is the permission model.
- **Not one OS window per project.** Tauri can do it; it doubles every piece of
  state in here and the app is a terminal, not a workspace manager.
- **No editing of the transcript directory.** Read at most, for titles.
- **Not a replacement for running `claude` in a pane.** Anyone who prefers that
  keeps it, and both can be open at once.

---

## Verification

Manual, per platform (macOS, Windows, Linux), because everything in here is a
process and a terminal:

- `claude` installed via the native installer, via npm under `nvm`, and not at
  all — resolution correct in the first two, a clear message in the third
- A project folder with a space, a quote and a `$(` in its name — argv all the
  way down means these are inert; prove it
- Start a conversation, switch project, come back mid-turn: output complete, no
  redraw damage, cursor where it should be
- Same, but with the window closed and reopened
- Window resize, drag-resize, PiP, maximize — no fit while hidden, one fit on
  show
- Add a folder mid-conversation; ask Claude to read a file in it
- Two projects on the same primary folder with different additional folders:
  both open, both named the same, told apart in the switcher by their paths
- Ten or more live conversations across several projects: memory measured, no
  cap hit, switching still instant
- Quit with conversations live: the dialog names them; quitting anyway loses no
  history, and each one resumes on the next launch
- Quit with conversations live: no hang on Windows, no orphaned processes
  anywhere
- A `path:line:col` in Claude's output opens the editor at the right line

Automated, because they are silently wrong when wrong:

- Argv construction from a project (folder set → flag list), including empty
  `extraDirs` and paths needing no escaping because there is no escaping
- `projectName`: a root with a trailing separator, a root that *is* the
  separator, a Windows drive root — none of which may produce an empty name
- The project store's load-merge: version mismatch, malformed array, missing
  field
- Transcript path derivation from a root, with the separator mangling

---

## Nothing left to decide

Every design question this document opened has been answered. For the record, in
the order they were asked and settled:

| | |
|---|---|
| The window hosts the CLI, not a chat UI | Settled |
| No project name — the primary folder's last segment is the name | Settled |
| Additional folders are add-only | Settled |
| One window, shared by every project | Settled |
| No cap on live conversations | Settled |
| No background sessions; quit stops them, the next launch resumes them | Settled |
| Modal with picture-in-picture now; docking permitted later, on evidence | Decided here |

What remains is not decisions but two facts to check against the installed CLI,
both in Phase 1 and both with a working fallback already written down:

1. **Does `/add-dir` exist and behave as assumed** in the version the user has?
   If not, adding a folder relaunches with `--resume` instead.
2. **Which notification channel does the CLI use by default**, and does a
   backgrounded conversation actually ring the terminal bell? If it doesn't,
   attention falls back to `foreground_pid()`.

So the next move is yours: this is ready to build from, or to throw out, and
both are reasonable answers to a feature this size.
