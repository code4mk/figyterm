import { useState, useCallback, useEffect, useRef, lazy, Suspense } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitToSelf, listenToSelf, openWindow } from "../../services/windows";
import { NewWindowPrompt } from "./NewWindowPrompt";
import { confirm } from "@tauri-apps/plugin-dialog";
import { TabBar } from "../Terminal/TabBar";
import { StatusBar } from "../Terminal/StatusBar";
import { SystemMonitor } from "../Terminal/SystemMonitor";
import { BrowserModal } from "../Browser/BrowserModal";
import { OverlayBoundary } from "../Overlay/OverlayBoundary";
import { useDrawingStore } from "../../stores/drawingStore";
import { CommandPalette } from "../CommandPalette/CommandPalette";
import { Settings } from "../Settings/Settings";
import { UpdateModal } from "../Updates/UpdateModal";
import { UpdateToast } from "../Updates/UpdateToast";
import { useUpdateCheck } from "../../hooks/useUpdateCheck";
import {
  PaneContainer,
  PaneNode,
  countPanes,
  findLeafIds,
  splitPane,
  removePane,
} from "../Terminal/PaneContainer";
import { useTerminalStore } from "../../stores/terminalStore";
import { useThemeStore } from "../../stores/themeStore";
import { TerminalSession } from "../../types/terminal";
import { SHORTCUTS, keys, matches } from "../../services/shortcuts";
// Type-only, so importing it doesn't pull the editor into the startup bundle.
import type { EditorOpenRequest } from "../Editor/EditorModal";
import type { ClaudeMentionRequest } from "../Claude/ClaudeModal";
import { isMac, EMBEDDED_BROWSER_SUPPORTED } from "../../services/platform";
import { DockWindow, MinimizedDock } from "./MinimizedDock";
import { AppHeader } from "./AppHeader";
import { TerminalWindow } from "../Terminal/TerminalWindow";
import { WelcomeScreen } from "../Welcome/WelcomeScreen";
import { resolveBase, type ServiceId } from "../../services/catalog";
import { useSettingsStore } from "../../stores/settingsStore";
import { serveAgentLsp } from "../../services/figycode-lsp";

const MAX_PANES_PER_TAB = 4;

/**
 * The editor is fetched the first time it's opened, not at launch.
 *
 * It carries CodeMirror, which is a few hundred kilobytes of the bundle, and
 * this is a terminal — the shell should be on screen before anything is spent
 * on an editor the user may never open in this session. After that first open
 * it stays mounted, so the cost is paid once.
 */
const EditorModal = lazy(() =>
  import("../Editor/EditorModal").then((module) => ({ default: module.EditorModal }))
);

/**
 * The Claude window is fetched the first time it's opened, like the editor.
 *
 * It carries a second xterm setup and the project machinery, and most sessions
 * never open it — but once opened it stays mounted for the rest of the session,
 * because unmounting it would kill every conversation running inside it. That
 * is a stronger version of the editor's rule: there, hiding protects undo
 * history; here it protects a running process.
 */
const ClaudeModal = lazy(() =>
  import("../Claude/ClaudeModal").then((module) => ({ default: module.ClaudeModal }))
);

/**
 * The Figy Code window, fetched on first open like the others.
 *
 * It latches mounted for the weakest of the reasons on this page — there is
 * no process behind it yet, only a scripted transcript — but a window you
 * dismissed mid-conversation and reopened to find blank would be wrong
 * whichever side of it is real.
 */
const FigyCodeModal = lazy(() =>
  import("../FigyCode/FigyCodeModal").then((module) => ({ default: module.FigyCodeModal }))
);

/**
 * The drawing window is fetched the first time it is opened — Excalidraw and
 * its fonts are a megabyte or two, and most sessions never draw. Like the
 * editor, it latches mounted once opened.
 */
const DrawingModal = lazy(() =>
  import("../Drawing/DrawingModal").then((module) => ({ default: module.DrawingModal }))
);

/**
 * The API client is fetched on first open, like the rest of them — and unlike
 * the rest, it latches mounted for a reason that is only about work in
 * progress: a half-written request and the response beside it are not worth
 * losing to a dismissed window. Persistence arrives with the store; until then
 * this is what stands in for it.
 */
const ApiModal = lazy(() =>
  import("../Api/ApiModal").then((module) => ({ default: module.ApiModal }))
);

/**
 * ⌘1-9 / Ctrl+1-9 jumps to a tab by position. It lives here rather than in the
 * shortcut table because it's a range of keys, not one — but the modifier has to
 * agree with the table: plain ⌘ on macOS, plain Ctrl elsewhere (digits are not
 * something the shell claims, so they don't need Ctrl+Shift).
 */
function isTabNumber(event: KeyboardEvent): boolean {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.shiftKey || event.altKey) return false;
  return event.key >= "1" && event.key <= "9";
}

interface TabInstance {
  id: string;
  paneTree: PaneNode;
  sessions: Record<string, { sessionId: string | null; session: TerminalSession | null }>;
}

export function AppShell() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  /*
    The terminal is a window now, like the other six.

    It opens closed, because whenever it is *not* the base somebody chose
    something else to look at — and whenever it is, this flag is ignored: a
    docked service is never hidden. See `visibleWhenNotBase` below.
  */
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** Latches the first time the terminal is shown; it then stays mounted. */
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  /** Latches on the first open; the window then stays mounted. See above. */
  const [claudeMounted, setClaudeMounted] = useState(false);
  const [figyOpen, setFigyOpen] = useState(false);
  /** Latches on the first open; the window then stays mounted. */
  const [figyMounted, setFigyMounted] = useState(false);
  const [drawingOpen, setDrawingOpen] = useState(false);
  /** Latches on the first open; the drawing window then stays mounted. */
  const [drawingMounted, setDrawingMounted] = useState(false);
  const [apiOpen, setApiOpen] = useState(false);
  /** Latches on the first open, so a request in progress survives closing. */
  const [apiMounted, setApiMounted] = useState(false);
  /** Counts the ⌘W presses handed to the Claude window. */
  const [claudeCloseTab, setClaudeCloseTab] = useState(0);
  /** Conversations with a live process, reported by the Claude window. */
  const [claudeLive, setClaudeLive] = useState(0);
  /** Conversations waiting for an answer, reported the same way. */
  const [claudeAttention, setClaudeAttention] = useState(0);
  /** A file the editor's tree asked Claude to look at. */
  const [claudeMention, setClaudeMention] = useState<ClaudeMentionRequest | null>(null);
  /** Latches on the first open, so the editor is fetched once and then stays. */
  const [editorMounted, setEditorMounted] = useState(false);
  /** The file a clicked path in terminal output asked the editor to open. */
  const [editorRequest, setEditorRequest] = useState<EditorOpenRequest | null>(null);
  /** Counts the ⌘W presses handed to the editor; see the menu listener below. */
  const [editorCloseTab, setEditorCloseTab] = useState(0);
  /**
   * Windows put away rather than closed, oldest first.
   *
   * The distinction is only about what the footer shows. Every one of these
   * windows already survives being closed — the `*Mounted` flags above are
   * what keep a pty, a request in flight and an unsaved buffer alive — but a
   * closed window leaves nothing on screen to say so, and "is that still
   * running?" had no answer anywhere. Minimizing puts it in the dock, which is
   * that answer.
   *
   * Order is insertion order so the row does not reshuffle under the pointer
   * as windows come and go.
   */
  const [minimized, setMinimized] = useState<DockWindow[]>([]);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [tabs, setTabs] = useState<TabInstance[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [liveCwds, setLiveCwds] = useState<Record<string, string>>({});
  const [customTabNames, setCustomTabNames] = useState<Record<string, string>>({});
  const initialCreated = useRef(false);

  const { addTab, removeTab, setActiveTab, reorderTabs } = useTerminalStore();
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  /*
    Which service fills the window, and whether anybody has said yet.

    `baseService` is stored as a plain string and may name a service that this
    build dropped or this platform cannot run; `resolveBase` turns it into an
    id that is known good, or null. Null is not a failure — it is a first run,
    and the welcome page is what the window shows until it is answered.
  */
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const baseId = resolveBase(settings.baseService);
  const welcomed = settings.welcomedAt !== null && baseId !== null;

  const chooseBase = useCallback(
    (id: ServiceId) => updateSettings({ baseService: id, welcomedAt: Date.now() }),
    [updateSettings]
  );

  /**
   * Whether a service should be drawn as a floating window.
   *
   * The base is never one: it is docked, it is always visible, and its own
   * `visible` prop is ignored in favour of `docked`. Everything else is a
   * window, shown when it has been opened.
   */
  const windowVisible = useCallback(
    (id: ServiceId, open: boolean) => open && baseId !== id,
    [baseId]
  );

  /**
   * Asks the focused pane to do something only it can do.
   *
   * The palette lives up here and the terminals are several levels down, each
   * owning its own xterm instance; rather than thread a ref per action through
   * `PaneContainer`, these go out as the same events the native menu sends and
   * the active pane picks them up (see `Terminal.tsx`).
   */
  const askActivePane = useCallback((action: "copy" | "paste" | "find" | "history") => {
    // To this window only. A plain `emit` reaches every window, so with two
    // open, Copy from the palette copied in the other window's focused pane
    // too and Find opened a search box in a window nobody was looking at.
    void emitToSelf(`menu://${action}`);
  }, []);

  /**
   * Another window, with its own tabs, shells and editor workspace.
   *
   * Asks what to call it first — every route in (the Shell menu, the chord,
   * the palette) goes through the same prompt, so a window is never made
   * without the one chance to say what it is for. The window itself is built
   * on the Rust side; `services/windows.ts` says why.
   */
  const [newWindowPrompt, setNewWindowPrompt] = useState(false);

  const handleNewWindow = useCallback(() => setNewWindowPrompt(true), []);

  const confirmNewWindow = useCallback((name: string) => {
    setNewWindowPrompt(false);
    // An empty name is passed through rather than withheld: the backend reads
    // it as "you pick" and answers with a fruit nothing else is called.
    void openWindow(name).catch((e) => console.error("could not open a window", e));
  }, []);
  const {
    info: updateInfo,
    loading: updateLoading,
    error: updateError,
    checkNow: checkForUpdatesNow,
    toastVisible,
    dismissToast,
    hideToast,
    updateAvailable,
  } = useUpdateCheck();
  const clearRefs = useRef<Map<string, React.MutableRefObject<(() => void) | null>>>(new Map());
  const focusRefs = useRef<Map<string, React.MutableRefObject<(() => void) | null>>>(new Map());
  const paneInitialCwds = useRef<Map<string, string>>(new Map());

  const getActiveCwd = useCallback(() => {
    if (!activePaneId || !activeTabId) return undefined;
    const tab = tabs.find((t) => t.id === activeTabId);
    const cwd = liveCwds[activePaneId] || tab?.sessions[activePaneId]?.session?.cwd;
    return cwd || undefined;
  }, [activePaneId, activeTabId, tabs, liveCwds]);

  const setPaneInitialCwd = useCallback((paneId: string, cwd?: string) => {
    if (cwd) {
      paneInitialCwds.current.set(paneId, cwd);
    } else {
      paneInitialCwds.current.delete(paneId);
    }
  }, []);

  const getPaneInitialCwd = useCallback((paneId: string) => {
    return paneInitialCwds.current.get(paneId);
  }, []);

  const focusActivePane = useCallback(() => {
    if (!activePaneId) return;
    const ref = focusRefs.current.get(activePaneId);
    if (ref?.current) ref.current();
  }, [activePaneId]);

  const createTab = useCallback((cwd?: string) => {
    const tabId = crypto.randomUUID();
    const paneId = crypto.randomUUID();
    const paneTree: PaneNode = { type: "leaf", id: paneId };
    setPaneInitialCwd(paneId, cwd);
    setTabs((prev) => [...prev, { id: tabId, paneTree, sessions: {} }]);
    setActiveTabId(tabId);
    setActivePaneId(paneId);
    // A new tab is a request to look at the terminal. When it is the base it
    // is already in front of you; when it is not — ⌘T from the drawing board,
    // or "open a terminal here" from the editor's tree — the window has to
    // come up, or the tab is made somewhere nobody can see.
    setTerminalOpen(true);
  }, [setPaneInitialCwd]);

  const handleNewTab = useCallback(() => {
    createTab();
  }, [createTab]);

  const handleNewTabInSameDir = useCallback(() => {
    createTab(getActiveCwd());
  }, [createTab, getActiveCwd]);

  const handleSessionCreated = useCallback(
    (paneId: string, session: TerminalSession) => {
      setTabs((prev) =>
        prev.map((tab) => {
          const leafIds = findLeafIds(tab.paneTree);
          if (leafIds.includes(paneId)) {
            return {
              ...tab,
              sessions: { ...tab.sessions, [paneId]: { sessionId: session.id, session } },
            };
          }
          return tab;
        })
      );
      addTab(session);
      setActiveTab(session.id);
    },
    [addTab, setActiveTab]
  );

  const handleSplitPane = useCallback(
    (direction: "horizontal" | "vertical") => {
      if (!activeTabId || !activePaneId) return;
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== activeTabId) return tab;
          if (countPanes(tab.paneTree) >= MAX_PANES_PER_TAB) return tab;
          const newPaneId = crypto.randomUUID();
          const newTree = splitPane(tab.paneTree, activePaneId, direction, newPaneId);
          setActivePaneId(newPaneId);
          return { ...tab, paneTree: newTree };
        })
      );
    },
    [activeTabId, activePaneId]
  );

  /**
   * Close one pane of the active tab.
   *
   * The keybinding, the menu and the palette close whichever pane has focus and
   * pass nothing; a pane's own close button names itself, because the pane the
   * pointer is over is not necessarily the pane the keyboard is in.
   */
  const handleClosePane = useCallback(
    (paneId?: string) => {
      const targetPaneId = paneId ?? activePaneId;
      if (!activeTabId || !targetPaneId) return;

      setTabs((prev) => {
        const tab = prev.find((t) => t.id === activeTabId);
        if (!tab) return prev;

        const forgetPane = () => {
          const paneSession = tab.sessions[targetPaneId];
          if (paneSession?.sessionId) {
            removeTab(paneSession.sessionId);
          }
          clearRefs.current.delete(targetPaneId);
          focusRefs.current.delete(targetPaneId);
          paneInitialCwds.current.delete(targetPaneId);
        };

        const paneCount = countPanes(tab.paneTree);
        if (paneCount <= 1) {
          // Last pane — close the entire tab
          const updated = prev.filter((t) => t.id !== activeTabId);
          if (updated.length > 0) {
            const idx = prev.findIndex((t) => t.id === activeTabId);
            const newIdx = Math.min(idx, updated.length - 1);
            setActiveTabId(updated[newIdx].id);
            const newLeafs = findLeafIds(updated[newIdx].paneTree);
            setActivePaneId(newLeafs[0] || null);
          } else {
            setActiveTabId(null);
            setActivePaneId(null);
          }

          forgetPane();
          return updated;
        }

        // Remove one pane from the tree
        const newTree = removePane(tab.paneTree, targetPaneId);
        if (!newTree) return prev;

        // Closing a pane the keyboard isn't in leaves focus where it is.
        if (targetPaneId === activePaneId) {
          const survivor = findLeafIds(newTree)[0] || null;
          setActivePaneId(survivor);
          if (survivor) {
            requestAnimationFrame(() => focusRefs.current.get(survivor)?.current?.());
          }
        }

        forgetPane();

        const newSessions = { ...tab.sessions };
        delete newSessions[targetPaneId];

        return prev.map((t) =>
          t.id === activeTabId ? { ...t, paneTree: newTree, sessions: newSessions } : t
        );
      });
    },
    [activeTabId, activePaneId, removeTab]
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const tab = prev.find((t) => t.id === tabId);
        if (tab) {
          Object.values(tab.sessions).forEach((s) => {
            if (s.sessionId) removeTab(s.sessionId);
          });
          findLeafIds(tab.paneTree).forEach((id) => {
            clearRefs.current.delete(id);
            paneInitialCwds.current.delete(id);
          });
        }

        const updated = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId && updated.length > 0) {
          const idx = prev.findIndex((t) => t.id === tabId);
          const newIdx = Math.min(idx, updated.length - 1);
          setActiveTabId(updated[newIdx].id);
          const newLeafs = findLeafIds(updated[newIdx].paneTree);
          setActivePaneId(newLeafs[0] || null);
        } else if (updated.length === 0) {
          setActiveTabId(null);
          setActivePaneId(null);
        }
        return updated;
      });
    },
    [activeTabId, removeTab]
  );

  const handleSwitchTab = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      const tab = tabs.find((t) => t.id === tabId);
      if (tab) {
        const leafIds = findLeafIds(tab.paneTree);
        if (leafIds.length > 0 && (!activePaneId || !leafIds.includes(activePaneId))) {
          setActivePaneId(leafIds[0]);
        }
        const firstSession = tab.sessions[leafIds[0]];
        if (firstSession?.sessionId) {
          setActiveTab(firstSession.sessionId);
        }
        setTimeout(() => {
          const targetPaneId = leafIds.includes(activePaneId || "") ? activePaneId : leafIds[0];
          const ref = focusRefs.current.get(targetPaneId || "");
          if (ref?.current) ref.current();
        }, 50);
      }
    },
    [tabs, activePaneId, setActiveTab]
  );

  const switchToNextTab = useCallback(() => {
    if (tabs.length <= 1) return;
    const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
    const nextIdx = (currentIdx + 1) % tabs.length;
    handleSwitchTab(tabs[nextIdx].id);
  }, [tabs, activeTabId, handleSwitchTab]);

  const switchToPreviousTab = useCallback(() => {
    if (tabs.length <= 1) return;
    const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
    const prevIdx = (currentIdx - 1 + tabs.length) % tabs.length;
    handleSwitchTab(tabs[prevIdx].id);
  }, [tabs, activeTabId, handleSwitchTab]);

  const handleReorderTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;
      setTabs((prev) => {
        const updated = [...prev];
        const [moved] = updated.splice(fromIndex, 1);
        updated.splice(toIndex, 0, moved);
        return updated;
      });
      reorderTabs(fromIndex, toIndex);
    },
    [reorderTabs]
  );

  const handleClearTerminal = useCallback(() => {
    if (!activePaneId) return;
    const ref = clearRefs.current.get(activePaneId);
    if (ref?.current) ref.current();
  }, [activePaneId]);

  useEffect(() => {
    if (editorOpen) setEditorMounted(true);
  }, [editorOpen]);

  useEffect(() => {
    if (claudeOpen) setClaudeMounted(true);
  }, [claudeOpen]);

  useEffect(() => {
    if (figyOpen) setFigyMounted(true);
  }, [figyOpen]);

  /*
    The agent's questions about code are answered here rather than inside
    the FigyCode window.

    They go to the language server this process is already running — see
    `services/figycode-lsp.ts` — and the agent can be mid-turn while its
    window is minimised. A listener that came and went with the window
    would drop the reply and leave the turn waiting out its timeout.
  */
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    void serveAgentLsp().then((off) => {
      if (alive) unlisten = off;
      else off();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (drawingOpen) setDrawingMounted(true);
  }, [drawingOpen]);

  useEffect(() => {
    if (apiOpen) setApiMounted(true);
  }, [apiOpen]);

  /**
   * Read by the ⌘W listener, which is registered once and must not be torn
   * down and rebuilt every time the editor is toggled.
   */
  const editorOpenRef = useRef(editorOpen);
  editorOpenRef.current = editorOpen;

  /**
   * Closing the editor hands the keyboard back to the shell.
   *
   * The editor takes focus when it opens, and its container is hidden rather
   * than unmounted when it closes — so the focused element goes out from under
   * the browser and the keyboard belongs to nothing at all until the terminal
   * is clicked. Every route out of the editor goes through here for that
   * reason: the chord, the menu item, the modal's own close button and the
   * error boundary.
   */
  /**
   * Puts a window away without stopping it.
   *
   * The same hide that closing performs — these windows are all latched
   * mounted — plus a place in the dock, which is the only difference between
   * the two and the whole point of having both. The keyboard goes back to the
   * shell either way: a window you cannot see must not be holding it.
   */
  /**
   * Each service's "is it open" setter, in one place.
   *
   * There were four copies of this correspondence — minimize, restore, the
   * dock-pruning effect and the palette — each a chain of `if` on a different
   * spelling of the same seven things, and adding the terminal to all four was
   * the point at which that stopped being reasonable.
   */
  const setServiceOpen = useCallback((which: ServiceId, open: boolean) => {
    switch (which) {
      case "figy-terminal":
        setTerminalOpen(open);
        break;
      case "figy-browser":
        setBrowserOpen(open);
        break;
      case "figy-code-editor":
        setEditorOpen(open);
        break;
      case "claude-code":
        setClaudeOpen(open);
        break;
      case "figy-harness":
        setFigyOpen(open);
        break;
      case "figy-man":
        setApiOpen(open);
        break;
      case "figy-drawing":
        setDrawingOpen(open);
        break;
    }
  }, []);

  const minimizeWindow = useCallback(
    (which: DockWindow) => {
      setMinimized((ids) => (ids.includes(which) ? ids : [...ids, which]));
      setServiceOpen(which, false);
      focusActivePane();
    },
    [focusActivePane, setServiceOpen]
  );

  /** Brings one back, and takes it out of the dock. */
  const restoreWindow = useCallback(
    (which: DockWindow) => {
      setMinimized((ids) => ids.filter((id) => id !== which));
      setServiceOpen(which, true);
    },
    [setServiceOpen]
  );

  /*
    Opening a window by any other route — the chord, the palette, the menu —
    also takes it out of the dock. Watching the open flags rather than patching
    six call sites: every one of them sets exactly these, and a route added
    later would otherwise leave a window on screen and in the dock at once.
  */
  useEffect(() => {
    const open: Record<ServiceId, boolean> = {
      "figy-terminal": terminalOpen,
      "figy-browser": browserOpen,
      "figy-code-editor": editorOpen,
      "claude-code": claudeOpen,
      "figy-harness": figyOpen,
      "figy-man": apiOpen,
      "figy-drawing": drawingOpen,
    };
    setMinimized((ids) => {
      // The base is not a window and cannot be in the dock — a service that
      // becomes the base while minimized has to leave it, or the footer offers
      // to restore the thing already filling the screen.
      const next = ids.filter((id) => !open[id] && id !== baseId);
      return next.length === ids.length ? ids : next;
    });
  }, [terminalOpen, browserOpen, editorOpen, claudeOpen, figyOpen, apiOpen, drawingOpen, baseId]);

  /** Read by the shortcut handler, which is registered once. */
  const terminalOpenRef = useRef(terminalOpen);
  terminalOpenRef.current = terminalOpen;

  /**
   * Closing the terminal window stops nothing.
   *
   * The panes stay mounted and their shells keep running — see `TerminalWindow`,
   * which hides rather than unmounts for exactly this reason. Refused when the
   * terminal is the base: there would be nothing left in the window.
   */
  const closeTerminal = useCallback(() => {
    if (baseId === "figy-terminal") return;
    setTerminalOpen(false);
    setMinimized((ids) => ids.filter((id) => id !== "figy-terminal"));
  }, [baseId]);

  const toggleTerminal = useCallback(() => {
    if (baseId === "figy-terminal") return;
    if (terminalOpenRef.current) closeTerminal();
    else setTerminalOpen(true);
  }, [baseId, closeTerminal]);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setMinimized((ids) => ids.filter((id) => id !== "figy-code-editor"));
    focusActivePane();
  }, [focusActivePane]);

  const toggleEditor = useCallback(() => {
    if (editorOpenRef.current) closeEditor();
    else setEditorOpen(true);
  }, [closeEditor]);

  /** Read by the ⌘W listener, which must not be rebuilt on every toggle. */
  const claudeOpenRef = useRef(claudeOpen);
  claudeOpenRef.current = claudeOpen;

  /**
   * Closing the window hands the keyboard back to the shell — and stops
   * nothing. Conversations are ptys owned by the backend; hiding their window
   * is not a reason to end them, any more than closing a tab strip would be.
   */
  const closeClaude = useCallback(() => {
    setClaudeOpen(false);
    setMinimized((ids) => ids.filter((id) => id !== "claude-code"));
    focusActivePane();
  }, [focusActivePane]);

  const toggleClaude = useCallback(() => {
    if (claudeOpenRef.current) closeClaude();
    else setClaudeOpen(true);
  }, [closeClaude]);

  /** Read by the shortcut handler, which is registered once. */
  const figyOpenRef = useRef(figyOpen);
  figyOpenRef.current = figyOpen;

  const closeFigy = useCallback(() => {
    setFigyOpen(false);
    setMinimized((ids) => ids.filter((id) => id !== "figy-harness"));
    focusActivePane();
  }, [focusActivePane]);

  const toggleFigy = useCallback(() => {
    if (figyOpenRef.current) closeFigy();
    else setFigyOpen(true);
  }, [closeFigy]);

  /** Read by the shortcut handler, which is registered once and must not be
   * torn down and rebuilt every time the window is toggled. */
  const drawingOpenRef = useRef(drawingOpen);
  drawingOpenRef.current = drawingOpen;

  /** Closing the drawing window hands the keyboard back to the shell. */
  const closeDrawing = useCallback(() => {
    setDrawingOpen(false);
    focusActivePane();
  }, [focusActivePane]);

  const toggleDrawing = useCallback(() => {
    if (drawingOpenRef.current) closeDrawing();
    else setDrawingOpen(true);
  }, [closeDrawing]);

  /** Read by the shortcut and menu handlers, which are registered once. */
  const apiOpenRef = useRef(apiOpen);
  apiOpenRef.current = apiOpen;

  /** Closing the API client hands the keyboard back to the shell. A request in
   * flight is left alone: it is a socket, not a window, and the answer is worth
   * having when the window comes back. */
  const closeApi = useCallback(() => {
    setApiOpen(false);
    setMinimized((ids) => ids.filter((id) => id !== "figy-man"));
    focusActivePane();
  }, [focusActivePane]);

  const toggleApi = useCallback(() => {
    if (apiOpenRef.current) closeApi();
    else setApiOpen(true);
  }, [closeApi]);

  /** The editor's undo/redo, while it is mounted and holding the keyboard. */
  /** The editor's handler for the chords the native menu owns; see `runMenuChord`. */
  const editorChordRef = useRef<
    ((command: "undo" | "redo" | "selectAll") => boolean) | null
  >(null);

  /**
   * ⌘Z / ⇧⌘Z, on macOS only — see `menu.rs`.
   *
   * The code editor keeps its own history, so it gets first refusal. Anything
   * else with focus is an ordinary text field, where the webview's own undo
   * stack is the correct one and `execCommand` is how to reach it now that the
   * menu no longer performs it directly.
   */
  /**
   * A chord the native macOS menu owns, offered to the editor first.
   *
   * The editor declines unless its text actually holds the keyboard, in which
   * case the webview's own handling is the right answer — the caret is in a
   * search field or the quick-open box, and `selectAll` there means that
   * field. See `menu.rs` for why these three cannot simply be bound in the
   * webview.
   */
  const runMenuChord = useCallback((command: "undo" | "redo" | "selectAll") => {
    if (editorChordRef.current?.(command)) return;
    document.execCommand(command === "selectAll" ? "selectAll" : command);
  }, []);

  /** A path clicked in terminal output; see the link provider in `Terminal.tsx`. */
  useEffect(() => {
    const pending = listenToSelf<{
      path: string;
      line?: number;
      column?: number;
      root?: string;
    }>("editor://open-path", (payload) => {
      setEditorOpen(true);
      setEditorRequest((prev) => ({
        path: payload.path,
        line: payload.line,
        column: payload.column,
        // Where the link came from, so the editor can adopt that folder when
        // the file is outside the one it has open.
        root: payload.root,
        // The token is what lets the same path be asked for twice.
        token: (prev?.token ?? 0) + 1,
      }));
    });
    return () => {
      pending.then((off) => off()).catch(() => {});
    };
  }, []);

  /**
   * "Ask Claude about this", from the editor's file tree.
   *
   * Handed down as a request rather than left as an event for the window to
   * hear, because the window may never have been mounted — the same reason the
   * editor takes a clicked path this way. Opening it here is what mounts it.
   */
  useEffect(() => {
    const pending = listenToSelf<{ path: string }>("claude://mention", (payload) => {
      setClaudeOpen(true);
      setClaudeMention((previous) => ({
        path: payload.path,
        // The token is what lets the same file be handed over twice.
        token: (previous?.token ?? 0) + 1,
      }));
    });
    return () => {
      pending.then((off) => off()).catch(() => {});
    };
  }, []);

  const handleOpenUpdates = useCallback(() => {
    hideToast();
    setUpdatesOpen(true);
    checkForUpdatesNow();
  }, [hideToast, checkForUpdatesNow]);

  /**
   * Quitting with conversations running asks first.
   *
   * A terminal does not normally ask — a shell sitting at a prompt loses
   * nothing — but an agent halfway through editing files is not that, and
   * Figylo deliberately runs no background sessions, so quitting really does
   * stop them. Nothing is *lost*: every conversation is resumable next launch,
   * because its id is ours and its transcript is the CLI's. What is lost is a
   * turn in flight, which is worth one dialog.
   *
   * `destroy` rather than `close` on the way out: `close` would raise this same
   * event again and the confirmation would ask forever.
   */
  const claudeLiveRef = useRef(claudeLive);
  claudeLiveRef.current = claudeLive;

  useEffect(() => {
    const pending = getCurrentWindow().onCloseRequested(async (event) => {
      const live = claudeLiveRef.current;
      if (live === 0) return;

      event.preventDefault();
      const ok = await confirm(
        `${live} Claude ${live === 1 ? "conversation is" : "conversations are"} running. ` +
          "Quitting stops them — you can resume each one next time, with its history.",
        { title: "Quit Figylo?", kind: "warning", okLabel: "Quit", cancelLabel: "Cancel" }
      );
      if (ok) await getCurrentWindow().destroy();
    });

    return () => {
      pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  /**
   * Whether the terminal is on screen at all — as the base, or as a window.
   *
   * The first shell waits for this. It used to be spawned on mount, which was
   * right while the terminal was the base by definition and wrong now: a first
   * run shows the welcome page with no base chosen, and starting somebody's
   * login shell behind a page they have not answered is work nobody asked for.
   * Pick the drawing board and no shell is ever started.
   */
  const terminalShown = baseId === "figy-terminal" || terminalOpen;

  useEffect(() => {
    if (!terminalShown) return;
    setTerminalMounted(true);
    if (initialCreated.current) return;
    initialCreated.current = true;
    handleNewTab();
  }, [terminalShown, handleNewTab]);

  useEffect(() => {
    const unlisteners = [
      listenToSelf("menu://new-window", () => handleNewWindow()),
      listenToSelf("menu://new-tab", () => handleNewTab()),
      listenToSelf("menu://new-tab-same-dir", () => handleNewTabInSameDir()),
      listenToSelf("menu://split-right", () => handleSplitPane("horizontal")),
      listenToSelf("menu://split-down", () => handleSplitPane("vertical")),
      listenToSelf("menu://close-pane", () => handleClosePane()),
      listenToSelf("menu://clear-terminal", () => handleClearTerminal()),
      listenToSelf("menu://browser", () => setBrowserOpen((open) => !open)),
      listenToSelf("menu://editor", () => toggleEditor()),
      listenToSelf("menu://claude", () => toggleClaude()),
      listenToSelf("menu://figy-code", () => toggleFigy()),
      listenToSelf("menu://drawing", () => toggleDrawing()),
      listenToSelf("menu://api", () => toggleApi()),
      listenToSelf("menu://monitor", () => setMonitorOpen((open) => !open)),
      listenToSelf("menu://command-palette", () => setCommandPaletteOpen((open) => !open)),
      listenToSelf("menu://settings", () => setSettingsOpen(true)),
      listenToSelf("menu://toggle-theme", () => toggleTheme()),
      listenToSelf("menu://check-updates", () => handleOpenUpdates()),
      /*
        ⌘W, on macOS only — see `menu.rs` for why it arrives as an event rather
        than as a key the editor could bind. With the editor up the chord
        belongs to its tab strip, the way it does in every editor; with the
        editor closed it means what the menu says.
      */
      /*
        Three claimants now, and the order is "whichever window is in front of
        you": the Claude window opens over the editor, so it answers first.
      */
      listenToSelf("menu://close-window", () => {
        if (claudeOpenRef.current) setClaudeCloseTab((count) => count + 1);
        else if (editorOpenRef.current) setEditorCloseTab((count) => count + 1);
        else void getCurrentWindow().close();
      }),
      listenToSelf("menu://undo", () => runMenuChord("undo")),
      listenToSelf("menu://redo", () => runMenuChord("redo")),
      listenToSelf("menu://select-all", () => runMenuChord("selectAll")),
    ];

    return () => {
      unlisteners.forEach((promise) => {
        promise.then((unlisten) => unlisten()).catch(() => {});
      });
    };
  }, [
    handleNewWindow,
    handleNewTab,
    handleNewTabInSameDir,
    handleSplitPane,
    handleClosePane,
    handleClearTerminal,
    handleOpenUpdates,
    toggleTheme,
    toggleEditor,
    toggleClaude,
    toggleFigy,
    toggleDrawing,
    toggleApi,
    runMenuChord,
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matches(e, SHORTCUTS.newWindow)) {
        e.preventDefault();
        handleNewWindow();
      } else if (matches(e, SHORTCUTS.newTabSameDir)) {
        e.preventDefault();
        handleNewTabInSameDir();
      } else if (matches(e, SHORTCUTS.newTab)) {
        e.preventDefault();
        handleNewTab();
      } else if (matches(e, SHORTCUTS.closePane)) {
        e.preventDefault();
        handleClosePane();
      } else if (matches(e, SHORTCUTS.clearTerminal)) {
        e.preventDefault();
        handleClearTerminal();
      } else if (matches(e, SHORTCUTS.commandPalette)) {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
      } else if (matches(e, SHORTCUTS.cycleTabBack)) {
        e.preventDefault();
        switchToPreviousTab();
      } else if (matches(e, SHORTCUTS.cycleTab)) {
        e.preventDefault();
        switchToNextTab();
      } else if (matches(e, SHORTCUTS.toggleTheme)) {
        e.preventDefault();
        toggleTheme();
      } else if (matches(e, SHORTCUTS.settings)) {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (matches(e, SHORTCUTS.monitor)) {
        e.preventDefault();
        setMonitorOpen((prev) => !prev);
      } else if (EMBEDDED_BROWSER_SUPPORTED && matches(e, SHORTCUTS.browser)) {
        e.preventDefault();
        setBrowserOpen((prev) => !prev);
      } else if (matches(e, SHORTCUTS.editor)) {
        e.preventDefault();
        toggleEditor();
      } else if (matches(e, SHORTCUTS.claude)) {
        e.preventDefault();
        toggleClaude();
      } else if (matches(e, SHORTCUTS.figyCode)) {
        e.preventDefault();
        toggleFigy();
      } else if (matches(e, SHORTCUTS.drawing)) {
        e.preventDefault();
        toggleDrawing();
      } else if (matches(e, SHORTCUTS.api)) {
        e.preventDefault();
        toggleApi();
      } else if (matches(e, SHORTCUTS.splitDown)) {
        e.preventDefault();
        handleSplitPane("vertical");
      } else if (matches(e, SHORTCUTS.splitRight)) {
        e.preventDefault();
        handleSplitPane("horizontal");
      } else if (matches(e, SHORTCUTS.prevTab)) {
        e.preventDefault();
        switchToPreviousTab();
      } else if (matches(e, SHORTCUTS.nextTab)) {
        e.preventDefault();
        switchToNextTab();
      } else if (isTabNumber(e)) {
        e.preventDefault();
        const tabNum = parseInt(e.key, 10) - 1;
        if (tabNum < tabs.length) {
          handleSwitchTab(tabs[tabNum].id);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewTab, handleNewTabInSameDir, handleClosePane, handleClearTerminal, switchToNextTab, switchToPreviousTab, handleSplitPane, handleSwitchTab, tabs, toggleTheme, toggleEditor, toggleClaude, toggleFigy, toggleDrawing, toggleApi]);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const tabsForUI = tabs.map((tab) => {
    const leafIds = findLeafIds(tab.paneTree);
    const firstSession = tab.sessions[leafIds[0]];
    const title = customTabNames[tab.id] || firstSession?.session?.title || "Terminal";
    const paneCount = countPanes(tab.paneTree);
    return {
      id: tab.id,
      title,
      isActive: tab.id === activeTabId,
      paneCount,
    };
  });

  const activePaneSession = activeTab?.sessions[activePaneId || ""];

  /**
   * Every action the app has, in one list.
   *
   * The palette is the answer to "what can this thing do" — and to "the
   * shortcut for that is different on my other machine" — so anything reachable
   * by a chord is reachable here, spelled for whichever platform is running.
   * The four that operate on a single pane go out as events, because the pane
   * that should handle them is the focused one; see `askActivePane`.
   */
  const commands = [
    { id: "new-window", label: "New Window…", shortcut: keys(SHORTCUTS.newWindow), action: handleNewWindow },
    { id: "new-terminal", label: "New Terminal", shortcut: keys(SHORTCUTS.newTab), action: handleNewTab },
    { id: "new-terminal-same-dir", label: "New Terminal in Same Directory", shortcut: keys(SHORTCUTS.newTabSameDir), action: handleNewTabInSameDir },
    { id: "split-right", label: "Split Right", shortcut: keys(SHORTCUTS.splitRight), action: () => handleSplitPane("horizontal") },
    { id: "split-down", label: "Split Down", shortcut: keys(SHORTCUTS.splitDown), action: () => handleSplitPane("vertical") },
    { id: "close-pane", label: "Close Pane", shortcut: keys(SHORTCUTS.closePane), action: handleClosePane },
    { id: "next-tab", label: "Next Tab", shortcut: keys(SHORTCUTS.cycleTab), action: switchToNextTab },
    { id: "prev-tab", label: "Previous Tab", shortcut: keys(SHORTCUTS.cycleTabBack), action: switchToPreviousTab },
    { id: "clear-terminal", label: "Clear Terminal", shortcut: keys(SHORTCUTS.clearTerminal), action: handleClearTerminal },
    { id: "find", label: "Find in Terminal", shortcut: keys(SHORTCUTS.find), action: () => askActivePane("find") },
    { id: "history", label: "Search Command History", shortcut: keys(SHORTCUTS.history), action: () => askActivePane("history") },
    { id: "copy", label: "Copy Selection", shortcut: keys(SHORTCUTS.copy), action: () => askActivePane("copy") },
    { id: "paste", label: "Paste", shortcut: keys(SHORTCUTS.paste), action: () => askActivePane("paste") },
    { id: "toggle-theme", label: "Toggle Light/Dark Theme", shortcut: keys(SHORTCUTS.toggleTheme), action: toggleTheme },
    /*
      One entry per service, named as the catalogue names it — the palette
      used to call Figy Man "API Client" and the dock called it "API", which
      left the app with three names for one program.

      The base is left out: it is already the whole window, so "Open" is not
      something it can do.
    */
    ...(baseId !== "figy-terminal"
      ? [{ id: "terminal", label: "Open Figy Terminal", action: toggleTerminal }]
      : []),
    // Absent only where the embedded browser can't be positioned at all.
    ...(EMBEDDED_BROWSER_SUPPORTED && baseId !== "figy-browser"
      ? [{ id: "browser", label: "Open Figy Browser", shortcut: keys(SHORTCUTS.browser), action: () => setBrowserOpen(true) }]
      : []),
    ...(baseId !== "figy-code-editor"
      ? [{ id: "editor", label: "Open Figy Code Editor", shortcut: keys(SHORTCUTS.editor), action: () => setEditorOpen(true) }]
      : []),
    ...(baseId !== "claude-code"
      ? [{ id: "claude", label: "Open Claude Code", shortcut: keys(SHORTCUTS.claude), action: () => setClaudeOpen(true) }]
      : []),
    ...(baseId !== "figy-harness"
      ? [{ id: "figy-code", label: "Open Figy Harness", shortcut: keys(SHORTCUTS.figyCode), action: () => setFigyOpen(true) }]
      : []),
    ...(baseId !== "figy-drawing"
      ? [{ id: "drawing", label: "Open Figy Drawing", shortcut: keys(SHORTCUTS.drawing), action: () => setDrawingOpen(true) }]
      : []),
    ...(baseId !== "figy-man"
      ? [{ id: "api", label: "Open Figy Man", shortcut: keys(SHORTCUTS.api), action: () => setApiOpen(true) }]
      : []),
    {
      id: "drawing-new",
      label: "New Drawing",
      action: () => {
        setDrawingOpen(true);
        // `create()` hydrates first, so this is safe in a window that has never
        // been opened and whose project list has never been read.
        void useDrawingStore.getState().create();
      },
    },
    { id: "monitor", label: "System Monitor", shortcut: keys(SHORTCUTS.monitor), action: () => setMonitorOpen(true) },
    { id: "settings", label: "Settings", shortcut: keys(SHORTCUTS.settings), action: () => setSettingsOpen(true) },
    { id: "check-updates", label: "Check for Updates", action: handleOpenUpdates },
  ];

  /** Which services currently have a window up, for the header's menu. */
  const openIds = new Set<ServiceId>(
    (
      [
        ["figy-terminal", terminalOpen],
        ["figy-browser", browserOpen],
        ["figy-code-editor", editorOpen],
        ["claude-code", claudeOpen],
        ["figy-harness", figyOpen],
        ["figy-man", apiOpen],
        ["figy-drawing", drawingOpen],
      ] as const
    )
      .filter(([, open]) => open)
      .map(([id]) => id)
  );

  /** The header's menu, and anything else that opens a service by name. */
  const openService = useCallback(
    (id: ServiceId) => {
      // The base is already the whole window. Asking for it is a no-op rather
      // than an error — the menu lists it because leaving it out would be a
      // list of six that claims to be the services.
      if (id === baseId) return;
      setServiceOpen(id, true);
    },
    [baseId, setServiceOpen]
  );

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-ft-bg">
      <AppHeader
        baseId={baseId}
        openIds={openIds}
        onOpenService={openService}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {/*
        The space the base occupies, and nothing else.

        The base is an overlay like every other window — placed by
        `baseSlotRect`, which is this gap measured from the two bars around it
        — so there is nothing to render into it here. What this div does is
        hold the gap open at the right height, which is the one thing a
        `position: fixed` rectangle cannot do for itself.
      */}
      <div className="flex-1 min-h-0" />
      <div onMouseUp={focusActivePane}>
        <StatusBar
          cwd={activePaneId ? (liveCwds[activePaneId] || activePaneSession?.session?.cwd || "") : ""}
          shell={activePaneSession?.session?.shell ?? ""}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenMonitor={() => setMonitorOpen(true)}
          updateAvailable={updateAvailable}
          onOpenUpdates={handleOpenUpdates}
          // Only while the window is closed; an open one marks the tab itself.
          claudeAttention={claudeOpen ? 0 : claudeAttention}
          onOpenClaude={() => setClaudeOpen(true)}
          dock={
            <MinimizedDock
              windows={minimized}
              onRestore={restoreWindow}
              // A minimized Claude window is the one place a waiting
              // conversation can be said out loud, so the count rides on its
              // dock item rather than being announced twice.
              badges={{ "claude-code": claudeAttention }}
            />
          }
        />
      </div>
      {/*
        The terminal, in the frame it never used to have.

        Mounted from the moment it is first shown and kept thereafter: the
        panes are ptys, and the one thing this window must not do is end
        somebody's shell because it was dismissed.
      */}
      {terminalMounted && (
        <TerminalWindow
          visible={windowVisible("figy-terminal", terminalOpen)}
          docked={baseId === "figy-terminal"}
          onClose={closeTerminal}
          onMinimize={() => minimizeWindow("figy-terminal")}
          chrome={({ controls, onDragHandle }) => (
            <div onMouseUp={focusActivePane}>
              <TabBar
                tabs={tabsForUI}
                onTabClick={handleSwitchTab}
                onTabClose={handleCloseTab}
                onNewTab={handleNewTab}
                onRenameTab={(id, name) =>
                  setCustomTabNames((prev) => ({ ...prev, [id]: name }))
                }
                onReorderTabs={handleReorderTabs}
                onPrevTab={switchToPreviousTab}
                onNextTab={switchToNextTab}
                controls={controls}
                onDragHandle={onDragHandle}
              />
            </div>
          )}
        >
          <div className="absolute inset-0" onClick={focusActivePane}>
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`absolute inset-0 ${
                  tab.id === activeTabId ? "z-10" : "z-0 invisible"
                }`}
              >
                <PaneContainer
                  paneTree={tab.paneTree}
                  activePaneId={tab.id === activeTabId ? activePaneId : null}
                  onPaneFocus={setActivePaneId}
                  onPaneClose={handleClosePane}
                  onSessionCreated={handleSessionCreated}
                  onCwdChange={(paneId, cwd) =>
                    setLiveCwds((prev) => ({ ...prev, [paneId]: cwd }))
                  }
                  getPaneInitialCwd={getPaneInitialCwd}
                  clearRefs={clearRefs}
                  focusRefs={focusRefs}
                />
              </div>
            ))}
          </div>
        </TerminalWindow>
      )}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commands}
      />
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        activeSessionId={activePaneSession?.sessionId ?? null}
      />
      <OverlayBoundary label="system monitor" onDismiss={() => setMonitorOpen(false)}>
        <SystemMonitor
          visible={monitorOpen}
          onClose={() => setMonitorOpen(false)}
        />
      </OverlayBoundary>
      {EMBEDDED_BROWSER_SUPPORTED && (
        <OverlayBoundary label="browser" onDismiss={() => setBrowserOpen(false)}>
          <BrowserModal
            visible={windowVisible("figy-browser", browserOpen)}
            docked={baseId === "figy-browser"}
            onClose={() => setBrowserOpen(false)}
            onMinimize={() => minimizeWindow("figy-browser")}
          />
        </OverlayBoundary>
      )}
      {/*
        Once mounted it stays mounted whether or not it's open — it hides
        itself. Unmounting it would throw away every open buffer's undo history
        and selection, which is the one thing an editor must not lose when you
        dismiss it to look at the shell for a moment.
      */}
      {(editorMounted || baseId === "figy-code-editor") && (
        <OverlayBoundary label="code editor" onDismiss={closeEditor}>
          <Suspense fallback={null}>
            <EditorModal
              visible={windowVisible("figy-code-editor", editorOpen)}
              docked={baseId === "figy-code-editor"}
              onClose={closeEditor}
              onMinimize={() => minimizeWindow("figy-code-editor")}
              cwd={getActiveCwd()}
              onOpenTerminal={createTab}
              openRequest={editorRequest}
              closeTabRequest={editorCloseTab}
              chordRef={editorChordRef}
            />
          </Suspense>
        </OverlayBoundary>
      )}
      {/*
        Mounted once and then kept, whether or not it is open — every
        conversation inside it is a live process, and unmounting would end them
        all because the window happened to be dismissed.
      */}
      {(claudeMounted || baseId === "claude-code") && (
        <OverlayBoundary label="Claude Code" onDismiss={closeClaude}>
          <Suspense fallback={null}>
            <ClaudeModal
              visible={windowVisible("claude-code", claudeOpen)}
              docked={baseId === "claude-code"}
              onClose={closeClaude}
              onMinimize={() => minimizeWindow("claude-code")}
              cwd={getActiveCwd()}
              closeTabRequest={claudeCloseTab}
              onLiveCountChange={setClaudeLive}
              onAttentionCountChange={setClaudeAttention}
              mentionRequest={claudeMention}
            />
          </Suspense>
        </OverlayBoundary>
      )}
      {/*
        Mounted once and then kept, so a scripted run you dismissed halfway
        is still there when the window comes back.
      */}
      {(figyMounted || baseId === "figy-harness") && (
        <OverlayBoundary label="FigyCode" onDismiss={closeFigy}>
          <Suspense fallback={null}>
            <FigyCodeModal
              visible={windowVisible("figy-harness", figyOpen)}
              docked={baseId === "figy-harness"}
              onClose={closeFigy}
              onMinimize={() => minimizeWindow("figy-harness")}
              cwd={getActiveCwd()}
            />
          </Suspense>
        </OverlayBoundary>
      )}
      {(drawingMounted || baseId === "figy-drawing") && (
        <OverlayBoundary label="drawing" onDismiss={closeDrawing}>
          <Suspense fallback={null}>
            <DrawingModal
              visible={windowVisible("figy-drawing", drawingOpen)}
              docked={baseId === "figy-drawing"}
              onClose={closeDrawing}
            />
          </Suspense>
        </OverlayBoundary>
      )}
      {(apiMounted || baseId === "figy-man") && (
        <OverlayBoundary label="API client" onDismiss={closeApi}>
          <Suspense fallback={null}>
            <ApiModal
              visible={windowVisible("figy-man", apiOpen)}
              docked={baseId === "figy-man"}
              onClose={closeApi}
              onMinimize={() => minimizeWindow("figy-man")}
            />
          </Suspense>
        </OverlayBoundary>
      )}
      <UpdateModal
        isOpen={updatesOpen}
        onClose={() => setUpdatesOpen(false)}
        info={updateInfo}
        loading={updateLoading}
        error={updateError}
        onCheck={checkForUpdatesNow}
        activeSessionId={activePaneSession?.sessionId ?? null}
      />
      <UpdateToast
        visible={toastVisible && !updatesOpen}
        version={updateInfo?.latestVersion ?? ""}
        onView={handleOpenUpdates}
        onDismiss={dismissToast}
      />
      <NewWindowPrompt
        open={newWindowPrompt}
        onCancel={() => setNewWindowPrompt(false)}
        onSubmit={confirmNewWindow}
      />
      {/*
        Last, and over everything. Until it is answered there is no base, so
        the window behind it is the header, an empty slot and the status bar —
        which is exactly what it should be, because nothing has been chosen to
        put there yet.
      */}
      {!welcomed && <WelcomeScreen initial={baseId} onChoose={chooseBase} />}
    </div>
  );
}
