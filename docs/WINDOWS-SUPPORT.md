# Windows Support

An assessment of what it would take to ship FigyTerm on Windows, written against
the code as it stands. Nothing here is implemented yet — this is the plan.

Related: [`WINDOWS-TASKS.md`](./WINDOWS-TASKS.md) tracks the work.
[`LINUX-SUPPORT.md`](./LINUX-SUPPORT.md) is the same document for the Linux port,
which is worth reading first — not because the problems are the same, but
because they are almost entirely different, and that difference is the point.

---

## Verdict

**It will run, and that's the easy part.** The Rust core is genuinely portable:
`portable-pty` speaks ConPTY on Windows, `sysinfo` works, `main.rs` already
carries `windows_subsystem = "windows"`, `bundle.targets: "all"` already emits an
MSI and an NSIS installer, and the embedded browser should work *without* the
container surgery Linux needed — Tauri positions child webviews correctly on
WebView2, so `browser_layout.rs` stays Linux-only.

**The hard part is that Windows doesn't share macOS's assumptions.** The Linux
port was mostly packaging plus two runtime bugs, because Linux and macOS are both
POSIX: same `$HOME`, same `/` paths, same `$SHELL`, same `-l` login flag, same
`~/.bash_history`. Windows breaks every one of those, and they're threaded
through the parts of FigyTerm that make it FigyTerm — the autocomplete engine
resolves paths, the status bar scrapes a POSIX prompt, the theme picker shells
out to `grep` and `sed`.

So: a week or so to a build that runs and feels right, with one feature (the Oh
My Zsh theme picker) that has no Windows meaning and should be hidden rather than
ported. Set against Linux, expect *less* packaging work and *more* core work.

On the "OS-agnostic" framing: macOS and Linux agreeing is mostly POSIX doing the
work. Windows is the real test of whether the abstractions hold.

---

## What already works, unchanged

| Area | Where | Why it's fine |
|------|-------|---------------|
| PTY backend | `src-tauri/src/terminal/pty.rs` | `portable-pty` uses ConPTY on Windows 10 1809+. The same call, a completely different implementation underneath. |
| No console window | `src-tauri/src/main.rs:1` | `windows_subsystem = "windows"` is already there, so no stray console flashes at launch. |
| Bundling | `tauri.conf.json` (`"targets": "all"`) | Already means MSI (WiX) + NSIS `-setup.exe` on Windows. |
| Embedded browser | `src-tauri/src/commands/browser.rs` | Tauri uses `build_as_child` on Windows, and WebView2 honours child positioning — the thing that's broken on GTK. Should behave like macOS. |
| System monitor | `src-tauri/src/commands/system.rs` | `sysinfo` supports Windows CPU/memory. |
| Keyboard shortcuts | `src/services/shortcuts.ts` | `platform.ts` already detects `windows` and gives it the `Ctrl+Shift` scheme — which is also Windows Terminal's convention, so this lands right by accident of doing Linux properly. |
| Paste | `src/components/Terminal/Terminal.tsx` | The `!isMac` branch performs the paste explicitly, which is what `Ctrl+Shift+V` needs on Windows too. |
| Home directory | `src-tauri/src/filesystem/operations.rs:62` | Already has a `USERPROFILE` branch. |
| Shell detection | `src-tauri/src/commands/terminal.rs:25` | Already has a Windows branch — though it picks the wrong shell; see below. |
| Icons | `src-tauri/icons/icon.ico` | Present and already in the bundle icon list. |
| Signing | — | No notarization equivalent to fight. SmartScreen warns on an unsigned installer but doesn't refuse; see *Distribution*. |

---

## Blockers — must be fixed before Windows runs properly

### 1. The shell is spawned as a POSIX login shell

`pty.rs` does `cmd.args(&["-l"])` unconditionally. `-l` is a POSIX login-shell
flag; `powershell.exe -l` is not valid and `cmd.exe -l` means nothing. This has
to be POSIX-only.

### 2. `env_clear()` is fatal on Windows

`pty.rs` clears the environment and re-adds a POSIX allowlist (`HOME`, `USER`,
`SHELL`, `PATH`, `LANG`, `TERM`…). On macOS that imitates Terminal.app; on Linux
it cost us the session variables (already fixed). On Windows it's worse than
either: a process with no `SYSTEMROOT`/`windir` frequently fails to start at all,
and `PATHEXT`, `COMSPEC`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and `TEMP` are
all load-bearing. The Windows path should inherit the environment and add only
what we want on top.

`HOME` doesn't exist on Windows either — it's `USERPROFILE` — and the current
fallback is `/tmp`.

### 3. `build_path()` builds a POSIX `PATH`

Colon-separated, `/usr/local/bin`-flavoured. Windows separates with `;` and shares
none of those directories. `shell_exec.rs` has the same problem: its
`SYSTEM_PREFIXES` is `#[cfg(not(target_os = "macos"))]`, so the POSIX list leaks
into the Windows build.

### 4. The wrong shell wins

`detect_shell()` returns `COMSPEC` first, which is `cmd.exe`. A terminal aimed at
developers should prefer `pwsh.exe` (PowerShell 7), then `powershell.exe`, then
`cmd.exe` — and let the setting override it.

### 5. Working-directory detection doesn't recognise a Windows prompt

`parseCwd()` looks for OSC 7, then for a path starting `~` or `/` followed by one
of `] $ % # >`. PowerShell's default prompt is `PS C:\Users\me>` and cmd's is
`C:\Users\me>` — neither matches, so the status bar will read nothing and, worse,
path completion will resolve against an empty base directory. Same coupling that
made `cd` completion fail on Ubuntu.

PowerShell has no `PROMPT_COMMAND`, so the OSC 7 trick from the Linux port
doesn't transfer; injecting a `prompt` function would mean `-NoExit -Command`,
which is intrusive. Scraping a drive-letter prompt is the realistic route.

### 6. Path completion assumes POSIX paths

`autocomplete.rs`'s `expand_path`/`resolve_base` treat `/` as the only separator
and `starts_with('/')` as "absolute". Windows needs drive letters (`C:\`), UNC
paths (`\\server\share`), backslash separators, and case-insensitive matching.
This is the biggest single chunk of work in the port, and it matters most: path
autocomplete is the product.

### 7. Shell history is read from the wrong place

`read_shell_history()` reads `~/.zsh_history` then `~/.bash_history`. PowerShell
keeps its history in
`%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`, one
command per line. `cmd.exe` keeps none at all.

### 8. The Oh My Zsh theme picker can't work

`Settings.tsx` shells out to `sh -c`, `grep`, `ls` and `sed -i` against
`~/.zshrc` and `~/.oh-my-zsh`. None of that exists on Windows. This should be
hidden on Windows, not ported — Oh My Posh is the analogue, and wiring it up is a
feature, not a port task.

### 9. Updater asset matching will miss

`BUNDLE_EXT` is `.msi` off macOS and Linux, and the arch match expects a name
ending `x64.msi`. Tauri actually writes `FigyTerm_0.1.0_x64_en-US.msi` — the
locale suffix means the arch token never matches, and selection only works by
falling through to the "a lone unsuffixed bundle is safe" branch. That's working
by accident, and it breaks the moment an NSIS `.exe` is published alongside it.

### 10. No `build-windows` job

`.github/workflows/release.yml` has `build-macos` and `build-linux`.
`latest.json` needs a `windows-x86_64` entry too.

---

## Degradations worth accepting

- **"A command is running" check.** `PtyInstance::foreground_pid()` compares the
  tty's foreground process group against the shell's pid. ConPTY has no process
  groups, so this returns `None` — which the code already treats as idle. The
  practical effect is that the confirmation before restarting to install an
  update won't fire on Windows. Safe direction (a missed prompt, not a wrong
  action), but it should be documented rather than discovered.
- **Spec storage.** `~/.figyterm` becomes `%USERPROFILE%\.figyterm`, which works
  but isn't idiomatic — `%APPDATA%\figyterm` is. Same call as the XDG question on
  Linux, and the same answer: low priority.
- **`-l` semantics.** A POSIX login shell sources profile files; PowerShell always
  loads its profile unless told not to. Close enough that nobody will notice.

---

## Distribution

**Ship the NSIS `-setup.exe` as the primary artifact.** It supports per-user
installation without admin rights, it's what Tauri's updater handles most
cleanly, and it's a smaller download. Publish the **MSI** alongside it for
enterprise deployment (GPO, Intune), which is the one thing NSIS can't do.

**SmartScreen is the Windows version of the Gatekeeper problem**, and it's worth
being upfront about it in the docs the way `INSTALLATION.md` already is for macOS.
An unsigned installer shows *"Windows protected your PC"* with the Run-anyway
button hidden behind **More info**. Unlike Gatekeeper there's no `xattr` trick and
no `curl` loophole — reputation accrues per-binary as downloads accumulate, and a
standard code-signing certificate doesn't bypass it (only an EV certificate gets
instant reputation, at a price that isn't worth it yet).

**winget** is the natural Windows equivalent of the install script, and a manifest
is cheap to submit once there are signed, stable releases. A PowerShell
`install.ps1` is possible but pointless next to winget.

**x86_64 first.** Windows on ARM is a real audience now, but cross-building it is
disproportionate effort for the current userbase — same call as `aarch64` Linux.

---

## Suggested order of work

1. **Make the PTY spawn Windows-correct** (§1–4). Without this nothing runs, and
   it's a contained change to two files.
2. **Fix `parseCwd` for drive-letter prompts** (§5). Cheap, and it unblocks the
   status bar *and* path completion together — the same coupling as Ubuntu.
3. **Windows path handling in autocomplete** (§6). The big one. Drive letters,
   both separators, case-insensitive matching.
4. **PowerShell history** (§7) and **hide the theme picker** (§8).
5. **Updater asset matching** (§9), then the **`build-windows` CI job** (§10) and
   the `windows-x86_64` manifest entry.
6. **Docs**: a Windows section in `INSTALLATION.md` covering the two installers
   and SmartScreen, plus `README.md` and `RELEASING.md`.
7. **Test on Windows 10 and 11**, with PowerShell 7, PowerShell 5.1 and cmd.exe,
   and on a HiDPI display — the display-scaling path is the one that most often
   differs from what testing on macOS suggests.

Steps 1–2 get you something that starts and tracks its directory. Step 3 is what
makes it *FigyTerm* rather than a terminal that happens to run on Windows.
