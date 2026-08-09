# FigyTerm Spec Repository Guide

This document explains how to set up and maintain the `figy-specs` repository — the community-driven autocomplete spec registry for FigyTerm.

## Repository Structure

```
figy-specs/
├── registry.json          # Index of all available specs (metadata)
├── specs/                 # One .ts file per command
│   ├── kubectl.ts
│   ├── terraform.ts
│   ├── aws.ts
│   ├── cargo.ts
│   ├── pip.ts
│   ├── curl.ts
│   └── ...
├── icons/                 # PNG icons for commands (optional)
│   ├── kubectl.png
│   ├── terraform.png
│   ├── aws.png
│   └── ...
├── README.md
├── CONTRIBUTING.md
└── scripts/
    └── validate.js        # Validates all specs before merge
```

## registry.json

This is the catalog that FigyTerm fetches to show available specs. It must be kept in sync with the `specs/` folder.

```json
{
  "version": 1,
  "specs": [
    {
      "name": "kubectl",
      "description": "Kubernetes command-line tool",
      "category": "DevOps",
      "icon": true
    },
    {
      "name": "terraform",
      "description": "Infrastructure as Code by HashiCorp",
      "category": "DevOps",
      "icon": true
    },
    {
      "name": "aws",
      "description": "AWS Command Line Interface v2",
      "category": "Cloud",
      "icon": true
    },
    {
      "name": "cargo",
      "description": "Rust package manager and build tool",
      "category": "Languages",
      "icon": false
    },
    {
      "name": "pip",
      "description": "Python package installer",
      "category": "Languages",
      "icon": false
    },
    {
      "name": "curl",
      "description": "Transfer data with URLs",
      "category": "Networking",
      "icon": false
    }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Command name (must match the `.ts` filename) |
| `description` | string | yes | Short description shown in Settings UI |
| `category` | string | yes | Grouping for the UI (DevOps, Cloud, Languages, etc.) |
| `icon` | boolean | yes | Whether an icon exists in `icons/{name}.png` |

### Categories

Use consistent categories:

- **DevOps** — kubectl, terraform, ansible, helm, vagrant
- **Cloud** — aws, gcloud, az, vercel, netlify, heroku, fly
- **Languages** — cargo, pip, conda, gem, composer, go, deno, bun
- **Databases** — psql, mysql, redis-cli, mongo, sqlite3
- **Networking** — curl, wget, httpie, ssh, scp, rsync
- **Containers** — podman, buildah, skopeo, nerdctl
- **Version Control** — gh, gitlab, hg
- **System** — systemctl, journalctl, apt, dnf, pacman
- **Utilities** — jq, yq, fzf, ripgrep, fd, bat, eza

## Spec File Format

Each spec is a TypeScript file that exports a `completionSpec` object as the default export.

### Minimal Example (`specs/curl.ts`)

```typescript
// @ts-nocheck
const completionSpec: Figy.Spec = {
  name: "curl",
  description: "Transfer data with URLs",
  options: [
    {
      name: ["-X", "--request"],
      description: "HTTP method",
      args: {
        name: "method",
        suggestions: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
      },
    },
    {
      name: ["-H", "--header"],
      description: "Pass custom header",
      isRepeatable: true,
      args: { name: "header" },
    },
    {
      name: ["-d", "--data"],
      description: "HTTP POST data",
      args: { name: "data" },
    },
    {
      name: ["-o", "--output"],
      description: "Write output to file",
      args: { name: "file", template: "filepaths" },
    },
    {
      name: ["-L", "--location"],
      description: "Follow redirects",
    },
    {
      name: ["-v", "--verbose"],
      description: "Make the operation more talkative",
    },
    {
      name: ["-s", "--silent"],
      description: "Silent mode",
    },
  ],
  args: {
    name: "url",
    description: "URL to request",
  },
};

export default completionSpec;
```

### Full Example with Subcommands (`specs/cargo.ts`)

```typescript
// @ts-nocheck
const completionSpec: Figy.Spec = {
  name: "cargo",
  description: "Rust package manager and build tool",
  subcommands: [
    {
      name: "build",
      description: "Compile the current package",
      options: [
        { name: "--release", description: "Build in release mode" },
        { name: "--all-targets", description: "Build all targets" },
        {
          name: ["-p", "--package"],
          description: "Package to build",
          args: { name: "spec" },
        },
        {
          name: "--target",
          description: "Build for the given target triple",
          args: { name: "triple" },
        },
      ],
    },
    {
      name: "run",
      description: "Run a binary or example",
      options: [
        { name: "--release", description: "Run in release mode" },
        {
          name: "--bin",
          description: "Name of the bin target to run",
          args: { name: "name" },
        },
        {
          name: "--example",
          description: "Run the given example",
          args: { name: "name" },
        },
      ],
      args: {
        name: "args",
        isVariadic: true,
        isOptional: true,
      },
    },
    {
      name: "test",
      description: "Run the tests",
      options: [
        { name: "--release", description: "Test in release mode" },
        { name: "--all", description: "Test all packages in workspace" },
        { name: "--no-run", description: "Compile but don't run tests" },
      ],
      args: {
        name: "testname",
        isOptional: true,
      },
    },
    {
      name: "add",
      description: "Add dependencies to Cargo.toml",
      args: {
        name: "crate",
        isVariadic: true,
      },
      options: [
        { name: "--dev", description: "Add as dev dependency" },
        { name: "--build", description: "Add as build dependency" },
        { name: "--optional", description: "Mark as optional" },
        {
          name: "--features",
          description: "Enable specific features",
          args: { name: "features" },
        },
      ],
    },
    {
      name: "init",
      description: "Create a new Cargo package in existing directory",
      options: [
        { name: "--lib", description: "Create a library package" },
        { name: "--bin", description: "Create a binary package" },
        {
          name: "--name",
          description: "Package name",
          args: { name: "name" },
        },
      ],
    },
    {
      name: "new",
      description: "Create a new Cargo package",
      args: { name: "path", template: "folders" },
      options: [
        { name: "--lib", description: "Create a library package" },
        { name: "--bin", description: "Create a binary package" },
      ],
    },
    {
      name: "publish",
      description: "Package and upload to crates.io",
      options: [
        { name: "--dry-run", description: "Perform checks without uploading" },
        { name: "--allow-dirty", description: "Allow dirty working directory" },
      ],
    },
    {
      name: "clean",
      description: "Remove generated artifacts",
      options: [
        { name: "--release", description: "Clean release artifacts" },
      ],
    },
    {
      name: "update",
      description: "Update dependencies in Cargo.lock",
    },
    {
      name: "fmt",
      description: "Format Rust code",
      options: [
        { name: "--check", description: "Check formatting without modifying" },
      ],
    },
    {
      name: "clippy",
      description: "Run the Clippy linter",
      options: [
        { name: "--fix", description: "Automatically fix warnings" },
        { name: "--all-targets", description: "Check all targets" },
      ],
    },
  ],
  options: [
    { name: ["-V", "--version"], description: "Print version" },
    { name: ["-h", "--help"], description: "Print help" },
    { name: "--list", description: "List installed commands" },
    { name: ["-v", "--verbose"], description: "Use verbose output" },
    { name: ["-q", "--quiet"], description: "Suppress output" },
  ],
};

export default completionSpec;
```

### Example with Generators (`specs/gh.ts`)

```typescript
// @ts-nocheck
const completionSpec: Figy.Spec = {
  name: "gh",
  description: "GitHub CLI",
  subcommands: [
    {
      name: "pr",
      description: "Manage pull requests",
      subcommands: [
        {
          name: "checkout",
          description: "Check out a pull request",
          args: {
            name: "number",
            description: "PR number",
            generators: {
              script: ["gh", "pr", "list", "--json", "number,title", "--limit", "20"],
              postProcess: (out) => {
                try {
                  return JSON.parse(out).map((pr) => ({
                    name: String(pr.number),
                    description: pr.title,
                  }));
                } catch { return []; }
              },
            },
          },
        },
        {
          name: "create",
          description: "Create a pull request",
          options: [
            { name: ["-t", "--title"], description: "Title", args: { name: "title" } },
            { name: ["-b", "--body"], description: "Body", args: { name: "body" } },
            { name: ["-d", "--draft"], description: "Create as draft" },
            { name: ["-B", "--base"], description: "Base branch", args: { name: "branch" } },
          ],
        },
        { name: "list", description: "List pull requests" },
        { name: "view", description: "View a pull request" },
        { name: "merge", description: "Merge a pull request" },
        { name: "close", description: "Close a pull request" },
      ],
    },
    {
      name: "issue",
      description: "Manage issues",
      subcommands: [
        { name: "create", description: "Create an issue" },
        { name: "list", description: "List issues" },
        { name: "view", description: "View an issue" },
        { name: "close", description: "Close an issue" },
      ],
    },
    {
      name: "repo",
      description: "Manage repositories",
      subcommands: [
        { name: "clone", description: "Clone a repository", args: { name: "repo" } },
        { name: "create", description: "Create a new repository" },
        { name: "fork", description: "Fork a repository" },
        { name: "view", description: "View a repository" },
      ],
    },
  ],
};

export default completionSpec;
```

## Icons

- Format: PNG, 64x64px or 128x128px
- Filename: Must match the spec name (`kubectl.png` for `kubectl.ts`)
- Background: Transparent preferred
- Keep file size under 20KB

## Porting Fig Specs

The Fig autocomplete community has 600+ specs at [withfig/autocomplete](https://github.com/withfig/autocomplete). To port one:

1. Copy the `.ts` file from Fig's `src/` folder
2. Add `// @ts-nocheck` at the top
3. Replace `Fig.` with `Figy.` (namespace)
4. Replace `fig://` with `figy://` (icon URLs, optional)
5. Remove any Fig-specific imports (e.g., `@fig/autocomplete-generators`)
6. Ensure `export default completionSpec;` exists at the bottom
7. Test locally by placing in `~/.figyterm/specs/`

### Quick port script:

```bash
# Download a Fig spec and convert it
curl -s "https://raw.githubusercontent.com/withfig/autocomplete/master/src/kubectl.ts" \
  | sed '1i // @ts-nocheck' \
  | sed 's/Fig\./Figy./g' \
  | sed 's/fig:\/\//figy:\/\//g' \
  > specs/kubectl.ts
```

## Validation Script

Create `scripts/validate.js` to run in CI:

```javascript
const fs = require("fs");
const path = require("path");

const specsDir = path.join(__dirname, "..", "specs");
const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "registry.json"), "utf8"));

let errors = 0;

// Check all registry entries have corresponding files
for (const entry of registry.specs) {
  const specPath = path.join(specsDir, `${entry.name}.ts`);
  if (!fs.existsSync(specPath)) {
    console.error(`MISSING: ${entry.name}.ts not found in specs/`);
    errors++;
  }
  if (entry.icon) {
    const iconPath = path.join(__dirname, "..", "icons", `${entry.name}.png`);
    if (!fs.existsSync(iconPath)) {
      console.error(`MISSING ICON: ${entry.name}.png not found in icons/`);
      errors++;
    }
  }
}

// Check all spec files are in registry
const specFiles = fs.readdirSync(specsDir).filter(f => f.endsWith(".ts"));
for (const file of specFiles) {
  const name = file.replace(".ts", "");
  if (!registry.specs.find(s => s.name === name)) {
    console.error(`NOT IN REGISTRY: ${file} exists but not in registry.json`);
    errors++;
  }
}

// Check each spec has valid structure
for (const file of specFiles) {
  const content = fs.readFileSync(path.join(specsDir, file), "utf8");
  if (!content.includes("export default")) {
    console.error(`NO DEFAULT EXPORT: ${file}`);
    errors++;
  }
  if (!content.includes("name:")) {
    console.error(`NO NAME FIELD: ${file}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n${errors} error(s) found`);
  process.exit(1);
} else {
  console.log(`All ${specFiles.length} specs validated successfully`);
}
```

## GitHub Actions CI

Create `.github/workflows/validate.yml`:

```yaml
name: Validate Specs
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: node scripts/validate.js
```

## README for figy-specs repo

```markdown
# figy-specs

Community-driven autocomplete specs for [FigyTerm](https://github.com/code4mk/figyterm).

## Usage

In FigyTerm, go to **Settings > Specs** and click "Load Specs" to browse and install.

## Contributing

1. Fork this repo
2. Add your spec in `specs/yourcommand.ts`
3. Add entry to `registry.json`
4. (Optional) Add icon in `icons/yourcommand.png`
5. Run `node scripts/validate.js`
6. Open a PR

See [FigyTerm Spec Authoring Guide](https://github.com/code4mk/figyterm/blob/main/docs/SPECS.md) for spec format docs.

## Porting from Fig

See the porting section in the docs. Most Fig specs work with minimal changes.
```

## Workflow Summary

```
Developer creates spec
        │
        ▼
PR to figy-specs repo
        │
        ▼
CI validates (structure, registry sync)
        │
        ▼
Merged to main
        │
        ▼
FigyTerm users see it in Settings > Specs > Available
        │
        ▼
User clicks Install → fetched from raw.githubusercontent.com
        │
        ▼
Saved to ~/.figyterm/specs/ → autocomplete works immediately
```
