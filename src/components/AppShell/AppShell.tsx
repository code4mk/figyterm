import { useState, useCallback, useEffect, useRef } from "react";
import { Terminal } from "../Terminal/Terminal";
import { TabBar } from "../Terminal/TabBar";
import { StatusBar } from "../Terminal/StatusBar";
import { CommandPalette } from "../CommandPalette/CommandPalette";
import { Settings } from "../Settings/Settings";
import { useTerminalStore } from "../../stores/terminalStore";
import { TerminalSession } from "../../types/terminal";

interface TerminalInstance {
  id: string;
  sessionId: string | null;
  session: TerminalSession | null;
  clearRef: React.MutableRefObject<(() => void) | null>;
}

export function AppShell() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminals, setTerminals] = useState<TerminalInstance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [liveCwds, setLiveCwds] = useState<Record<string, string>>({});
  const [customTabNames, setCustomTabNames] = useState<Record<string, string>>({});
  const initialCreated = useRef(false);

  const { addTab, removeTab, setActiveTab } = useTerminalStore();

  const clearRefs = useRef<Map<string, React.MutableRefObject<(() => void) | null>>>(new Map());

  const handleNewTab = useCallback(() => {
    const id = crypto.randomUUID();
    const clearRef: React.MutableRefObject<(() => void) | null> = { current: null };
    clearRefs.current.set(id, clearRef);
    setTerminals((prev) => [...prev, { id, sessionId: null, session: null, clearRef }]);
    setActiveId(id);
  }, []);

  const handleSessionCreated = useCallback(
    (instanceId: string, session: TerminalSession) => {
      setTerminals((prev) =>
        prev.map((t) =>
          t.id === instanceId ? { ...t, sessionId: session.id, session } : t
        )
      );
      addTab(session);
      setActiveTab(session.id);
      setActiveId(instanceId);
    },
    [addTab, setActiveTab]
  );

  const handleCloseTab = useCallback(
    (instanceId: string) => {
      clearRefs.current.delete(instanceId);
      setTerminals((prev) => {
        const updated = prev.filter((t) => t.id !== instanceId);
        if (activeId === instanceId && updated.length > 0) {
          const idx = prev.findIndex((t) => t.id === instanceId);
          const newIdx = Math.min(idx, updated.length - 1);
          setActiveId(updated[newIdx].id);
        } else if (updated.length === 0) {
          setActiveId(null);
        }
        return updated;
      });
      const terminal = terminals.find((t) => t.id === instanceId);
      if (terminal?.sessionId) {
        removeTab(terminal.sessionId);
      }
    },
    [activeId, terminals, removeTab]
  );

  const handleSwitchTab = useCallback(
    (instanceId: string) => {
      setActiveId(instanceId);
      const terminal = terminals.find((t) => t.id === instanceId);
      if (terminal?.sessionId) {
        setActiveTab(terminal.sessionId);
      }
    },
    [terminals, setActiveTab]
  );

  const switchToNextTab = useCallback(() => {
    if (terminals.length <= 1) return;
    const currentIdx = terminals.findIndex((t) => t.id === activeId);
    const nextIdx = (currentIdx + 1) % terminals.length;
    handleSwitchTab(terminals[nextIdx].id);
  }, [terminals, activeId, handleSwitchTab]);

  const switchToPreviousTab = useCallback(() => {
    if (terminals.length <= 1) return;
    const currentIdx = terminals.findIndex((t) => t.id === activeId);
    const prevIdx = (currentIdx - 1 + terminals.length) % terminals.length;
    handleSwitchTab(terminals[prevIdx].id);
  }, [terminals, activeId, handleSwitchTab]);

  const handleClearTerminal = useCallback(() => {
    if (!activeId) return;
    const ref = clearRefs.current.get(activeId);
    if (ref?.current) ref.current();
  }, [activeId]);

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
        if (activeId) {
          handleCloseTab(activeId);
        }
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
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewTab, handleCloseTab, activeId, switchToNextTab, switchToPreviousTab, handleClearTerminal]);

  const activeTerminal = terminals.find((t) => t.id === activeId);

  const tabsForUI = terminals
    .filter((t) => t.session !== null)
    .map((t) => ({
      id: t.id,
      title: customTabNames[t.id] || t.session!.title,
      isActive: t.id === activeId,
    }));

  const commands = [
    { id: "new-terminal", label: "New Terminal", shortcut: "⌘T", action: handleNewTab },
    { id: "close-terminal", label: "Close Terminal", shortcut: "⌘W", action: () => activeId && handleCloseTab(activeId) },
    { id: "clear-terminal", label: "Clear Terminal", shortcut: "⌘K", action: handleClearTerminal },
    { id: "next-tab", label: "Next Tab", shortcut: "⌘Tab", action: switchToNextTab },
    { id: "prev-tab", label: "Previous Tab", shortcut: "⌘⇧Tab", action: switchToPreviousTab },
    { id: "settings", label: "Settings", shortcut: "⌘,", action: () => setSettingsOpen(true) },
  ];

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-ft-bg">
      <TabBar
        tabs={tabsForUI}
        onTabClick={handleSwitchTab}
        onTabClose={handleCloseTab}
        onNewTab={handleNewTab}
        onRenameTab={(id, name) => setCustomTabNames((prev) => ({ ...prev, [id]: name }))}
        onDuplicateTab={handleNewTab}
      />
      <div className="flex-1 relative overflow-hidden">
        {terminals.map((terminal) => (
          <Terminal
            key={terminal.id}
            instanceId={terminal.id}
            isActive={terminal.id === activeId}
            onSessionCreated={(session) => handleSessionCreated(terminal.id, session)}
            onCwdChange={(cwd) => setLiveCwds((prev) => ({ ...prev, [terminal.id]: cwd }))}
            clearRef={terminal.clearRef}
          />
        ))}
      </div>
      <StatusBar
        cwd={activeId ? (liveCwds[activeId] || activeTerminal?.session?.cwd || "") : ""}
        shell={activeTerminal?.session?.shell ?? ""}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commands}
      />
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        activeSessionId={terminals.find((t) => t.id === activeId)?.sessionId ?? null}
      />
    </div>
  );
}
