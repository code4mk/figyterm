# Windows Port — Task List

Working checklist for making FigyTerm run and ship on Windows. Rationale for each
item lives in [`WINDOWS-SUPPORT.md`](./WINDOWS-SUPPORT.md).

Status: `[x]` done · `[~]` done as far as macOS allows, needs confirming on
Windows · `[ ]` todo

Everything below marked `[x]` was written and type-checked, but **nothing has run
on Windows**. The Rust Windows branches were compiled for
`x86_64-pc-windows-msvc` in isolation (the full crate can't cross-check here —
`ring`, via the updater plugin, needs a Windows C toolchain), and the path logic
is covered by unit tests that deliberately run on any host. §9 is the part that
still needs a real box — and §8 is what running it found.

That isolation has a known blind spot, and it has already cost one round trip:
it checks the code *this port wrote*, not pre-existing code that the Windows
target newly compiles. `foreground_pid()` calling a `#[cfg(unix)]` trait method
was found by a real Windows build, not by anything here. A crate-wide audit for
other unix-only APIs (`std::os::unix`, `libc`, `nix`, `PermissionsExt`, …) came
back empty, so that was the only one — but the first real build is still the
authority.

---

## 1. Make it start

- [x] **Don't pass `-l`** — `pty.rs` spawns every shell as a POSIX login shell.
      `powershell.exe -l` isn't valid and `cmd.exe -l` is meaningless.
- [x] **Don't `env_clear()` on Windows** — a process without `SYSTEMROOT`/`windir`
      often won't start, and `PATHEXT`, `COMSPEC`, `USERPROFILE`, `APPDATA`,
      `LOCALAPPDATA` and `TEMP` are all load-bearing. Inherit, then add.
- [x] **`USERPROFILE`, not `HOME`** — `pty.rs` reads `HOME` and falls back to
      `/tmp`.
- [x] **Don't build a POSIX `PATH`** — `build_path()` is colon-separated and
      `/usr`-flavoured; `shell_exec.rs`'s `SYSTEM_PREFIXES` leaks the same list in
      via `cfg(not(macos))`.
- [x] **Prefer PowerShell over cmd** — `detect_shell()` returns `COMSPEC` first.
      Order should be `pwsh.exe`, `powershell.exe`, `cmd.exe`.

## 2. Working directory

- [x] **Recognise a drive-letter prompt in `parseCwd`** — PowerShell's default is
      `PS C:\Users\me>`, cmd's is `C:\Users\me>`; neither matches the POSIX
      pattern, so the status bar reads nothing *and* path completion resolves
      against an empty base. Same coupling that broke `cd` on Ubuntu.
- [x] **Decide on shell integration** — scraping, and not injecting anything.
      PowerShell has no `PROMPT_COMMAND`; making it emit OSC 7 would mean
      launching with `-NoExit -Command` and rewriting the user's `prompt`
      function, which is more intrusive than the problem deserves. The Windows
      prompt shape is distinctive enough to scrape reliably.

## 3. Path completion — the big one

- [x] **Drive letters and UNC** — `expand_path`/`resolve_base` treat
      `starts_with('/')` as the only absolute form.
- [x] **Both separators** — accept `\` and `/`, emit `\`.
- [x] **Case-insensitive matching** — already was: `list_path_completions`
      compares lowercased names against a lowercased prefix, so this needed
      nothing. (macOS is case-insensitive too and benefits from the same code.)

## 4. Shell features

- [x] **PowerShell history** — read
      `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`
      (one command per line). `cmd.exe` has none; that's fine.
- [x] **Hide the Oh My Zsh theme picker** — it shells out to `sh -c`, `grep`, `ls`
      and `sed -i`. Hide on Windows rather than port; Oh My Posh support is a
      feature, not a port task.

## 5. Updater

- [x] **Windows asset matching** — Tauri writes `FigyTerm_<v>_x64_en-US.msi`, so
      the arch token never matches and selection only works by falling through to
      the lone-bundle branch. Breaks as soon as an NSIS `.exe` ships beside it.
- [x] **Pick the primary artifact** — NSIS `-setup.exe` for updates, MSI for
      enterprise. The manifest should point at whichever the updater installs.

## 6. Build & release pipeline

- [x] **`build-windows` CI job** — `windows-latest`, feeding the same draft
      release.
- [x] **`latest.json` includes Windows** — a `windows-x86_64` entry with its
      `.sig`.

## 7. Documentation

- [x] **`INSTALLATION.md`** — the two installers, and SmartScreen: *"Windows
      protected your PC"* → **More info** → **Run anyway**. No `xattr` equivalent
      and no `curl` loophole; reputation accrues per binary.
- [x] **`README.md`** — three platforms, and a Windows column in the shortcut
      table (it shares Linux's `Ctrl+Shift` scheme).
- [x] **`RELEASING.md`** — the Windows job and which artifact the updater uses.
- [x] **Document the degradations** — the "a command is running" guard can't fire
      on Windows: ConPTY has no process groups, and `portable-pty` declares
      `process_group_leader` under `#[cfg(unix)]`, so `foreground_pid()` is
      `#[cfg]`-split and returns `None` there. Callers read that as idle.

## 8. Found by running it on Windows

The first real Windows run produced [`issues/issue.md`](./issues/issue.md). What
it turned up, and what was done:

- [x] **The native menu was eating the keyboard.** Tauri installs a Windows
      message hook that runs `TranslateAcceleratorW` over every menu accelerator
      *before* tao dispatches the message, and a translated message is not
      dispatched at all — so the key never reaches WebView2, and the `WM_COMMAND`
      it turns into goes to whichever HWND had focus rather than to the frame
      muda listens on. Two separate costs:

      - `PredefinedMenuItem`'s accelerators are hard-wired to `CmdOrCtrl`, which
        off macOS is bare Ctrl. The Edit menu was holding **Ctrl+C** (so no
        SIGINT), Ctrl+V, Ctrl+X, **Ctrl+A** (start of line), Ctrl+Z and Ctrl+Y
        (PSReadLine undo and yank), and Window held **Ctrl+M — which is Enter**.
      - The app's own `Ctrl+Shift+…` chords were registered twice, once in the
        menu and once in the webview, and the menu's copy won the race and then
        dropped it.

      Fix: Windows registers no accelerators and shows the chord as label text
      after a tab, the way a Win32 menu draws a shortcut hint; `shortcuts.ts` is
      the only handler there. Off macOS the Edit menu is Copy and Paste only, as
      custom items on `Ctrl+Shift+C`/`V` routed to the focused pane, and
      Minimize/Maximize are macOS-only.

- [x] **Completion emitted POSIX paths.** `acceptSuggestion` joined with `/` and
      escaped a space as `\ `, so `cd` was handed
      `re-technology\ projects/ret-frontend` — two arguments to PowerShell, and
      *"A positional parameter cannot be found"*. §3 fixed the Rust half; the
      frontend half was still POSIX-only. It now joins with `\`, quotes the path
      as a whole (single quotes for PowerShell, double for cmd), stops treating
      a backslash as an escape, and no longer reads a trailing `\` as a line
      continuation — which had been killing completion the moment you typed
      `D:\`. See `src/services/paths.ts`.

- [x] **Invisible text in the light theme.** ANSI white there is `#f8f9fb` and
      bright white is `#ffffff` — the background, and lighter than it — while
      `minimumContrastRatio` was `1`, so anything the shell printed in white was
      drawn in the background colour. The light theme now asks for WCAG AA and
      lets xterm adjust the foreground; the dark theme is unchanged.

- [x] **The app hangs and won't close.** Reported on real hardware as well as
      the VM, so this one is not the environment. Two causes, both "a blocking
      call on the UI thread", both invisible on POSIX.

      **1. `ClosePseudoConsole`.** Closing a pane dropped its `PtyInstance`
      inside `close_session`, on the main thread. That drop reaches
      `PsuedoCon::drop` → `ClosePseudoConsole`, which **blocks** until the
      attached client exits and the console drains. Three things made that as
      bad as it can get:

      - The shell was never killed. `spawn_command`'s `Child` was dropped on the
        spot and only its pid kept, so nothing ever asked `powershell.exe` to
        go. POSIX got away with it — closing the pty is a hangup and the shell
        takes SIGHUP — but Windows has no such signal, so `ClosePseudoConsole`
        waited on a shell with no reason to exit.
      - The field order dropped `master` *before* `writer`, so the pty was torn
        down while its own input handle was still open. Backwards: closing input
        first is what tells the shell its stdin has ended.
      - Nothing bounded the wait, and it ran on the thread that paints the
        window and answers the close button.

      A pane closed at an idle prompt usually came back. One closed while
      something was running did not, and the window froze with it.

      Fixed by splitting a `ChildKiller` off the child and killing the shell
      first (Windows only — POSIX keeps the hangup it already had), grouping the
      two handles into `PtyHandles` so the close order is declared and
      commented, and handing the drop to a detached thread on Windows so the
      caller cannot be held up even if the close still takes its time.

      **2. Nothing ended the shells at quit.** `TerminalManager::shutdown_all`
      existed and was never called. On POSIX process exit closes the ptys and
      the shells follow; on Windows there is no hangup and no parent-child
      lifetime link, so every tab left an orphaned `powershell.exe`. Now wired
      to `RunEvent::Exit`.

      **Also moved off the main thread** (`#[tauri::command(async)]`), because a
      synchronous Tauri command runs on it: `execute_shell_command` — which
      spawns a process on every autocomplete generator call, on a 120ms debounce
      while you type — plus `list_path_completions`, `read_shell_history`,
      `get_system_stats` and `create_terminal_session`. Each is cheap on macOS
      and measurably not on Windows. `execute_shell_command` also gained
      `CREATE_NO_WINDOW`, without which every one of those calls flashes a
      console window.

- [x] **Spec generators returned nothing.** `pnpm run <tab>` offered no scripts,
      `uv` no dependencies, and so on — everywhere the completion has to *ask
      the project* something rather than read it off the spec. Two separate
      causes, both about what counts as a program.

      **1. POSIX text utilities aren't programs on Windows.** The npm, pnpm and
      yarn script generators ran `cat package.json`; uv's ran
      `bash -c 'awk …'` and a `python3` heredoc; docker's build-target one ran
      `grep -iE 'FROM.*AS' Dockerfile`. None of `cat`, `bash`, `awk`, `python3`
      or `grep` exists there — PowerShell's `cat` is an alias, not an
      executable, and `CreateProcessW` only launches executables — so each
      returned nothing and the generator fell silent.

      None of them wanted a subprocess in the first place; they wanted the
      contents of a file. `Generator.readFile` now says so directly, backed by
      `read_project_file`, and the four generators use it. Windows gets working
      completion and every platform gets one process fewer per keystroke. The
      command takes a bare file name resolved against the pane's directory, not
      a path — covered by a test.

      **2. Node tools are `.cmd` shims.** `pnpm`, `npm` and `yarn` install as
      `pnpm.cmd` and friends, and `CreateProcessW` — so `std::process::Command`
      — searches PATH for the name and for name + `.exe` and stops. It does not
      consult `PATHEXT`, so `Command::new("pnpm")` fails outright. Anything
      calling a Node tool was affected, not just the specs shipped here.
      `resolve_program` in `shell_exec.rs` now does the PATHEXT walk and hands
      `Command` a full path; Rust runs a `.bat`/`.cmd` from there itself, and
      has escaped the arguments safely when doing so since 1.77.2.

      Two dead spawns went with them: `npmSearchGenerator` ran `echo` for an
      answer its `postProcess` always discarded, and `seedFromHistory` ran a
      four-program `sh -c` pipeline at every launch that could only fail on
      Windows — and, because a failure deliberately doesn't mark the seed done,
      failed again on the next one. That now goes through `read_shell_history`,
      which already knows about PSReadLine.

      Still POSIX-only, deliberately: `brew`'s generators shell out to `bash`
      and `sed`. Homebrew doesn't run on Windows, so there is nothing there for
      them to complete.

- [x] **Courier New.** The default font stack led with Menlo and Monaco, which
      exist only on macOS, so Windows fell through to Courier New. Defaults are
      per-platform now (Cascadia Mono on Windows, DejaVu Sans Mono on Linux).

- [x] **The embedded browser was placed with the wrong scale factor.** Once it
      opened (below), the page drew up and to the left of the modal and
      overlapped its toolbar. Measured off the report screenshot, the webview
      rect was a uniform **0.8775** of the reserved viewport — 938/1069 across,
      523/596 down, the same figure in both axes — and its position scaled about
      the window origin by the same amount, so the two rects share an origin and
      differ only by a factor.

      That factor is the whole bug. The bounds went over as CSS pixels and
      something had to turn them into device pixels; wry's `set_bounds` derives
      its own from `hwnd_dpi` on the child container HWND, and that disagreed by
      14% with the factor WebView2 had actually laid the page out at.

      `Bounds` now carries the app webview's own `devicePixelRatio` and the rect
      is converted here, going over as `PhysicalPosition`/`PhysicalSize` so no
      platform layer re-derives anything. The number cannot disagree with the
      layout when it comes from the webview that produced the layout. Linux is
      untouched — `browser_layout` places widgets in GTK's logical units, not
      device pixels, so that path keeps the CSS rect.

- [x] **The embedded browser opened no tab.** "No page loaded", `0 tabs`, `+`
      does nothing, and the address bar does nothing. The screenshot pins down
      more than it looks: no error bar means `browser_open_tab` never *rejected*
      either, so the call is not failing, it is not answering.

      Four changes, in order of how sure they are:

      1. **The address bar was inert by design.** `submitAddress` opened with
         `if (!activeTabId) return`, so with no tab, typing a URL and pressing
         Enter did nothing at all. It now opens a tab on what was typed. Certain,
         and independent of the platform — closing the last tab bricked the
         modal everywhere.
      2. **The create path failed silently.** `createTab` returned without a
         word when the viewport measured zero, and never retried. It now waits
         for layout and reports what went wrong otherwise.
      3. **A hang is now visible.** `openBrowserTab` times out at 15s rather
         than leaving the promise pending forever.
      4. **Webview creation moved off the main thread** (`#[tauri::command(async)]`).
         `Window::add_child` posts the build to the main thread and blocks for
         it, and `send_user_message` short-circuits a main-thread caller by
         running it inline — so from a sync command the build happens nested
         inside the IPC dispatch that requested it. On Windows that build is
         `webview2_com::wait_with_pump`, a reentrant `GetMessage`/`DispatchMessage`
         loop, now started from the middle of another message's handler. This is
         the hypothesis for the non-answer, and the async path is the one every
         other caller of `add_child` already uses.

      **Confirmed.** The next Windows run opened google.com in a tab, which
      makes (4) the answer: the build was deadlocking against the message pump
      it was nested inside. The remaining fault was where the page was *drawn*,
      which is the entry above.

- [x] **Modals dead to hover, focus and clicks.** Reported as all three at once,
      on every kind of modal, intermittently. All three together is the tell:
      that is not a broken handler, it is `inert`.

      Headless UI's `Dialog` — Settings, the update modal, the tab rename box —
      makes the rest of the page inert while it is open, and picks its target
      with `mainTreeNode.closest('body > *:not(#headlessui-portal-root)')`, which
      resolves to **`#root`**. It then sets the real `inert` property, not just
      `aria-hidden`. An inert subtree is skipped by hit testing and refuses
      focus.

      Every one of the app's own overlays — command palette, browser, system
      monitor, history search — was rendered inside `#root`. So with Settings
      open, all of them drew, animated, and were completely dead to the mouse.
      In the other order it was worse: a click aimed at the (inert) browser
      modal fell through to the Settings backdrop underneath and dismissed it,
      which is exactly "sometimes I can, sometimes not".

      Fix: `OverlayPortal` renders those four beside Headless UI's portal
      instead of under it. Nothing about stacking changes — the container
      declares no position or z-index. Verified against the installed
      `@headlessui/react` 2.2.10 source (`hooks/use-inert-others.js`,
      `hooks/use-root-containers.js`), not inferred.

      Not platform-specific in principle; Windows surfaced it because the menu
      accelerators there made it easy to land two overlays open at once.

## 9. Verification

- [ ] **Windows 11** — PowerShell 7.
- [ ] **Windows 10** — the ConPTY floor is 1809; PowerShell 5.1.
- [ ] **cmd.exe** as the shell, at least far enough to confirm it isn't broken.
- [ ] **HiDPI display** — display scaling is where Windows most often diverges
      from what macOS testing suggests.
- [ ] **macOS + Linux regression pass** — nothing above changed either.

---

## What's left

§8's last two entries, and §9. The original list, kept for the record —

1. **Does it start, and does the shell come up?** §1 is the part that had to be
   right for anything else to matter, and it's the least verifiable from here.
2. **Does the status bar show the directory, and does `cd ` complete?** These
   share a cause, as they did on Ubuntu, so they'll pass or fail together.
3. **Does the embedded browser work?** It should need none of the Linux
   container surgery — WebView2 honours child positioning — but "should" is
   doing real work in that sentence.
4. **Tab and pane creation.** The cursor-position race was fixed by waiting for
   layout rather than guessing, which should hold anywhere, but Windows is a
   third timing profile.
5. **A prerelease tag**, to exercise `build-windows` end to end and confirm
   `latest.json` carries `windows-x86_64`.

---

## Not Windows: stray characters left on the command line

Reported on macOS — `pnpm run dev` typed, `pnpnpm run dev` on screen, and the
leading `pn` beyond the reach of backspace.

`acceptSuggestion` used to apply every completion as
`"\x7f".repeat(token.length) + completion`: delete what it believes is there,
then retype it. That is only correct while `inputBufferRef` — this app's guess
at the line, accumulated from the keys the user pressed — still matches what the
shell is actually holding. It stops matching the moment the shell edits the line
by itself: its own Tab completion, zsh-autosuggestions accepting a ghost,
history expansion, a bracketed paste. Delete two characters of a four-character
`pnpm` and retype the whole token and the line reads `pnpnpm` — and the stray
`pn` is unreachable because the shell's buffer never had it.

Completions almost always *extend* the token they matched, so `completionEdit`
now sends the remainder and nothing else: `ev` for `d` → `dev`, a bare space for
`run` → `run`. Typing forwards can't corrupt what it never claims to know.
Backspaces remain the fallback for a substring or case-insensitive match, where
there is no forward path from one to the other.

Enter also accepted suggestions nobody asked for. Enter runs and Tab completes,
so Enter now only accepts one the user has actually narrowed down to:

- **Nothing typed to complete.** `docker ` opens a list of all fifty
  subcommands with the first selected, and accepting a suggestion re-opens the
  popup, so `docker system ` then offered `prune`. Enter meant "run this" and
  inserted a word instead.
- **Already typed in full.** The engine offers `run` for `pnpm run`, so the
  first Enter was spent adding a space and the command only went on the second.

That is also where the stray `df` in a `dfdocker` report came from: `df` is a
real suggestion — `docker system df` — inserted by an Enter that was meant to
run the line.
