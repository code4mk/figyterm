import { useState, useCallback, useEffect, useRef } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { TabBar } from "../Terminal/TabBar";
import { StatusBar } from "../Terminal/StatusBar";
import { SystemMonitor } from "../Terminal/SystemMonitor";
import { BrowserModal } from "../Browser/BrowserModal";
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
import { isMac, EMBEDDED_BROWSER_SUPPORTED } from "../../services/platform";

const MAX_PANES_PER_TAB = 4;

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

  const handleOpenUpdates = useCallback(() => {
    hideToast();
    setUpdatesOpen(true);
    checkForUpdatesNow();
  }, [hideToast, checkForUpdatesNow]);

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
      listen("menu://monitor", () => setMonitorOpen((open) => !open)),
      listen("menu://command-palette", () => setCommandPaletteOpen((open) => !open)),
      listen("menu://settings", () => setSettingsOpen(true)),
      listen("menu://toggle-theme", () => toggleTheme()),
      listen("menu://check-updates", () => handleOpenUpdates()),
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
  }, [handleNewTab, handleNewTabInSameDir, handleClosePane, handleClearTerminal, switchToNextTab, switchToPreviousTab, handleSplitPane, handleSwitchTab, tabs, toggleTheme]);

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
      <SystemMonitor
        visible={monitorOpen}
        onClose={() => setMonitorOpen(false)}
      />
      {EMBEDDED_BROWSER_SUPPORTED && (
        <BrowserModal
          visible={browserOpen}
          onClose={() => setBrowserOpen(false)}
        />
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
