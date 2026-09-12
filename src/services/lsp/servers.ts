/**
 * Which language server to run for which file, and whether it is installed.
 *
 * **No bundling, no downloading, no install wizard.** This is a terminal: the
 * user's toolchain is already installed and already configured, and the same
 * reasoning that has the app shell out to `git` rather than link libgit2 applies
 * here. What this file provides is a table of what to look for and an honest
 * message when it isn't there.
 *
 * ## Why this keys on file extensions
 *
 * The obvious thing is to key on the editor's own `languageId`, and that was the
 * first attempt. It is wrong twice over.
 *
 * **The editor's language ids are approximate.** They exist to pick a
 * *highlighting grammar*, and where no grammar exists they borrow the nearest
 * one: `.kt` is highlighted as `cpp`, `.svelte` as `html`, `.scala` as `cpp`. A
 * Kotlin server keyed on `cpp` would start on C++ files.
 *
 * **They are also the wrong string to send the server.** `didOpen` carries a
 * language id the server switches behaviour on, and it is the *protocol's*
 * vocabulary, not ours: `typescript-language-server` wants `typescriptreact`
 * for a `.tsx` file and does the wrong thing with `tsx`. So each extension
 * carries the id to send with it.
 *
 * ## What gets in
 *
 * The bar is: the implementation its own ecosystem ships or has settled on, it
 * speaks stdio, and it needs no bespoke bootstrapping. That last clause is what
 * keeps `jdtls` (a per-workspace data directory), Roslyn's
 * `Microsoft.CodeAnalysis.LanguageServer` (a non-standard `solution/open`
 * notification) and Vue (a TypeScript plugin to wire in) out — they need
 * handling, not a table row.
 */

import { invoke } from "@tauri-apps/api/core";
import type { LspServerOverride } from "../editor-session";

export interface LspServerDef {
  /** Stable key: settings, the registry and the status bar all use it. */
  id: string;
  label: string;
  program: string;
  args: string[];
  /**
   * Extension (no dot, lowercase) → the `languageId` to send in `didOpen`.
   *
   * Both halves in one field because they are one fact: this server handles
   * these files, and calls them this.
   */
  extensions: Record<string, string>;
  /** Whole filenames, lowercased, for files that have no useful extension. */
  filenames?: Record<string, string>;
  /** Shown verbatim when the program isn't on `PATH`. */
  install: string;
  /** Server-specific `initializationOptions`, where one is needed to be useful. */
  initializationOptions?: Record<string, unknown>;
  /**
   * Runs *alongside* whichever other server claims the file, rather than
   * instead of it.
   *
   * Tailwind is the case this exists for: it completes class names inside HTML,
   * CSS and JSX, all of which already have a server. Without this it would have
   * to replace one of them, which is a worse editor either way.
   */
  companion?: boolean;
}

/** `--stdio` is on most of these because the default transport is a socket. */
export const SERVERS: LspServerDef[] = [
  {
    id: "typescript",
    label: "TypeScript / JavaScript",
    program: "typescript-language-server",
    args: ["--stdio"],
    extensions: {
      ts: "typescript",
      mts: "typescript",
      cts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      jsx: "javascriptreact",
    },
    install: "npm i -g typescript-language-server typescript",
  },
  {
    id: "rust",
    label: "Rust",
    program: "rust-analyzer",
    args: [],
    extensions: { rs: "rust" },
    install: "rustup component add rust-analyzer",
  },
  {
    id: "python",
    label: "Python",
    program: "pyright-langserver",
    args: ["--stdio"],
    extensions: { py: "python", pyi: "python", pyw: "python" },
    install: "npm i -g pyright",
  },
  {
    id: "go",
    label: "Go",
    program: "gopls",
    args: [],
    extensions: { go: "go" },
    filenames: { "go.mod": "go.mod", "go.work": "go.work" },
    install: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "clangd",
    label: "C / C++ / Objective-C",
    program: "clangd",
    args: [],
    extensions: {
      c: "c",
      h: "c",
      cpp: "cpp",
      cxx: "cpp",
      cc: "cpp",
      hpp: "cpp",
      hh: "cpp",
      m: "objective-c",
      mm: "objective-cpp",
    },
    install: "Ships with LLVM — brew install llvm, or apt install clangd",
  },
  {
    id: "json",
    label: "JSON",
    program: "vscode-json-language-server",
    args: ["--stdio"],
    extensions: { json: "json", jsonc: "jsonc", json5: "jsonc" },
    install: "npm i -g vscode-langservers-extracted",
    // Without this it announces no formatting support at all, which is most of
    // why anyone runs it on JSON.
    initializationOptions: { provideFormatter: true },
  },
  {
    id: "css",
    label: "CSS / SCSS / Less",
    program: "vscode-css-language-server",
    args: ["--stdio"],
    extensions: { css: "css", scss: "scss", sass: "scss", less: "less" },
    install: "npm i -g vscode-langservers-extracted",
    initializationOptions: { provideFormatter: true },
  },
  {
    id: "html",
    label: "HTML",
    program: "vscode-html-language-server",
    args: ["--stdio"],
    extensions: { html: "html", htm: "html" },
    install: "npm i -g vscode-langservers-extracted",
    initializationOptions: { provideFormatter: true },
  },
  {
    id: "yaml",
    label: "YAML",
    program: "yaml-language-server",
    args: ["--stdio"],
    extensions: { yaml: "yaml", yml: "yaml" },
    install: "npm i -g yaml-language-server",
  },
  {
    id: "bash",
    label: "Shell",
    program: "bash-language-server",
    args: ["start"],
    extensions: { sh: "shellscript", bash: "shellscript", zsh: "shellscript" },
    install: "npm i -g bash-language-server",
  },
  {
    id: "lua",
    label: "Lua",
    program: "lua-language-server",
    args: [],
    extensions: { lua: "lua" },
    install: "brew install lua-language-server",
  },

  // ── Added for coverage of the languages people actually work in ──────────

  {
    id: "php",
    label: "PHP",
    program: "intelephense",
    args: ["--stdio"],
    extensions: { php: "php" },
    // PHP has no first-party server; this is the one the ecosystem uses, and
    // its free tier covers everything here.
    install: "npm i -g intelephense",
  },
  {
    id: "ruby",
    label: "Ruby",
    program: "ruby-lsp",
    args: [],
    extensions: { rb: "ruby", rake: "ruby", gemspec: "ruby", ru: "ruby" },
    filenames: { gemfile: "ruby", rakefile: "ruby" },
    install: "gem install ruby-lsp",
  },
  {
    id: "swift",
    label: "Swift",
    program: "sourcekit-lsp",
    args: [],
    extensions: { swift: "swift" },
    // Ships inside the toolchain rather than being installed separately.
    install: "Included with Xcode or a swift.org toolchain",
  },
  {
    id: "zig",
    label: "Zig",
    program: "zls",
    args: [],
    extensions: { zig: "zig", zon: "zig" },
    install: "brew install zls, or build from github.com/zigtools/zls",
  },
  {
    id: "toml",
    label: "TOML",
    program: "taplo",
    args: ["lsp", "stdio"],
    extensions: { toml: "toml" },
    install: "brew install taplo, or cargo install taplo-cli --features lsp",
  },
  {
    id: "terraform",
    label: "Terraform",
    program: "terraform-ls",
    args: ["serve"],
    extensions: { tf: "terraform", tfvars: "terraform-vars" },
    install: "brew install hashicorp/tap/terraform-ls",
  },
  {
    id: "markdown",
    label: "Markdown",
    program: "marksman",
    args: ["server"],
    extensions: { md: "markdown", markdown: "markdown" },
    install: "brew install marksman",
  },
  {
    id: "svelte",
    label: "Svelte",
    program: "svelteserver",
    args: ["--stdio"],
    extensions: { svelte: "svelte" },
    install: "npm i -g svelte-language-server",
  },
  {
    id: "dart",
    label: "Dart",
    program: "dart",
    args: ["language-server", "--client-id", "figyterm"],
    extensions: { dart: "dart" },
    install: "Included with the Dart and Flutter SDKs",
  },
  {
    id: "kotlin",
    label: "Kotlin",
    program: "kotlin-language-server",
    args: [],
    extensions: { kt: "kotlin", kts: "kotlin" },
    install: "brew install kotlin-language-server",
  },
  {
    id: "csharp",
    label: "C#",
    program: "csharp-ls",
    args: [],
    extensions: { cs: "csharp", csx: "csharp" },
    /*
      `csharp-ls`, not OmniSharp and not Roslyn.

      Roslyn's `Microsoft.CodeAnalysis.LanguageServer` is what the official C#
      extension drives, and it is the better analyser — but it is shipped as a
      NuGet payload rather than a program on `PATH`, and it needs the solution
      opened through a **non-standard `solution/open` notification** before it
      will analyse anything. A generic client that speaks only the
      specification gets a server that starts cleanly and then reports nothing.

      OmniSharp is the older one and is winding down.

      `csharp-ls` is a plain stdio server that finds the `.sln` or `.csproj`
      from the workspace root by itself, which is exactly what this table can
      drive. It is a community project — the same relaxation of the
      "first-party" rule as PHP, and for the same reason.
    */
    install: "dotnet tool install --global csharp-ls",
  },
  {
    id: "docker",
    label: "Dockerfile",
    program: "docker-langserver",
    args: ["--stdio"],
    extensions: { dockerfile: "dockerfile" },
    filenames: { dockerfile: "dockerfile", containerfile: "dockerfile" },
    install: "npm i -g dockerfile-language-server-nodejs",
  },

  // ── Companions: run alongside whatever else claims the file ──────────────

  {
    id: "tailwind",
    label: "Tailwind CSS",
    program: "tailwindcss-language-server",
    args: ["--stdio"],
    /*
      Every place a class name can appear. This is why it has to be a
      companion: each of these already has a server, and Tailwind completes
      *inside* them rather than replacing them.
    */
    extensions: {
      html: "html",
      css: "css",
      scss: "scss",
      less: "less",
      jsx: "javascriptreact",
      tsx: "typescriptreact",
      js: "javascript",
      ts: "typescript",
      vue: "vue",
      svelte: "svelte",
      astro: "astro",
      php: "php",
      erb: "erb",
    },
    install: "npm i -g @tailwindcss/language-server",
    companion: true,
    /*
      It asks for these through `workspace/configuration` and refuses to offer
      anything without them. The defaults match what the official extension
      sends; `userLanguages` is empty because the language ids above are
      already the ones it expects.
    */
    initializationOptions: {
      userLanguages: {},
      configuration: {
        editor: { tabSize: 2 },
        tailwindCSS: {
          validate: true,
          classAttributes: ["class", "className", "ngClass", "class:list"],
          includeLanguages: {},
          lint: {
            cssConflict: "warning",
            invalidApply: "error",
            invalidConfigPath: "error",
            invalidScreen: "error",
            invalidTailwindDirective: "error",
            invalidVariant: "error",
            recommendedVariantOrder: "warning",
          },
        },
      },
    },
  },
];

/**
 * What the user changed about one of the above.
 *
 * Declared in `editor-session.ts`, where it is stored and checked on the way in
 * — see `sanitizeLspServers`, which is what stands between hand-edited storage
 * and `Command::new`.
 */
export type { LspServerOverride } from "../editor-session";

export type LspOverrides = Record<string, LspServerOverride>;

/** A table entry with the user's overrides folded in. */
export function resolveServer(def: LspServerDef, overrides: LspOverrides): LspServerDef {
  const override = overrides[def.id];
  if (!override) return def;
  return {
    ...def,
    program: override.program?.trim() || def.program,
    args: override.args ?? def.args,
  };
}

export function isEnabled(id: string, overrides: LspOverrides): boolean {
  return overrides[id]?.enabled !== false;
}

/** The lowercased file name and extension of a path. */
function nameAndExtension(path: string): { name: string; extension: string } {
  const name = (path.split(/[/\\]/).pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return { name, extension: dot > 0 ? name.slice(dot + 1) : "" };
}

export interface ServerMatch {
  def: LspServerDef;
  /** The `languageId` to send in `didOpen` for *this* file. */
  languageId: string;
}

/**
 * Every server that claims a file: at most one primary, plus any companions.
 *
 * An empty list is the common case and not an error — most files the editor
 * opens have no server in the table and never will.
 */
export function serversForPath(path: string): ServerMatch[] {
  const { name, extension } = nameAndExtension(path);
  const matches: ServerMatch[] = [];

  for (const def of SERVERS) {
    const languageId = def.filenames?.[name] ?? def.extensions[extension];
    if (!languageId) continue;
    // The primary comes first, so callers that want "the" server take [0].
    if (def.companion) matches.push({ def, languageId });
    else matches.unshift({ def, languageId });
  }

  return matches;
}

/** The server that owns a file's language features, ignoring companions. */
export function primaryServerForPath(path: string): ServerMatch | null {
  return serversForPath(path).find((match) => !match.def.companion) ?? null;
}

export interface DetectedProgram {
  program: string;
  /** Null when it isn't on `PATH`. */
  path: string | null;
}

/**
 * Which of these the user actually has, asked for all at once.
 *
 * One call rather than one per server: the first of them may have to run a
 * login shell to discover the user's real `PATH` (a GUI launch doesn't inherit
 * one — see `spawn.rs`), and that should happen once.
 */
export async function detectServers(overrides: LspOverrides): Promise<Map<string, string | null>> {
  const programs = SERVERS.map((def) => resolveServer(def, overrides).program);
  const found = await invoke<DetectedProgram[]>("lsp_detect", { programs });
  const byProgram = new Map(found.map((entry) => [entry.program, entry.path]));

  const byServer = new Map<string, string | null>();
  for (const def of SERVERS) {
    byServer.set(def.id, byProgram.get(resolveServer(def, overrides).program) ?? null);
  }
  return byServer;
}
