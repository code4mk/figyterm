# Linux Port — Task List

Working checklist for making FigyTerm run and ship on Linux. Rationale for each
item lives in [`LINUX-SUPPORT.md`](./LINUX-SUPPORT.md).

Status: `[x]` done · `[~]` done as far as macOS allows, needs confirming on a
Linux machine · `[ ]` todo

---

## 1. Runtime correctness

- [x] **PTY session environment** — `env_clear()` stripped `DISPLAY`,
      `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` and
      friends, which would have broken `xdg-open`, GUI editors, clipboard tools
      and `systemctl --user` from inside FigyTerm. Now passed through via
      `SESSION_PASSTHROUGH`. `src-tauri/src/terminal/pty.rs`
- [x] **PTY default PATH** — `build_path()` adds `/usr/games` off macOS and
      appends whatever the session already had, so Nix and Homebrew-on-Linux
      prefixes survive `env_clear()`. macOS keeps its fixed list (`path_helper`
      rebuilds it anyway). `src-tauri/src/terminal/pty.rs`
- [x] **`shell_exec` Homebrew paths** — `/opt/homebrew/*` is now behind
      `SYSTEM_PREFIXES`, macOS-only. `src-tauri/src/commands/shell_exec.rs`

## 2. Embedded browser

- [~] **Child webview bounds on WebKitGTK** — the macOS autoresize fix is an
      `NSView` quirk; under GTK the child sits in a fixed container that doesn't
      resize its children, so there should be nothing to undo. Reasoned, not
      measured — the comment at `src-tauri/src/commands/browser.rs` records what
      to look for.
- [x] **Runtime spike on Linux** — done, and it failed: the site rendered
      outside the modal entirely. Cause is upstream (see §8), and the modal is
      now hidden on Linux.

## 3. Updater

- [x] **AppImage asset matching** — `asset_for_current_target()` selects by
      platform bundle extension (`.dmg` / `.AppImage`) and accepts both
      architecture spellings (`x64`/`amd64`, `aarch64`/`arm64`).
      `src-tauri/src/updater/mod.rs`
- [x] **Install-flavour detection** — `install_method()` returns `SelfUpdating`
      for a macOS bundle or a running AppImage (`APPIMAGE` is set), `Managed`
      otherwise. Surfaced to the UI as `UpdateInfo.installMethod`.
- [x] **Update UI respects notify-only** — a managed install gets a card
      explaining that its files belong to the package manager, plus a download
      link. No Install button, no manual-install toggle.
      `src/components/Updates/UpdateModal.tsx`

## 4. Build & release pipeline

- [x] **`build-linux` CI job** — `ubuntu-22.04` for the glibc floor, WebKitGTK
      system deps, `APPIMAGE_EXTRACT_AND_RUN` for the FUSE-less runner, feeding
      the same draft release. `.github/workflows/release.yml`
- [x] **`latest.json` includes Linux** — the manifest step now builds entries
      through an `add_platform` helper and carries `linux-x86_64` pointing at the
      AppImage.
- [x] **Version sync deduplicated** — both build jobs run
      `scripts/sync-version.mjs` instead of keeping two copies of the same
      inline script.

## 5. Packaging & install

- [x] **512×512 icon** — `icons/icon.png` (already 512) and `icons/64x64.png`
      added to the bundle icon list; Linux app grids had nothing above 128px.
- [x] **`.desktop` metadata** — `src-tauri/linux/figyterm.desktop` supplies
      `Categories=System;TerminalEmulator;` and keywords, wired up through
      `bundle.linux.deb.desktopTemplate` (the AppImage bundler builds on the deb
      output, so it inherits this).
- [x] **`install-linux.sh`** — fetches the AppImage, installs to
      `~/.local/bin/figy-term` under a stable name, extracts the icon and writes
      a desktop entry. `install.sh` now redirects Linux users to it.
- [ ] **`StartupWMClass`** — deliberately omitted until the real WM class is
      known; a wrong value breaks icon grouping worse than an absent one.

## 6. Frontend / UX

- [x] **One shortcut table** — `src/services/shortcuts.ts` is now the single
      source for bindings and labels, mirrored by `accel()` in
      `src-tauri/src/menu.rs`. The 37 hardcoded `⌘` glyphs are gone.
- [x] **Linux keymap is `Ctrl+Shift`, not `Ctrl`** — the bigger finding. Every
      handler tested `metaKey || ctrlKey`, so on Linux the app would have
      swallowed `Ctrl+D` (EOF), `Ctrl+K` (kill line), `Ctrl+R` (reverse-search)
      and `Ctrl+W` (delete word) before the shell saw them. App shortcuts now
      take `Ctrl+Shift` as in GNOME Terminal and Konsole, with `Ctrl+Alt` for the
      two chords that would otherwise collide (`⌘⇧T`, `⌘⇧D`).
- [x] **`metaKey`-only handlers** — history search and paste went through the
      table. Paste is performed explicitly off macOS, since `Ctrl+Shift+V` isn't
      a chord the webview acts on by itself.
- [x] **`Ctrl+C` always interrupts** — it used to be swallowed as "copy" whenever
      a selection existed. Copy is `⌘C` / `Ctrl+Shift+C` now; `Ctrl+C` reaches
      the shell on both platforms.
- [x] **Shortcut list honesty** — Quit / Minimise / Fullscreen are listed only on
      macOS. They're app-menu bindings there; on Linux the window manager owns
      them and the keys vary by desktop.
- [ ] **GTK menubar** — the app menu renders inside the window on Linux, eating
      terminal rows. Decide whether to keep it or hide it and lean on the command
      palette. Needs eyes on a real desktop.

## 7. Documentation

- [x] **`INSTALLATION.md`** — Linux section covering AppImage, deb and rpm, the
      `WEBKIT_DISABLE_DMABUF_RENDERER=1` blank-window workaround, where files
      live, and uninstalling.
- [x] **`README.md`** — no longer says macOS only; the shortcut table has a Linux
      column and explains why it isn't plain `Ctrl`.
- [x] **`RELEASING.md`** — documents `build-linux`, why the runner is pinned to
      22.04, and the AppImage-only update constraint.
- [x] **`UPDATE-SYSTEM.md`** — new section on where the update model forks by
      install format.
- [x] **Release notes template** — the workflow's rendered notes now include
      Linux install instructions.

## 8. Found on Ubuntu 22.04 (first real run)

- [x] **Status-bar path showed escape codes** — the footer read
      `~\x1b[01;32mubuntu@ubuntu\x1b[00m…`. cwd was scraped from the raw PTY
      stream, and Ubuntu's default bash PS1 sets a window title *and* colours the
      prompt, so the path pattern ran straight through both. `parseCwd()` in
      `Terminal.tsx` now strips OSC/CSI before scraping and prefers OSC 7.
- [x] **`cd ` offered no completions** — same root cause, not a second bug: the
      bad cwd was the base directory path suggestions resolve against, so
      `list_path_completions` errored and the popup stayed empty.
- [x] **bash now reports its directory** — `pty.rs` exports a `PROMPT_COMMAND`
      that emits OSC 7, so Linux no longer depends on scraping at all. Verified
      against bash on a PTY: it runs the inherited value and re-emits on `cd`.
      A user config that sets its own `PROMPT_COMMAND` replaces it, which is what
      the scraping fallback is still there for.
- [x] **Embedded browser renders outside the modal** — the chrome drew in the
      right place but the site was positioned below the window, ignoring the
      bounds we set. Not our bug and not fixable here:
      [tauri#10420](https://github.com/tauri-apps/tauri/issues/10420) — child
      webview positioning is broken on Linux/GTK, still open. wry places a child
      webview as a separate X11 window and moves it with `gtk_window.move_()`,
      which doesn't land in parent-relative coordinates.
      **Resolution:** hidden on Linux rather than shipped broken —
      `EMBEDDED_BROWSER_SUPPORTED` in `src/services/platform.ts` gates the
      modal, the palette entry, the shortcut and the settings row, and
      `menu.rs` drops the menu item. Revisit when that issue closes; the
      `#[cfg]`/flag pair is the only thing to remove.

## 9. Verification

- [x] **macOS regression pass** — `cargo check`, `cargo test --lib`, `tsc
      --noEmit` and `npm run build` all clean after the changes.
- [ ] **Ubuntu 22.04** — glibc floor, GNOME/Wayland. First real run.
- [ ] **Fedora** — recent WebKitGTK.
- [ ] **A tiling WM** — window sizing and decorations.
- [ ] **Tag a prerelease** — exercises `build-linux` end to end and proves
      `latest.json` carries `linux-x86_64`.

---

## What's left, in order

1. Run it on Ubuntu 22.04 — everything below waits on this.
2. Spike the browser modal (§2), the only item that could still change the plan.
3. Judge the GTK menubar (§6) with the app in front of you.
4. Tag a prerelease and confirm the pipeline and the updater manifest.
