import { useCallback, useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import {
  closeTerminalSession,
  resizeTerminalSession,
  writeTerminalSession,
} from "../../services/terminal";
import { startConversation } from "../../services/claude";
import { ClaudeProject, Conversation } from "../../services/claude-project";
import { subscribeSession } from "../../services/terminal-bus";
import {
  DARK_THEME,
  LIGHT_THEME,
  ensureMonospaceFallback,
  measureDimensions,
  minimumContrastFor,
  pathLinkProvider,
  waitForLayout,
} from "../../services/xterm";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";

/**
 * One conversation, drawn.
 *
 * An xterm bound to a pty running `claude`, and the three rules that make a
 * terminal survivable when it is not the one on screen:
 *
 * 1. **Mounted stays mounted.** The component is rendered for every
 *    conversation the window knows about and hides itself; unmounting would
 *    throw away the scrollback of a conversation that is still running.
 * 2. **Never fit while hidden.** A hidden container measures as zero, and
 *    `FitAddon` on a zero cell either does nothing or proposes nonsense — and
 *    a `resize` to one column makes Claude's TUI redraw its whole interface
 *    into that column, which nothing but another resize can undo. Fitting
 *    happens on show and on a real size change, never on a project switch.
 * 3. **One output listener, not one per conversation.** See `terminal-bus.ts`.
 */

/**
 * Smaller than a shell pane's scrollback, deliberately.
 *
 * A shell's buffer is the only record of what happened. A conversation's record
 * is the transcript the CLI writes to disk, and the buffer is only what you can
 * scroll back through — so this is sized to be useful rather than complete, and
 * it is what makes "as many conversations as you like" affordable.
 */
const SCROLLBACK = 3000;

interface ClaudeSurfaceProps {
  project: ClaudeProject;
  conversation: Conversation;
  /** True only when this conversation is the one on screen in an open window. */
  visible: boolean;
  /** Resolved absolute path to the `claude` binary. */
  program: string;
  onStarted: (sessionId: string) => void;
  onExited: (sessionId: string) => void;
  onFailed: (sessionId: string, message: string) => void;
  /**
   * Claude wants the user — it rang the bell, or changed the terminal title.
   *
   * Both are things the CLI already does through the terminal protocol, which
   * is why this is a signal rather than a guess: scraping output for prompt
   * text would break the first time any of it is reworded.
   */
  onAttention?: (sessionId: string) => void;
  /**
   * Handed a writer for this conversation, so the window can type into it —
   * `/add-dir`, and nothing else so far.
   */
  writeRef?: React.MutableRefObject<Record<string, (text: string) => void>>;
  focusRef?: React.MutableRefObject<Record<string, () => void>>;
}

export function ClaudeSurface({
  project,
  conversation,
  visible,
  program,
  onStarted,
  onExited,
  onFailed,
  onAttention,
  writeRef,
  focusRef,
}: ClaudeSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const startedRef = useRef(false);
  const aliveRef = useRef(false);
  const theme = useThemeStore((s) => s.theme);
  const settings = useSettingsStore((s) => s.settings);

  const sessionId = conversation.sessionId;

  /*
    Read through refs by the start effect, which must run exactly once per
    conversation. Depending on them directly would restart the process every
    time the font size changed.
  */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const callbacks = useRef({ onStarted, onExited, onFailed, onAttention });
  callbacks.current = { onStarted, onExited, onFailed, onAttention };
  const projectRef = useRef(project);
  projectRef.current = project;
  /*
    `program` is read through a ref rather than depended on for a specific
    reason: a dependency change tears the effect down — closing the pty — and
    then the `startedRef` guard makes the new run bail out, leaving a dead
    conversation that looks alive. The process is tied to the component's
    lifetime, so the effect's deps must be too. Remounting is the caller's job,
    and it does it by changing the key.
  */
  const programRef = useRef(program);
  programRef.current = program;

  /** Fits, and tells the pty — but only when there is a real size to fit to. */
  const fit = useCallback(() => {
    const container = containerRef.current;
    const fitAddon = fitRef.current;
    if (!container || !fitAddon) return;
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    fitAddon.fit();
  }, []);

  // ─── Start ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (startedRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    startedRef.current = true;

    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const run = async () => {
      const s = settingsRef.current;
      const xterm = new XTerm({
        fontFamily: ensureMonospaceFallback(s.fontFamily),
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        cursorStyle: s.cursorStyle,
        cursorBlink: s.cursorBlink,
        scrollback: SCROLLBACK,
        theme: themeRef.current === "dark" ? DARK_THEME : LIGHT_THEME,
        allowProposedApi: true,
        drawBoldTextInBrightColors: true,
        minimumContrastRatio: minimumContrastFor(themeRef.current),
      });

      const fitAddon = new FitAddon();
      const unicode11 = new Unicode11Addon();
      const webLinks = new WebLinksAddon((_event, uri) => {
        invoke("plugin:shell|open", { path: uri }).catch(() => {
          window.open(uri, "_blank");
        });
      });

      xterm.loadAddon(fitAddon);
      xterm.loadAddon(unicode11);
      xterm.loadAddon(webLinks);
      xterm.unicode.activeVersion = "11";

      /*
        A path Claude prints opens in the embedded editor. Relative paths
        resolve against the project root rather than a live cwd: Claude's own
        working directory is the project's and does not move the way a shell's
        does.
      */
      xterm.registerLinkProvider(
        pathLinkProvider(
          xterm,
          () => projectRef.current.root,
          // Whichever of this project's folders actually contains the file, so
          // a path in an added folder sends the editor there rather than to a
          // root it isn't under.
          (path) => {
            const project = projectRef.current;
            const under = (dir: string) =>
              path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
            return [...project.extraDirs, project.root].find(under) ?? project.root;
          }
        )
      );

      /*
        Attention, from the terminal protocol rather than from reading the
        output. A conversation you have switched away from will eventually need
        an answer, and this is how it says so without anyone parsing prose.

        **The bell only.** The design said the title change counted too, and it
        does not: the CLI rewrites the terminal title as its status changes, so
        a conversation quietly working would raise a "needs you" flag every few
        seconds. A bell is a request; a title is a status.
      */
      xterm.onBell(() => callbacks.current.onAttention?.(sessionId));

      xterm.open(container);
      xtermRef.current = xterm;
      fitRef.current = fitAddon;

      // The container can mount a frame or two before it has a size; measuring
      // before then is what produces an 80×24 session in a 200-column window.
      await waitForLayout(container);
      if (disposed) return;

      fitAddon.fit();
      const dims = await measureDimensions(fitAddon);
      if (disposed) return;

      const cols = dims?.cols ?? 80;
      const rows = dims?.rows ?? 24;

      /*
        Subscribed *before* the process is created. `create_terminal_session`
        spawns the child and starts its reader thread before it returns, so a
        subscription taken afterwards can miss the first bytes — which for a
        program that paints a TUI on startup is a visibly broken first frame.
      */
      unsubscribe = subscribeSession(sessionId, {
        onOutput: (data) => xterm.write(data),
        onExit: () => {
          aliveRef.current = false;
          xterm.write("\r\n\x1b[2m── this conversation has ended ──\x1b[0m\r\n");
          callbacks.current.onExited(sessionId);
        },
      });

      try {
        // Whether this is a new conversation or a resumed one is decided in
        // `startConversation`, from whether the transcript exists.
        await startConversation(
          projectRef.current,
          { sessionId },
          { cols, rows },
          programRef.current
        );
        if (disposed) return;
        aliveRef.current = true;
        callbacks.current.onStarted(sessionId);
      } catch (error) {
        unsubscribe?.();
        unsubscribe = null;
        const message = error instanceof Error ? error.message : String(error);
        xterm.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
        callbacks.current.onFailed(sessionId, message);
        return;
      }

      xterm.onData((data) => {
        if (!aliveRef.current) return;
        void writeTerminalSession(sessionId, new TextEncoder().encode(data));
      });

      xterm.onResize(({ cols, rows }) => {
        if (!aliveRef.current) return;
        void resizeTerminalSession(sessionId, cols, rows);
      });
    };

    void run();

    return () => {
      disposed = true;
      unsubscribe?.();
      /*
        Closing the pty here is correct *because* this component is only
        unmounted when the conversation is closed for good. Hiding it — a
        project switch, the window closing — leaves it mounted and running,
        which is the whole feature.
      */
      if (aliveRef.current) {
        aliveRef.current = false;
        void closeTerminalSession(sessionId).catch(() => {});
      }
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // ─── Becoming visible ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return;
    // A frame so the container has been laid out at its new size before it is
    // measured — this is the moment the "never fit while hidden" rule is paying
    // off, and fitting a frame too early would waste it.
    const frame = requestAnimationFrame(() => {
      fit();
      xtermRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, fit]);

  /** Window resizes, and the modal being dragged to a new size. */
  useEffect(() => {
    if (!visible) return;
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => fit());
    observer.observe(container);
    return () => observer.disconnect();
  }, [visible, fit]);

  // ─── Live settings ────────────────────────────────────────────────────────

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.theme = theme === "dark" ? DARK_THEME : LIGHT_THEME;
    xterm.options.minimumContrastRatio = minimumContrastFor(theme);
  }, [theme]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.fontFamily = ensureMonospaceFallback(settings.fontFamily);
    xterm.options.fontSize = settings.fontSize;
    xterm.options.lineHeight = settings.lineHeight;
    if (visible) fit();
  }, [settings.fontFamily, settings.fontSize, settings.lineHeight, visible, fit]);

  // ─── Handles the window holds ─────────────────────────────────────────────

  useEffect(() => {
    if (writeRef) {
      writeRef.current[sessionId] = (text: string) => {
        if (!aliveRef.current) return;
        void writeTerminalSession(sessionId, new TextEncoder().encode(text));
      };
    }
    if (focusRef) {
      focusRef.current[sessionId] = () => xtermRef.current?.focus();
    }
    return () => {
      if (writeRef) delete writeRef.current[sessionId];
      if (focusRef) delete focusRef.current[sessionId];
    };
  }, [sessionId, writeRef, focusRef]);

  return (
    <div
      // `invisible` rather than `display: none`: a hidden-but-laid-out element
      // still has a size, so becoming visible again is a fit rather than a
      // re-measurement from zero.
      className={`absolute inset-0 claude-surface ${visible ? "" : "invisible"}`}
      aria-hidden={!visible}
    >
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
