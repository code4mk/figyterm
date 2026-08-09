import { create } from "zustand";
import { TerminalSession, TerminalTab } from "../types/terminal";

interface TerminalStore {
  tabs: TerminalTab[];
  activeTabId: string | null;
  addTab: (session: TerminalSession) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  getActiveSession: () => TerminalSession | null;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (session: TerminalSession) => {
    const tab: TerminalTab = {
      id: session.id,
      session,
      isActive: true,
    };
    set((state) => ({
      tabs: [
        ...state.tabs.map((t) => ({ ...t, isActive: false })),
        tab,
      ],
      activeTabId: session.id,
    }));
  },

  removeTab: (id: string) => {
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== id);
      let newActiveId = state.activeTabId;

      if (state.activeTabId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        if (newTabs.length > 0) {
          const newIdx = Math.min(idx, newTabs.length - 1);
          newActiveId = newTabs[newIdx].id;
          newTabs.forEach((t) => (t.isActive = t.id === newActiveId));
        } else {
          newActiveId = null;
        }
      }

      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  setActiveTab: (id: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) => ({ ...t, isActive: t.id === id })),
      activeTabId: id,
    }));
  },

  renameTab: (id: string, title: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, session: { ...t.session, title } } : t
      ),
    }));
  },

  getActiveSession: () => {
    const state = get();
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    return activeTab?.session ?? null;
  },
}));
