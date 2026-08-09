import { create } from "zustand";
import { Settings, loadSettings, saveSettings, getDefaultSettings } from "../services/settings";

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
