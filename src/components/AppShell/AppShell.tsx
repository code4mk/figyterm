import { useState, useCallback, useEffect, useRef } from "react";
import { TabBar } from "../Terminal/TabBar";
import { StatusBar } from "../Terminal/StatusBar";
import { SystemMonitor } from "../Terminal/SystemMonitor";
import { BrowserModal } from "../Browser/BrowserModal";
import { CommandPalette } from "../CommandPalette/CommandPalette";
import { Settings } from "../Settings/Settings";
import {
  PaneContainer,
  PaneNode,
  countPanes,
  findLeafIds,
  splitPane,
  removePane,
} from "../Terminal/PaneContainer";
import { useTerminalStore } from "../../stores/terminalStore";
import { TerminalSession } from "../../types/terminal";

const MAX_PANES_PER_TAB = 4;

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
  const [tabs, setTabs] = useState<TabInstance[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [liveCwds, setLiveCwds] = useState<Record<string, string>>({});
  const [customTabNames, setCustomTabNames] = useState<Record<string, string>>({});
  const initialCreated = useRef(false);

  const { addTab, removeTab, setActiveTab, reorderTabs } = useTerminalStore();
  const clearRefs = useRef<Map<string, React.MutableRefObject<(() => void) | null>>>(new Map());
  const focusRefs = useRef<Map<string, React.MutableRefObject<(() => void) | null>>>(new Map());

  const focusActivePane = useCallback(() => {
    if (!activePaneId) return;
    const ref = focusRefs.current.get(activePaneId);
    if (ref?.current) ref.current();
  }, [activePaneId]);

  const handleNewTab = useCallback(() => {
    const tabId = crypto.randomUUID();
    const paneId = crypto.randomUUID();
    const paneTree: PaneNode = { type: "leaf", id: paneId };
    setTabs((prev) => [...prev, { id: tabId, paneTree, sessions: {} }]);
    setActiveTabId(tabId);
    setActivePaneId(paneId);
  }, []);

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

  const handleClosePane = useCallback(() => {
    if (!activeTabId || !activePaneId) return;

    setTabs((prev) => {
      const tab = prev.find((t) => t.id === activeTabId);
      if (!tab) return prev;

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

        // Clean up session
        const paneSession = tab.sessions[activePaneId];
        if (paneSession?.sessionId) {
          removeTab(paneSession.sessionId);
        }
        clearRefs.current.delete(activePaneId);
        return updated;
      }

      // Remove one pane from the tree
      const newTree = removePane(tab.paneTree, activePaneId);
      if (!newTree) return prev;

      const remainingLeafs = findLeafIds(newTree);
      setActivePaneId(remainingLeafs[0] || null);

      const paneSession = tab.sessions[activePaneId];
      if (paneSession?.sessionId) {
        removeTab(paneSession.sessionId);
      }
      clearRefs.current.delete(activePaneId);

      const newSessions = { ...tab.sessions };
      delete newSessions[activePaneId];

      return prev.map((t) =>
        t.id === activeTabId ? { ...t, paneTree: newTree, sessions: newSessions } : t
      );
    });
  }, [activeTabId, activePaneId, removeTab]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const tab = prev.find((t) => t.id === tabId);
        if (tab) {
          Object.values(tab.sessions).forEach((s) => {
            if (s.sessionId) removeTab(s.sessionId);
          });
          findLeafIds(tab.paneTree).forEach((id) => clearRefs.current.delete(id));
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
    if (!initialCreated.current) {
      initialCreated.current = true;
      handleNewTab();
    }
  }, [handleNewTab]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        handleNewTab();
      } else if (isMod && e.key === "w") {
        e.preventDefault();
        handleClosePane();
      } else if (isMod && e.key === "k") {
        e.preventDefault();
        handleClearTerminal();
      } else if (isMod && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
      } else if (isMod && e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          switchToPreviousTab();
        } else {
          switchToNextTab();
        }
      } else if (isMod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (isMod && e.shiftKey && (e.key === "M" || e.key === "m")) {
        e.preventDefault();
        setMonitorOpen((prev) => !prev);
      } else if (isMod && e.shiftKey && (e.key === "B" || e.key === "b")) {
        e.preventDefault();
        setBrowserOpen((prev) => !prev);
      } else if (isMod && e.key === "d" && !e.shiftKey) {
        e.preventDefault();
        handleSplitPane("horizontal");
      } else if (isMod && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        handleSplitPane("vertical");
      } else if (isMod && e.shiftKey && e.key === "[") {
        e.preventDefault();
        switchToPreviousTab();
      } else if (isMod && e.shiftKey && e.key === "]") {
        e.preventDefault();
        switchToNextTab();
      } else if (isMod && !e.shiftKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const tabNum = parseInt(e.key, 10) - 1;
        if (tabNum < tabs.length) {
          handleSwitchTab(tabs[tabNum].id);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewTab, handleClosePane, handleClearTerminal, switchToNextTab, switchToPreviousTab, handleSplitPane, handleSwitchTab, tabs]);

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

  const commands = [
    { id: "new-terminal", label: "New Terminal", shortcut: "⌘T", action: handleNewTab },
    { id: "split-right", label: "Split Right", shortcut: "⌘D", action: () => handleSplitPane("horizontal") },
    { id: "split-down", label: "Split Down", shortcut: "⌘⇧D", action: () => handleSplitPane("vertical") },
    { id: "close-pane", label: "Close Pane", shortcut: "⌘W", action: handleClosePane },
    { id: "clear-terminal", label: "Clear Terminal", shortcut: "⌘K", action: handleClearTerminal },
    { id: "next-tab", label: "Next Tab", shortcut: "⌘Tab", action: switchToNextTab },
    { id: "prev-tab", label: "Previous Tab", shortcut: "⌘⇧Tab", action: switchToPreviousTab },
    { id: "browser", label: "Open Browser", shortcut: "⌘⇧B", action: () => setBrowserOpen(true) },
    { id: "monitor", label: "System Monitor", shortcut: "⌘⇧M", action: () => setMonitorOpen(true) },
    { id: "settings", label: "Settings", shortcut: "⌘,", action: () => setSettingsOpen(true) },
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
              onSessionCreated={handleSessionCreated}
              onCwdChange={(paneId, cwd) => setLiveCwds((prev) => ({ ...prev, [paneId]: cwd }))}
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
      <BrowserModal
        visible={browserOpen}
        onClose={() => setBrowserOpen(false)}
      />
    </div>
  );
}
