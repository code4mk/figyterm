/**
 * The parts of setting up an xterm that both terminals in this app need.
 *
 * There are two now — the shell panes in `Terminal.tsx` and the conversations in
 * the Claude window — and everything here was learned the hard way by the first
 * one. A second copy would be a second place for the lessons to rot: the
 * zero-size measurement problem in particular is silent when you get it wrong,
 * and produces a terminal that looks fine and is 80×24 whatever the window says.
 */

import type { ILink, ILinkProvider, ITheme, Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { emit } from "@tauri-apps/api/event";
import { languageFor } from "./editor-lang";
import { PATH_SEP } from "./paths";

export const DARK_THEME: ITheme = {
  background: "#1a1d23",
  foreground: "#e6edf3",
  cursor: "#6366f1",
  cursorAccent: "#1a1d23",
  selectionBackground: "rgba(99, 102, 241, 0.25)",
  selectionForeground: "#ffffff",
  black: "#1e2228",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39d353",
  white: "#e6edf3",
  brightBlack: "#6e7681",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

export const LIGHT_THEME: ITheme = {
  background: "#f8f9fb",
  foreground: "#1a1d27",
  cursor: "#4f46e5",
  cursorAccent: "#f8f9fb",
  selectionBackground: "rgba(79, 70, 229, 0.15)",
  selectionForeground: "#1a1d27",
  black: "#1a1d27",
  red: "#dc2626",
  green: "#059669",
  yellow: "#d97706",
  blue: "#2563eb",
  magenta: "#7c3aed",
  cyan: "#0891b2",
  white: "#f8f9fb",
  brightBlack: "#6b7280",
  brightRed: "#ef4444",
  brightGreen: "#10b981",
  brightYellow: "#f59e0b",
  brightBlue: "#3b82f6",
  brightMagenta: "#8b5cf6",
  brightCyan: "#06b6d4",
  brightWhite: "#ffffff",
};

/**
 * How hard xterm works to keep foreground text legible against the background.
 *
 * `1` means "don't interfere", which is right for the dark theme: every colour
 * in it was picked against `#1a1d23` and already stands out.
 *
 * The light theme can't be left alone. ANSI white is `#f8f9fb` there and bright
 * white is `#ffffff` — the background and lighter than the background — so a
 * shell that prints a filename in white (which PowerShell does, for every entry
 * `Get-ChildItem` lists that isn't a directory) draws it invisibly. Rather than
 * darken `white` itself, which would also darken `\e[47m` *backgrounds*, this
 * asks xterm for a WCAG AA foreground and lets it adjust only the text.
 */
const DARK_MIN_CONTRAST = 1;
const LIGHT_MIN_CONTRAST = 4.5;

export function minimumContrastFor(theme: string): number {
  return theme === "dark" ? DARK_MIN_CONTRAST : LIGHT_MIN_CONTRAST;
}

/**
 * Ensure fontFamily has proper CSS quoting and ends with 'monospace' fallback.
 * xterm.js needs this for correct character measurement.
 */
export function ensureMonospaceFallback(raw: string): string {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  // Ensure multi-word font names are quoted
  const formatted = parts.map((p) => {
    if (p === "monospace" || p === "serif" || p === "sans-serif") return p;
    const unquoted = p.replace(/^['"]|['"]$/g, "");
    return unquoted.includes(" ") ? `'${unquoted}'` : unquoted;
  });
  // Always end with monospace
  if (!formatted.includes("monospace")) {
    formatted.push("monospace");
  }
  return formatted.join(", ");
}

export const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Waits until `el` has actually been laid out.
 *
 * xterm measures one character cell from a probe element the moment it opens,
 * and a container with no layout yet measures as zero. Everything downstream
 * then quietly misbehaves: `FitAddon.proposeDimensions()` bails out on a zero
 * cell, so `fit()` does nothing and the shell is started at the fallback 80x24,
 * and the DOM renderer positions the cursor at `column * cellWidth` — which is
 * 0 for every column, parking the cursor at the left edge on top of the prompt.
 *
 * A new tab or pane can easily mount a frame or two before its container has a
 * size, so wait for the real thing instead of guessing with a fixed delay: this
 * used to be a flat 30ms, which macOS won and a software-rendered Linux VM lost.
 *
 * Gives up after `frames` so a container that genuinely never gets a size (a
 * pane closed while starting up) can't hang initialisation.
 */
export async function waitForLayout(el: HTMLElement, frames = 60): Promise<void> {
  for (let remaining = frames; remaining > 0; remaining--) {
    if (el.clientWidth > 0 && el.clientHeight > 0) return;
    await nextFrame();
  }
}

/**
 * The terminal's size in cells, retried across a few frames.
 *
 * Even with a laid-out container the first measurement can come back empty, and
 * silently accepting the 80x24 fallback leaves the shell disagreeing with the
 * display about how wide the window is.
 */
export async function measureDimensions(fit: FitAddon, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const dims = fit.proposeDimensions();
    if (dims && dims.cols > 0 && dims.rows > 0) return dims;
    await nextFrame();
    fit.fit();
  }
  return undefined;
}

// ─── Paths in output ────────────────────────────────────────────────────────

/**
 * A file path, optionally with `:line` or `:line:col` after it.
 *
 * Written for what actually appears in terminal output: compiler errors, stack
 * traces, `grep -n` hits, `git status` lines. Paths broken across a wrapped
 * line aren't detected — the buffer line ends mid-path — which is a real
 * limitation and not worth reassembling reflowed lines for.
 */
const FILE_PATH =
  /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])*[\w.@+-]+\.[A-Za-z][\w-]{0,9}(?::\d+(?::\d+)?)?/g;

/**
 * Whether a matched string is worth offering as a link.
 *
 * Anything with a separator in it is a path by construction. Anything else has
 * to have an extension the editor recognises, which is what stops `v1.2.3`,
 * `example.com` and `Cargo.toml.orig` from all becoming links. `languageFor`
 * already holds that list, so this doesn't add a second one to keep in step.
 */
function looksLikePath(candidate: string): boolean {
  const withoutPosition = candidate.replace(/:\d+(?::\d+)?$/, "");
  if (/[\\/]/.test(withoutPosition)) return true;
  return languageFor(withoutPosition) !== "plaintext";
}

/** Splits `src/app.ts:42:7` into its path, line and column. */
export function parsePathTarget(candidate: string): {
  path: string;
  line?: number;
  column?: number;
} {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(candidate);
  if (!match) return { path: candidate };
  return {
    path: match[1],
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : undefined,
  };
}

export function isAbsolutePath(path: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/]|~)/.test(path);
}

/**
 * Turns file paths in output into links that open the editor.
 *
 * This is the point of having an editor in a terminal: a `tsc` error, a stack
 * trace, a `grep -n` hit and a `git status` line all name a file and often a
 * line, and clicking it should go there. It is also the point of having Claude
 * Code in one — an agent says "I changed src/app.ts:42" constantly, and in any
 * other terminal that is a string.
 *
 * `baseDir` is read per activation rather than captured, because the directory
 * a relative path is relative to moves: a pane's cwd follows `cd`, and a
 * conversation's is its project root.
 */
export function pathLinkProvider(
  xterm: XTerm,
  baseDir: () => string,
  /**
   * Which folder to tell the editor a path belongs to, when that isn't simply
   * `baseDir`.
   *
   * A shell pane has one folder and this is it. A Claude conversation has
   * several — its project root plus whatever it was granted — and naming the
   * root for a file that lives in one of the others would send the editor to a
   * folder the file isn't in, which fails in exactly the way this exists to
   * prevent.
   */
  rootFor?: (path: string) => string | undefined
): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const line = xterm.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString(true);
      const links: ILink[] = [];

      for (const match of text.matchAll(FILE_PATH)) {
        const candidate = match[0];
        if (match.index === undefined || !looksLikePath(candidate)) continue;

        // Skip anything inside a URL — `https://x.dev/a/b.js` is the web links
        // addon's to handle, and it already has it.
        const preceding = text.slice(0, match.index);
        if (/:\/\/\S*$/.test(preceding)) continue;

        const target = parsePathTarget(candidate);
        const base = baseDir();
        const resolved = isAbsolutePath(target.path)
          ? target.path
          : base
            ? `${base}${PATH_SEP}${target.path}`
            : target.path;

        links.push({
          range: {
            // xterm columns are 1-based and inclusive at both ends.
            start: { x: match.index + 1, y: lineNumber },
            end: { x: match.index + candidate.length, y: lineNumber },
          },
          text: candidate,
          activate() {
            void emit("editor://open-path", {
              path: resolved,
              line: target.line,
              column: target.column,
              /*
                The folder this link came from — a pane's cwd, or a Claude
                project's root. The editor confines itself to the folder it
                has open, so a path from somewhere else is refused unless it
                is told where that somewhere is; without this, clicking a
                file in one project while the editor sits in another produced
                "…is outside the folders open in the editor" and nothing else.
              */
              root: (rootFor ? rootFor(resolved) : base) || undefined,
            });
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
