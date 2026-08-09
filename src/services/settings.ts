export interface Settings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  shell: string | null;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fontFamily: "'Meslo LG S DZ for Powerline', 'MesloLGS NF', 'JetBrains Mono', Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.2,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10000,
  shell: null,
};

const STORAGE_KEY = "figy-term-settings";

export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
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
