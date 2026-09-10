import type { Extension } from "@codemirror/state";
import { basename } from "./editor-fs";

/**
 * Which language a file is, and how to load support for it.
 *
 * Every grammar arrives by dynamic `import()`, so opening a `.tsx` file doesn't
 * pay for Rust, Python and SQL as well — the initial editor chunk carries no
 * grammars at all, and each one is fetched once and cached by the browser
 * module registry.
 *
 * The imports are written out one per language rather than built from a
 * template string, because Vite can only pre-bundle a dynamic import it can
 * read statically; `import(\`...\${id}\`)` would resolve at runtime against
 * paths that don't exist in the build.
 */

export interface LanguageDef {
  id: string;
  /** Shown in the status bar and the language picker. */
  label: string;
  load: () => Promise<Extension>;
}

type Loader = () => Promise<Extension>;

/** Wraps one of CodeMirror's ported CodeMirror-5 modes as a CM6 language. */
async function stream(mode: unknown): Promise<Extension> {
  const { StreamLanguage } = await import("@codemirror/language");
  // The legacy modes are structurally `StreamParser`s; the cast is the price of
  // not depending on their internal types.
  return StreamLanguage.define(mode as never);
}

const javascript = (typescript: boolean, jsx: boolean): Loader => async () => {
  const mod = await import("@codemirror/lang-javascript");
  return mod.javascript({ typescript, jsx });
};

const LOADERS: Record<string, Loader> = {
  javascript: javascript(false, true),
  typescript: javascript(true, false),
  tsx: javascript(true, true),
  json: async () => (await import("@codemirror/lang-json")).json(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  xml: async () => (await import("@codemirror/lang-xml")).xml(),
  php: async () => (await import("@codemirror/lang-php")).php(),
  java: async () => (await import("@codemirror/lang-java")).java(),
  cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
  go: async () => (await import("@codemirror/lang-go")).go(),
  shell: async () => stream((await import("@codemirror/legacy-modes/mode/shell")).shell),
  toml: async () => stream((await import("@codemirror/legacy-modes/mode/toml")).toml),
  ruby: async () => stream((await import("@codemirror/legacy-modes/mode/ruby")).ruby),
  lua: async () => stream((await import("@codemirror/legacy-modes/mode/lua")).lua),
  swift: async () => stream((await import("@codemirror/legacy-modes/mode/swift")).swift),
  dockerfile: async () =>
    stream((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
  diff: async () => stream((await import("@codemirror/legacy-modes/mode/diff")).diff),
  ini: async () =>
    stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
  powershell: async () =>
    stream((await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
};

const LABELS: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  markdown: "Markdown",
  python: "Python",
  rust: "Rust",
  yaml: "YAML",
  sql: "SQL",
  xml: "XML",
  php: "PHP",
  java: "Java",
  cpp: "C/C++",
  go: "Go",
  shell: "Shell",
  toml: "TOML",
  ruby: "Ruby",
  lua: "Lua",
  swift: "Swift",
  dockerfile: "Dockerfile",
  diff: "Diff",
  ini: "INI",
  powershell: "PowerShell",
  plaintext: "Plain Text",
};

const BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  html: "html",
  htm: "html",
  // Not their own grammars, but a single-file component is mostly HTML and
  // reads far better highlighted as that than as plain text.
  vue: "html",
  svelte: "html",
  astro: "html",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  pyi: "python",
  pyw: "python",
  rs: "rust",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  xaml: "xml",
  php: "php",
  java: "java",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hh: "cpp",
  m: "cpp",
  mm: "cpp",
  cs: "cpp",
  kt: "cpp",
  kts: "cpp",
  scala: "cpp",
  go: "go",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  env: "shell",
  toml: "toml",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  lua: "lua",
  swift: "swift",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  editorconfig: "ini",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
};

/**
 * Files whose whole name decides the language.
 *
 * Checked before the extension, since these mostly have none — and the ones
 * that do would otherwise be read wrongly: `.gitignore` is not an "ignore"
 * language, and `CMakeLists.txt` is not plain text.
 */
const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "shell",
  gnumakefile: "shell",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".zprofile": "shell",
  ".profile": "shell",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".env": "shell",
  "cargo.lock": "toml",
  gemfile: "ruby",
  rakefile: "ruby",
  "package.json": "json",
  "tsconfig.json": "json",
};

/** The language id for a path, falling back to `plaintext`. */
export function languageFor(path: string): string {
  const name = basename(path).toLowerCase();

  const byName = BY_NAME[name];
  if (byName) return byName;

  // `.env.local`, `.env.production` — the interesting part is the first
  // segment, and there are too many suffixes to enumerate.
  if (name.startsWith(".env")) return "shell";
  if (name.startsWith("dockerfile")) return "dockerfile";

  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return BY_EXTENSION[name.slice(dot + 1)] ?? "plaintext";
}

export function labelFor(languageId: string): string {
  return LABELS[languageId] ?? "Plain Text";
}

/**
 * Loads the grammar for a language, or nothing for one we don't have.
 *
 * A failed import resolves to no extension rather than rejecting: a missing
 * grammar chunk should cost highlighting, not the whole file.
 */
export async function loadLanguage(languageId: string): Promise<Extension | null> {
  const loader = LOADERS[languageId];
  if (!loader) return null;
  try {
    return await loader();
  } catch (error) {
    console.warn(`editor: could not load the ${languageId} grammar`, error);
    return null;
  }
}

/** Every language the picker can offer, sorted for display. */
export function availableLanguages(): LanguageDef[] {
  return Object.keys(LABELS)
    .map((id) => ({ id, label: LABELS[id], load: LOADERS[id] ?? (async () => []) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
