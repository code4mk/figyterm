import { create } from "zustand";
import {
  Settings,
  loadSettings,
  saveSettings,
  getDefaultSettings,
  SETTINGS_STORAGE_KEY,
} from "../services/settings";

interface SettingsStore {
  settings: Settings;
  updateSettings: (partial: Partial<Settings>) => void;
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: loadSettings(),

  updateSettings: (partial: Partial<Settings>) => {
    set((state) => {
      const newSettings = { ...state.settings, ...partial };
      saveSettings(newSettings);
      return { settings: newSettings };
    });
  },

  resetSettings: () => {
    const defaults = getDefaultSettings();
    saveSettings(defaults);
    set({ settings: defaults });
  },
}));

/*
  Settings follow the window that changed them, into every other window.

  All the windows of one app share an origin, so they share this `localStorage`
  key — and each one writes its *whole* settings object. Left alone that is
  last-writer-wins against a stale copy: change the font in one window, change
  anything at all in another, and the font change is gone, because the second
  window wrote the settings as they were when it started.

  The `storage` event is the other side of that sharing and the fix for it. It
  fires only in the windows that did *not* write, so this re-reads and never
  writes back — no echo, and no loop. What it buys beyond correctness is the
  behaviour anybody would expect of a preference: change the font size in one
  window and both windows change.
*/
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== SETTINGS_STORAGE_KEY) return;
    useSettingsStore.setState({ settings: loadSettings() });
  });
}
