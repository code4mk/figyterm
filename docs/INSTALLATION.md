# Installing FigyTerm

macOS on Apple Silicon and Intel, Linux on x86_64, and Windows on x64.

On **macOS** there are two ways to install, and they produce the same app:

| | [Install script](#option-1--install-script) | [Manual .dmg](#option-2--manual-dmg) |
|---|---|---|
| Steps | one command | download, drag, one command |
| Security dialog | none | "damaged" / "unidentified developer" |
| `xattr` needed | no | yes |
| Picks your architecture | automatically | you choose |

On **Linux** there are three formats — see [Linux](#linux) below. The AppImage updates
itself; a `.deb` or `.rpm` belongs to your package manager, so FigyTerm will tell you
when a new version exists but leave installing it to you.

On **Windows** there are two — see [Windows](#windows) below. The `-setup.exe` updates
itself; the `.msi` is for managed deployment and doesn't.

Except for those managed packages, **you only install once** — FigyTerm updates itself
from then on.

---

## Option 1 — install script

```bash
curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install.sh | sh
```

That's it. The script detects whether you're on Apple Silicon or Intel, downloads the
matching build from the latest GitHub release, and installs it to `/Applications`.

You should read anything you pipe into a shell — [here's the script](../install.sh). It
touches exactly two things: a temporary directory, and `FigyTerm.app` in your
applications folder.

### Options

```bash
# Install a specific version
FIGYTERM_VERSION=v0.1.0 sh -c "$(curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install.sh)"

# Install somewhere other than /Applications
FIGYTERM_INSTALL_DIR="$HOME/Applications" sh -c "$(curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install.sh)"
```

### What it does

1. Checks you're on macOS and picks `aarch64` or `x64` from `uname -m`
2. Resolves the latest release tag from the GitHub API
3. Downloads that `.dmg` with `curl`
4. Mounts it at a **private** mountpoint (so it can't collide with a `FigyTerm` volume
   you already have mounted)
5. Removes any previous `FigyTerm.app`, copies the new one in
6. Clears extended attributes as a belt-and-braces measure
7. Unmounts and cleans up — including on every failure path

It will **refuse to run** if FigyTerm is currently open, rather than replacing an app
with live terminal sessions in it. Quit FigyTerm and run it again.

If your install directory isn't writable it will ask for your password via `sudo`.

---

## Option 2 — manual .dmg

1. Go to [Releases](https://github.com/code4mk/figyterm/releases) and download the build
   for your Mac:
   - **Apple Silicon** (M1/M2/M3/M4) — `FigyTerm_x.x.x_aarch64.dmg`
   - **Intel** — `FigyTerm_x.x.x_x64.dmg`

   Not sure which? Run `uname -m` — `arm64` means Apple Silicon, `x86_64` means Intel.

2. Open the `.dmg` and drag **FigyTerm** into **Applications**.

3. **Clear the quarantine flag.** This step is not optional:

   ```bash
   xattr -cr /Applications/FigyTerm.app
   ```

4. Launch FigyTerm from Applications or Spotlight.

If macOS still blocks it, open **System Settings → Privacy & Security**, scroll down,
and click **Open Anyway**. On macOS 15 (Sequoia) and later this is the only route —
Apple removed the old right-click → Open shortcut.

---

## Why the extra step exists

FigyTerm isn't code-signed with an Apple Developer ID, which costs $99/year.

macOS attaches a `com.apple.quarantine` attribute to downloaded files, and refuses to
open a quarantined app that has no recognised signature. The important detail is **who**
attaches it: the *downloading application*. Browsers do. `curl`, `git` and Homebrew
don't.

That's the whole difference between the two options. The script isn't doing anything
clever or bypassing a security check — it just isn't a browser, so the flag is never
set in the first place. `xattr -cr` in Option 2 removes the flag after the fact, which
is the same end state.

**This only affects your first install.** FigyTerm's built-in updater downloads over
HTTP rather than through a browser, so updates are never quarantined. You'll never see
a Gatekeeper prompt or type `xattr` again.

---

## Linux

x86_64 only for now. Everything above about Gatekeeper, quarantine and `xattr` is
macOS-specific and has no Linux equivalent — there's nothing to clear.

### AppImage (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install-linux.sh | sh
```

The script downloads the AppImage, installs it to `~/.local/bin/figy-term`, and adds a
desktop entry so it shows up in your app menu. As with any piped script,
[read it first](../install-linux.sh) — it touches a temp directory, that install
directory, and one `.desktop` file.

By hand instead:

```bash
chmod +x FigyTerm_*_amd64.AppImage
./FigyTerm_*_amd64.AppImage
```

This is the build to pick if you want the in-app updater: it's the only Linux format
Tauri's updater can replace in place.

### Debian, Ubuntu

```bash
sudo apt install ./FigyTerm_*_amd64.deb
```

### Fedora, RHEL

```bash
sudo dnf install ./FigyTerm-*-1.x86_64.rpm
```

### A blank or black window

Some Nvidia and older Mesa drivers can't render WebKitGTK's DMA-BUF path, and the
window comes up empty. Start it with the renderer disabled:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 figy-term
```

If that fixes it, make it permanent by adding the variable to the `Exec=` line of your
`~/.local/share/applications/figy-term.desktop` entry.

### Where things live

| | |
|---|---|
| AppImage install | `~/.local/bin/figy-term` |
| Desktop entry | `~/.local/share/applications/figy-term.desktop` |
| Package install | `/usr/bin/figy-term` |
| Settings and specs | `~/.figyterm/` |

---

## Windows

x64 only for now. Nothing about Gatekeeper, quarantine or `xattr` applies here — those
are macOS problems. Windows has its own, and it's SmartScreen.

### The installer (recommended)

Download `FigyTerm_<version>_x64-setup.exe` and run it. It's an NSIS installer: it
installs for the current user under `%LOCALAPPDATA%\FigyTerm`, needs no administrator
rights, adds a Start Menu entry, and is the build the in-app updater can replace.

### "Windows protected your PC"

Expected, and it means exactly one thing: the installer isn't code-signed.

1. Click **More info**
2. Click **Run anyway**

There's no way to avoid the prompt from our side yet. Unlike macOS there's no flag to
clear and no `curl` loophole — SmartScreen builds reputation per binary as downloads
accumulate, and a standard code-signing certificate doesn't grant it instantly (only an
EV certificate does, at a price that isn't justified yet).

### The MSI

`FigyTerm_<version>_x64_en-US.msi` is published for deployment via Group Policy or
Intune. It installs per-machine and **does not self-update** — a managed install stays
managed by whatever pushed it. FigyTerm will report that a new version exists and leave
the install alone.

### Which shell it runs

PowerShell 7 (`pwsh.exe`) if it's on `PATH`, otherwise Windows PowerShell
(`powershell.exe`), otherwise `cmd.exe`. Command history comes from PSReadLine, so
`cmd.exe` sessions have none — that's a cmd limitation, not a FigyTerm one.

### Where things live

| | |
|---|---|
| Installer install | `%LOCALAPPDATA%\FigyTerm` |
| MSI install | `%PROGRAMFILES%\FigyTerm` |
| Settings and specs | `%USERPROFILE%\.figyterm` |
| History read from | `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine` |

---

## Updating

Nothing to do. FigyTerm checks for new versions in the background and offers to install
them; you can also check any time from **FigyTerm → Check for Updates…** or the Updates
tab in Settings.

Updates install in place and relaunch the app. If any terminal pane is running a
command, FigyTerm names it and asks before restarting.

The exception is a Linux `.deb` or `.rpm` install: those files are owned by your package
manager, and FigyTerm won't rewrite files it doesn't own. It tells you a new version is
out and points at the download; installing it stays with `apt`/`dnf`. The AppImage build
has no such limit.

To turn off automatic checks: **Settings → Updates → Check Automatically**.

---

## Verifying an install

```bash
# Should print nothing — no quarantine flag
xattr -lr /Applications/FigyTerm.app

# Confirms the bundle's signature is intact (ad-hoc, not Apple-issued)
codesign --verify --strict /Applications/FigyTerm.app && echo "signature OK"
```

`spctl -a /Applications/FigyTerm.app` will say `rejected`. That's expected and not a
problem — it only means the app has no Apple Developer ID signature.

---

## Uninstalling

macOS:

```bash
rm -rf /Applications/FigyTerm.app

# Settings and installed autocomplete specs
rm -rf ~/Library/Application\ Support/com.code4mk.figyterm
rm -rf ~/Library/WebKit/com.code4mk.figyterm
```

Linux:

```bash
# AppImage install
rm -f ~/.local/bin/figy-term ~/.local/share/applications/figy-term.desktop

# Package install
sudo apt remove figyterm     # or: sudo dnf remove figyterm

# Settings and installed autocomplete specs
rm -rf ~/.figyterm
```

Windows:

```powershell
# Installer install: use Settings > Apps, or
& "$env:LOCALAPPDATA\FigyTerm\uninstall.exe"

# Settings and installed autocomplete specs
Remove-Item -Recurse "$env:USERPROFILE\.figyterm"
```

FigyTerm doesn't modify your shell config, so there's nothing to undo in `.zshrc`,
`.bashrc` or your PowerShell profile.

---

## Building from source

See the [README](../README.md#build-from-source). You'll need Rust and Node 20+, plus
the Xcode command line tools on macOS or the WebKitGTK development packages on Linux
(`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libxdo-dev`,
`libayatana-appindicator3-dev`, `libssl-dev`, `patchelf`).

Related: [`UPDATE-SYSTEM.md`](./UPDATE-SYSTEM.md) for how updates work internally, and
[`RELEASING.md`](./RELEASING.md) for cutting a release.
