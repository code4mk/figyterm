import { useState, useCallback, useEffect, useRef, lazy, Suspense } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { TabBar } from "../Terminal/TabBar";
import { StatusBar } from "../Terminal/StatusBar";
import { SystemMonitor } from "../Terminal/SystemMonitor";
import { BrowserModal } from "../Browser/BrowserModal";
import { OverlayBoundary } from "../Overlay/OverlayBoundary";
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
  const [browserOpen, setBrowserOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  /** Latches on the first open; the window then stays mounted. See above. */
  const [claudeMounted, setClaudeMounted] = useState(false);
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
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [tabs, setTabs] = useState<TabInstance[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [liveCwds, setLiveCwds] = useState<Record<string, string>>({});
  const [customTabNames, setCustomTabNames] = useState<Record<string, string>>({});
  const initialCreated = useRef(false);

  const { addTab, removeTab, setActiveTab, reorderTabs } = useTerminalStore();
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  /**
   * Asks the focused pane to do something only it can do.
   *
   * The palette lives up here and the terminals are several levels down, each
   * owning its own xterm instance; rather than thread a ref per action through
   * `PaneContainer`, these go out as the same events the native menu sends and
   * the active pane picks them up (see `Terminal.tsx`).
   */
  const askActivePane = useCallback((action: "copy" | "paste" | "find" | "history") => {
    void emit(`menu://${action}`);
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
  const closeEditor = useCallback(() => {
    setEditorOpen(false);
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
    focusActivePane();
  }, [focusActivePane]);

  const toggleClaude = useCallback(() => {
    if (claudeOpenRef.current) closeClaude();
    else setClaudeOpen(true);
  }, [closeClaude]);

  /** The editor's undo/redo, while it is mounted and holding the keyboard. */
  const editorHistoryRef = useRef<((command: "undo" | "redo") => boolean) | null>(null);

  /**
   * ⌘Z / ⇧⌘Z, on macOS only — see `menu.rs`.
   *
   * The code editor keeps its own history, so it gets first refusal. Anything
   * else with focus is an ordinary text field, where the webview's own undo
   * stack is the correct one and `execCommand` is how to reach it now that the
   * menu no longer performs it directly.
   */
  const runHistoryCommand = useCallback((command: "undo" | "redo") => {
    if (editorHistoryRef.current?.(command)) return;
    document.execCommand(command);
  }, []);

  /** A path clicked in terminal output; see the link provider in `Terminal.tsx`. */
  useEffect(() => {
    const pending = listen<{
      path: string;
      line?: number;
      column?: number;
      root?: string;
    }>("editor://open-path", (event) => {
      setEditorOpen(true);
      setEditorRequest((prev) => ({
        path: event.payload.path,
        line: event.payload.line,
        column: event.payload.column,
        // Where the link came from, so the editor can adopt that folder when
        // the file is outside the one it has open.
        root: event.payload.root,
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
    const pending = listen<{ path: string }>("claude://mention", (event) => {
      setClaudeOpen(true);
      setClaudeMention((previous) => ({
        path: event.payload.path,
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
   * FigyTerm deliberately runs no background sessions, so quitting really does
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
        { title: "Quit FigyTerm?", kind: "warning", okLabel: "Quit", cancelLabel: "Cancel" }
      );
      if (ok) await getCurrentWindow().destroy();
    });

    return () => {
      pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!initialCreated.current) {
      initialCreated.current = true;
      handleNewTab();
    }
  }, [handleNewTab]);

  useEffect(() => {
    const unlisteners = [
      listen("menu://new-tab", () => handleNewTab()),
      listen("menu://new-tab-same-dir", () => handleNewTabInSameDir()),
      listen("menu://split-right", () => handleSplitPane("horizontal")),
      listen("menu://split-down", () => handleSplitPane("vertical")),
      listen("menu://close-pane", () => handleClosePane()),
      listen("menu://clear-terminal", () => handleClearTerminal()),
      listen("menu://browser", () => setBrowserOpen((open) => !open)),
      listen("menu://editor", () => toggleEditor()),
      listen("menu://claude", () => toggleClaude()),
      listen("menu://monitor", () => setMonitorOpen((open) => !open)),
      listen("menu://command-palette", () => setCommandPaletteOpen((open) => !open)),
      listen("menu://settings", () => setSettingsOpen(true)),
      listen("menu://toggle-theme", () => toggleTheme()),
      listen("menu://check-updates", () => handleOpenUpdates()),
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
      listen("menu://close-window", () => {
        if (claudeOpenRef.current) setClaudeCloseTab((count) => count + 1);
        else if (editorOpenRef.current) setEditorCloseTab((count) => count + 1);
        else void getCurrentWindow().close();
      }),
      listen("menu://undo", () => runHistoryCommand("undo")),
      listen("menu://redo", () => runHistoryCommand("redo")),
    ];

    return () => {
      unlisteners.forEach((promise) => {
        promise.then((unlisten) => unlisten()).catch(() => {});
      });
    };
  }, [
    handleNewTab,
    handleNewTabInSameDir,
    handleSplitPane,
    handleClosePane,
    handleClearTerminal,
    handleOpenUpdates,
    toggleTheme,
    toggleEditor,
    toggleClaude,
    runHistoryCommand,
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matches(e, SHORTCUTS.newTabSameDir)) {
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
  }, [handleNewTab, handleNewTabInSameDir, handleClosePane, handleClearTerminal, switchToNextTab, switchToPreviousTab, handleSplitPane, handleSwitchTab, tabs, toggleTheme, toggleEditor, toggleClaude]);

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
    // Absent only where the embedded browser can't be positioned at all.
    ...(EMBEDDED_BROWSER_SUPPORTED
      ? [{ id: "browser", label: "Open Browser", shortcut: keys(SHORTCUTS.browser), action: () => setBrowserOpen(true) }]
      : []),
    { id: "editor", label: "Open Code Editor", shortcut: keys(SHORTCUTS.editor), action: () => setEditorOpen(true) },
    { id: "claude", label: "Open Claude Code", shortcut: keys(SHORTCUTS.claude), action: () => setClaudeOpen(true) },
    { id: "monitor", label: "System Monitor", shortcut: keys(SHORTCUTS.monitor), action: () => setMonitorOpen(true) },
    { id: "settings", label: "Settings", shortcut: keys(SHORTCUTS.settings), action: () => setSettingsOpen(true) },
    { id: "check-updates", label: "Check for Updates", action: handleOpenUpdates },
  ];

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-ft-bg">
      <div onMouseUp={focusActivePane}>
        <TabBar
          tabs={tabsForUI}
          onTabClick={handleSwitchTab}
          onTabClose={handleCloseTab}
          onNewTab={handleNewTab}
          onRenameTab={(id, name) => setCustomTabNames((prev) => ({ ...prev, [id]: name }))}
          onReorderTabs={handleReorderTabs}
          onPrevTab={switchToPreviousTab}
          onNextTab={switchToNextTab}
        />
      </div>
      <div className="flex-1 relative overflow-hidden" onClick={focusActivePane}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${tab.id === activeTabId ? "z-10" : "z-0 invisible"}`}
          >
            <PaneContainer
              paneTree={tab.paneTree}
              activePaneId={tab.id === activeTabId ? activePaneId : null}
              onPaneFocus={setActivePaneId}
              onPaneClose={handleClosePane}
              onSessionCreated={handleSessionCreated}
              onCwdChange={(paneId, cwd) => setLiveCwds((prev) => ({ ...prev, [paneId]: cwd }))}
              getPaneInitialCwd={getPaneInitialCwd}
              clearRefs={clearRefs}
              focusRefs={focusRefs}
            />
          </div>
        ))}
      </div>
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
        />
      </div>
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
            visible={browserOpen}
            onClose={() => setBrowserOpen(false)}
          />
        </OverlayBoundary>
      )}
      {/*
        Once mounted it stays mounted whether or not it's open — it hides
        itself. Unmounting it would throw away every open buffer's undo history
        and selection, which is the one thing an editor must not lose when you
        dismiss it to look at the shell for a moment.
      */}
      {editorMounted && (
        <OverlayBoundary label="code editor" onDismiss={closeEditor}>
          <Suspense fallback={null}>
            <EditorModal
              visible={editorOpen}
              onClose={closeEditor}
              cwd={getActiveCwd()}
              onOpenTerminal={createTab}
              openRequest={editorRequest}
              closeTabRequest={editorCloseTab}
              historyRef={editorHistoryRef}
            />
          </Suspense>
        </OverlayBoundary>
      )}
      {/*
        Mounted once and then kept, whether or not it is open — every
        conversation inside it is a live process, and unmounting would end them
        all because the window happened to be dismissed.
      */}
      {claudeMounted && (
        <OverlayBoundary label="Claude Code" onDismiss={closeClaude}>
          <Suspense fallback={null}>
            <ClaudeModal
              visible={claudeOpen}
              onClose={closeClaude}
              cwd={getActiveCwd()}
              closeTabRequest={claudeCloseTab}
              onLiveCountChange={setClaudeLive}
              onAttentionCountChange={setClaudeAttention}
              mentionRequest={claudeMention}
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
    </div>
  );
}
