# Installing FigyTerm

macOS only, on both Apple Silicon and Intel. There are two ways to install, and they
produce the same app — pick whichever you prefer.

| | [Install script](#option-1--install-script) | [Manual .dmg](#option-2--manual-dmg) |
|---|---|---|
| Steps | one command | download, drag, one command |
| Security dialog | none | "damaged" / "unidentified developer" |
| `xattr` needed | no | yes |
| Picks your architecture | automatically | you choose |

Whichever you use, **you only do it once** — FigyTerm updates itself from then on.

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

## Updating

Nothing to do. FigyTerm checks for new versions in the background and offers to install
them; you can also check any time from **FigyTerm → Check for Updates…** or the Updates
tab in Settings.

Updates install in place and relaunch the app. If any terminal pane is running a
command, FigyTerm names it and asks before restarting.

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

```bash
rm -rf /Applications/FigyTerm.app
```

To remove settings and installed autocomplete specs as well:

```bash
rm -rf ~/Library/Application\ Support/com.code4mk.figyterm
rm -rf ~/Library/WebKit/com.code4mk.figyterm
```

FigyTerm doesn't modify your shell config, so there's nothing to undo in `.zshrc`.

---

## Building from source

See the [README](../README.md#build-from-source). You'll need Rust, Node 20+, and the
Xcode command line tools.

Related: [`UPDATE-SYSTEM.md`](./UPDATE-SYSTEM.md) for how updates work internally, and
[`RELEASING.md`](./RELEASING.md) for cutting a release.
