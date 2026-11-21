import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setBrowserTheme } from "../services/browser";

type Theme = "dark" | "light";

interface ThemeStore {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const THEME_KEY = "figyterm-theme";

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {}
  return "dark";
}

/**
 * Puts a theme into effect.
 *
 * `persist` is false when the change *came from* storage — another window
 * having set it. Writing it back there would be an echo, and on the engines
 * that fire `storage` for a same-value write, a loop between two windows each
 * telling the other what it already knows.
 */
function applyTheme(theme: Theme, persist = true) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
    root.classList.remove("light");
  } else {
    root.classList.add("light");
    root.classList.remove("dark");
  }
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }

  // Update native macOS titlebar to match
  try {
    getCurrentWindow().setTheme(theme === "dark" ? "dark" : "light");
  } catch {}

  // Keep embedded browser webviews in sync with the app theme.
  setBrowserTheme(theme).catch(() => {});
}

const initialTheme = getInitialTheme();
applyTheme(initialTheme);

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: initialTheme,

  toggleTheme: () => {
    set((state) => {
      const next = state.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      return { theme: next };
    });
  },

  setTheme: (theme: Theme) => {
    applyTheme(theme);
    set({ theme });
  },
}));

/*
  The theme is one choice for the whole app, so every window follows it.

  Windows share an origin and so share this key; the `storage` event fires in
  the windows that did *not* write, which is exactly the set that needs to
  catch up. Applied without persisting — see `applyTheme` — so the one that
  made the change stays the only one that wrote it.
*/
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_KEY) return;
    const next = event.newValue;
    if (next !== "dark" && next !== "light") return;
    if (useThemeStore.getState().theme === next) return;
    applyTheme(next, false);
    useThemeStore.setState({ theme: next });
  });
}
