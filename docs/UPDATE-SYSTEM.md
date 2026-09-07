# FigyTerm Update System — Design & Implementation Plan

**Status:** Phases 1–3 implemented.
**Scope:** macOS only (Apple Silicon + Intel), distributed via GitHub Releases
**Related:** `.github/workflows/release.yml`, `src-tauri/src/menu.rs`, `src/components/Settings/Settings.tsx`

---

## 1. The problem

Today a FigyTerm user has no way to learn that a new version exists. They installed
`v0.0.6` from a GitHub release page and the app will sit at that version forever unless
they happen to revisit the repo.

Two separate problems are tangled together here, and they need separate solutions:

| # | Problem | Who hits it | Frequency |
|---|---------|-------------|-----------|
| **A** | No update discovery or install path inside the app | every user | every release, forever |
| **B** | Unsigned app → Gatekeeper blocks first launch, user must run `xattr -cr /Applications/FigyTerm.app` | every new user | once, at install |

**Constraint: there is no budget for an Apple Developer ID ($99/yr).** FigyTerm ships
unsigned and unnotarized for the foreseeable future. That is a fixed input to this design,
not a temporary state to be worked around.

This makes the two problems asymmetric in an important way:

- Problem **B** cannot be *eliminated* without Apple's signature. It can only be **routed
  around** — by using an install path that never sets the quarantine flag in the first
  place (see §3).
- Problem **A** is fully solvable, unsigned, for free.

And critically: because **B** is a per-install toll that we can't remove, solving **A**
properly becomes *more* valuable, not less. Every user should pay that toll exactly once,
ever. An auto-updater is what guarantees that.

---

## 2. Current state (as of `v0.0.6`)

Facts established from the repo:

- **Stack:** Tauri v2 + React 18 + Vite. `tauri-plugin-shell` is the only plugin.
- **Release pipeline** (`.github/workflows/release.yml`) is already in good shape:
  a `create-release` job writes the draft + notes, a matrix builds `aarch64-apple-darwin`
  and `x86_64-apple-darwin`, `publish-release` undrafts. The app version is rewritten from
  the git tag at build time.
- **`uploadUpdaterJson: false`** is set on `tauri-action` — the updater path was
  deliberately left off.
- **No `createUpdaterArtifacts`** in `tauri.conf.json`, so no `.app.tar.gz` / `.sig`
  artifacts are produced.
- **Menu** (`src-tauri/src/menu.rs`) has app / Shell / Edit / View / Window / **Help**,
  where **Help is completely empty** — `Submenu::with_id(app, "help", "Help", true)`.
  Free real estate.
- **Settings** is a Headless UI dialog with a tab strip
  (`general | terminal | theme | shortcuts | specs`) — adding an `updates` tab is a
  natural fit. Prefs persist to `localStorage` under `figy-term-settings`.
- **No code signing** anywhere in the workflow. No `CHANGELOG.md` exists, though the
  generated release notes link to one.
- **Version drift:** `tauri.conf.json` / `package.json` / `Cargo.toml` all say `0.1.0`
  while the latest tag is `v0.0.6`. CI overwrites them at build time so shipped binaries
  are correct, but a **local dev build reports a version newer than any release** — the
  update checker must handle "local > remote" gracefully.

---

## 3. The signing story — and why updates escape it

This is the part that determines the whole design, so it's worth being precise.

**`com.apple.quarantine` is set by the application that performs the download**, via
LaunchServices. Safari, Chrome, and Firefox set it on every file they save. Programmatic
downloads — `curl`, `wget`, Homebrew, and **Tauri's own updater (reqwest)** — do not.

Consequences:

1. **First install via browser → quarantined → Gatekeeper blocks → `xattr -cr` needed.**
   This is what users hit today.
2. **First install via a `curl` script → not quarantined → launches clean, no `xattr`.**
3. **Update installed by the in-app updater → not quarantined → installs and relaunches
   clean, no `xattr`, no Gatekeeper prompt.**

So an unsigned app *can* ship a fully working silent auto-updater. Apple's Developer ID
is not a prerequisite for updating — it is only a prerequisite for a frictionless *first*
install.

Two caveats to verify on real hardware before shipping:

- **App translocation.** A quarantined app launched from `~/Downloads` runs from a
  randomized read-only path, and a self-update would fail to write to itself. Once the app
  is in `/Applications` with quarantine cleared, translocation does not happen. The updater
  must detect a translocated/read-only bundle path and fall back to the manual flow rather
  than failing silently.
- **Ad-hoc signatures on Apple Silicon.** arm64 macOS requires every binary to carry at
  least an ad-hoc signature; the toolchain applies one automatically. `v0.0.6` runs today,
  which confirms this holds. Replacing the bundle wholesale preserves that property.

**Tauri's updater signature is unrelated to Apple.** It uses a minisign keypair
(`TAURI_SIGNING_PRIVATE_KEY` / `pubkey` in `tauri.conf.json`) purely so the app can verify
that an update payload came from us. It is free, requires no Apple account, and is
mandatory for the updater plugin. **This is the signing that matters for us**, and it costs
nothing.

### 3.1 What we can still do for free

Two things are worth doing even though notarization is off the table:

**Force an explicit ad-hoc signature.** Set `bundle.macOS.signingIdentity` to `"-"` in
`tauri.conf.json` so the bundler always ad-hoc signs rather than relying on whatever the
linker happens to do. Ad-hoc signing does **not** satisfy Gatekeeper and does **not** avoid
the quarantine dialog — but it produces a structurally valid bundle, which tends to move the
failure from the alarming *"FigyTerm is damaged and can't be opened"* (which reads like
malware to a first-time user) to the milder, more accurate *"unidentified developer"*.
Free, low-risk, worth verifying empirically on both architectures.

**Be accurate about the Gatekeeper bypass in our instructions.** On macOS 15 (Sequoia) and
later, Apple **removed** the old Control-click → Open shortcut for unsigned apps. The
supported path is now **System Settings → Privacy & Security → "Open Anyway"**, which
appears only *after* a blocked launch attempt. The current release notes already say this
correctly — keep it that way, and make sure the in-app instructions say the same thing.
Any guide still telling users to right-click → Open is wrong on modern macOS and will make
us look careless.

What we explicitly are *not* doing: a self-signed certificate. It costs effort, satisfies
no part of Gatekeeper, and changes nothing for the user.

---

## 4. Recommended approach

Ship in three phases. Each phase is independently valuable and independently shippable.

### Phase 1 — Update *discovery* (no auto-install)

The app learns about new versions and tells the user, clearly and well. Install is still
manual, but the app hands over a download link, release notes, and a one-click copy of the
`xattr` command, so nobody has to go hunting through GitHub.

**Why start here:** zero risk, no new signing keys, no release-pipeline changes, and it
immediately solves the "users are stranded on old versions" problem. It also becomes the
permanent fallback path for Phase 2 failures.

### Phase 2 — Real auto-update (Tauri updater plugin)

Background download, verify minisign signature, swap the bundle, relaunch. Works unsigned,
per §3. Requires updater artifacts + a `latest.json` manifest published on each release.

**Why this is the real answer:** it is the behaviour users expect from a professional
desktop app, and it makes the `xattr` problem invisible for everyone after their first
install.

### Phase 3 — Make the quarantine-free install path the *default* one

Since we can't remove the toll, we change which door users walk through. The headline
deliverable is an **`install.sh` one-liner**:

```bash
curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install.sh | sh
```

Because curl doesn't set the quarantine flag, this install has **no Gatekeeper dialog and
no `xattr` step at all**. It is not a workaround for the "real" install — with no Developer
ID, it *is* the real install, and the README should lead with it. The DMG stays available
for people who want it, with the `xattr` instructions attached.

For a terminal emulator this is an easy sell: the entire audience is already comfortable
with a shell one-liner, and several tools they already use (rustup, nvm, Homebrew itself)
install exactly this way.

Secondary: a **Homebrew tap** (`brew tap code4mk/tap && brew install --cask figyterm`).
Two caveats to check at implementation time — (1) homebrew-cask's main repo has notability
thresholds a young project likely won't meet, hence our *own* tap; (2) Homebrew applies
quarantine to cask installs by default and the cask-side opt-out was removed, so users may
need `--no-quarantine`. Verify current behaviour before promising anything in the README.

---

## 5. Phase 1 — detailed design

### 5.1 Backend (Rust)

New module `src-tauri/src/updater/mod.rs` exposing Tauri commands.

```rust
#[derive(Serialize)]
pub struct UpdateInfo {
    pub current_version: String,   // from app.package_info().version
    pub latest_version: String,    // tag_name minus leading "v"
    pub update_available: bool,
    pub is_prerelease: bool,
    pub release_notes: String,     // raw markdown body
    pub release_url: String,       // html_url
    pub published_at: String,      // ISO 8601
    pub download_url: Option<String>, // arch-matched .dmg asset
    pub download_size: Option<u64>,
    pub asset_name: Option<String>,
}
```

Commands:

- `check_for_updates(channel: Channel) -> Result<UpdateInfo, String>`
- `get_current_version() -> String`
- `open_release_page(url: String)` — delegates to `tauri-plugin-shell`

Implementation notes:

- **Fetch from Rust, not the webview.** Avoids CORS and keeps the CSP clean. Add
  `reqwest = { version = "0.12", features = ["json", "rustls-tls"] }` and
  `semver = "1"` to `src-tauri/Cargo.toml`.
- **Endpoint:**
  - stable channel → `GET https://api.github.com/repos/code4mk/figyterm/releases/latest`
    (GitHub excludes prereleases from `/latest` automatically)
  - prerelease channel → `GET .../releases?per_page=10`, take the first entry
- **Headers:** `User-Agent: FigyTerm/<version>` (GitHub rejects requests without one) and
  `Accept: application/vnd.github+json`.
- **Rate limit:** 60 req/hr per IP unauthenticated. Ample, but cache the response for
  ~1 hour in `AppState` so rapid manual checks don't burn quota.
- **Timeout:** 10s, and never block app startup on it.
- **Arch detection:** `std::env::consts::ARCH` → `aarch64` picks
  `FigyTerm_<v>_aarch64.dmg`, `x86_64` picks `FigyTerm_<v>_x64.dmg`. Match on the asset
  name suffix rather than reconstructing the filename, so a bundler naming change doesn't
  silently break asset selection.
- **Comparison:** `semver::Version` parse both sides.
  - `latest > current` → update available
  - `latest == current` → up to date
  - `latest < current` → **"development build"** state, not an error (this is the local
    `0.1.0` vs `v0.0.6` case; see §2)
  - unparseable version on either side → surface as an error state, don't panic

### 5.2 Menu changes (`src-tauri/src/menu.rs`)

Follow macOS convention: `Check for Updates…` belongs in the app menu, directly under
`About`.

```
FigyTerm
  About FigyTerm
  Check for Updates…          ← new (MENU_CHECK_UPDATES → "menu://check-updates")
  ─────────
  Services / Hide / Quit …
```

And fill in the currently-empty Help menu:

```
Help
  FigyTerm Documentation      → opens README / docs site
  Release Notes               → opens releases page
  ─────────
  Report an Issue…            → opens GitHub issues/new
  View License                → opens LICENSE
```

These follow the existing pattern exactly: a `MENU_*` id constant, an `EVENT_*` string, an
arm in `handle_menu_event`, and a `listen()` registration in `AppShell.tsx` alongside the
ten already there. The Help items that just open a URL can call `shell::open` directly in
`handle_menu_event` without round-tripping through the frontend.

### 5.3 UI

**`src/components/Updates/UpdateModal.tsx`** — a Headless UI `Dialog`, styled to match
`Settings.tsx` and `BrowserModal.tsx`. State machine:

| State | Content |
|-------|---------|
| `checking` | spinner, "Checking for updates…" |
| `up-to-date` | ✓ "FigyTerm 0.0.6 is the latest version", last-checked timestamp |
| `dev-build` | "You're running a development build (0.1.0). Latest release is 0.0.6." |
| `available` | version + date, rendered release notes, **Download** (primary), **View on GitHub**, and the install instructions block |
| `error` | message + Retry + a link to the releases page as manual fallback |

The **install instructions block** is the piece that earns its keep. Rather than burying
`xattr -cr` in a GitHub release body nobody reads, show it inline as numbered steps with a
copy button on the command:

```
1. Download and open the .dmg
2. Drag FigyTerm to Applications
3. Run this in your terminal:
   ┌────────────────────────────────────────┐
   │ xattr -cr /Applications/FigyTerm.app   │ [copy]
   └────────────────────────────────────────┘
   Why? FigyTerm isn't code-signed yet, so macOS
   quarantines it. This clears that flag.  [learn more]
```

Bonus, since this *is* a terminal: offer a **"Run in terminal"** button that writes the
command straight into the active session via the existing
`write_terminal_session` command. That is a genuinely nice touch no other app can do —
though it must paste-and-await-Enter rather than auto-execute, so the user stays in
control of what runs in their shell.

For the clipboard button, prefer `tauri-plugin-clipboard-manager` over
`navigator.clipboard` — the webview API's secure-context behaviour is less predictable
across macOS versions than a native call.

**Release notes rendering:** the GitHub body is markdown. Either add a tiny markdown
renderer or render a deliberately limited subset (headings, lists, bold, inline code,
links). Don't pull in a heavyweight dependency for this; and if rendering raw HTML,
sanitize — the body is remote content.

**Passive notification.** A modal that only opens on demand won't be seen. Add:

- A silent check on startup, delayed ~5s so it never competes with terminal spawn.
- Throttled to once per 24h via a `lastUpdateCheck` timestamp in settings.
- When an update is found: a small dot/badge in the status bar or title bar, plus a
  dismissible toast. **Never** a modal that steals focus on launch — for a terminal app
  that is actively hostile.
- Remember a dismissed version so the same update doesn't nag on every launch.

**Settings → Updates tab.** Add `"updates"` to the `SettingsTab` union:

- Current version + build info
- "Check automatically" toggle (default on)
- Channel: Stable / Include prereleases (default Stable)
- Last checked, with a **Check Now** button
- Link to the full release history

Extend the `Settings` interface in `src/services/settings.ts`:

```ts
autoCheckUpdates: boolean;   // default true
updateChannel: "stable" | "prerelease";  // default "stable"
lastUpdateCheck: number | null;
dismissedVersion: string | null;
```

The existing `{ ...DEFAULT_SETTINGS, ...parsed }` merge in `loadSettings()` handles
migration for existing users at no cost.

---

## 6. Phase 2 — detailed design (auto-update)

### 6.1 Signing keys

```bash
npm run tauri signer generate -- -w ~/.tauri/figyterm.key
```

Produces a private key + password and a public key.

- Public key → `tauri.conf.json` under `plugins.updater.pubkey`
- Private key → repo secret `TAURI_SIGNING_PRIVATE_KEY`
- Password → repo secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

**Back this key up outside the repo.** If it's lost, every already-installed client stops
accepting updates permanently and users must reinstall by hand. This is the single highest-
consequence artifact in the whole system.

### 6.2 Config

`src-tauri/Cargo.toml`: `tauri-plugin-updater = "2"`

`src-tauri/tauri.conf.json`:

```jsonc
{
  "bundle": {
    "createUpdaterArtifacts": true   // emits .app.tar.gz + .app.tar.gz.sig
  },
  "plugins": {
    "updater": {
      "pubkey": "<public key>",
      "endpoints": [
        "https://github.com/code4mk/figyterm/releases/latest/download/latest.json"
      ]
    }
  }
}
```

`releases/latest/download/...` resolves to the newest **non-prerelease** release, which
gives us stable-channel behaviour for free. A prerelease channel would need a second
endpoint pointing at a fixed manifest path.

`src-tauri/capabilities/default.json`: add `"updater:default"`.

> Verify the exact key names against the Tauri v2 config schema when implementing —
> `createUpdaterArtifacts` and the `plugins.updater` shape are v2-specific and the docs are
> the authority, not this file.

### 6.3 Workflow changes

Two changes to `.github/workflows/release.yml`:

1. Pass the signing secrets as env to the `tauri-action` step in `build-macos`.
2. **Generate `latest.json` in a dedicated job**, not via `uploadUpdaterJson: true`.

The second point matters. With a two-target matrix, both jobs would try to write
`latest.json` onto the same release and race each other — one architecture's entry can end
up overwriting the other's, which produces an updater that works for Apple Silicon and
silently 404s for Intel (or vice versa). A deterministic manifest job avoids the class of
bug entirely:

```
create-release  →  build-macos (matrix ×2)  →  updater-manifest  →  publish-release
```

`updater-manifest` runs after both builds, lists the release assets via `gh api`,
downloads the two `.sig` files, and composes:

```json
{
  "version": "0.0.7",
  "notes": "See the release page for details.",
  "pub_date": "2026-09-06T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<sig>", "url": "https://github.com/.../FigyTerm_0.0.7_aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "<sig>", "url": "https://github.com/.../FigyTerm_0.0.7_x64.app.tar.gz" }
  }
}
```

then uploads it as a release asset. Keep `uploadUpdaterJson: false` on `tauri-action`.

### 6.4 App behaviour

- Background check on startup (throttled, same as Phase 1).
- Update available → toast + status-bar badge. **Never interrupt.**
- User clicks Install → download with a progress bar → "Restart to finish".
- **Critical for a terminal app:** before relaunching, warn if any pane has a running
  foreground process. Killing someone's in-flight `terraform apply` to install a point
  release is unforgivable. Offer "Install on next launch" as the default.
- On any failure — network, signature mismatch, read-only bundle path, translocation —
  fall back to the Phase 1 manual flow with a clear explanation. Never dead-end.

### 6.5 Rollout

Phase 2 has a bootstrapping property worth planning around: **only builds that already
contain the updater plugin can auto-update.** Users on `v0.0.6` and earlier must update to
the first updater-enabled release manually. So:

1. Ship Phase 1 first — it gives existing users a path forward.
2. Announce the updater-enabled release loudly in its notes as "the last manual update".
3. Every release after that updates itself.

---

## 7. Phase 3 — first-install experience

### 7.1 `install.sh`

Hosted in the repo, invoked as:

```bash
curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install.sh | sh
```

Steps: detect arch → resolve the latest tag from the GitHub API → download the matching
DMG **with curl** (no quarantine flag) → `hdiutil attach` → copy to `/Applications` →
`xattr -cr` defensively → `hdiutil detach` → `open` the app.

The script must be readable and boring — people are piping it to a shell, and a terminal-
tool audience will read it before running it. Print each step, fail loudly, clean up the
mount on error via `trap`.

### 7.2 DMG polish

Tauri supports a custom DMG layout (background image, window size, icon positions,
`/Applications` alias). A drag-to-Applications background image is a cheap, high-visibility
signal of a maintained product. Verify the config key shape against the v2 schema.

### 7.3 Documentation

With no Developer ID, the install instructions are part of the product, not an afterthought.
They should live in exactly three places and say the same thing in all three:

- **README** — leads with the `install.sh` one-liner; DMG + `xattr` as the alternative.
- **Release notes template** — same, trimmed.
- **In-app update modal** — same, with the copy button (§5.3).

Be straightforward about *why*: "FigyTerm is open source and not code-signed, because an
Apple Developer ID costs $99/year. Here's what that means for you and how to install
safely." Developers respond well to that framing; a vague "click Open Anyway" with no
explanation reads like something to be suspicious of.

### 7.4 Notarization — deferred, not planned

Out of scope: no budget. Recorded here only so the door stays open.

If it's ever funded, the change is small because Phases 1–3 don't depend on it: add repo
secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) and `tauri-action` signs and notarizes
automatically. The update system keeps working unchanged; only first install improves.

**Design implication for now:** do *not* pre-wire the Apple signing env block "ready for
later". This was tried and broke the release build: a referenced secret that doesn't
exist still defines the variable as an empty string, and the bundler treats a *present*
`APPLE_CERTIFICATE` as "sign this", then fails on `security import`. The env block and
the secrets have to arrive together. See [`RELEASING.md`](./RELEASING.md) for the exact
block to add and the failure signature.

Possible funding routes if it becomes worth revisiting: GitHub Sponsors, or Apple's fee
waiver for nonprofits/educational institutions (unlikely to apply here, but it exists).

---

## 8. Supporting work

- **`CHANGELOG.md`** — the generated release notes already link to it and it 404s today.
  Adopt Keep a Changelog format; the updater modal can surface the entry for the new
  version instead of a raw commit dump.
- **Version source of truth.** Committed version is `0.1.0` while the latest tag is
  `v0.0.6`. Either set committed files to the last released version, or document clearly
  that the tag is authoritative and CI rewrites. Right now it silently produces a dev build
  that looks newer than production.
- **Release notes template.** Once the app shows notes in-product, the current
  installation/troubleshooting boilerplate becomes redundant noise inside the app. Consider
  splitting: "What's New" at the top (shown in-app), install instructions below (for the
  web view only).

---

## 9. Open decisions

1. **Phase 2 now, or after Phase 1 ships?** Recommendation: Phase 1 first — it's a day of
   work, zero risk, and is the required fallback for Phase 2 anyway. But treat Phase 2 as
   *committed*, not optional: unsigned, it's the only thing standing between users and a
   manual reinstall on every single release.
2. **Prerelease channel in v1?** Recommendation: build the setting, default to stable, and
   don't publicize it until there's actually a beta stream.
3. **Where does the update badge live** — status bar, title bar, or both?
4. ~~Is a Developer ID in budget?~~ **Resolved: no.** Plan assumes permanently unsigned.
5. **Telemetry?** An update check is a natural place for a version-count ping. For a
   terminal tool aimed at developers, recommendation is **no** — or strictly opt-in.
6. **Does `install.sh` become the README's primary install method?** Recommendation: yes.
   It's the only path with zero Gatekeeper friction, and it matches how this audience
   installs developer tools already.

---

## 10. Task checklist

### Phase 1 — Update discovery ✅ implemented
- [x] Add `reqwest` + `semver` to `src-tauri/Cargo.toml`
- [x] Create `src-tauri/src/updater/mod.rs` with `check_for_updates` / `get_current_version`
- [x] Register commands in `lib.rs`; register the module in `lib.rs`
- [x] Cache check results (1h, per channel) in `UpdaterState`
- [x] Add `MENU_CHECK_UPDATES` + `menu://check-updates` in `menu.rs`
- [x] Populate the empty Help submenu (docs / release notes / report issue / license)
- [x] Build `src/components/Updates/UpdateModal.tsx` with the full state machine
- [x] Install-instructions block with copy button + "paste into terminal"
- [x] Minimal markdown rendering for release notes (`Updates/Markdown.tsx`)
- [x] Wire menu listeners in `AppShell.tsx` + command-palette entry
- [x] Extend `Settings` type with the four update fields
- [x] Add the `updates` tab to `Settings.tsx`
- [x] Startup check (5s delay, 24h throttle, respects `autoCheckUpdates`)
- [x] Status-bar badge + dismissible toast, with per-version dismissal
- [x] Unit tests: available / up-to-date / dev-build / malformed version / asset
      selection / real GitHub payload shape

**Files added:** `src-tauri/src/updater/mod.rs`, `src/services/updater.ts`,
`src/hooks/useUpdateCheck.ts`, `src/components/Updates/{UpdateModal,UpdateToast,Markdown}.tsx`

**Implementation notes worth carrying forward:**

- The backend caches per channel, so toggling Stable/Pre-release in Settings does not
  serve the other channel's stale answer.
- "Check Now" and the menu item pass `force: true` to bypass that cache; the automatic
  startup check does not, so repeated launches don't burn API quota.
- A failed *background* check is silent by design — the user didn't ask. Only explicit
  checks surface errors.
- Asset selection matches on filename suffix (`aarch64.dmg` / `x64.dmg`) and falls back
  to "no direct link, use the GitHub page" rather than guessing. A lone unsuffixed
  `.dmg` is accepted; two ambiguous ones are not. `.app.tar.gz` artifacts are never
  offered as a download — they already exist on releases and would be the wrong file.
- The "paste into terminal" button writes the command *without* a trailing newline, so
  the user presses Enter themselves. Nothing executes in their shell unprompted.
- Release notes render to React elements with no HTML passthrough at all, so markup
  injection from a remote release body is structurally impossible.

### Phase 2 — Auto-update ✅ implemented
- [x] Generate the minisign keypair (`~/.tauri/figyterm.key`, mode 600, outside the repo)
- [x] Add `tauri-plugin-updater`, `createUpdaterArtifacts`, `plugins.updater`, capability
- [x] Pass signing env to `tauri-action`
- [x] Add the `updater-manifest` job; keep `uploadUpdaterJson: false`
- [x] Download → progress → install → relaunch flow in the modal
- [x] Running-process guard before relaunch
- [x] Fallback to the manual flow on every failure path
- [ ] **Add the repo secrets** — `TAURI_SIGNING_PRIVATE_KEY` and
      `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty). Until these exist the
      `updater-manifest` job fails the release by design, rather than shipping a
      release whose updater silently does nothing.
- [ ] **Back up the private key** outside the machine. If it's lost, every
      installed client stops accepting updates permanently.
- [ ] **Verify on a real Mac after the first updater-enabled release:** an
      updater-installed build carries no quarantine flag; both architectures
      update; a translocated / read-only bundle falls back cleanly.

**Files added:** `src/services/installer.ts`

**Architecture:** discovery and install are deliberately separate. Discovery stays
on the GitHub Releases API (Phase 1) because it yields rich release notes, dates,
asset sizes and a prerelease flag — none of which `latest.json` carries. The
updater plugin is used purely as the mechanism that swaps the bundle. That split
is also what makes the fallback natural: if the plugin can't install (no manifest
on old releases, `tauri dev`, a read-only bundle), the UI reveals the manual DMG
path it already had.

**Running-process guard:** `PtyInstance::foreground_pid()` compares the tty's
foreground process group leader against the shell's own pid; when they differ the
user is running something. `running_foreground_commands` resolves those pids to
names via `sysinfo` so the warning can say *what* would be killed. Undeterminable
is treated as idle — a false "busy" would block updating forever, while a false
"idle" costs only a confirmation the user would have clicked through.

**Bootstrapping:** only builds that already contain the updater plugin can
auto-update, so v0.0.6 and earlier must install the first updater-enabled release
by hand. The release-notes template says so.

### Phase 3 — First install (unsigned-permanent) ✅ implemented
- [x] `install.sh` — arch detect, curl download, mount, copy, `xattr -cr`, detach
- [x] `trap`-based mount cleanup on failure; readable output (people will read it before piping)
- [x] Make `install.sh` the README's primary install method; DMG + `xattr` as alternative
- [x] Set `bundle.macOS.signingIdentity: "-"` for explicit ad-hoc signing
- [x] Align install wording across README / release notes / in-app modal, including the
      macOS 15+ "System Settings → Open Anyway" path (no right-click → Open)
- [x] `CHANGELOG.md`
- [x] Signing env removed from CI rather than pre-wired (see §7.4 — pre-wiring broke the build)
- [ ] Verify the Gatekeeper message on an **Intel** Mac (only tested on Apple Silicon)
- [~] Custom DMG layout — **not done, deliberately.** Tauri's defaults are already a
      correct drag-to-Applications layout (660×400, app at 180,170, Applications at
      480,170). Without a designed background image, setting those explicitly is
      no-op churn. Worth doing only alongside a real background asset.
- [~] Homebrew tap — **not done.** Homebrew quarantines cask installs by default and
      the cask-side opt-out was removed, so a tap may not even avoid the `xattr` step.
      Needs verifying before it's worth promising anyone.

**Verified on macOS (Apple Silicon), against the real v0.0.11 release:**

- `install.sh` runs end-to-end and the installed bundle has **no `com.apple.quarantine`
  attribute** — the premise the whole approach rests on.
- Mount cleanup leaves nothing behind, including on the failure paths.
- Ad-hoc signing measurably improved the bundle:

  | | before | after |
  |---|---|---|
  | flags | `adhoc, linker-signed` | `adhoc, runtime` |
  | `_CodeSignature` | absent | present |
  | `codesign --verify --strict` | — | passes |
  | `spctl` | *"no resources but signature indicates they must be present"* | plain `rejected` |

  The malformed-seal complaint is what produced the *"FigyTerm is damaged"* wording.
  It now reads as an unidentified developer instead, which is both accurate and far
  less alarming. Hardened runtime came along with it, which notarization would require.

**Design note — why the installer isn't a workaround.** With no Developer ID, quarantine
cannot be *removed* from the browser path; it can only be *avoided* by not using a
browser. That makes `curl | sh` the primary install route rather than a convenience,
and the README is ordered accordingly.

---

## 11. Linux — where the model forks

Everything above describes macOS, where there is exactly one install shape (a `.app`
bundle) and it can always be replaced. Linux has three, and only one of them can:

| Format | Updates |
|---|---|
| AppImage | In place, same as macOS — Tauri's updater swaps the file |
| `.deb` / `.rpm` | Discovery only: FigyTerm reports the new version and links the download |

The reason is ownership, not capability. A package install puts the binary in `/usr/bin`
and records it in the package database; rewriting it would need root and would leave
`apt`/`dnf` describing a version that is no longer there. So the app detects its own
install shape at startup — `install_method()` in `src-tauri/src/updater/mod.rs`, which
reads the `APPIMAGE` environment variable that only a running AppImage sets — and
`UpdateInfo.installMethod` carries the answer to the UI. On a managed install the modal
never renders an Install button.

Two smaller consequences:

- **Asset matching.** `asset_for_current_target()` looks for `.AppImage` on Linux and
  `.dmg` on macOS. The `.deb` and `.rpm` are deliberately not offered as downloads from
  inside the app: pointing at one would be offering an install FigyTerm can't complete.
- **`latest.json`.** The manifest's `linux-x86_64` entry points at the AppImage and its
  signature. A package-managed install never reaches the updater endpoint at all.

Nothing about Gatekeeper, quarantine or `xattr` applies on Linux — that entire section
of this document is macOS-only.
