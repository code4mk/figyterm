# Spec Authoring Guide

FigyTerm uses a spec-based autocomplete engine inspired by [Fig's completion specs](https://fig.io/docs/getting-started). This guide explains how to add support for new CLI tools.

## Overview

A **spec** is a TypeScript object that describes a command's structure — its subcommands, options, and arguments. When a user types a command, FigyTerm's engine traverses the spec tree to determine relevant suggestions.

## Quick Start

### 1. Create the Spec File

Create `src/specs/yourcommand.ts`:

```typescript
// @ts-nocheck
const completionSpec: Figy.Spec = {
  name: "mycommand",
  description: "Description shown in suggestions",
  subcommands: [
    {
      name: "init",
      description: "Initialize a new project",
      options: [
        {
          name: ["--template", "-t"],
          description: "Template to use",
          args: {
            name: "template",
            suggestions: ["react", "vue", "svelte"],
          },
        },
      ],
    },
    {
      name: "build",
      description: "Build the project",
      options: [
        {
          name: "--output",
          description: "Output directory",
          args: {
            name: "path",
            template: "folders",
          },
        },
        {
          name: "--minify",
          description: "Minify output",
        },
      ],
    },
  ],
  options: [
    {
      name: ["--version", "-v"],
      description: "Show version",
    },
    {
      name: ["--help", "-h"],
      description: "Show help",
    },
  ],
};

export default completionSpec;
```

### 2. Register the Spec

Add it to `src/specs/index.ts`:

```typescript
registry.register("mycommand", () => import("./mycommand").then((m) => m.default));
```

### 3. Test

```bash
npm run tauri dev
```

Type `mycommand ` in the terminal — you should see subcommand suggestions.

## Spec Structure

### Root Spec

```typescript
interface Spec {
  name: string | string[];         // Command name(s)
  description?: string;            // Shown in popup
  subcommands?: Subcommand[];      // Available subcommands
  options?: Option[];              // Global options
  args?: Arg | Arg[];              // Positional arguments
}
```

### Subcommands

```typescript
interface Subcommand {
  name: string | string[];         // Subcommand name(s) / aliases
  description?: string;
  subcommands?: Subcommand[];      // Nested subcommands
  options?: Option[];
  args?: Arg | Arg[];
}
```

### Options

```typescript
interface Option {
  name: string | string[];         // e.g., ["--verbose", "-v"]
  description?: string;
  args?: Arg | Arg[];              // Value the option takes
  isRepeatable?: boolean;          // Can be specified multiple times
  isPersistent?: boolean;          // Available to all subcommands
  exclusiveOn?: string[];          // Mutually exclusive options
  requiresEquals?: boolean;        // Uses = syntax (--key=value)
}
```

### Arguments

```typescript
interface Arg {
  name: string;                    // Display name
  description?: string;
  suggestions?: (string | Suggestion)[];  // Static suggestions
  template?: "filepaths" | "folders";     // Dynamic file/folder completion
  isOptional?: boolean;
  isVariadic?: boolean;            // Accepts multiple values
  generators?: Generator | Generator[];   // Dynamic suggestion generator
}
```

### Generators

Generators produce dynamic suggestions based on context:

```typescript
interface Generator {
  script?: string | string[];      // Shell command to run
  postProcess?: (out: string) => Suggestion[];  // Process command output
  template?: "filepaths" | "folders";
  custom?: (tokens: string[], exec: Function) => Promise<Suggestion[]>;
}
```

## Examples

### Git-style Subcommands

```typescript
const spec: Figy.Spec = {
  name: "git",
  subcommands: [
    {
      name: "checkout",
      description: "Switch branches",
      args: {
        name: "branch",
        generators: {
          script: ["git", "branch", "--format=%(refname:short)"],
          postProcess: (out) =>
            out.split("\n").filter(Boolean).map((b) => ({
              name: b.trim(),
              description: "Branch",
            })),
        },
      },
      options: [
        { name: "-b", description: "Create and switch to new branch" },
      ],
    },
  ],
};
```

### Package.json Scripts

```typescript
{
  name: "run",
  description: "Run a script",
  args: {
    name: "script",
    generators: {
      custom: async (tokens, executeShellCommand) => {
        const result = await executeShellCommand("cat package.json");
        const pkg = JSON.parse(result);
        return Object.keys(pkg.scripts || {}).map((s) => ({
          name: s,
          description: pkg.scripts[s],
          icon: "figy://icon?type=command",
        }));
      },
    },
  },
}
```

### File/Folder Templates

```typescript
{
  name: "--config",
  description: "Config file path",
  args: {
    name: "file",
    template: "filepaths",  // Shows file browser
  },
}

{
  name: "--output",
  description: "Output directory",
  args: {
    name: "dir",
    template: "folders",    // Shows only directories
  },
}
```

### Static Suggestions with Icons

```typescript
{
  name: "--format",
  args: {
    name: "format",
    suggestions: [
      { name: "json", description: "JSON output", icon: "figy://icon?type=string" },
      { name: "yaml", description: "YAML output", icon: "figy://icon?type=string" },
      { name: "table", description: "Table output", icon: "figy://icon?type=string" },
    ],
  },
}
```

### Variadic Arguments

```typescript
{
  name: "install",
  description: "Install packages",
  args: {
    name: "packages",
    isVariadic: true,     // Keeps suggesting after each selection
    generators: { /* ... */ },
  },
}
```

## Tips

1. **Use `// @ts-nocheck`** at the top if your spec uses patterns that don't match the strict type definitions
2. **Test incrementally** — add subcommands one at a time and verify
3. **Look at existing specs** (`src/specs/git.ts`, `src/specs/docker.ts`) for reference
4. **Keep descriptions concise** — they appear in a small popup
5. **Prefer static suggestions** over generators when the option set is fixed
6. **Use `template: "folders"`** for any argument that expects a directory path

## Porting Fig Specs

FigyTerm's spec format is compatible with Fig's format. To port an existing Fig spec:

1. Copy the spec file
2. Add `// @ts-nocheck` at the top
3. Replace `Fig.` namespace references with `Figy.`
4. Replace `fig://` icon URLs with `figy://` (optional, icons are cosmetic)
5. Register in `src/specs/index.ts`
6. Test

Most Fig community specs work with minimal or no modifications.

## Available Specs

| File | Commands |
|------|----------|
| `git.ts` | git |
| `docker.ts` | docker |
| `docker-compose.ts` | docker-compose, docker compose |
| `npm.ts` | npm |
| `pnpm.ts` | pnpm |
| `yarn.ts` | yarn |
| `uv.ts` | uv |
