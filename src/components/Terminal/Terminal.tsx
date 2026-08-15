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

export function Terminal({ instanceId, isActive, onSessionCreated, onCwdChange, clearRef, focusRef }: TerminalProps) {
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
    const trimmed = input.trimStart();
    if (!trimmed) {
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
      updateUI([], 0, false);
      return;
    }

    // Don't suggest when input ends with \ (line continuation)
    if (trimmed.endsWith("\\")) {
      updateUI([], 0, false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const parts = trimmed.split(/\s+/);
      const command = parts[0].toLowerCase();
      const lastToken = extractLastToken(trimmed);
      const lastTokenUnescaped = unescapeToken(lastToken);

      const hasSpec = specRegistry.hasSpec(command);

      if (hasSpec && parts.length >= 1) {
        try {
          const figSuggestions = await getAutocompleteSuggestions(trimmed, cwdRef.current);

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
          updateUI([], 0, false);
        }
      } else if (parts.length >= 2 && PATH_COMMANDS.includes(command)) {
        const pathItems = await fetchPathCompletions(lastTokenUnescaped);
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
    }, 80);
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

  const initTerminal = useCallback(async () => {
    if (initStarted.current || !containerRef.current) return;
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
    xterm.open(containerRef.current);

    searchAddonRef.current = searchAddon;

    xterm.attachCustomKeyEventHandler((event) => {
      // Cmd+F / Ctrl+F: open search
      if ((event.metaKey || event.ctrlKey) && event.key === "f" && event.type === "keydown") {
        openSearch();
        return false;
      }
      // Ctrl+C / Cmd+C: copy if selection, otherwise SIGINT
      if ((event.ctrlKey || event.metaKey) && event.key === "c" && event.type === "keydown") {
        if (xterm.hasSelection()) {
          navigator.clipboard.writeText(xterm.getSelection());
          return false;
        }
        return true;
      }
      if (event.metaKey && event.key === "v") {
        return true;
      }
      return true;
    });

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    await new Promise((r) => setTimeout(r, 30));
    fitAddon.fit();

    const dims = fitAddon.proposeDimensions();
    const cols = dims?.cols ?? 80;
    const rows = dims?.rows ?? 24;

    // Listen BEFORE creating session
    const unlisten = await listen<TerminalOutputPayload>("terminal-output", (event) => {
      if (event.payload.session_id === sessionIdRef.current) {
        const data = new Uint8Array(event.payload.data);
        xterm.write(data);
        const text = new TextDecoder().decode(data);

        // Track CWD
        let newCwd = "";
        const osc7 = text.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)/);
        if (osc7) newCwd = osc7[1];
        const promptCwd = text.match(/[:\s](~[^\s\]]*|\/[^\s\]]*)\s*[\]$%#>]\s*$/m);
        if (promptCwd) newCwd = promptCwd[1];
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
          // Line continuation: pass through to shell, keep buffer context
          updateUI([], 0, false);
        } else if (isShowing && items.length > 0) {
          // Popup open → Enter always picks the selected suggestion
          acceptSuggestion(items[idx]);
          return;
        }
        if (!trimmedInput.endsWith("\\")) {
          inputBufferRef.current = "";
        }
        updateUI([], 0, false);
      } else if (data === "\x7f") {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        const trimmedBuf = inputBufferRef.current.trimStart();
        if (trimmedBuf.length > 0 && trimmedBuf.includes(" ")) {
          triggerAutocomplete(inputBufferRef.current);
        } else {
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
        // Arrow right - just close popup, let it pass through to terminal
        if (isShowing) {
          updateUI([], 0, false);
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
      const raw = await invoke<RawTerminalSession>("create_terminal_session", { cols, rows });
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
      fitAddonRef.current?.fit();
    }
  }, [settings.fontFamily, settings.fontSize, settings.lineHeight, settings.letterSpacing]);

  useEffect(() => {
    if (isActive && xtermRef.current) {
      fitAddonRef.current?.fit();
      xtermRef.current.focus();
    }
  }, [isActive]);

  useEffect(() => {
    if (focusRef) {
      focusRef.current = () => {
        xtermRef.current?.focus();
      };
    }
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const doFit = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
      }
    };

    const observer = new ResizeObserver(() => {
      if (!isDragging()) {
        doFit();
      }
    });
    observer.observe(el);

    const onDragEnd = () => doFit();
    window.addEventListener("pane-drag-end", onDragEnd);

    return () => {
      observer.disconnect();
      window.removeEventListener("pane-drag-end", onDragEnd);
    };
  }, []);

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
        visible={showSuggestions && isActive}
        anchorRef={containerRef}
        onSelect={acceptSuggestion}
        fontFamily={settings.fontFamily}
      />
    </div>
  );
}
