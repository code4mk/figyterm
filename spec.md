# Local AI Terminal — Technical Specification

## 1. Project Overview

Build a cross-platform desktop terminal application inspired by the interaction model of Fig, but implemented as a fully local desktop application.

The application must:

* Run without a backend server owned by the application.
* Execute shell commands directly on the user's machine.
* Provide a real persistent terminal using PTY.
* Support multiple terminal tabs.
* Provide a modern terminal UI.
* Provide command autocomplete/suggestions.
* Provide Git-aware and filesystem-aware suggestions.
* Be architected so AI assistance can be added later.
* Work on macOS, Linux, and Windows where technically supported.

The application should feel like a modern developer terminal rather than a traditional terminal emulator.

---

# 2. Technology Stack

## Frontend

* React
* TypeScript
* Vite
* Tailwind CSS
* xterm.js
* xterm-addon-fit
* xterm-addon-web-links

## Desktop Runtime

* Tauri 2.x
* Rust

## Native Layer

Rust is responsible for:

* PTY creation
* Shell process management
* Terminal input/output
* Filesystem operations
* Git operations
* Process management
* OS integration
* Application configuration

## Frontend ↔ Rust Communication

Use Tauri commands/events.

Do not create an HTTP server between the frontend and Rust.

Architecture:

```text
React
  │
  │ Tauri IPC
  ▼
Rust
  │
  ├── PTY
  ├── Filesystem
  ├── Git
  └── Process management
```

---

# 3. Important Architecture Principle

The application must NOT depend on a remote backend for core terminal functionality.

This must work while completely offline:

```text
Create terminal
      ↓
Start shell
      ↓
Run commands
      ↓
Read filesystem
      ↓
Run git
      ↓
Autocomplete commands
```

No API server should be required.

AI integration must be an optional layer.

---

# 4. Application Architecture

```text
figy-term/
├── src/
│
│   │   ├── Sidebar/
│   │   │   ├── Sidebar.tsx
│   │   │   └── WorkspaceTree.tsx
│   │   │
│   │   ├── CommandPalette/
│   │   │   └── CommandPalette.tsx
│   │   │
│   │   └── Settings/
│   │       └── Settings.tsx
│   │
│   ├── hooks/
│   │   ├── useTerminal.ts
│   │   ├── useTerminalTabs.ts
│   │   └── useAutocomplete.ts
│   │
│   ├── services/
│   │   ├── terminal.ts
│   │   ├── filesystem.ts
│   │   ├── git.ts
│   │   ├── autocomplete.ts
│   │   └── settings.ts
│   │
│   ├── stores/
│   │   ├── terminalStore.ts
│   │   ├── settingsStore.ts
│   │   └── workspaceStore.ts
│   │
│   ├── types/
│   │   ├── terminal.ts
│   │   ├── autocomplete.ts
│   │   └── git.ts
│   │
│   ├── App.tsx
│   └── main.tsx
│
├── src-tauri/
│
│   ├── src/
│   │
│   │   ├── main.rs
│   │   │
│   │   ├── terminal/
│   │   │   ├── mod.rs
│   │   │   ├── pty.rs
│   │   │   ├── session.rs
│   │   │   └── manager.rs
│   │   │
│   │   ├── filesystem/
│   │   │   ├── mod.rs
│   │   │   └── operations.rs
│   │   │
│   │   ├── git/
│   │   │   ├── mod.rs
│   │   │   └── operations.rs
│   │   │
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   └── terminal.rs
│   │   │
│   │   └── state/
│   │       └── app_state.rs
│   │
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── package.json
└── README.md
```

---

# 5. Terminal Engine

The terminal must use a real PTY.

Do NOT implement terminal execution using independent commands such as:

```rust
Command::new("ls")
```

for each command.

A terminal tab must maintain a persistent shell process.

Example:

```text
Terminal Tab
     │
     ▼
PTY Session
     │
     ▼
Shell Process
     │
     ├── stdin
     ├── stdout
     └── stderr
```

Supported shells:

### macOS/Linux

Detect in this order:

```text
$SHELL
/bin/zsh
/bin/bash
/bin/fish
```

### Windows

Detect:

```text
PowerShell
cmd.exe
```

The shell must remain alive for the lifetime of the terminal tab.

---

# 6. PTY Session Model

Each terminal tab has a unique session ID.

Example:

```typescript
interface TerminalSession {
  id: string;
  shell: string;
  cwd: string;
  title: string;
  createdAt: number;
  status: "running" | "exited";
}
```

Rust should maintain:

```text
HashMap<SessionId, PtySession>
```

Each PTY session must support:

```text
create_session
write_to_session
resize_session
close_session
get_session_info
```

Terminal output should be emitted to the frontend through Tauri events.

Example event:

```text
terminal-output
```

Payload:

```json
{
  "sessionId": "abc123",
  "data": "hello world\n"
}
```

---

# 7. Terminal UI

The UI should resemble a modern developer terminal.

Layout:

```text
┌──────────────────────────────────────────────────────────┐
│  Terminal                              +    ⌘K    ⚙       │
├──────────────────────────────────────────────────────────┤
│  Tab 1       Tab 2       Tab 3                         + │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ~/projects/my-app                                       │
│  $ git status                                            │
│                                                          │
│  On branch main                                          │
│  Your branch is up to date.                              │
│                                                          │
│  $ npm run dev                                           │
│                                                          │
│  > my-app@1.0.0 dev                                      │
│  > vite                                                  │
│                                                          │
│  Local: http://localhost:5173                            │
│                                                          │
│  $ _                                                     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

The terminal rendering itself must use xterm.js.

Do not implement terminal ANSI rendering manually.

---

# 8. Terminal Tabs

Users must be able to:

* Create tab
* Close tab
* Switch tab
* Rename tab
* Duplicate tab
* Restart terminal
* Split terminal in the future

Each tab owns exactly one PTY session.

Example:

```text
Tab 1 → PTY 001 → zsh
Tab 2 → PTY 002 → zsh
Tab 3 → PTY 003 → zsh
```

Closing a tab must terminate its PTY process.

---

# 9. Working Directory

Each terminal has its own current working directory.

When the shell executes:

```bash
cd ~/projects
```

the shell itself controls the working directory.

The frontend should not attempt to emulate shell state.

The application may separately detect the current directory for UI purposes.

Display:

```text
~/projects/my-app
```

in the terminal header when possible.

---

# 10. Terminal Resize

When the application window changes size:

```text
React
 ↓
xterm.js dimensions
 ↓
Tauri IPC
 ↓
Rust PTY resize
```

The PTY must receive updated rows/columns.

Do not restart the shell when resizing.

---

# 11. Keyboard Support

Required shortcuts:

```text
Cmd/Ctrl + T
    New terminal

Cmd/Ctrl + W
    Close terminal

Cmd/Ctrl + Shift + T
    Reopen terminal

Cmd/Ctrl + K
    Command palette

Cmd/Ctrl + Shift + P
    Command palette

Cmd/Ctrl + Tab
    Next terminal

Cmd/Ctrl + Shift + Tab
    Previous terminal
```

Terminal-native shortcuts such as:

```text
Ctrl+C
Ctrl+D
Ctrl+Z
Ctrl+L
Ctrl+R
```

must continue to work normally.

Do not intercept them unnecessarily.

---

# 12. Autocomplete Engine

Autocomplete is a separate subsystem.

It must not be tightly coupled to the PTY.

Architecture:

```text
User input
    ↓
Autocomplete Engine
    ↓
Context Analyzer
    ↓
Suggestion Providers
    ↓
Ranker
    ↓
Suggestions
```

Providers:

```text
CommandProvider
FilesystemProvider
GitProvider
EnvironmentProvider
HistoryProvider
```

Future:

```text
DockerProvider
KubernetesProvider
AWSProvider
TerraformProvider
AIProvider
```

---

# 13. Command Specification System

Create a local command specification format.

Example:

```json
{
  "name": "git",
  "description": "Distributed version control system",
  "subcommands": [
    {
      "name": "checkout",
      "description": "Switch branches or restore files"
    },
    {
      "name": "commit",
      "description": "Record changes to the repository"
    },
    {
      "name": "branch",
      "description": "List, create, or delete branches"
    }
  ]
}
```

The system must support:

```text
command
subcommand
arguments
options
descriptions
examples
```

Example:

```text
git checkout

Options:

-b
Create a new branch

-B
Create/reset branch

--detach
Detach HEAD
```

---

# 14. Autocomplete UI

When the user types:

```text
git che
```

display:

```text
┌─────────────────────────────────────────┐
│ git checkout                            │
│ Switch branches or restore files        │
├─────────────────────────────────────────┤
│ git cherry-pick                         │
│ Apply changes from existing commits     │
├─────────────────────────────────────────┤
│ git check-attr                          │
└─────────────────────────────────────────┘
```

Suggestions should appear near the cursor.

Keyboard:

```text
↑ / ↓
    Navigate

Tab
    Accept

Enter
    Accept

Esc
    Close
```

Autocomplete must never prevent normal shell input.

---

# 15. Filesystem Suggestions

When the user types:

```bash
cd ~/pro
```

suggest:

```text
~/projects/
~/production/
~/programming/
```

When typing:

```bash
cat ./src/
```

suggest files/directories from the current path.

Filesystem suggestions must be asynchronous.

Do not block the UI while scanning directories.

Respect filesystem permissions.

---

# 16. Git Integration

Detect whether the current directory is a Git repository.

For example:

```bash
git status --short --branch
```

Use Git information for suggestions.

Example:

```text
git checkout
```

suggest:

```text
main
develop
feature/auth
feature/payment
```

For:

```text
git switch
```

suggest local branches.

For:

```text
git add
```

suggest modified/untracked files.

Git integration should be implemented as a separate Rust module.

---

# 17. Command History

Maintain local command history.

History should include:

```typescript
interface CommandHistoryEntry {
  command: string;
  cwd: string;
  timestamp: number;
}
```

History should be searchable.

Example:

```text
Cmd + R

Search commands...

docker compose up
docker compose up -d
kubectl get pods
git checkout develop
```

Do not store passwords or obvious secret values.

History storage should be local.

---

# 18. Command Palette

Implement a global command palette.

Shortcut:

```text
Cmd/Ctrl + K
```

Example:

```text
┌────────────────────────────────────────────┐
│ Search commands...                         │
├────────────────────────────────────────────┤
│ New Terminal                               │
│ Close Terminal                             │
│ Split Terminal                             │
│ Search History                             │
│ Open Settings                              │
│ Change Theme                               │
│ Clear Terminal                             │
└────────────────────────────────────────────┘
```

Commands should be searchable.

---

# 19. Settings

Settings should be local.

Initial settings:

```typescript
interface Settings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  shell: string | null;
}
```

Store settings using Tauri's local application storage.

---

# 20. Themes

Implement theme support.

At minimum:

```text
Dark
Light
System
```

The architecture should allow custom terminal themes later.

---

# 21. Security

Security is critical because this application executes arbitrary shell commands.

Rules:

1. Never execute shell commands from the frontend directly.
2. All process execution must happen in Rust.
3. Validate Tauri IPC inputs.
4. Do not expose arbitrary filesystem APIs unnecessarily.
5. Use Tauri capabilities/permissions correctly.
6. Do not create an HTTP server.
7. Do not expose a localhost API unless explicitly required later.
8. Do not send terminal output anywhere by default.
9. AI integrations must be opt-in.
10. API keys must never be committed to source control.

---

# 22. AI Architecture — Future

AI must be implemented as an optional provider layer.

```text
AIProvider
    │
    ├── OpenAIProvider
    ├── AnthropicProvider
    ├── GeminiProvider
    └── OllamaProvider
```

Interface:

```typescript
interface AIProvider {
  generateCommand(context: CommandContext): Promise<string>;
  explainCommand(command: string): Promise<string>;
  explainError(context: TerminalErrorContext): Promise<string>;
}
```

AI should receive only the minimum required context.

Example:

```text
User:
"Why did my Docker build fail?"

Context:

command:
docker build .

exitCode:
1

output:
...
```

The AI provider should be called directly from the desktop application or through a user-configured provider.

No application-owned backend is required.

---

# 23. AI Command Generation

Future feature:

User opens AI command palette:

```text
┌────────────────────────────────────────────┐
│ What do you want to do?                    │
│                                            │
│ deploy my current app to kubernetes        │
└────────────────────────────────────────────┘
```

AI returns:

```bash
kubectl apply -f deployment.yaml
```

Before execution:

```text
┌────────────────────────────────────────────┐
│ Proposed command                           │
│                                            │
│ kubectl apply -f deployment.yaml           │
│                                            │
│ [Cancel]                   [Run Command]   │
└────────────────────────────────────────────┘
```

Never execute AI-generated commands automatically without explicit user confirmation.

---

# 24. Offline-First Requirement

The application must remain useful with zero network access.

Offline functionality:

```text
Terminal              ✓
PTY                   ✓
Shell                 ✓
Filesystem            ✓
Git                   ✓
Autocomplete          ✓
History               ✓
Command palette       ✓
Themes                ✓
Settings              ✓
```

Optional network functionality:

```text
Cloud AI               optional
Updates                optional
Telemetry              optional
```

No telemetry should be enabled by default.

---

# 25. Performance Requirements

The terminal must remain responsive while commands produce large amounts of output.

Requirements:

* Do not render every output chunk through React state.
* xterm.js should handle terminal rendering directly.
* Rust should stream PTY output efficiently.
* Avoid unnecessary serialization.
* Autocomplete must not block terminal input.
* Filesystem scanning must be asynchronous.
* Git operations must not block the UI.
* Large terminal output must not freeze the application.

Target:

```text
Typing latency:
< 16 ms perceived UI latency

Autocomplete:
< 100 ms for normal local suggestions

Terminal:
Smooth while handling large output
```

---

# 26. MVP Scope

The first implementation should ONLY include:

### Phase 1

```text
Tauri
React
TypeScript
Tailwind
xterm.js
Rust
PTY
```

Features:

* Application window
* Terminal UI
* Create terminal
* Persistent shell
* Input/output
* Resize
* Multiple tabs
* Close tabs
* Basic keyboard shortcuts
* macOS/Linux shell detection
* Windows shell detection
* Clean application shutdown

Do NOT implement AI in Phase 1.

Do NOT implement autocomplete in Phase 1.

The goal is to first prove that the PTY architecture is correct.

---

# 27. Phase 2

Add:

```text
Autocomplete
Filesystem suggestions
Command history
Git integration
Command specifications
Command palette
```

---

# 28. Phase 3

Add:

```text
AI provider abstraction
OpenAI
Anthropic
Gemini
Ollama
Command generation
Command explanation
Error explanation
```

---

# 29. Phase 4

Add advanced developer features:

```text
Split panes
Workspaces
Project detection
Docker integration
Kubernetes integration
AWS integration
Terraform integration
SSH sessions
Remote terminals
AI agent
```

SSH/remote terminal support should remain separate from the local PTY implementation.

---

# 30. Acceptance Criteria

The MVP is complete when:

### Terminal

* Application launches successfully.
* A terminal automatically opens.
* User can type shell commands.
* Commands execute in the real local shell.
* `cd` persists.
* Environment variables persist.
* Ctrl+C works.
* Ctrl+D works.
* Ctrl+Z works.
* Terminal resize works.
* ANSI colors work.
* Interactive applications work where supported.

Examples:

```bash
top
vim
python
ssh
git
npm
```

### Tabs

* Multiple terminal sessions can run simultaneously.
* Each tab has an independent shell.
* Closing a tab terminates its process.
* Switching tabs preserves terminal state.

### UI

* Terminal is responsive.
* No unnecessary React rerendering occurs for terminal output.
* Dark theme works.
* Keyboard navigation works.

### Architecture

* No backend server exists.
* No HTTP API is required.
* Shell execution happens in Rust.
* PTY management happens in Rust.
* Frontend communicates with Rust using Tauri IPC.
* Core functionality works offline.

---

# 31. Cursor Agent Instructions

When implementing this project:

1. Start with Phase 1 only.
2. Do not implement future features prematurely.
3. Do not create a backend server.
4. Do not use Node.js for shell execution.
5. Use Rust for process/PTY management.
6. Use xterm.js for terminal rendering.
7. Keep terminal state separate from React rendering.
8. Keep PTY management isolated from UI code.
9. Use strongly typed TypeScript interfaces.
10. Use strongly typed Rust structures.
11. Keep modules small and focused.
12. Add error handling for all IPC operations.
13. Do not silently swallow Rust errors.
14. Add logging for PTY lifecycle events.
15. Ensure child processes are cleaned up when the application exits.
16. Do not add AI until Phase 1 is stable.
17. Do not add unnecessary dependencies.
18. Prefer native Tauri functionality over introducing a server.
19. Keep the architecture extensible for autocomplete providers.
20. Write a README explaining how the architecture works.

Before implementing a feature, inspect the existing project structure and avoid duplicating functionality.

After each major implementation step, run:

```bash
npm run build
```

and the appropriate Tauri development/build command.

Fix compilation/type errors before moving to the next feature.

---

# 32. Definition of Done

A developer should be able to clone the repository, install dependencies, and run:

```bash
npm install
npm run tauri dev
```

and receive a desktop application containing a working terminal.

The resulting application should be a real local terminal, not a web-based terminal simulation.

The architecture must be ready for the next phase:

```text
PTY
 ↓
Terminal
 ↓
Autocomplete
 ↓
Command Intelligence
 ↓
AI
```

The project should prioritize correctness of the PTY/terminal foundation over visual polish during Phase 1.
