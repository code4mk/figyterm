import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  createTerminalSession,
  writeTerminalSession,
  resizeTerminalSession,
  closeTerminalSession,
  listenTerminalOutput,
} from "../services/terminal";
import { useSettingsStore } from "../stores/settingsStore";
import { TerminalSession, TerminalOutputEvent } from "../types/terminal";

interface UseTerminalOptions {
  onSessionCreated?: (session: TerminalSession) => void;
  onSessionClosed?: (sessionId: string) => void;
}

export function useTerminal(options: UseTerminalOptions = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const { settings } = useSettingsStore();

  const initTerminal = useCallback(async () => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        cursorAccent: "#1a1b26",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const dims = fitAddon.proposeDimensions();
    const cols = dims?.cols ?? 80;
    const rows = dims?.rows ?? 24;

    try {
      const session = await createTerminalSession(cols, rows);
      sessionIdRef.current = session.id;

      const unlisten = await listenTerminalOutput((event: TerminalOutputEvent) => {
        if (event.session_id === sessionIdRef.current) {
          const data = new Uint8Array(event.data);
          terminal.write(data);
        }
      });
      unlistenRef.current = unlisten;

      terminal.onData((data) => {
        if (sessionIdRef.current) {
          const encoder = new TextEncoder();
          writeTerminalSession(sessionIdRef.current, encoder.encode(data));
        }
      });

      terminal.onResize(({ cols, rows }) => {
        if (sessionIdRef.current) {
          resizeTerminalSession(sessionIdRef.current, cols, rows);
        }
      });

      options.onSessionCreated?.(session);
    } catch (err) {
      terminal.writeln(`\x1b[31mFailed to create terminal session: ${err}\x1b[0m`);
    }

    return terminal;
  }, [settings, options]);

  const fit = useCallback(() => {
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
  }, []);

  const destroy = useCallback(async () => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    if (sessionIdRef.current) {
      try {
        await closeTerminalSession(sessionIdRef.current);
      } catch {
        // Session may already be closed
      }
      options.onSessionClosed?.(sessionIdRef.current);
      sessionIdRef.current = null;
    }
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }
  }, [options]);

  const focus = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      destroy();
    };
  }, [destroy]);

  return {
    containerRef,
    terminalRef,
    fitAddonRef,
    sessionIdRef,
    initTerminal,
    fit,
    destroy,
    focus,
  };
}
