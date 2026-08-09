# Contributing to FigyTerm

Thank you for your interest in contributing to FigyTerm! This guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Commit Guidelines](#commit-guidelines)
- [Pull Requests](#pull-requests)
- [Adding Command Specs](#adding-command-specs)
- [Reporting Bugs](#reporting-bugs)
- [Feature Requests](#feature-requests)

## Code of Conduct

This project follows a standard Code of Conduct. Be respectful, constructive, and inclusive in all interactions.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/figyterm.git
   cd figyterm
   ```
3. **Add upstream** remote:
   ```bash
   git remote add upstream https://github.com/code4mk/figyterm.git
   ```

## Development Setup

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) |
| Rust | 1.86+ | [rustup.rs](https://rustup.rs/) |
| Tauri CLI | 2.x | `cargo install tauri-cli` |

### macOS-specific

```bash
xcode-select --install
```

### Install & Run

```bash
# Install frontend dependencies
npm install

# Start development mode
npm run tauri dev
```

This starts:
- Vite dev server with HMR (frontend)
- Rust compilation and Tauri window (backend)

### Useful Commands

```bash
# Type check frontend
npx tsc --noEmit

# Check Rust compilation
cd src-tauri && cargo check

# Production build
npm run tauri build

# Format Rust code
cd src-tauri && cargo fmt

# Lint Rust code
cd src-tauri && cargo clippy
```

## Making Changes

### Branch Naming

Create a descriptive branch from `main`:

```bash
git checkout -b feat/split-pane-resize
git checkout -b fix/autocomplete-popup-position
git checkout -b docs/add-spec-guide
```

Prefixes:
- `feat/` — New feature
- `fix/` — Bug fix
- `refactor/` — Code refactoring
- `docs/` — Documentation
- `chore/` — Build, CI, dependency updates

### Code Style

**TypeScript/React:**
- Use functional components with hooks
- Prefer named exports
- Use Tailwind CSS for styling (no inline styles unless dynamic)
- Keep components focused — split large components into sub-components

**Rust:**
- Follow standard Rust conventions (`cargo fmt`)
- Use `Result` for fallible operations
- Document public functions

## Commit Guidelines

We follow conventional commit style:

```
<type>: <short description>

<optional body explaining why>
```

**Types:**
| Type | Usage |
|------|-------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation changes |
| `style` | Formatting, missing semicolons (no code logic change) |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `chore` | Build process, CI, dependency updates |

**Examples:**
```
feat: Add split pane support with Cmd+D shortcut

fix: Resolve autocomplete popup appearing inside quoted strings

docs: Add spec authoring guide
```

## Pull Requests

1. Keep PRs focused — one feature or fix per PR
2. Update the README if your change affects user-facing behavior
3. Add/update specs in `src/specs/` if adding command support
4. Test your changes:
   - Run `npm run tauri dev` and verify the feature works
   - Run `npx tsc --noEmit` to ensure no type errors
   - Run `cd src-tauri && cargo check` for Rust changes
5. Write a clear PR description explaining **what** and **why**

### PR Template

```markdown
## Summary
Brief description of changes.

## Changes
- Added X
- Fixed Y
- Updated Z

## Testing
How you verified the changes work correctly.

## Screenshots (if UI change)
Before/after screenshots.
```

## Adding Command Specs

One of the easiest ways to contribute is adding autocomplete specs for new commands.

See the [Spec Authoring Guide](SPECS.md) for detailed instructions.

Quick summary:
1. Create `src/specs/yourcommand.ts`
2. Define subcommands, options, and argument generators
3. Register it in `src/specs/index.ts`
4. Test with `npm run tauri dev`

## Reporting Bugs

When filing a bug report, please include:

1. **FigyTerm version** (from Settings or `package.json`)
2. **macOS version**
3. **Shell** (zsh, bash, fish)
4. **Steps to reproduce**
5. **Expected behavior**
6. **Actual behavior**
7. **Screenshots** (if visual bug)

Use the [Bug Report](https://github.com/code4mk/figyterm/issues/new?template=bug_report.md) issue template.

## Feature Requests

We welcome ideas! When requesting a feature:

1. **Check existing issues** to avoid duplicates
2. **Describe the use case** — what problem does it solve?
3. **Suggest an approach** (optional) — how might it work?

Use the [Feature Request](https://github.com/code4mk/figyterm/issues/new?template=feature_request.md) issue template.

## Architecture Overview

Understanding the codebase:

| Area | Location | Purpose |
|------|----------|---------|
| UI Components | `src/components/` | React components (Terminal, TabBar, Settings) |
| Autocomplete | `src/services/figy-autocomplete-engine.ts` | Spec parsing & suggestion logic |
| Specs | `src/specs/` | Command definitions (git, docker, etc.) |
| State | `src/stores/` | Zustand stores for settings, themes |
| Rust Commands | `src-tauri/src/commands/` | IPC handlers for PTY, filesystem, shell |
| PTY | `src-tauri/src/commands/terminal.rs` | Shell session management |

### Key Data Flow

```
User types → xterm.js onData → inputBuffer → triggerAutocomplete()
  → figy-autocomplete-engine (parse tokens, match spec)
  → SuggestionPopup (rendered via floating-ui)
  → User selects → acceptSuggestion() → write to PTY
```

## Questions?

Open a [Discussion](https://github.com/code4mk/figyterm/discussions) or reach out in issues. We're happy to help!
