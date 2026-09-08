# Releasing FigyTerm

How to cut a release, what the pipeline does, and how to fix it when it breaks.

Related: [`UPDATE-SYSTEM.md`](./UPDATE-SYSTEM.md) covers the in-app update system this
pipeline feeds.

---

## Cutting a release

```bash
git tag v0.0.7
git push origin v0.0.7
```

That's it. The tag drives everything — the version in `package.json`,
`tauri.conf.json` and `Cargo.toml` is rewritten from it at build time, so those
committed values don't need to be correct.

Tags must be `vMAJOR.MINOR.PATCH` with an optional prerelease suffix
(`v1.0.0-beta.1`). Anything with a suffix ships as a GitHub prerelease and is
excluded from the updater's "latest" endpoint.

To rebuild an existing tag, use **Actions → Release → Run workflow**, enter the tag,
and pick a platform from **Which platform to build** (`all`, `macos`, `linux`,
`windows`). The workflow is re-run safe: it PATCHes the existing release rather than
creating a duplicate, and replaces `latest.json` instead of colliding with it. A
single-platform rebuild still refreshes the manifest and undrafts — the tail jobs run
after a skipped build, just not after a failed one.

### The builds compile the tag, not the branch

This is the one thing to internalise about a manual re-run, and it has already cost two
builds. `workflow_dispatch` takes the *workflow file* from the branch you dispatch from,
but every build job does `checkout` with `ref: <tag>`. So you can dispatch a workflow
that contains a fix and still compile tagged code that doesn't — the build fails on a
bug you already fixed, at a line number that no longer exists.

If a tag is behind, move it:

```bash
git tag -f v0.1.0 <commit-or-branch>
git push -f origin v0.1.0
```

Then re-run. The `Report the commit that will be built` step prints the tag's commit and
subject into the job summary before anything compiles, so a stale tag is visible in the
first few seconds rather than inferred from a compiler error.

---

## What the pipeline does

```
create-release  →  build-macos (aarch64 + x64)  ┐
                →  build-linux (x86_64)         ┼→  updater-manifest  →  publish-release
                →  build-windows (x64)          ┘
```

| Job | Does |
|-----|------|
| `create-release` | Validates the tag, renders release notes, creates a **draft** release. Runs once so the body isn't raced by the build matrix. |
| `build-macos` | Builds and bundles both architectures, uploads `.dmg` + `.app.tar.gz` + `.sig` to the draft. |
| `build-linux` | Builds on `ubuntu-22.04`, uploads `.AppImage` + `.sig`, `.deb` and `.rpm`. |
| `build-windows` | Builds on `windows-latest`, uploads `-setup.exe` + `.sig` and the `.msi`. |
| `updater-manifest` | Composes `latest.json` from every build's signatures and uploads it. |
| `publish-release` | Undrafts. This is what makes the release visible and updatable. |

Every build job runs `scripts/sync-version.mjs` first, which rewrites `package.json`,
`tauri.conf.json` and `Cargo.toml` from the tag. That's why the committed versions
don't have to be correct.

### Why `ubuntu-22.04` and not `ubuntu-latest`

The binary links against the builder's glibc. Built on 24.04 (glibc 2.39) it refuses to
start on Debian 12 or Ubuntu 22.04 with a `GLIBC_2.38 not found` error. 22.04 ships
glibc 2.35, which covers every currently supported distro. Moving this forward drops
users; do it deliberately, not by following the runner label.

### Why Windows updates go through the NSIS installer

`latest.json` points `windows-x86_64` at `-setup.exe`, not the `.msi`. The NSIS
installer is per-user and needs no elevation, so the updater can replace it without a
UAC prompt. The MSI is published for Group Policy / Intune deployment and is
deliberately left alone: a per-machine managed install belongs to whatever pushed it,
the same reasoning that keeps `.deb`/`.rpm` out of the Linux path.

Windows installers are unsigned, which means SmartScreen shows *"Windows protected your
PC"* on first run. That's a warning, not a block — see `INSTALLATION.md`. There is no
signing block pre-wired in the workflow, for the same reason there's none for Apple: a
missing secret still sets the variable, and the bundler treats a present certificate as
"sign this" and then fails.

### Why Linux updates are AppImage-only

`latest.json` carries `linux-x86_64` pointing at the AppImage, because that's the only
Linux format Tauri's updater can replace in place. A `.deb` or `.rpm` install lives in
`/usr/bin` and is owned by the package database — the app detects that case at runtime
(via the `APPIMAGE` environment variable, which only a running AppImage sets) and
offers a download instead of an install. See `install_method()` in
`src-tauri/src/updater/mod.rs`.

The release stays a **draft** until every job succeeds. A failure part-way leaves a
draft release with partial assets — see [Recovering](#recovering-from-a-failed-run).

---

## Required secrets

Only one:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of `~/.tauri/figyterm.key`, both lines including the `untrusted comment:` line. |

Set it with `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/figyterm.key`, or paste
it at **Settings → Secrets and variables → Actions → New repository secret**.

### Why there is no `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret

The key was generated without a password, and **GitHub's web UI won't save a secret
with an empty value**. You don't need to: `${{ secrets.MISSING }}` evaluates to an
empty string, so the workflow sets the variable to `""` either way. Tauri reads that
as "no password" and proceeds.

What matters is that the variable is *set*, not that the secret exists — an unset
variable can make Tauri prompt for a password and hang the job. The workflow always
sets it.

If you later switch to a password-protected key, just add the secret. No workflow
change needed.

### Backing up the signing key

`~/.tauri/figyterm.key` has no recovery path. GitHub secrets are write-only, so you
cannot read it back out of Actions. If you lose the local copy and the machine, every
installed client stops accepting updates permanently and every user has to reinstall
by hand. Put it in a password manager.

---

## Troubleshooting

### `failed to run command security import: failed to import keychain certificate`

```
security: SecKeychainItemImport: One or more parameters passed to a function were not valid.
failed to bundle project: failed codesign application: failed to run command
security import: failed to import keychain certificate
```

**Cause:** an `APPLE_CERTIFICATE` env var is set to an empty string. A referenced
secret that doesn't exist still *defines* the variable, and the Tauri bundler checks
whether `APPLE_CERTIFICATE` is **present**, not whether it's non-empty. Seeing it
present, it tries to import a certificate from an empty value and fails.

**Fix:** don't reference Apple signing secrets at all until you actually have them.
The `Build Tauri app` step must have no `APPLE_*` variables in its `env:` block.

This is the one asymmetry worth remembering: for `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
present-and-empty is exactly right. For `APPLE_CERTIFICATE`, present-and-empty is
fatal. "Wire it up now, add the secret later" works for the first and breaks the
second.

### `<artifact>.sig is missing from the release`

Raised by `updater-manifest` for whichever artifact it couldn't find a signature for —
`FigyTerm_<version>_<arch>.app.tar.gz` on macOS, `FigyTerm_<version>_amd64.AppImage` on
Linux, `FigyTerm_<version>_x64-setup.exe` on Windows.

**Cause:** `TAURI_SIGNING_PRIVATE_KEY` isn't set, so the bundler produced no updater
signature.

**Fix:** add the secret, then re-run the workflow for that tag.

This check is deliberate. Without it the release would publish successfully with a
`latest.json` that never matches anything, and the auto-updater would silently do
nothing for every user — a failure you'd only discover much later.

### DMG bundling fails locally with `error running bundle_dmg.sh`

**Cause:** a volume named `FigyTerm` is already mounted — usually a previously
downloaded FigyTerm `.dmg` still open in Finder. The bundler can't create its own
volume under that name.

**Fix:** eject it (`ls /Volumes`, then `hdiutil detach /Volumes/FigyTerm`), or skip
DMG bundling while iterating:

```bash
npm run tauri build -- --bundles app
```

CI is unaffected — runners have no stray mounts.

### Verifying a signature locally

To confirm a build's signature matches the public key in `tauri.conf.json` — i.e.
that installed clients will actually accept it:

```bash
python3 -c "
import base64, json
sig_text = base64.b64decode(open('src-tauri/target/release/bundle/macos/FigyTerm.app.tar.gz.sig').read()).decode()
sig = base64.b64decode(sig_text.splitlines()[1])
pub_text = base64.b64decode(json.load(open('src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey']).decode()
pub = base64.b64decode(pub_text.splitlines()[1])
print('MATCH' if sig[2:10] == pub[2:10] else 'MISMATCH — clients would reject this update')"
```

Build with the key in the environment first:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/figyterm.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npm run tauri build -- --bundles app
```

---

## Recovering from a failed run

A failed run leaves a **draft** release holding whatever assets did upload. Nothing is
public yet, so there's no rush.

**Same tag, after fixing the workflow:** push the fix, then **Actions → Release → Run
workflow** with the tag. It reuses the draft, refreshes the notes, and re-uploads.
Stale assets from the failed attempt are replaced.

Note the re-run builds from the **tag's** commit, not your branch — the checkout uses
`ref: <tag>`. A workflow fix on `dev` won't be picked up until the tag points at it.
Either move the tag:

```bash
git tag -f v0.0.7 && git push -f origin v0.0.7
```

or, cleaner, abandon the tag and cut the next one.

**Starting over:** delete the draft release in the GitHub UI, then
`git push --delete origin v0.0.7 && git tag -d v0.0.7`.

---

## Enabling notarization later

Currently out of scope — an Apple Developer ID is $99/yr and there's no budget. See
[`UPDATE-SYSTEM.md` §7.4](./UPDATE-SYSTEM.md). Recorded here so the door stays open.

Nothing else depends on it: the update system works unsigned, and notarization only
improves *first* install (no `xattr`, no "unidentified developer", no "damaged and
can't be opened").

When there is a Developer ID, add these secrets **and** the matching `env:` block to
the `Build Tauri app` step — both together, never the block alone:

```yaml
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

`APPLE_PASSWORD` is an app-specific password, not the Apple ID password.
