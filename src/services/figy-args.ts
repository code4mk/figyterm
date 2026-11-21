/**
 * Where the command line is, as arithmetic over tokens.
 *
 * Pulled out of `figy-autocomplete-engine.ts` so it can be tested. The engine
 * itself reaches the filesystem and the spec store through Tauri, which a
 * `node` test cannot do; this half is a pure function of the text and the spec,
 * which is the half that was getting the answer wrong. Same split, and the same
 * reason, as `explorer-paths.ts` next door.
 */

import { Figy } from "../types/figy";

/**
 * Splits a command line the way a shell would, and says where the cursor is.
 *
 * A trailing space produces a trailing empty token, which is the whole point:
 * `git add ` is "starting a new argument" and `git add` is "still typing the
 * subcommand", and every decision after this one depends on telling those
 * apart.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (input.endsWith(" ") && !inSingleQuote && !inDoubleQuote) {
    tokens.push("");
  }

  return tokens;
}

/**
 * Whether a token is a flag rather than a positional argument.
 *
 * Asked of the *token*, not of the spec. The walker used to ask
 * `tok.startsWith("-") && currentSpec.options`, so a flag typed against a
 * subcommand whose spec happens to list no options fell through to the bottom
 * of the loop and was counted as a positional argument. One `-v` too many and
 * the engine believed an argument had been supplied that never was, and stopped
 * offering the one the user was actually typing.
 *
 * A lone `-` is conventionally stdin and `--` ends the options; neither is a
 * value for the command's own arguments, so neither is counted.
 */
export function isFlagToken(token: string): boolean {
  return token.startsWith("-") && token.length > 0;
}

/**
 * Which of a command's arguments are still worth suggesting.
 *
 * `consumedArgs` is how many positional values have already been typed, and
 * `currentToken` is the one being typed now — empty when the user has just
 * pressed space and is starting a fresh one.
 *
 * **Variadic arguments keep their place.** The previous rule dropped them as
 * soon as one value had been supplied and a new token was begun:
 *
 * ```
 * if (arg.isVariadic && consumedArgs > 0 && currentToken === "") return false;
 * ```
 *
 * which is the exact moment a variadic argument is most useful, and it made
 * `git add one.txt <space>` offer nothing at all — the second file, which is
 * the only reason `git add` takes a list. Ninety-odd arguments across the
 * shipped specs are variadic, so this was most of the second suggestion anyone
 * ever asked for. Variadic means "and again": a value consumed is a reason to
 * offer the next one, not a reason to stop.
 */
export function argsToOffer<T extends Figy.Arg>(args: T[], consumedArgs: number): T[] {
  return args.filter((arg, index) => {
    // A variadic argument never finishes. It is the last one a command has —
    // nothing can follow a list — so it stays on offer however many values
    // have gone into it.
    if (arg.isVariadic) return true;

    // A fixed argument is done once a value has been typed in its position.
    return index >= consumedArgs;
  });
}
