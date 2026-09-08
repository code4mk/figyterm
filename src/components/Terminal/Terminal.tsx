import { useEffect, useCallback, useRef, useState } from "react";
import { Terminal as XTerm, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { TerminalSession } from "../../types/terminal";
import { SuggestionPopup, SuggestionItem } from "./SuggestionPopup";
import { getAutocompleteSuggestions } from "../../services/figy-autocomplete-engine";
import { specRegistry } from "../../services/figy-spec-registry";
import { isDragging } from "./SplitHandle";
import { recordDirUsage, sortByRecency, setHomeDir } from "../../services/recent-dirs";
import { Search, ChevronUp, ChevronDown, X } from "lucide-react";
import { HistorySearch } from "./HistorySearch";
import { SHORTCUTS, matches } from "../../services/shortcuts";
import { isMac } from "../../services/platform";

const DARK_THEME: ITheme = {
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

const LIGHT_THEME: ITheme = {
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

interface TerminalProps {
  instanceId: string;
  isActive: boolean;
  initialCwd?: string;
  onSessionCreated: (session: TerminalSession) => void;
  onCwdChange?: (cwd: string) => void;
  clearRef?: React.MutableRefObject<(() => void) | null>;
  focusRef?: React.MutableRefObject<(() => void) | null>;
}

interface RawTerminalSession {
  id: string;
  shell: string;
  cwd: string;
  title: string;
  created_at: number;
  status: "running" | "exited";
}

interface TerminalOutputPayload {
  session_id: string;
  data: number[];
}

interface CompletionEntry {
  name: string;
  path: string;
  isDir: boolean;
  isHidden: boolean;
}

const PATH_COMMANDS = ["cd", "ls", "cat", "less", "more", "head", "tail", "vim", "nano", "code", "open", "cp", "mv", "rm", "mkdir", "touch", "chmod", "chown", "source", "bat"];

/**
 * Extract the last shell token respecting escape sequences and quotes.
 * e.g. `cd My\ Documents/foo` → `My\ Documents/foo`
 */
/**
 * Ensure fontFamily has proper CSS quoting and ends with 'monospace' fallback.
 * xterm.js needs this for correct character measurement.
 */
function ensureMonospaceFallback(raw: string): string {
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

function extractLastToken(input: string): string {
  let token = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      token += "\\" + ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      token += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      token += ch;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(ch)) {
      token = "";
      continue;
    }

    token += ch;
  }
  return token;
}

/** Unescape backslash-escaped chars for passing to filesystem (e.g. `My\ Doc` → `My Doc`) */
function unescapeToken(token: string): string {
  return token.replace(/\\(.)/g, "$1");
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

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
async function waitForLayout(el: HTMLElement, frames = 60): Promise<void> {
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
async function measureDimensions(fit: FitAddon, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const dims = fit.proposeDimensions();
    if (dims && dims.cols > 0 && dims.rows > 0) return dims;
    await nextFrame();
    fit.fit();
  }
  return undefined;
}

/** OSC — window titles and OSC 7, terminated by BEL or ST. */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** CSI — colours, cursor moves, erases. */
const CSI_SEQUENCE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
/** Anything left over: lone ESC, BEL, and other C0 bytes that aren't \t \n \r. */
const CONTROL_BYTE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** A POSIX prompt ending in one of `] $ % # >`, e.g. `ubuntu@ubuntu:~$ `. */
const POSIX_PROMPT = /[:\s](~[^\s\]]*|\/[^\s\]]*)\s*[\]$%#>]\s*$/m;

/**
 * A Windows prompt: `PS C:\Users\me>` from PowerShell, `C:\Users\me>` from cmd.
 *
 * Tried after the POSIX pattern rather than instead of it. Neither can match the
 * other — a drive letter doesn't start with `~` or `/`, and a POSIX path has no
 * `X:\` — so both can be attempted on every platform, which keeps `parseCwd`
 * pure and testable anywhere.
 */
const WINDOWS_PROMPT = /([A-Za-z]:\\[^\r\n>]*?)\s*>\s*$/m;

/**
 * Reads the working directory out of a chunk of terminal output.
 *
 * Two sources, most trustworthy first:
 *
 * 1. **OSC 7**, where the shell states its cwd outright. Unambiguous — and what
 *    `pty.rs` asks bash to emit, so on Linux this is normally the one that hits.
 * 2. **The prompt, scraped.** The fallback for shells that don't report, and it
 *    only works on text with the escape sequences removed. Scraping the raw
 *    bytes is what produced `~\x1b[01;32mubuntu@ubuntu\x1b[00m…` as a "path" on
 *    Ubuntu: bash's default PS1 there sets a window title *and* colours the
 *    prompt, so the greedy character class ran straight through both. That bad
 *    path then broke `cd` completion too, since it's the base directory the
 *    filesystem suggestions are resolved against.
 *
 *    Windows only ever reaches this branch: neither PowerShell nor cmd emits
 *    OSC 7, and PowerShell has no `PROMPT_COMMAND` to make it with the way bash
 *    does, so a drive-letter prompt is the whole signal there.
 *
 * Returns null when the chunk says nothing about the directory, which is the
 * common case — most output isn't a prompt.
 */
function parseCwd(chunk: string): string | null {
  const osc7 = chunk.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)/);
  if (osc7) {
    try {
      // Shells percent-encode non-ASCII paths here, as VTE's own helper does.
      return decodeURIComponent(osc7[1]);
    } catch {
      return osc7[1];
    }
  }

  const plain = chunk
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(CONTROL_BYTE, "");

  const posix = plain.match(POSIX_PROMPT);
  if (posix) return posix[1];

  const windows = plain.match(WINDOWS_PROMPT);
  return windows ? windows[1] : null;
}

export function Terminal({ instanceId, isActive, initialCwd, onSessionCreated, onCwdChange, clearRef, focusRef }: TerminalProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const initStarted = useRef(false);
  const inputBufferRef = useRef("");
  const cwdRef = useRef("");
  const { settings } = useSettingsStore();
  const settingsRef = useRef(settings);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchCount, setSearchMatchCount] = useState<string>("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  settingsRef.current = settings;
  const theme = useThemeStore((s) => s.theme);

  // Use REFS for autocomplete state so callbacks always have latest values
  const suggestionsRef = useRef<SuggestionItem[]>([]);
  const selectedIndexRef = useRef(0);
  const showRef = useRef(false);

  // State for React rendering only
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchIdRef = useRef(0);

  const updateUI = useCallback((items: SuggestionItem[], idx: number, show: boolean) => {
    if (!show && debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    suggestionsRef.current = items;
    selectedIndexRef.current = idx;
    showRef.current = show;
    setSuggestions(items);
    setSelectedIndex(idx);
    setShowSuggestions(show);
  }, []);

  useEffect(() => {
    if (!settings.showSuggestionPopup) {
      updateUI([], 0, false);
    }
  }, [settings.showSuggestionPopup, updateUI]);

  const fetchPathCompletions = useCallback(async (partial: string): Promise<SuggestionItem[]> => {
    try {
      const entries = await invoke<CompletionEntry[]>("list_path_completions", {
        baseDir: cwdRef.current || "~",
        partial,
      });
      const items = entries.map((e) => ({
        name: e.name,
        type: e.isDir ? "folder" as const : "file" as const,
        path: e.path,
        isDir: e.isDir,
        isHidden: e.isHidden,
      }));
      const parentDir = cwdRef.current || "";
      return sortByRecency(items, parentDir);
    } catch {
      return [];
    }
  }, []);

  const triggerAutocomplete = useCallback((input: string) => {
    if (!settingsRef.current.showSuggestionPopup) {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      updateUI([], 0, false);
      return;
    }

    const trimmed = input.trimStart();
    if (!trimmed) {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      updateUI([], 0, false);
      return;
    }

    // Don't suggest while inside a quoted string
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "\\" && i + 1 < trimmed.length) { i++; continue; }
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      if (ch === '"' && !inSingle) inDouble = !inDouble;
    }
    if (inSingle || inDouble) {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      updateUI([], 0, false);
      return;
    }

    // Don't suggest when input ends with \ (line continuation)
    if (trimmed.endsWith("\\")) {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      updateUI([], 0, false);
      return;
    }

    // Don't hide existing suggestions during the debounce wait — only clear
    // the timer and start a fresh one. This prevents flash (hide → show).
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const thisId = ++fetchIdRef.current;
    debounceRef.current = setTimeout(async () => {
      // If another trigger fired while we waited, bail out
      if (thisId !== fetchIdRef.current) return;

      const parts = trimmed.split(/\s+/);
      const command = parts[0].toLowerCase();
      const lastToken = extractLastToken(trimmed);
      const lastTokenUnescaped = unescapeToken(lastToken);

      const hasSpec = specRegistry.hasSpec(command);

      if (hasSpec && parts.length >= 1) {
        try {
          const figSuggestions = await getAutocompleteSuggestions(trimmed, cwdRef.current);
          if (thisId !== fetchIdRef.current) return;

          const needsPathCompletion = figSuggestions.some(
            (s) => s.type === "file" || s.type === "folder"
          );

          let items: SuggestionItem[] = figSuggestions
            .filter((s) => s.type !== "file" && s.type !== "folder")
            .map((s) => ({
              name: s.name,
              description: s.description,
              type: s.type as SuggestionItem["type"],
              icon: s.icon,
              insertValue: s.insertValue,
            }));

          if (needsPathCompletion) {
            const foldersOnly = figSuggestions.some((s) => s.type === "folder") &&
              !figSuggestions.some((s) => s.type === "file");
            const pathItems = await fetchPathCompletions(lastTokenUnescaped);
            if (thisId !== fetchIdRef.current) return;
            const filtered = foldersOnly
              ? pathItems.filter((p) => p.type === "folder")
              : pathItems;
            items = [...items, ...filtered];
          }

          if (items.length > 0) {
            updateUI(items, 0, true);
          } else {
            updateUI([], 0, false);
          }
        } catch {
          if (thisId === fetchIdRef.current) updateUI([], 0, false);
        }
      } else if (parts.length >= 2 && PATH_COMMANDS.includes(command)) {
        const pathItems = await fetchPathCompletions(lastTokenUnescaped);
        if (thisId !== fetchIdRef.current) return;
        let items = command === "cd"
          ? pathItems.filter((p) => p.type === "folder")
          : pathItems;

        if (command === "cd" && lastTokenUnescaped.endsWith("/")) {
          const currentDirItem: SuggestionItem = {
            name: ".",
            description: "Select current folder",
            type: "folder",
          };
          items = [currentDirItem, ...items];
        }

        if (items.length > 0) {
          updateUI(items, 0, true);
        } else {
          updateUI([], 0, false);
        }
      } else {
        updateUI([], 0, false);
      }
    }, 120);
  }, [fetchPathCompletions, updateUI]);

  const acceptSuggestion = useCallback((item: SuggestionItem, inline = false) => {
    if (!xtermRef.current || !sessionIdRef.current) return;

    // "Select current folder" ? remove trailing slash, send Enter to execute cd
    if (item.name === ".") {
      const encoder = new TextEncoder();
      invoke("write_terminal_session", {
        sessionId: sessionIdRef.current,
        data: Array.from(encoder.encode("\x7f\r")),
      });
      inputBufferRef.current = "";
      updateUI([], 0, false);
      xtermRef.current.focus();
      return;
    }

    const input = inputBufferRef.current;
    const trimmed = input.trimStart();
    const currentToken = extractLastToken(trimmed);
    const encoder = new TextEncoder();

    if (item.type === "file" || item.type === "folder") {
      const lastSlash = currentToken.lastIndexOf("/");
      const toDelete = lastSlash >= 0 ? currentToken.slice(lastSlash + 1) : currentToken;

      const backspaces = "\x7f".repeat(toDelete.length);
      let rawName = item.insertValue || item.name;

      const needsEscape = /[ \t()'"`$!#&;|<>{}\[\]*?~]/.test(rawName);
      const escaped = needsEscape ? rawName.replace(/([ \t()'"`$!#&;|<>{}\[\]*?~])/g, "\\$1") : rawName;

      let completion = escaped;
      if (!inline && item.type === "folder") completion += "/";

      const toSend = backspaces + completion;
      invoke("write_terminal_session", {
        sessionId: sessionIdRef.current,
        data: Array.from(encoder.encode(toSend)),
      });

      const basePath = lastSlash >= 0 ? currentToken.slice(0, lastSlash + 1) : "";
      const newPartial = basePath + completion;
      inputBufferRef.current = input.slice(0, input.length - currentToken.length) + newPartial;

      updateUI([], 0, false);
      xtermRef.current.focus();

      // Only fetch next level on Tab/Enter for folders
      if (!inline && item.type === "folder") {
        setTimeout(() => triggerAutocomplete(inputBufferRef.current), 150);
      }
    } else {
      // Spec-based completion (subcommand, option, arg)
      const backspaces = "\x7f".repeat(currentToken.length);
      const completion = (item.insertValue || item.name) + (inline ? "" : " ");

      const toSend = backspaces + completion;
      invoke("write_terminal_session", {
        sessionId: sessionIdRef.current,
        data: Array.from(encoder.encode(toSend)),
      });

      inputBufferRef.current = input.slice(0, input.length - currentToken.length) + completion;

      updateUI([], 0, false);
      xtermRef.current.focus();

      if (!inline) {
        setTimeout(() => triggerAutocomplete(inputBufferRef.current), 100);
      }
    }
  }, [triggerAutocomplete, updateUI]);

  const openSearch = useCallback(() => {
    setShowSearch(true);
    // Multiple focus attempts to beat any competing focus-restore logic
    setTimeout(() => searchInputRef.current?.focus(), 50);
    setTimeout(() => searchInputRef.current?.focus(), 150);
  }, []);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery("");
    setSearchMatchCount("");
    searchAddonRef.current?.clearDecorations();
    xtermRef.current?.focus();
  }, []);

  const doSearch = useCallback((query: string) => {
    setSearchQuery(query);
    if (!searchAddonRef.current) return;
    if (!query) {
      searchAddonRef.current.clearDecorations();
      setSearchMatchCount("");
      return;
    }
    searchAddonRef.current.findNext(query, { regex: false, caseSensitive: false, decorations: {
      matchBackground: "#fbbf2450",
      matchBorder: "#fbbf24",
      matchOverviewRuler: "#fbbf24",
      activeMatchBackground: "#f97316",
      activeMatchBorder: "#f97316",
      activeMatchColorOverviewRuler: "#f97316",
    }});
  }, []);

  const searchNext = useCallback(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery, { regex: false, caseSensitive: false, decorations: {
        matchBackground: "#fbbf2450",
        matchBorder: "#fbbf24",
        matchOverviewRuler: "#fbbf24",
        activeMatchBackground: "#f97316",
        activeMatchBorder: "#f97316",
        activeMatchColorOverviewRuler: "#f97316",
      }});
    }
  }, [searchQuery]);

  const searchPrev = useCallback(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findPrevious(searchQuery, { regex: false, caseSensitive: false, decorations: {
        matchBackground: "#fbbf2450",
        matchBorder: "#fbbf24",
        matchOverviewRuler: "#fbbf24",
        activeMatchBackground: "#f97316",
        activeMatchBorder: "#f97316",
        activeMatchColorOverviewRuler: "#f97316",
      }});
    }
  }, [searchQuery]);

  const clearTerminal = useCallback(() => {
    if (!xtermRef.current || !sessionIdRef.current) return;
    xtermRef.current.clear();
    const encoder = new TextEncoder();
    invoke("write_terminal_session", {
      sessionId: sessionIdRef.current,
      data: Array.from(encoder.encode("clear\n")),
    }).catch(() => {});
    inputBufferRef.current = "";
  }, []);

  useEffect(() => {
    if (clearRef) clearRef.current = clearTerminal;
  }, [clearRef, clearTerminal]);

  /**
   * Re-fits the terminal to its container and repaints it.
   *
   * `FitAddon.fit()` skips the resize when the cell count hasn't changed — and
   * so skips the repaint with it. A pane whose first render used a stale
   * character measurement would keep drawing its cursor at the wrong offset
   * until something else happened to redraw the row, so ask for the redraw.
   */
  const refit = useCallback(() => {
    const xterm = xtermRef.current;
    if (!xterm || !fitAddonRef.current) return;
    fitAddonRef.current.fit();
    xterm.refresh(0, xterm.rows - 1);
  }, []);

  /**
   * Writes the clipboard straight to the PTY. Only needed off macOS, where the
   * paste chord (Ctrl+Shift+V) isn't one the webview acts on by itself.
   */
  const pasteFromClipboard = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      await invoke("write_terminal_session", {
        sessionId: sessionIdRef.current,
        data: Array.from(new TextEncoder().encode(text)),
      });
    } catch {
      // Clipboard access can be refused; nothing useful to say about it here.
    }
  }, []);

  const initTerminal = useCallback(async () => {
    const container = containerRef.current;
    if (initStarted.current || !container) return;
    initStarted.current = true;

    const s = settingsRef.current;
    const fontFamily = ensureMonospaceFallback(s.fontFamily);

    const xterm = new XTerm({
      fontFamily,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing ?? 0,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      scrollback: s.scrollback,
      theme: theme === "dark" ? DARK_THEME : LIGHT_THEME,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const unicode11Addon = new Unicode11Addon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      invoke("plugin:shell|open", { path: uri }).catch(() => {
        window.open(uri, "_blank");
      });
    });

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(searchAddon);
    xterm.loadAddon(unicode11Addon);
    xterm.loadAddon(webLinksAddon);
    xterm.unicode.activeVersion = "11";

    // Open into a container that already has a size, so the very first
    // character measurement is a real one. See `waitForLayout`.
    await waitForLayout(container);
    xterm.open(container);

    searchAddonRef.current = searchAddon;

    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;

      if (matches(event, SHORTCUTS.find)) {
        openSearch();
        return false;
      }

      if (matches(event, SHORTCUTS.history)) {
        setShowHistory(true);
        return false;
      }

      // Copy the selection, if there is one. Without one the chord means
      // nothing to the app, so it falls through — which on macOS is how ⌃C
      // still reaches the shell as SIGINT.
      if (matches(event, SHORTCUTS.copy)) {
        if (xterm.hasSelection()) {
          navigator.clipboard.writeText(xterm.getSelection());
          return false;
        }
        return true;
      }

      if (matches(event, SHORTCUTS.paste)) {
        // macOS routes ⌘V through the webview's own paste handling. Ctrl+Shift+V
        // is not a webview binding, so off macOS the paste has to be performed
        // here or nothing happens at all.
        if (!isMac) {
          pasteFromClipboard();
          return false;
        }
        return true;
      }

      return true;
    });

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    fitAddon.fit();

    const dims = await measureDimensions(fitAddon);
    if (!dims) {
      // 80x24 keeps the shell usable, but it won't match the window, so say so
      // rather than leaving a mystery to debug from a screenshot.
      console.warn("Terminal: could not measure the container; falling back to 80x24");
    }
    const cols = dims?.cols ?? 80;
    const rows = dims?.rows ?? 24;

    // Listen BEFORE creating session
    const unlisten = await listen<TerminalOutputPayload>("terminal-output", (event) => {
      if (event.payload.session_id === sessionIdRef.current) {
        const data = new Uint8Array(event.payload.data);
        xterm.write(data);
        const text = new TextDecoder().decode(data);

        // Track CWD
        const newCwd = parseCwd(text);
        if (newCwd && newCwd !== cwdRef.current) {
          cwdRef.current = newCwd;
          recordDirUsage(newCwd);
          onCwdChange?.(newCwd);
        }
      }
    });
    unlistenRef.current = unlisten;

    // Input handler - uses refs for latest autocomplete state
    xterm.onData((data) => {
      if (!sessionIdRef.current) return;

      const isShowing = showRef.current;
      const items = suggestionsRef.current;
      const idx = selectedIndexRef.current;

      if (data === "\r" || data === "\n" || data === "\x1bOM") {
        const trimmedInput = inputBufferRef.current.trimEnd();
        if (trimmedInput.endsWith("\\")) {
          updateUI([], 0, false);
        } else if (isShowing && items.length > 0) {
          const selected = items[idx];
          // Enter skips only --options/-flags; accepts everything else (files, folders, subcommands, args)
          const isOption = selected.type === "option" || (selected.name && /^-/.test(selected.name));
          if (!isOption) {
            acceptSuggestion(selected);
            return;
          }
        }
        if (!trimmedInput.endsWith("\\")) {
          inputBufferRef.current = "";
        }
        updateUI([], 0, false);
      } else if (data === "\x7f") {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        const trimmedBuf = inputBufferRef.current.trimStart();
        if (trimmedBuf.length > 0 && trimmedBuf.includes(" ")) {
          // Re-trigger without hiding first to prevent flash
          triggerAutocomplete(inputBufferRef.current);
        } else {
          if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
          updateUI([], 0, false);
        }
      } else if (data === "\x03") {
        // Ctrl+C - cancel
        inputBufferRef.current = "";
        updateUI([], 0, false);
      } else if (data === "\x15") {
        // Ctrl+U - kill line (clear everything before cursor)
        inputBufferRef.current = "";
        updateUI([], 0, false);
      } else if (data === "\x17") {
        // Ctrl+W - kill word (remove last word)
        const buf = inputBufferRef.current;
        const trimmedEnd = buf.replace(/\s+$/, "");
        const lastSpace = trimmedEnd.lastIndexOf(" ");
        inputBufferRef.current = lastSpace >= 0 ? buf.slice(0, lastSpace + 1) : "";
        if (inputBufferRef.current.trim()) {
          triggerAutocomplete(inputBufferRef.current);
        } else {
          updateUI([], 0, false);
        }
      } else if (data === "\x01" || data === "\x05") {
        // Ctrl+A / Ctrl+E - home / end — no buffer change, just close popup
        if (isShowing) updateUI([], 0, false);
      } else if (data === "\x1b") {
        // Escape alone
        if (isShowing) {
          updateUI([], 0, false);
          return; // Don't send escape to terminal
        }
      } else if (data === "\t") {
        // Tab - accept suggestion
        if (isShowing && items.length > 0) {
          acceptSuggestion(items[idx]);
          return; // Don't send tab to terminal
        }
      } else if (data === "\x1b[C" || data === "\x1bOC") {
        // Arrow right - close popup and consume the keystroke to prevent
        // zsh-autosuggestions from accepting its ghost suggestion
        if (isShowing) {
          updateUI([], 0, false);
          return;
        }
      } else if (data === "\x1b[A" || data === "\x1bOA") {
        // Arrow up
        if (isShowing && items.length > 0) {
          const newIdx = Math.max(0, idx - 1);
          selectedIndexRef.current = newIdx;
          setSelectedIndex(newIdx);
          return;
        }
      } else if (data === "\x1b[B" || data === "\x1bOB") {
        // Arrow down
        if (isShowing && items.length > 0) {
          const newIdx = Math.min(items.length - 1, idx + 1);
          selectedIndexRef.current = newIdx;
          setSelectedIndex(newIdx);
          return;
        }
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        inputBufferRef.current += data;
        triggerAutocomplete(inputBufferRef.current);
      } else if (data.length > 1) {
        // Multi-character input (paste) — handle bracketed paste sequences
        let pasteContent = data;
        if (pasteContent.startsWith("\x1b[200~")) {
          pasteContent = pasteContent.slice(6);
        }
        if (pasteContent.endsWith("\x1b[201~")) {
          pasteContent = pasteContent.slice(0, -6);
        }
        // Skip pure escape sequences (arrows, function keys, etc.)
        if (pasteContent.startsWith("\x1b") && pasteContent.length <= 6) {
          // Not a paste, just a normal escape sequence — don't update buffer
        } else if (pasteContent.includes("\n") || pasteContent.includes("\r")) {
          const lines = pasteContent.split(/[\r\n]+/);
          const lastLine = lines[lines.length - 1] || "";
          inputBufferRef.current = lastLine;
          if (lastLine.trim()) {
            triggerAutocomplete(lastLine);
          } else {
            updateUI([], 0, false);
          }
        } else if (pasteContent.length > 0 && !pasteContent.startsWith("\x1b")) {
          inputBufferRef.current += pasteContent;
          triggerAutocomplete(inputBufferRef.current);
        }
      }

      // Send data to PTY
      const encoder = new TextEncoder();
      invoke("write_terminal_session", {
        sessionId: sessionIdRef.current,
        data: Array.from(encoder.encode(data)),
      }).catch(() => {});
    });

    let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
    xterm.onResize(({ cols, rows }) => {
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        if (sessionIdRef.current) {
          invoke("resize_terminal_session", {
            sessionId: sessionIdRef.current,
            cols,
            rows,
          }).catch(() => {});
        }
      }, 400);
    });

    // Create session
    try {
      const raw = await invoke<RawTerminalSession>("create_terminal_session", {
        cols,
        rows,
        cwd: initialCwd || null,
      });
      sessionIdRef.current = raw.id;
      cwdRef.current = raw.cwd;
      invoke<string>("get_home_dir").then((home) => setHomeDir(home)).catch(() => {});

      const session: TerminalSession = {
        id: raw.id,
        shell: raw.shell,
        cwd: raw.cwd,
        title: raw.title,
        createdAt: raw.created_at,
        status: raw.status,
      };

      onSessionCreated(session);
      setTimeout(() => xterm.focus(), 50);
    } catch (err) {
      xterm.writeln(`\x1b[38;5;203mFailed to create terminal: ${err}\x1b[0m`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    initTerminal();
    return () => {
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
      if (sessionIdRef.current) {
        invoke("close_terminal_session", { sessionId: sessionIdRef.current }).catch(() => {});
        sessionIdRef.current = null;
      }
      if (xtermRef.current) { xtermRef.current.dispose(); xtermRef.current = null; }
    };
  }, [initTerminal]);

  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = theme === "dark" ? DARK_THEME : LIGHT_THEME;
    }
  }, [theme]);

  useEffect(() => {
    if (!xtermRef.current) return;
    const xterm = xtermRef.current;
    const fontFamily = ensureMonospaceFallback(settings.fontFamily);
    const changed =
      xterm.options.fontFamily !== fontFamily ||
      xterm.options.fontSize !== settings.fontSize ||
      xterm.options.lineHeight !== settings.lineHeight ||
      xterm.options.letterSpacing !== (settings.letterSpacing ?? 0);
    if (changed) {
      xterm.options.fontFamily = fontFamily;
      xterm.options.fontSize = settings.fontSize;
      xterm.options.lineHeight = settings.lineHeight;
      xterm.options.letterSpacing = settings.letterSpacing ?? 0;
      // A font change moves every cell boundary, so this one needs the repaint
      // as much as the resize does.
      refit();
    }
  }, [settings.fontFamily, settings.fontSize, settings.lineHeight, settings.letterSpacing, refit]);

  useEffect(() => {
    if (isActive && xtermRef.current) {
      refit();
      xtermRef.current.focus();
    }
  }, [isActive, refit]);

  useEffect(() => {
    if (focusRef) {
      focusRef.current = () => {
        xtermRef.current?.focus();
      };
    }
  });

  const handleHistorySelect = useCallback(async (command: string) => {
    const sid = sessionIdRef.current;
    const xterm = xtermRef.current;
    if (!sid || !xterm) return;

    try {
      const encoder = new TextEncoder();
      await invoke("write_terminal_session", {
        sessionId: sid,
        data: Array.from(encoder.encode("\x15")),
      });
      await invoke("write_terminal_session", {
        sessionId: sid,
        data: Array.from(encoder.encode(command)),
      });
    } catch { /* ignore */ }
    inputBufferRef.current = command;
    xterm.focus();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      if (!isDragging()) {
        refit();
      }
    });
    observer.observe(el);

    const onDragEnd = () => refit();
    window.addEventListener("pane-drag-end", onDragEnd);

    return () => {
      observer.disconnect();
      window.removeEventListener("pane-drag-end", onDragEnd);
    };
  }, [refit]);

  return (
    <div
      ref={wrapperRef}
      data-instance-id={instanceId}
      className="relative w-full h-full"
    >
      {/* Search bar */}
      {showSearch && (
        <div
          className="search-bar absolute top-2 right-3 z-50 flex items-center gap-1 px-2 py-1.5 rounded-lg shadow-lg"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Search size={13} className="search-icon shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => doSearch(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                e.shiftKey ? searchPrev() : searchNext();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            onKeyUp={(e) => e.stopPropagation()}
            onPaste={(e) => e.stopPropagation()}
            placeholder="Search..."
            className="search-input bg-transparent outline-none text-xs w-40"
            autoFocus
          />
          {searchMatchCount && (
            <span className="text-[10px] search-count shrink-0">{searchMatchCount}</span>
          )}
          <button onClick={searchPrev} className="search-nav-btn p-0.5 rounded transition-colors" title="Previous (Shift+Enter)">
            <ChevronUp size={14} />
          </button>
          <button onClick={searchNext} className="search-nav-btn p-0.5 rounded transition-colors" title="Next (Enter)">
            <ChevronDown size={14} />
          </button>
          <button onClick={closeSearch} className="search-nav-btn p-0.5 rounded transition-colors" title="Close (Esc)">
            <X size={14} />
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        className="w-full h-full"
      />
      <SuggestionPopup
        items={suggestions}
        selectedIndex={selectedIndex}
        visible={showSuggestions && isActive && settings.showSuggestionPopup}
        anchorRef={containerRef}
        onSelect={acceptSuggestion}
        fontFamily={settings.fontFamily}
      />
      <HistorySearch
        visible={showHistory && isActive}
        onClose={() => {
          setShowHistory(false);
          xtermRef.current?.focus();
        }}
        onSelect={handleHistorySelect}
      />
    </div>
  );
}
