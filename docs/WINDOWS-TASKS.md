# Windows Port — Task List

Working checklist for making FigyTerm run and ship on Windows. Rationale for each
item lives in [`WINDOWS-SUPPORT.md`](./WINDOWS-SUPPORT.md).

Status: `[x]` done · `[~]` done as far as macOS allows, needs confirming on
Windows · `[ ]` todo

Everything below marked `[x]` was written and type-checked, but **nothing has run
on Windows**. The Rust Windows branches were compiled for
`x86_64-pc-windows-msvc` in isolation (the full crate can't cross-check here —
`ring` needs a Windows C toolchain), and the path logic is covered by unit tests
that deliberately run on any host. §8 is the part that still needs a real box.

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
      on Windows (ConPTY has no process groups, so `foreground_pid()` always
      returns `None`, which reads as idle).

## 8. Verification

- [ ] **Windows 11** — PowerShell 7.
- [ ] **Windows 10** — the ConPTY floor is 1809; PowerShell 5.1.
- [ ] **cmd.exe** as the shell, at least far enough to confirm it isn't broken.
- [ ] **HiDPI display** — display scaling is where Windows most often diverges
      from what macOS testing suggests.
- [ ] **macOS + Linux regression pass** — nothing above changed either.

---

## What's left

Only §8: running it. In order of what's most likely to be wrong —

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
