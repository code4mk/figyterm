# My Terminal

A cross-platform desktop terminal application built with Tauri 2, React, and Rust. Figyterm is a fully local desktop application with no backend server required.

## Architecture

```
React (UI Layer)
  │
  │ Tauri IPC
  ▼
Rust (Native Layer)
  │
  ├── PTY management (persistent shell sessions)
  ├── Filesystem operations
  ├── Git operations
  └── Process management
```

### Key Design Decisions

- **Real PTY sessions** — Each terminal tab maintains a persistent shell process via PTY, not independent command executions.
- **No backend server** — All communication between frontend and Rust uses Tauri IPC (commands/events).
- **Offline-first** — Core functionality works without network access.
- **xterm.js for rendering** — Terminal output is handled directly by xterm.js, not React state.
- **Streaming output via events** — PTY output is emitted to the frontend through Tauri events for efficient real-time rendering.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Terminal rendering | xterm.js, @xterm/addon-fit, @xterm/addon-web-links |
| Desktop runtime | Tauri 2.x |
| Native layer | Rust |
| PTY | portable-pty |
| State management | Zustand |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (1.86+)
- Platform-specific Tauri dependencies ([see Tauri docs](https://v2.tauri.app/start/prerequisites/))

### Install & Run

```bash
# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev
```

### Build for Production

```bash
npm run tauri build
```

## Project Structure

```
figy-term/
├── src/                          # Frontend (React + TypeScript)
│   ├── components/
│   │   ├── AppShell/             # Main application shell
│   │   ├── Terminal/             # Terminal UI (xterm.js integration)
│   │   ├── CommandPalette/       # Command palette (Cmd+K)
│   │   └── Settings/            # Settings panel
│   ├── hooks/                    # React hooks (useTerminal, useTerminalTabs)
│   ├── services/                 # Tauri IPC service layer
│   ├── stores/                   # Zustand state stores
│   └── types/                    # TypeScript type definitions
├── src-tauri/                    # Backend (Rust)
│   └── src/
│       ├── terminal/             # PTY session management
│       ├── filesystem/           # Filesystem operations
│       ├── git/                  # Git integration
│       ├── commands/             # Tauri command handlers
│       └── state/               # Application state
├── package.json
└── README.md
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + T` | New terminal tab |
| `Cmd/Ctrl + W` | Close current tab |
| `Cmd/Ctrl + K` | Command palette |
| `Cmd/Ctrl + Shift + P` | Command palette |
| `Cmd/Ctrl + Tab` | Next tab |
| `Cmd/Ctrl + Shift + Tab` | Previous tab |

Terminal-native shortcuts (Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, Ctrl+R) pass through to the shell.

## Development Phases

### Phase 1 (Current) — Terminal Foundation
- Tauri + React + xterm.js
- Real PTY sessions in Rust
- Multiple terminal tabs
- Keyboard shortcuts
- Shell detection (zsh, bash, fish, PowerShell)
- Terminal resize
- Dark theme

### Phase 2 — Intelligence
- Autocomplete engine
- Filesystem suggestions
- Git-aware suggestions
- Command specifications
- Command history
- Command palette enhancements

### Phase 3 — AI Integration
- AI provider abstraction (OpenAI, Anthropic, Gemini, Ollama)
- Command generation
- Command explanation
- Error explanation

### Phase 4 — Advanced Features
- Split panes
- Workspaces
- Docker/Kubernetes/AWS integration
- SSH sessions
- Remote terminals

## License

MIT
