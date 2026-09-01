export interface Settings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  shell: string | null;
  showSuggestionPopup: boolean;
  showSystemStats: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10000,
  shell: null,
  showSuggestionPopup: true,
  showSystemStats: false,
};

const STORAGE_KEY = "figy-term-settings";

export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const merged = { ...DEFAULT_SETTINGS, ...parsed };
      // Migrate: if letterSpacing was never explicitly set (missing or 0),
      // apply the improved default for proper font rendering
      if (!("letterSpacing" in parsed)) {
        merged.letterSpacing = DEFAULT_SETTINGS.letterSpacing;
      }
      return merged;
    }
  } catch {
    // Fall through to default
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function getDefaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS };
}
