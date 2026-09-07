# Linux Support

An assessment of what it would take to ship FigyTerm on Linux, written against the
code as it stands. Nothing here is implemented yet — this is the plan.

Related: [`RELEASING.md`](./RELEASING.md) (the pipeline that would need a Linux job),
[`UPDATE-SYSTEM.md`](./UPDATE-SYSTEM.md) (the updater that would need a Linux path),
[`INSTALLATION.md`](./INSTALLATION.md) (macOS install docs).

---

## Verdict

**Yes, this ports.** Roughly 80–85% of the codebase is already platform-neutral, and
the macOS-specific parts are mostly `#[cfg]`-gated rather than tangled through the
core. The Rust foundation — PTY, shell detection, filesystem, system stats, history
parsing — needs almost nothing.

The work is not in the app. It's in the **shipping pipeline** (build, package,
update, install) and in one high-risk feature (the embedded browser). Expect a
usable Linux build in a few days of focused work, and a *well-behaved* one — one
that doesn't feel like a mac app wearing a Linux costume — in one to two weeks.

One nice side effect: Linux has no Gatekeeper, no notarization, no Developer ID.
The entire category of pain documented in `INSTALLATION.md` simply doesn't exist.

---

## What already works, unchanged

| Area | Where | Why it's fine |
|------|-------|---------------|
| PTY backend | `src-tauri/src/terminal/pty.rs:20` | `portable-pty`'s `native_pty_system()` uses `openpty(3)` on Linux. This is the riskiest-sounding part and it's a non-issue. |
| Shell detection | `src-tauri/src/commands/terminal.rs:13` | Already `cfg(any(macos, linux))`, reads `$SHELL`, falls back through `/bin/zsh`, `/bin/bash`, `/bin/fish`, `/bin/sh`. |
| System monitor | `src-tauri/src/commands/system.rs` | `sysinfo` supports Linux CPU/memory natively. |
| Shell history | `src-tauri/src/commands/autocomplete.rs:161` | `~/.zsh_history` / `~/.bash_history` are the same paths on Linux. |
| Spec + icon storage | `src-tauri/src/commands/specs.rs:7` | `~/.figyterm/` is POSIX. Works as-is (see *XDG* under polish). |
| Oh My Zsh integration | `src/components/Settings/Settings.tsx:102` | `~/.oh-my-zsh` is the same on Linux. |
| App menu | `src-tauri/src/menu.rs:185-250` | Already has `cfg(not(macos))` branches, and every accelerator is `CmdOrCtrl+…` rather than `Cmd+…`. |
| Objective-C deps | `src-tauri/Cargo.toml` | `objc2` / `objc2-app-kit` are already `[target.'cfg(target_os = "macos")']`-gated, so a Linux build won't even try to pull them. |
| Bundling | `src-tauri/tauri.conf.json` (`"targets": "all"`) | On Linux this already means `.deb` + `.rpm` + `.AppImage`. No config change needed. |
| Opening URLs | `src/components/Terminal/Terminal.tsx:534` | `tauri-plugin-shell`'s `open` shells out to `xdg-open` on Linux. |

---

## Blockers — must be done before a Linux release

### 1. No Linux build job in CI

`.github/workflows/release.yml` has exactly one build job: `build-macos`, matrixed
over `aarch64-apple-darwin` and `x86_64-apple-darwin`. A `build-linux` job needs to
be added alongside it, feeding the same draft release.

Two things to get right:

- **System dependencies.** WebKitGTK isn't preinstalled. The job needs
  `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`, `libssl-dev`, `libxdo-dev`, `build-essential`, `curl`, `wget`,
  `file`, `patchelf`.
- **glibc floor.** Build on the *oldest* runner you're willing to support, not
  `ubuntu-latest`. A binary built against glibc 2.39 will not start on Debian 12 or
  Ubuntu 22.04. `ubuntu-22.04` (glibc 2.35) is the sensible floor and covers
  Debian 12, Ubuntu 22.04+, and current Fedora.

`aarch64` Linux can wait. Cross-compiling Tauri for ARM Linux needs a sysroot and
is disproportionate effort for the audience; ship `x86_64` first.

### 2. The updater only knows about `.dmg`

`src-tauri/src/updater/mod.rs:120-143` picks the download asset by matching
architecture suffixes against filenames ending in `.dmg`, and rejects everything
else. On Linux it would find no candidate at all.

There's a second, sharper constraint behind that: **Tauri's built-in updater on
Linux only supports AppImage.** A `.deb` or `.rpm` install has no in-place update
path — the binary lives in `/usr/bin` and is owned by the package manager, which the
app can't and shouldn't write to.

So the update story has to fork by install method:

| Install method | Update path |
|---|---|
| AppImage | Full in-app auto-update, same as macOS today |
| `.deb` / `.rpm` | Detect, then *notify only* — show the release, link out, don't offer a one-click install |

Practically: teach `pick_asset` an AppImage branch, and detect the install flavor at
runtime (the `APPIMAGE` env var is set inside a running AppImage — that's the
reliable signal) to decide whether the update button installs or just informs.

### 3. `install.sh` is macOS-only

It's `hdiutil`, `/Applications`, and a Gatekeeper-avoidance rationale that has no
Linux equivalent. Either add a platform branch at the top or ship a separate
`install-linux.sh` that fetches the AppImage, drops it in `~/.local/bin`, and writes
a `.desktop` entry. The second is cleaner — the two scripts share almost nothing.

### 4. The embedded browser is the real unknown

This is the one feature that could genuinely fail, and it deserves a spike before
anything else is committed to.

`src-tauri/src/commands/browser.rs` builds child webviews (Tauri's `unstable`
multi-webview feature) and pins them with macOS-native calls:

- `configure_child_webview` (`browser.rs:224`) sends `setAutoresizingMask: 0` to the
  `WKWebView` so it stops growing over the React chrome. On Linux this compiles to
  an empty function — the comment at `browser.rs:222` describes the exact bug that
  will reappear, unaddressed, under WebKitGTK.
- `apply_native_webview_theme` (`browser.rs:197`) is likewise a no-op on Linux, so
  the browser's native scrollbars and form controls won't follow the app theme.
  The injected-JS `color-scheme` path still runs, so this is cosmetic.
- `USER_AGENT` is `None` on non-macOS (`browser.rs:30`), which is correct — WebKitGTK
  sends a sane UA already.

Verify early, in this order: (a) does the child webview respect explicit bounds and
sit *under* the React chrome, (b) does it clip correctly on resize, (c) does video
play. If child-webview positioning turns out to be unworkable on WebKitGTK, the
fallback is to ship Linux with the browser modal hidden rather than broken.

### 5. WebKitGTK blank-window class of bug

Not a code defect, but it will generate issues on day one. On some GPU/driver
combinations (Nvidia proprietary especially) WebKitGTK renders a blank or black
window until DMA-BUF rendering is disabled:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 figyterm
```

Document this prominently, and consider setting it in the shipped `.desktop` `Exec=`
line — the compositing cost is minor next to a black window on first launch.

---

## Polish — needed for it to feel native, not required to launch

### The `⌘` glyphs are hardcoded

37 occurrences across `Settings.tsx`, `StatusBar.tsx`, `TabBar.tsx`,
`AppShell.tsx`, and `CommandPalette.tsx`. The *bindings* are fine — the keyboard
handlers already check `e.metaKey || e.ctrlKey` (`AppShell.tsx:326`,
`BrowserModal.tsx:340`) and the menu uses `CmdOrCtrl`. It's only the labels that
lie, telling a Linux user to press a key their keyboard doesn't have.

Fix once, centrally: a small `mod`/`alt`/`shift` glyph module that resolves to
`⌘/⌥/⇧` on macOS and `Ctrl/Alt/Shift` elsewhere, then replace the literals.

Two of the shortcut handlers are also `metaKey`-only and would be dead on Linux —
`⌘R` history search (`Terminal.tsx:555`) and `⌘V` paste (`Terminal.tsx:567`).

### `env_clear()` strips the Linux session environment

`src-tauri/src/terminal/pty.rs:47-66` deliberately starts the shell from a clean
environment "like Terminal.app does", then re-adds a fixed allowlist: `HOME`,
`USER`, `SHELL`, `PATH`, `LANG`, `TERM`, and a few others.

On macOS that's a reasonable imitation of Terminal.app. On Linux it's a real bug:
it also drops `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`,
`DBUS_SESSION_BUS_ADDRESS`, `XAUTHORITY`, and `XDG_SESSION_TYPE`. Any command that
touches the GUI or the session bus — `xdg-open`, `code .`, `firefox`,
`systemctl --user`, `notify-send`, clipboard tools — will fail from inside FigyTerm
while working fine in every other terminal. That's the kind of thing that gets the
app written off as broken.

Add a Linux-gated passthrough for those variables. The hardcoded
`/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin` PATH
(`pty.rs:52`) should also gain `/usr/games` and, more importantly, not clobber Nix
or Homebrew-on-Linux setups — prefer inheriting `PATH` and appending, over
replacing it outright.

### Homebrew paths in `shell_exec`

`src-tauri/src/commands/shell_exec.rs:34` injects `/opt/homebrew/bin` and
`/opt/homebrew/sbin`. Harmless on Linux (they just don't exist) but it should be
`cfg`-gated so the intent stays readable.

### XDG directories

`~/.figyterm/specs` works, but Linux convention is
`$XDG_CONFIG_HOME/figyterm` / `$XDG_DATA_HOME/figyterm`. Worth doing eventually,
with a migration for anyone who started on the dotdir. Low priority — a dotdir in
`$HOME` offends nobody.

### Icons and desktop entry

`src-tauri/icons/` has 32, 64, 128, 128@2x, `.icns`, `.ico` — but no 512×512, which
Linux desktops want for app grids and dock/alt-tab. Regenerate with
`npm run tauri icon` from a 1024×1024 source. The `.desktop` file also needs
`Categories=System;TerminalEmulator;` and `Keywords=`, and ideally registration as
an x-terminal-emulator alternative so other apps can launch it.

### GTK menubar

`menu.rs` builds a full app menu. On macOS that's the system bar; on Linux GTK
renders it as a menubar *inside the window*, eating vertical space at the top of a
terminal. Check how it looks, and consider hiding it on Linux and moving Preferences
and Check for Updates into the existing command palette.

---

## Distribution

**Ship AppImage as the primary artifact.** It's the only Linux format that supports
the in-app auto-update this app is built around, it's distro-agnostic, and it needs
no root. `.deb` second, for the Debian/Ubuntu majority who'd rather use `apt`.
`.rpm` third — Tauri produces it for free, so there's no reason not to publish it.

An AUR `PKGBUILD` is worth encouraging but should be community-maintained, not
something the release pipeline owns.

**Skip Flatpak, at least initially.** A terminal emulator is close to the worst fit
for the Flatpak sandbox: the entire point is spawning arbitrary host processes with
the user's real environment, which means `--filesystem=host`, `--talk-name=…`, and
enough holes that the sandbox stops meaning anything. It's a lot of packaging work
to arrive at a worse product. Snap has the same problem.

---

## Suggested order of work

1. **Spike the child webview on Linux** (half a day). This is the only thing that
   could change the plan. Run `npm run tauri dev` in a VM, open the browser modal,
   resize. Everything below assumes it works — or that it's been cut for Linux.
2. **Add `build-linux` to the release workflow** on `ubuntu-22.04`. Get artifacts
   appearing on a draft release.
3. **Fix the PTY environment** — the `env_clear` passthrough. Cheap, and it's the
   difference between "works" and "feels broken".
4. **Teach the updater about AppImage**, plus deb/rpm notify-only detection.
5. **Platform-aware modifier labels** and the two `metaKey`-only handlers.
6. **Icons, `.desktop` metadata, `install-linux.sh`**, and a Linux section in
   `INSTALLATION.md` (including the `WEBKIT_DISABLE_DMABUF_RENDERER` note).
7. **Test on three targets** — Ubuntu 22.04 (glibc floor + GNOME/Wayland),
   Fedora (recent WebKitGTK), and one tiling WM (window sizing). That combination
   catches most of what actually breaks.

Steps 2–3 alone get you a build people can run. The rest is what stops it feeling
like a port.
