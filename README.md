<p align="center">
  <img src="public/logo.png" alt="FigyTerm" width="80" />
</p>

<h1 align="center">FigyTerm</h1>

<p align="center">
  <strong>A modern, intelligent terminal for macOS with autocomplete superpowers.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
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

Download the latest `.dmg` from the [Releases](https://github.com/code4mk/figyterm/releases) page.

```bash
# Or build from source
git clone https://github.com/code4mk/figyterm.git
cd figyterm
npm install
npm run tauri build
```

The built app will be at `src-tauri/target/release/bundle/macos/FigyTerm.app`.

### Prerequisites (for building)

| Requirement | Version |
|-------------|---------|
| [Node.js](https://nodejs.org/) | 18+ |
| [Rust](https://rustup.rs/) | 1.86+ |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | 2.x |

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
