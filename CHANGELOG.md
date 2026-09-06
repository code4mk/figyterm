# Changelog

All notable changes to FigyTerm are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `install.sh` — a one-line macOS installer:
  `curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install.sh | sh`.
  Because `curl` doesn't apply macOS quarantine (browsers do), this installs with no
  Gatekeeper dialog and no `xattr` step. Detects architecture, verifies the app bundle,
  and cleans up its mount on any failure path.
- `CHANGELOG.md` — release notes have linked here since v0.0.6.
- `docs/RELEASING.md` — release process, required secrets, and troubleshooting.

### Changed
- The app is now explicitly ad-hoc signed (`signingIdentity: "-"`). Previously the
  bundle carried only a linker-generated signature with no sealed resources, which made
  macOS report it as *"damaged"* — alarming wording for what is really just an unsigned
  app. It now verifies under `codesign --verify --strict` and reports as an
  unidentified developer instead. This is **not** Apple notarization; first-time
  installs still need the installer script or the `xattr` step.
- README leads with the installer script; the `.dmg` route is documented as the manual
  alternative.

## [0.0.11] — 2026-09-06

### Fixed
- Release builds failed at bundling with
  `failed to run command security import: failed to import keychain certificate`.
  Apple signing variables had been pre-wired in the workflow ahead of the secrets
  existing, but a referenced-yet-missing secret still defines the variable as an empty
  string, and the bundler treats a *present* `APPLE_CERTIFICATE` as "sign this".

## [0.0.9] — 2026-09-06

### Added
- **Automatic updates.** FigyTerm downloads, verifies and installs new versions in
  place, then relaunches. Update payloads are verified against a minisign signature;
  this is independent of Apple code signing.
  Because the updater downloads over HTTP rather than through a browser, updated builds
  carry no quarantine flag — after this release, `xattr` is never needed again.
- Before installing, any commands still running in a pane are detected and named, and
  confirmation is required — restarting would otherwise kill them silently.
- Falls back to the manual download whenever one-click install isn't possible (older
  releases without a manifest, a read-only bundle), rather than dead-ending.

## [0.0.7] – [0.0.8], [0.0.10]

Failed release attempts. No usable artifacts were produced; `0.0.10` is additionally a
malformed tag (missing the `v` prefix). Skip to [0.0.11].

## [0.0.6] — 2026-09-03

### Added
- In-app update checking against GitHub Releases, with a *Check for Updates…* menu item,
  an Updates tab in Settings, and a passive status-bar indicator.
- Help menu: documentation, release notes, report an issue, license.
- Embedded browser modal with tabs (`Cmd+Shift+B`).
- System Monitor with live CPU and memory graphs (`Cmd+Shift+M`).
- Folder-style spec support for `loadSpec` resolution.

## [0.0.5] — 2026-08-15

### Added
- Command history search with picture-in-picture mode (`Cmd+R`).

## [0.0.4] — 2026-08-15

### Added
- Terminal search (`Cmd+F`) and the unicode11 addon.
- Tab bar redesign with drag-to-reorder and move buttons.

### Fixed
- Tab dragging, keyboard shortcuts, autocomplete flashing, and the stray zsh prompt mark.
- Settings modal theming for dark and light modes.

## [0.0.1] – [0.0.3] — 2026-08-09 to 2026-08-11

Initial releases: terminal emulation, tabs and split panes, Fig-style autocomplete
specs, and the settings system.

[Unreleased]: https://github.com/code4mk/figyterm/compare/v0.0.11...HEAD
[0.0.11]: https://github.com/code4mk/figyterm/releases/tag/v0.0.11
[0.0.9]: https://github.com/code4mk/figyterm/releases/tag/v0.0.9
[0.0.6]: https://github.com/code4mk/figyterm/releases/tag/v0.0.6
[0.0.5]: https://github.com/code4mk/figyterm/releases/tag/v0.0.5
[0.0.4]: https://github.com/code4mk/figyterm/releases/tag/v0.0.4
