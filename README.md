<p align="center">
  <img src="public/logo.png" alt="FigyTerm icon" height="64" />
  &nbsp;&nbsp;
  <img src="public/figyterm.png" alt="FigyTerm" height="64" />
</p>

<p align="center">
  <strong>A modern, intelligent terminal for macOS with autocomplete superpowers.</strong>
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
- **Oh My Zsh Integration** — Real-time theme switching with full prompt rendering
- **Dark & Light Mode** — Beautifully themed UI that adapts to your preference
- **Recent Directory Ordering** — Frequently visited folders appear first in suggestions
- **Clickable URLs** — Links in terminal output open in your default browser
- **Native Performance** — Rust PTY backend with zero-latency input

## Installation

### Download (macOS)

1. Go to the [Releases](https://github.com/code4mk/figyterm/releases) page
2. Download the `.dmg` file for your Mac:
   - **Apple Silicon** (M1/M2/M3/M4): `FigyTerm_x.x.x_aarch64.dmg`
   - **Intel**: `FigyTerm_x.x.x_x64.dmg`
3. Open the `.dmg` file
4. Drag **FigyTerm** to your **Applications** folder
5. Launch from Applications

> **First launch:** macOS may show "FigyTerm can't be opened because it is from an unidentified developer." Go to **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.

> **"FigyTerm" is damaged and can't be opened:** This happens because the app isn't code-signed. Run this in Terminal:
> ```bash
> xattr -cr /Applications/FigyTerm.app
> ```
> Then launch again.

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

| Shortcut | Action |
|----------|--------|
| `⌘ T` | New tab |
| `⌘ W` | Close active pane |
| `⌘ D` | Split pane horizontally |
| `⌘ ⇧ D` | Split pane vertically |
| `⌘ K` | Clear terminal |
| `⌘ ,` | Settings |
| `⌘ 1-9` | Switch to tab N |
| `⌘ ⇧ [` | Previous tab |
| `⌘ ⇧ ]` | Next tab |
| `Tab` | Accept autocomplete suggestion |
| `↑ ↓` | Navigate suggestions |
| `Esc` | Dismiss suggestions |

Shell-native shortcuts (`Ctrl+C`, `Ctrl+D`, `Ctrl+Z`, `Ctrl+L`) pass through directly.

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
│  └── Settings & theme management           │
├─────────────────────────────────────────────┤
│  Tauri IPC (commands + events)             │
├─────────────────────────────────────────────┤
│  Rust (Native Layer)                        │
│  ├── PTY session management                │
│  ├── Path completion (filesystem)          │
│  ├── Shell command execution               │
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
│   │   ├── Terminal/             # Terminal, TabBar, SplitHandle, PaneContainer
│   │   └── Settings/            # Settings modal (tabbed)
│   ├── services/                 # Autocomplete engine, spec registry, recent dirs
│   ├── specs/                    # Command completion specs (git, docker, etc.)
│   ├── stores/                   # Zustand stores (settings, theme)
│   └── types/                    # TypeScript definitions (figy, terminal)
├── src-tauri/                    # Backend (Rust)
│   └── src/
│       ├── commands/             # Tauri IPC handlers
│       │   ├── terminal.rs       # PTY session create/write/resize/close
│       │   ├── autocomplete.rs   # Path completions
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
- [ ] Command history search (Ctrl+R enhancement)
- [ ] Plugin system for custom specs
- [ ] AI-powered command suggestions (local models)
- [ ] Snippet management
- [ ] Session restore on relaunch

## Contributing

We welcome contributions! Please read our [Contributing Guide](docs/CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE)
