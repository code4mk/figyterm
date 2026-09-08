<p align="center">
  <img src="public/logo.png" alt="FigyTerm icon" height="64" />
  &nbsp;&nbsp;
  <img src="public/figyterm.png" alt="FigyTerm" height="64" />
</p>

<p align="center">
  <strong>A modern, intelligent terminal for macOS and Linux with autocomplete superpowers.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#recommended-setup">Shell Setup</a> •
  <a href="#development">Development</a> •
  <a href="#keyboard-shortcuts">Shortcuts</a> •
  <a href="docs/CONTRIBUTING.md">Contributing</a>
</p>

---

FigyTerm is a fully local desktop terminal built with **Tauri 2**, **React**, and **Rust**. It brings IDE-level autocomplete to your command line — context-aware suggestions for git, docker, pnpm, npm, uv, and more — all running natively with zero network dependency.

Inspired by [Fig](https://fig.io) (now part of AWS), FigyTerm is an open-source alternative that keeps your terminal experience fast, private, and extensible.

## Features

- **Intelligent Autocomplete** — Context-aware suggestions for commands, subcommands, options, and file paths
- **Spec-based Engine** — Compatible with Fig's spec format for community-driven command completions
- **Split Panes** — Up to 4 resizable terminal panes per tab (Cmd+D / Cmd+Shift+D)
- **Multiple Tabs** — Browser-style tab bar with drag-to-reorder and rename support
- **Embedded Browser** — In-app browser modal with tabs, address bar, and back/forward/reload (`⌘⇧B`); uses a native child webview so real sites load (not an iframe). On Linux it's positioned through a `gtk::Fixed` of our own, since Tauri can't place child webviews on GTK ([tauri#10420](https://github.com/tauri-apps/tauri/issues/10420))
- **Command History Search** — Fuzzy-search past commands with picture-in-picture mode (`⌘R`)
- **System Monitor** — Live CPU and memory charts in a draggable modal (`⌘⇧M`)
- **Terminal Search** — Find text in the active pane (`⌘F`)
- **Command Palette** — Quick launcher for common actions (`⌘⇧P`)
- **Oh My Zsh Integration** — Real-time theme switching with full prompt rendering
- **Dark & Light Mode** — Beautifully themed UI that adapts to your preference
- **Recent Directory Ordering** — Frequently visited folders appear first in suggestions
- **Clickable URLs** — Links in terminal output open in your default browser
- **Native Performance** — Rust PTY backend with zero-latency input

## Installation

macOS (Apple Silicon and Intel) and Linux (x86_64) — see the
[installation guide](docs/INSTALLATION.md) for the full details.

**You only install once**: FigyTerm updates itself from then on. (The one exception is
a Linux `.deb`/`.rpm`, which stays with your package manager.)

### macOS — Option 1: install script (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install.sh | sh
```

One line, no security dialog, no `xattr` step. It detects your Mac's architecture,
downloads the right build, and installs to `/Applications`.

[Read the script first](install.sh) — you should read anything you pipe to a shell. It
touches a temp directory and `FigyTerm.app`, nothing else.

### macOS — Option 2: download the .dmg manually

1. Download the build for your Mac from [Releases](https://github.com/code4mk/figyterm/releases):
   `aarch64` for Apple Silicon, `x64` for Intel
2. Open the `.dmg` and drag **FigyTerm** into **Applications**
3. Clear the quarantine flag macOS added during the download:

   ```bash
   xattr -cr /Applications/FigyTerm.app
   ```

4. Launch FigyTerm

Step 3 isn't optional — skip it and macOS says *"FigyTerm is damaged and can't be
opened"*, which sounds alarming but only means the app is unsigned.

If macOS still blocks it, open **System Settings → Privacy & Security**, scroll down,
and click **Open Anyway**. (On macOS 15 and later this is the only way through — Apple
removed the old right-click → Open shortcut.)

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install-linux.sh | sh
```

Installs the AppImage to `~/.local/bin` with a desktop entry.
[Read the script first](install-linux.sh).

Or take a package from [Releases](https://github.com/code4mk/figyterm/releases):
`sudo apt install ./FigyTerm_*_amd64.deb`, `sudo dnf install ./FigyTerm-*.x86_64.rpm`.
No Gatekeeper, no quarantine, no `xattr` — none of that exists here.

The AppImage is the build that updates itself; a distro package is your package
manager's to update. If the window comes up blank on Nvidia or older Mesa drivers, start
it with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

<details>
<summary>Why does Option 1 skip that step?</summary>

FigyTerm isn't code-signed with an Apple Developer ID (it costs $99/year), so macOS
quarantines it on download and refuses to open it until the flag is cleared.

Quarantine is applied by the **downloading application** — browsers set it, `curl`
doesn't. The script isn't bypassing a security check; it just isn't a browser, so the
flag is never set in the first place. `xattr -cr` reaches the same end state after
the fact.

Either way it's a one-time thing: the built-in updater also downloads over HTTP rather
than through a browser, so updates are never quarantined.

</details>

> **Keychain access popup:** macOS may ask to allow FigyTerm to access your keychain (for SSH keys, credentials, etc.). Click **Always Allow** or **Allow** to proceed. If you accidentally deny it, go to **Keychain Access > login** and update the access control for the relevant entry.

### Build from Source

```bash
git clone https://github.com/code4mk/figyterm.git
cd figyterm
npm install
npm run tauri build
```

The built `.app` and `.dmg` will be in `src-tauri/target/release/bundle/macos/`.

### Prerequisites (for building from source)

| Requirement | Version |
|-------------|---------|
| [Node.js](https://nodejs.org/) | 18+ |
| [Rust](https://rustup.rs/) | 1.86+ |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | 2.x |
| Xcode Command Line Tools | `xcode-select --install` |

## Recommended Setup

FigyTerm runs your normal login shell — it uses the `$SHELL` environment variable (same as Terminal.app). **You do not need to install anything extra for basic use.**

For the best experience (themes, prompts, plugins, and recent-folder ordering from history), we recommend **zsh** with **Oh My Zsh**.

### Shell

| Shell | Required? | Notes |
|-------|-----------|-------|
| **zsh** | No (recommended) | Default on macOS since Catalina (`/bin/zsh`). FigyTerm launches whatever `$SHELL` points to. |
| **bash / fish** | Supported | Works out of the box if `$SHELL` is set to them. |
| **Oh My Zsh** | No (recommended) | Enables theme switching in Settings and rich prompt rendering. Without it, the terminal still works — you just won't see Oh My Zsh themes in Settings. |

To confirm your shell:

```bash
echo $SHELL
# Expected on modern macOS: /bin/zsh
```

If you want to switch the default shell to zsh:

```bash
chsh -s /bin/zsh
```

Restart FigyTerm (or open a new tab) after changing shells.

### Oh My Zsh (optional)

Oh My Zsh is **not required**, but it unlocks FigyTerm's theme picker (Settings → Theme) and matches how most developers configure their macOS terminal.

Install Oh My Zsh:

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

After install:

1. Restart FigyTerm or open a new tab
2. Open **Settings → Theme** to browse and switch Oh My Zsh themes live
3. Custom themes can be placed in `~/.oh-my-zsh/custom/themes/`

> **Already using Oh My Zsh in Terminal.app?** FigyTerm reads the same `~/.zshrc` and `~/.oh-my-zsh` config — no extra setup needed.

> **Not using Oh My Zsh?** FigyTerm still works. Autocomplete, split panes, tabs, and path suggestions are independent of Oh My Zsh.

## Keyboard Shortcuts

| macOS | Linux | Action |
|-------|-------|--------|
| `⌘ T` | `Ctrl+Shift+T` | New tab |
| `⌘ ⇧ T` | `Ctrl+Alt+T` | New tab (same directory as active tab) |
| `⌘ ⇧ W` | `Ctrl+Shift+W` | Close active pane |
| `⌘ D` | `Ctrl+Shift+D` | Split pane horizontally |
| `⌘ ⇧ D` | `Ctrl+Alt+D` | Split pane vertically |
| `⌘ K` | `Ctrl+Shift+K` | Clear terminal |
| `⌘ F` | `Ctrl+Shift+F` | Find in terminal |
| `⌘ R` | `Ctrl+Shift+R` | Search command history |
| `⌘ C` | `Ctrl+Shift+C` | Copy selection |
| `⌘ V` | `Ctrl+Shift+V` | Paste |
| `⌘ ⇧ B` | `Ctrl+Shift+B` | Open browser |
| `⌘ ⇧ M` | `Ctrl+Shift+M` | System monitor |
| `⌘ ⇧ P` | `Ctrl+Shift+P` | Command palette |
| `⌘ ,` | `Ctrl+,` | Settings |
| `⌘ 1-9` | `Ctrl+1-9` | Switch to tab N |
| `⌘ ⇧ [` | `Ctrl+Shift+[` | Previous tab |
| `⌘ ⇧ ]` | `Ctrl+Shift+]` | Next tab |
| `Tab` | `Tab` | Accept autocomplete suggestion |
| `↑ ↓` | `↑ ↓` | Navigate suggestions |
| `Esc` | `Esc` | Dismiss suggestions |

Shell-native shortcuts (`Ctrl+C`, `Ctrl+D`, `Ctrl+Z`, `Ctrl+L`, `Ctrl+R`) pass through
directly. That's why the Linux column uses `Ctrl+Shift` rather than plain `Ctrl`, the
same as GNOME Terminal and Konsole: a bare `Ctrl`+letter belongs to the shell, and an
app shortcut that took it would break the terminal it's wrapped around. The two chords
that would collide (`Ctrl+Shift+T` and `Ctrl+Shift+D` are already taken) fall back to
`Ctrl+Alt`.

## Supported Command Specs

FigyTerm ships with built-in specs for popular tools:

| Command | Coverage |
|---------|----------|
| `git` | Subcommands, branches, options |
| `docker` | Commands, containers, images, options |
| `docker compose` | Services, commands, options |
| `npm` | Scripts, packages, options |
| `pnpm` | Scripts, workspaces, options |
| `yarn` | Scripts, packages, options |
| `uv` | Scripts from pyproject.toml, options |
| `cd` | Directories with recent-first ordering |

Adding a new spec is straightforward — see the [Spec Authoring Guide](docs/SPECS.md).

## Architecture

```
┌─────────────────────────────────────────────┐
│  React + TypeScript (UI Layer)              │
│  ├── xterm.js (terminal rendering)         │
│  ├── Autocomplete engine (spec-based)      │
│  ├── Split panes (react-resizable-panels)  │
│  ├── Browser modal (native child webview)  │
│  └── Settings & theme management           │
├─────────────────────────────────────────────┤
│  Tauri IPC (commands + events)             │
├─────────────────────────────────────────────┤
│  Rust (Native Layer)                        │
│  ├── PTY session management                │
│  ├── Path completion (filesystem)          │
│  ├── Shell command execution               │
│  ├── Browser webviews (multi-webview)      │
│  └── Window management                     │
└─────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Terminal | xterm.js, FitAddon, WebLinksAddon |
| Desktop | Tauri 2.x |
| Native | Rust |
| PTY | portable-pty |
| State | Zustand |
| UI Components | Headless UI, Lucide Icons |
| Panels | react-resizable-panels |

## Development

```bash
# Install dependencies
npm install

# Start dev mode (hot-reload frontend + Rust rebuild)
npm run tauri dev

# Type check
npx tsc --noEmit

# Production build
npm run tauri build
```

### Project Structure

```
figyterm/
├── src/                          # Frontend (React + TypeScript)
│   ├── components/
│   │   ├── AppShell/             # Main layout, tab & pane management
│   │   ├── Browser/              # Embedded browser modal
│   │   ├── Terminal/             # Terminal, TabBar, HistorySearch, SystemMonitor
│   │   └── Settings/             # Settings modal (tabbed)
│   ├── services/                 # Autocomplete, browser IPC, spec registry
│   ├── specs/                    # Command completion specs (git, docker, etc.)
│   ├── stores/                   # Zustand stores (settings, theme)
│   └── types/                    # TypeScript definitions (figy, terminal)
├── src-tauri/                    # Backend (Rust)
│   └── src/
│       ├── commands/             # Tauri IPC handlers
│       │   ├── terminal.rs       # PTY session create/write/resize/close
│       │   ├── browser.rs        # Child webview lifecycle & navigation
│       │   ├── autocomplete.rs   # Path completions & shell history
│       │   ├── system.rs         # CPU/memory stats
│       │   └── shell_exec.rs     # Shell command execution
│       └── lib.rs                # App entry point
├── docs/                         # Documentation
│   ├── CONTRIBUTING.md           # Contribution guidelines
│   └── SPECS.md                  # Spec authoring guide
├── public/                       # Static assets (logo, icons)
└── package.json
```

## Roadmap

- [x] Real PTY sessions with persistent shell
- [x] Multi-tab support with rename
- [x] Intelligent autocomplete (spec-based)
- [x] Split panes (up to 4 per tab)
- [x] Oh My Zsh theme management
- [x] Dark/Light mode
- [x] Recent directory ordering
- [x] Clickable URLs
- [x] Command history search (`⌘R`)
- [x] Terminal search (`⌘F`)
- [x] System monitor (`⌘⇧M`)
- [x] Embedded browser with tabs (`⌘⇧B`)
- [ ] Plugin system for custom specs
- [ ] AI-powered command suggestions (local models)
- [ ] Snippet management
- [ ] Session restore on relaunch

## Contributing

We welcome contributions! Please read our [Contributing Guide](docs/CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE)
