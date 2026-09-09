import { platform } from "./platform";

/**
 * Shell path handling, spelled for the platform the terminal is running on.
 *
 * The two families disagree about both halves of the job:
 *
 * - **Separator.** POSIX has `/`. Windows writes `\` and *accepts* `/`, so a
 *   path the user typed can mix them and both have to be recognised — but what
 *   we emit is `\`, because that is what the user sees everywhere else on the
 *   system. `list_path_completions` already takes either
 *   (`commands/autocomplete.rs`).
 *
 * - **Quoting.** POSIX escapes a space with `\ `. Neither PowerShell nor cmd
 *   has that escape: a backslash there is a separator, so `re-technology\
 *   projects` is read as two arguments and `cd` fails with *"A positional
 *   parameter cannot be found"*. Windows quotes the whole path instead.
 *
 * Windows filenames can't contain `" * : < > ? \ / |` at all, which is what
 * makes whole-path quoting safe: there is no way for the closing quote to land
 * inside a name. Only `'` needs care, and only in PowerShell, where doubling it
 * is the escape.
 */

const isWindows = platform === "windows";

/** The separator completions are written with. */
export const PATH_SEP = isWindows ? "\\" : "/";

/** Every separator the user might have typed. */
const SEPARATORS = isWindows ? "\\/" : "/";

export function isSeparator(ch: string): boolean {
  return ch.length === 1 && SEPARATORS.includes(ch);
}

export function endsWithSeparator(path: string): boolean {
  return path.length > 0 && isSeparator(path[path.length - 1]);
}

/** Index of the last separator in `path`, or -1 when it has none. */
export function lastSeparatorIndex(path: string): number {
  for (let i = path.length - 1; i >= 0; i--) {
    if (isSeparator(path[i])) return i;
  }
  return -1;
}

/**
 * Whether a backslash starts an escape sequence here.
 *
 * On Windows it never does — it's the separator — so the token scanner and the
 * "input ends with a line continuation" check both have to stop treating it as
 * one, or `cd D:\` looks like an unfinished escape and completion stops dead.
 */
export const BACKSLASH_ESCAPES = !isWindows;

/** Which quoting rules the running shell follows. */
export type ShellFlavor = "posix" | "powershell" | "cmd";

/**
 * The flavour of a shell path as reported by `create_terminal_session`.
 *
 * Only `cmd.exe` is singled out: it quotes with `"` and knows nothing about
 * `'`. Everything else on Windows is PowerShell or pwsh.
 */
export function shellFlavor(shell: string): ShellFlavor {
  if (!isWindows) return "posix";
  return /(^|[\\/])cmd\.exe\s*$/i.test(shell.trim()) ? "cmd" : "powershell";
}

/** POSIX metacharacters that have to be escaped when they appear in a name. */
const POSIX_SPECIAL = /[ \t()'"`$!#&;|<>{}[\]*?~]/;

/** Anything that would end an unquoted argument in PowerShell or cmd. */
const WINDOWS_SPECIAL = /[\s'"`$&;,()[\]{}@#%!^|<>?*=+~]/;

/**
 * Makes `path` survive being pasted onto the command line.
 *
 * POSIX escapes character by character and leaves everything else bare, which
 * is what shell completion has always produced there. Windows quotes the whole
 * thing or nothing — half-quoting a path is not a form either shell has.
 */
export function quotePath(path: string, flavor: ShellFlavor): string {
  if (flavor === "posix") {
    return POSIX_SPECIAL.test(path)
      ? path.replace(/([ \t()'"`$!#&;|<>{}[\]*?~])/g, "\\$1")
      : path;
  }

  if (!WINDOWS_SPECIAL.test(path)) return path;

  // cmd has no literal-string quote, but it also has no expansion inside `"`
  // that a filename could trigger, and `"` itself is illegal in a filename.
  if (flavor === "cmd") return `"${path}"`;

  // PowerShell's single quotes are fully literal; `''` is the only escape.
  return `'${path.replace(/'/g, "''")}'`;
}

/**
 * The inverse: whatever the user (or a previous completion) put on the command
 * line, turned back into a path the filesystem understands.
 *
 * Both forms are undone on both platforms — a token can carry either, and
 * getting it wrong means the completion query is made against a path that
 * doesn't exist.
 */
export function unquotePath(token: string): string {
  let out = token;

  const first = out[0];
  const last = out[out.length - 1];
  if (out.length >= 2 && (first === "'" || first === '"') && last === first) {
    out = out.slice(1, -1);
    if (first === "'") out = out.replace(/''/g, "'");
    return out;
  }

  // Unquoted: strip POSIX escapes, but only where a backslash means one.
  return BACKSLASH_ESCAPES ? out.replace(/\\(.)/g, "$1") : out;
}

/**
 * Splits a partially typed path into the directory already committed to and
 * the fragment being completed.
 *
 * The directory part keeps the separators the user typed — mixing `/` and `\`
 * on Windows is legal and rewriting it under them would be rude.
 */
export function splitPath(path: string): { dir: string; leaf: string } {
  const cut = lastSeparatorIndex(path);
  return cut >= 0
    ? { dir: path.slice(0, cut + 1), leaf: path.slice(cut + 1) }
    : { dir: "", leaf: path };
}
