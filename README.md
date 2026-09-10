<p align="center">
  <img src="public/logo.png" alt="FigyTerm icon" height="64" />
  &nbsp;&nbsp;
  <img src="public/figyterm.png" alt="FigyTerm" height="64" />
</p>

<p align="center">
  <strong>A modern, intelligent terminal for macOS, Linux and Windows with autocomplete superpowers.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#code-editor">Editor</a> •
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
- **Embedded Code Editor** — A real editor beside the shell (`⌘⇧E`): CodeMirror 6, file tabs, a breadcrumb, and a resizable file tree. Click a `path:line:col` in terminal output and it opens there. Atomic saves with conflict detection, CRLF and BOM preserved, crash-safe drafts. Workspaces remember their own open tabs; fuzzy file finder (`⌘P`) and streamed project search (`⌘⇧F`). Loaded on first open, so it costs nothing at launch — see [the design notes](docs/CODE-EDITOR.md)
- **Git in the Editor** — Changed files badged in the tree, changed lines marked in the gutter, a branch indicator in the status bar, and a GitHub Desktop-style changes panel: tick the files, write a summary, commit. Discards to the trash, and runs your own `git`, so your hooks and credential helper apply
- **A Real Diff Viewer** — Unified or split, with word-level highlighting inside changed lines, and five presets (GitHub, GitLab, VS Code, delta, plain `git diff`) so it reads like the tool you already use
- **Markdown Preview** — GitHub-flavoured rendering with a live outline, scroll synced both ways, and clickable in-page and sibling-file links. No `dangerouslySetInnerHTML` anywhere, so a document can't inject markup
- **Command History Search** — Fuzzy-search past commands with picture-in-picture mode (`⌘R`)
- **System Monitor** — Live CPU and memory charts in a draggable modal (`⌘⇧M`)
- **Terminal Search** — Find text in the active pane (`⌘F`)
- **Command Palette** — Every action the app has, searchable, each spelled for the platform you're on (`⌘⇧P`)
- **Oh My Zsh Integration** — Real-time theme switching with full prompt rendering
- **Dark & Light Mode** — Beautifully themed UI that adapts to your preference (`⌘⇧L`)
- **Recent Directory Ordering** — Frequently visited folders appear first in suggestions
- **Clickable URLs** — Links in terminal output open in your default browser
- **Native Performance** — Rust PTY backend with zero-latency input

## Installation

macOS (Apple Silicon and Intel), Linux (x86_64) and Windows (x64) — see the
[installation guide](docs/INSTALLATION.md) for the full details.

**You only install once**: FigyTerm updates itself from then on. The exceptions are the
packages meant to be managed by something else — a Linux `.deb`/`.rpm` and the Windows
`.msi` — which stay with whatever installed them.

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

### Windows

Download `FigyTerm_*_x64-setup.exe` from [Releases](https://github.com/code4mk/figyterm/releases)
and run it. It installs for the current user, needs no administrator rights, and updates
itself from then on.

Windows shows **"Windows protected your PC"** the first time, because the installer
isn't code-signed — click **More info**, then **Run anyway**. There's no equivalent of
the macOS `curl` trick here: reputation accrues per binary as downloads accumulate.

An `.msi` is also published for Group Policy or Intune deployment. It doesn't
self-update, on purpose — a managed install stays managed.

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
| Xcode Command Line Tools (macOS) | `xcode-select --install` |
| WebKitGTK dev packages (Linux) | see [INSTALLATION.md](docs/INSTALLATION.md#building-from-source) |
| MSVC build tools + WebView2 (Windows) | Visual Studio 2022 C++ workload |

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

| macOS | Linux / Windows | Action |
|-------|----------------|--------|
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
| `⌘ ⇧ E` | `Ctrl+Shift+E` | Open code editor |
| `⌘ ⇧ M` | `Ctrl+Shift+M` | System monitor |
| `⌘ ⇧ L` | `Ctrl+Shift+L` | Toggle light/dark theme |
| `⌘ ⇧ P` | `Ctrl+Shift+P` | Command palette |
| `⌘ ,` | `Ctrl+,` | Settings |
| `⌘ 1-9` | `Ctrl+1-9` | Switch to tab N |
| `⌘ ⇧ [` | `Ctrl+Shift+[` | Previous tab |
| `⌘ ⇧ ]` | `Ctrl+Shift+]` | Next tab |
| `Tab` | `Tab` | Accept autocomplete suggestion |
| `↑ ↓` | `↑ ↓` | Navigate suggestions |
| `Esc` | `Esc` | Dismiss suggestions |

Shell-native shortcuts (`Ctrl+C`, `Ctrl+D`, `Ctrl+Z`, `Ctrl+L`, `Ctrl+R`) pass through
directly. That's why the second column uses `Ctrl+Shift` rather than plain `Ctrl`, the
same as GNOME Terminal, Konsole and Windows Terminal: a bare `Ctrl`+letter belongs to the shell, and an
app shortcut that took it would break the terminal it's wrapped around. The two chords
that would collide (`Ctrl+Shift+T` and `Ctrl+Shift+D` are already taken) fall back to
`Ctrl+Alt`.

### Inside the code editor

| macOS | Linux / Windows | Action |
|-------|----------------|--------|
| `⌘ S` | `Ctrl+S` | Save |
| `⌥ ⌘ S` | `Ctrl+Alt+S` | Save all |
| `⌘ P` | `Ctrl+P` | Go to file |
| `⌘ X` `⌘ C` `⌘ V` | `Ctrl+X` `Ctrl+C` `Ctrl+V` | Cut, copy, paste |
| `⌘ F` | `Ctrl+F` | Find in file |
| `⌥ ⌘ F` | `Ctrl+H` | Find and replace |
| `↵` / `⇧ ↵` | `Enter` / `Shift+Enter` | Next / previous match, in the find field |
| `⌘ ⇧ F` | `Ctrl+Shift+F` | Search in folder |
| `⌘ G` | `Ctrl+G` | Go to line |
| `⌘ W` | `Ctrl+W` | Close file tab |
| `⌘ B` | `Ctrl+B` | Toggle the file tree |
| `⌘ /` | `Ctrl+/` | Toggle comment |
| `⌘ D` | `Ctrl+D` | Select next occurrence |
| `⌘ 1-9` | `Ctrl+1-9` | Nth file tab |
| `Esc` | `Esc` | Close the editor |

These use plain `Ctrl` off macOS, unlike the table above. The reason the app
takes `Ctrl+Shift` elsewhere is that a bare `Ctrl`+letter belongs to the shell —
and inside the editor no shell has focus, so the conventional editor chords are
free to mean what they usually mean.

Right-clicking the text gives you cut, copy, paste, select all, undo, redo,
find, go to line, save and the path actions; right-clicking the file tree gives
you the file operations. Replace is `⌥⌘F` on macOS rather than the usual `⌘H`,
which belongs to the system.

## Code Editor

`⌘⇧E` opens an editor over the terminal, rooted at the focused pane's working
directory. It is **not** a second native webview like the browser: the browser
hosts pages it doesn't control, whereas the editor renders our own content, so
it's ordinary React in the app's own webview — no bounds arithmetic, no DPI
factor, no platform-specific container, and identical behaviour on all three
platforms. [The design notes](docs/CODE-EDITOR.md) go into why that difference
matters.

**Editing** is CodeMirror 6 — multi-cursor, folding, bracket matching, a real
search panel, and per-language grammars fetched on demand so opening a `.tsx`
doesn't pay for Rust and Python. There's no language server; word completion
from the open document covers the "finish this identifier" case.

**Saving is the part that had to be right.** Writes go to a sibling temp file
and are renamed over the target, so a crash can't leave a half-written file.
Every save carries the mtime the buffer was loaded at, so a file changed by
something else is never silently clobbered — you get overwrite, reload, or
cancel. Line endings and byte-order marks are written back exactly as found,
which is what stops a one-line edit becoming a whole-file diff. Dirty buffers
are journalled while you type and offered back after a crash.

**It knows it's in a terminal.** Paths in output are clickable — a `tsc` error,
a stack trace, a `grep -n` hit — and open at the right line. The tree offers
"open a terminal here". The workspace follows the shell.

**Git is built in.** Changed files are coloured and badged in the tree, changed
lines get a bar in the gutter beside the line number, and the branch (with
ahead/behind) sits in the status bar. The changes panel is shaped like GitHub
Desktop's: one list of what changed, a checkbox per file for what goes in the
next commit, and a summary/description box with **Commit N files to `main`**.
Clicking a file opens its diff against HEAD in a `diff-check` tab beside your
files, **unified or split**, with the changed *words* inside a line highlighted
the way GitHub does it — and a style picker covering GitHub, GitLab, VS Code,
delta and plain `git diff`, so it can look like whichever one you already read
diffs in. It shells out to your own `git`, so
your hooks, credential helper and `.gitattributes` all apply. Discarding an
untracked file moves it to the trash rather than deleting it, which is the one
thing `git clean` gets wrong for an editor. Hunk-level staging, branch switching
and push/pull are deliberately left to the shell.

**Workspaces** each remember their own open tabs and expanded folders, can be
starred, and are switched from a picker (click the folder name in the
breadcrumb). Both the editor and the browser can go picture-in-picture or
fullscreen, and clicking one brings it to the front.

Deliberately absent for now: git decorations in the tree, diffing, and a
language server. Reasons and a plan are in [docs/CODE-EDITOR.md](docs/CODE-EDITOR.md).

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
│  ├── Code editor (CodeMirror 6, in-webview)│
│  └── Settings & theme management           │
├─────────────────────────────────────────────┤
│  Tauri IPC (commands + events)             │
├─────────────────────────────────────────────┤
│  Rust (Native Layer)                        │
│  ├── PTY session management                │
│  ├── Path completion (filesystem)          │
│  ├── Editor filesystem (confined to roots) │
│  ├── File watching (notify) & project grep │
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
| Editor | CodeMirror 6 (per-language grammars, lazily imported) |
| Desktop | Tauri 2.x |
| Native | Rust |
| PTY | portable-pty |
| File watching | notify |
| Project search | ignore (ripgrep's walker), regex |
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
│   │   ├── Editor/               # Code editor: surface, tabs, tree, preview
│   │   ├── Overlay/              # Overlay portal & error boundary
│   │   ├── Terminal/             # Terminal, TabBar, HistorySearch, SystemMonitor
│   │   └── Settings/             # Settings modal (tabbed)
│   ├── hooks/                    # Draggable modals, file watching
│   ├── services/                 # Autocomplete, browser & editor IPC, specs
│   ├── specs/                    # Command completion specs (git, docker, etc.)
│   ├── stores/                   # Zustand stores (settings, theme, editor)
│   └── types/                    # TypeScript definitions (figy, terminal)
├── src-tauri/                    # Backend (Rust)
│   └── src/
│       ├── commands/             # Tauri IPC handlers
│       │   ├── terminal.rs       # PTY session create/write/resize/close
│       │   ├── browser.rs        # Child webview lifecycle & navigation
│       │   ├── autocomplete.rs   # Path completions & shell history
│       │   ├── fs.rs             # Editor filesystem, confined to roots
│       │   ├── fs_watch.rs       # File watching, debounced
│       │   ├── system.rs         # CPU/memory stats
│       │   └── shell_exec.rs     # Shell command execution
│       ├── filesystem/           # Read, atomic write, search, hidden files
│       └── lib.rs                # App entry point
├── docs/                         # Documentation
│   ├── CODE-EDITOR.md            # Editor design notes & decisions
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
- [x] Embedded code editor with file tree (`⌘⇧E`)
- [x] Markdown preview with a synced outline
- [ ] Git status in the editor's file tree and gutter
- [ ] Plugin system for custom specs
- [ ] AI-powered command suggestions (local models)
- [ ] Snippet management
- [ ] Session restore on relaunch

## Contributing

We welcome contributions! Please read our [Contributing Guide](docs/CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE)
