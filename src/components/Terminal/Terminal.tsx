import { useEffect, useCallback, useRef, useState } from "react";
import { Terminal as XTerm, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { TerminalSession } from "../../types/terminal";
import { SuggestionPopup, SuggestionItem } from "./SuggestionPopup";
import { getAutocompleteSuggestions } from "../../services/figy-autocomplete-engine";
import { specRegistry } from "../../services/figy-spec-registry";
import { isDragging } from "./SplitHandle";

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

export function Terminal({ instanceId, isActive, onSessionCreated, onCwdChange, clearRef }: TerminalProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const initStarted = useRef(false);
  const inputBufferRef = useRef("");
  const cwdRef = useRef("");
  const { settings } = useSettingsStore();
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
      return entries.map((e) => ({
        name: e.name,
        type: e.isDir ? "folder" as const : "file" as const,
        path: e.path,
        isDir: e.isDir,
        isHidden: e.isHidden,
      }));
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

      // Check if we have a Figy spec for this command
      const hasSpec = specRegistry.hasSpec(command);

      if (hasSpec && parts.length >= 1) {
        // Use Figy autocomplete engine
        try {
          const figSuggestions = await getAutocompleteSuggestions(trimmed, cwdRef.current);

          // For suggestions that are "file" or "folder" template types, fetch real paths
          const needsPathCompletion = figSuggestions.some(
            (s) => s.type === "file" || s.type === "folder"
          );

          let items: SuggestionItem[] = figSuggestions
            .filter((s) => s.type !== "file" && s.type !== "folder")
            .map((s) => ({
              name: s.name,
              description: s.description,
              type: s.type as SuggestionItem["type"],
              insertValue: s.insertValue,
            }));

          if (needsPathCompletion) {
            const currentToken = parts[parts.length - 1] || "";
            const foldersOnly = figSuggestions.some((s) => s.type === "folder") &&
              !figSuggestions.some((s) => s.type === "file");
            const pathItems = await fetchPathCompletions(currentToken);
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
        // Fallback: path completion for known commands without a spec
        const afterCommand = trimmed.slice(command.length).trimStart();
        const args = afterCommand.split(/\s+/);
        const partial = args[args.length - 1] || "";
        const pathItems = await fetchPathCompletions(partial);
        let items = command === "cd"
          ? pathItems.filter((p) => p.type === "folder")
          : pathItems;

        // Add "current folder" indicator when browsing inside a directory
        if (command === "cd" && partial.endsWith("/")) {
          const currentDirItem: SuggestionItem = {
            name: ".",
            description: "? Select current folder",
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
    const parts = trimmed.split(/\s+/);
    const currentToken = parts[parts.length - 1] || "";
    const encoder = new TextEncoder();

    if (item.type === "file" || item.type === "folder") {
      const lastSlash = currentToken.lastIndexOf("/");
      const toDelete = lastSlash >= 0 ? currentToken.slice(lastSlash + 1) : currentToken;

      const backspaces = "\x7f".repeat(toDelete.length);
      let completion = item.insertValue || item.name;

      // Right arrow: just complete the name, cursor at end. No trailing slash.
      // Tab/Enter: append / for folders and show next level.
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

    const xterm = new XTerm({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      theme: theme === "dark" ? DARK_THEME : LIGHT_THEME,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      invoke("plugin:shell|open", { path: uri }).catch(() => {
        window.open(uri, "_blank");
      });
    });

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);
    xterm.open(containerRef.current);

    // Ctrl+C: copy if there's a selection, otherwise send SIGINT to PTY
    xterm.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "c" && event.type === "keydown") {
        if (xterm.hasSelection()) {
          navigator.clipboard.writeText(xterm.getSelection());
          return false; // Prevent xterm from handling it
        }
        // No selection ? let xterm send \x03 (SIGINT)
        return true;
      }
      if (event.metaKey && event.key === "v") {
        return true;
      }
      return true;
    });

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

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
          const input = inputBufferRef.current.trimStart();
          const parts = input.split(/\s+/);
          const currentToken = parts[parts.length - 1] || "";
          const selected = items[idx];
          const selectedName = selected.name.toLowerCase();

          if (currentToken.length > 0) {
            if (selectedName.startsWith(currentToken.toLowerCase()) && selectedName !== currentToken.toLowerCase()) {
              acceptSuggestion(selected);
              return;
            }
          } else {
            if (selected.type === "arg" || selected.type === "subcommand") {
              acceptSuggestion(selected);
              return;
            }
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
          triggerAutocomplete(inputBufferRef.current);
        } else {
          updateUI([], 0, false);
        }
      } else if (data === "\x03") {
        inputBufferRef.current = "";
        updateUI([], 0, false);
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
      } else if (data.length > 1 && !data.startsWith("\x1b")) {
        // Multi-character input (paste)
        inputBufferRef.current += data;
        triggerAutocomplete(inputBufferRef.current);
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
    if (isActive && xtermRef.current) {
      fitAddonRef.current?.fit();
      xtermRef.current.focus();
    }
  }, [isActive]);

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
      />
    </div>
  );
}
