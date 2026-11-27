import { platform } from "./platform";

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
  autoCheckUpdates: boolean;
  updateChannel: "stable" | "prerelease";
  /** Epoch millis of the last successful check, or null if never checked. */
  lastUpdateCheck: number | null;
  /** Version the user dismissed, so the same update doesn't nag every launch. */
  dismissedVersion: string | null;
  /**
   * The service that fills the window, rather than floating above it.
   *
   * Stored as a plain string rather than `ServiceId` so that loading settings
   * doesn't drag the catalogue — and its lucide icons — into whatever imports
   * this. `resolveBase` in `services/catalog` turns it into an id that is known
   * to name an available service; nothing else should read it raw.
   */
  baseService: string;
  /**
   * Epoch millis of the moment the welcome page was answered, or null if it
   * has never been shown.
   *
   * A timestamp rather than a boolean, so a later version can tell a first run
   * from an install that was onboarded before a service existed and might be
   * worth telling about it.
   */
  welcomedAt: number | null;
}

/**
 * The monospace stack, per platform.
 *
 * Menlo and Monaco ship with macOS and exist nowhere else, so the old default
 * fell all the way through to Courier New on Windows and Linux — a thin,
 * loosely spaced face that is a poor thing to read a terminal in. Each platform
 * now leads with the font its own terminal uses.
 */
const MAC_FONT = "Menlo, Monaco, 'Courier New', monospace";
const WINDOWS_FONT = "'Cascadia Mono', Consolas, 'Courier New', monospace";
const LINUX_FONT = "'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono', monospace";

const PLATFORM_FONT =
  platform === "windows" ? WINDOWS_FONT : platform === "linux" ? LINUX_FONT : MAC_FONT;

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fontFamily: PLATFORM_FONT,
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10000,
  shell: null,
  showSuggestionPopup: true,
  showSystemStats: false,
  autoCheckUpdates: true,
  updateChannel: "stable",
  lastUpdateCheck: null,
  dismissedVersion: null,
  baseService: "figy-terminal",
  welcomedAt: null,
};

/**
 * Exported so the store can tell which `storage` event is about these.
 *
 * Windows of one app share an origin and so share this; see the listener in
 * `settingsStore` for what that means and why it is the behaviour you want.
 */
export const SETTINGS_STORAGE_KEY = "figy-term-settings";
const STORAGE_KEY = SETTINGS_STORAGE_KEY;

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
      // Migrate: settings saved before the font default became platform-aware
      // carry the macOS stack. Only a value the user never chose is replaced.
      if (parsed.fontFamily === MAC_FONT) {
        merged.fontFamily = PLATFORM_FONT;
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
