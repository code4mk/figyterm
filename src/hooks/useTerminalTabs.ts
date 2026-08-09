import { useCallback } from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { TerminalSession } from "../types/terminal";
import { closeTerminalSession } from "../services/terminal";

export function useTerminalTabs() {
  const { tabs, activeTabId, addTab, removeTab, setActiveTab, renameTab } =
    useTerminalStore();

  const createTab = useCallback(
    (session: TerminalSession) => {
      addTab(session);
    },
    [addTab]
  );

  const closeTab = useCallback(
    async (id: string) => {
      try {
        await closeTerminalSession(id);
      } catch {
        // Session may already be closed
      }
      removeTab(id);
    },
    [removeTab]
  );

  const switchTab = useCallback(
    (id: string) => {
      setActiveTab(id);
    },
    [setActiveTab]
  );

  const switchToNextTab = useCallback(() => {
    if (tabs.length <= 1) return;
    const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
    const nextIdx = (currentIdx + 1) % tabs.length;
    setActiveTab(tabs[nextIdx].id);
  }, [tabs, activeTabId, setActiveTab]);

  const switchToPreviousTab = useCallback(() => {
    if (tabs.length <= 1) return;
    const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
    const prevIdx = (currentIdx - 1 + tabs.length) % tabs.length;
    setActiveTab(tabs[prevIdx].id);
  }, [tabs, activeTabId, setActiveTab]);

  return {
    tabs,
    activeTabId,
    createTab,
    closeTab,
    switchTab,
    switchToNextTab,
    switchToPreviousTab,
    renameTab,
  };
}
