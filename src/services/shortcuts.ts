import { isMac } from "./platform";

/**
 * Every app-level keyboard shortcut, in one table, spelled per platform.
 *
 * macOS can afford ⌘ for the app and Ctrl for the shell — two separate
 * modifiers, no overlap. Linux and Windows have no ⌘, and a bare `Ctrl`+letter
 * already belongs to the shell: Ctrl+C interrupts, Ctrl+D is EOF, Ctrl+K kills
 * the line, Ctrl+R is reverse-search, Ctrl+W deletes a word. Binding those to
 * app actions would break the terminal to decorate the app around it.
 *
 * So off macOS the app takes `Ctrl+Shift`, exactly as GNOME Terminal, Konsole,
 * Terminator and xterm do. Two macOS pairs (`⌘T`/`⌘⇧T` and `⌘D`/`⌘⇧D`) would
 * collapse onto the same `Ctrl+Shift` chord; the second of each takes `Ctrl+Alt`
 * instead. Keys the shell never claims — `,`, digits, Tab — stay on plain Ctrl.
 *
 * The native menu carries its own copy of these accelerators, in
 * `src-tauri/src/menu.rs`. Change one, change the other — except on Windows,
 * where the menu registers none of them and this table is the only handler.
 * `TranslateAcceleratorW` runs before the message reaches WebView2 there, so an
 * accelerator in the menu doesn't share the chord with the webview, it takes
 * it. `menu.rs` explains what that costs.
 */

interface Combo {
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface Shortcut {
  /** Matched against `event.key`, lower-cased. Ignored when `code` is set. */
  key?: string;
  /**
   * Physical key, for punctuation whose `event.key` changes under Shift —
   * `Shift+[` arrives as `{`, so matching on `key` would never fire.
   */
  code?: string;
  /** How the key itself is written in the UI. */
  label: string;
  mac: Combo;
  other: Combo;
}

const MOD_ONLY: Combo = { meta: true };
const MOD_SHIFT: Combo = { meta: true, shift: true };
const CTRL: Combo = { ctrl: true };
const CTRL_SHIFT: Combo = { ctrl: true, shift: true };
const CTRL_ALT: Combo = { ctrl: true, alt: true };

function define<T extends Record<string, Shortcut>>(table: T): T {
  return table;
}

export const SHORTCUTS = define({
  newTab: { key: "t", label: "T", mac: MOD_ONLY, other: CTRL_SHIFT },
  newTabSameDir: { key: "t", label: "T", mac: MOD_SHIFT, other: CTRL_ALT },
  splitRight: { key: "d", label: "D", mac: MOD_ONLY, other: CTRL_SHIFT },
  splitDown: { key: "d", label: "D", mac: MOD_SHIFT, other: CTRL_ALT },
  closePane: { key: "w", label: "W", mac: MOD_SHIFT, other: CTRL_SHIFT },
  clearTerminal: { key: "k", label: "K", mac: MOD_ONLY, other: CTRL_SHIFT },
  commandPalette: { key: "p", label: "P", mac: MOD_SHIFT, other: CTRL_SHIFT },
  monitor: { key: "m", label: "M", mac: MOD_SHIFT, other: CTRL_SHIFT },
  browser: { key: "b", label: "B", mac: MOD_SHIFT, other: CTRL_SHIFT },
  find: { key: "f", label: "F", mac: MOD_ONLY, other: CTRL_SHIFT },
  history: { key: "r", label: "R", mac: MOD_ONLY, other: CTRL_SHIFT },
  copy: { key: "c", label: "C", mac: MOD_ONLY, other: CTRL_SHIFT },
  paste: { key: "v", label: "V", mac: MOD_ONLY, other: CTRL_SHIFT },
  prevTab: { code: "BracketLeft", label: "[", mac: MOD_SHIFT, other: CTRL_SHIFT },
  nextTab: { code: "BracketRight", label: "]", mac: MOD_SHIFT, other: CTRL_SHIFT },
  // `L` for light/dark. Nothing else claims it: the shell's own Ctrl+L clears
  // the screen, and this is Ctrl+Shift+L.
  toggleTheme: { key: "l", label: "L", mac: MOD_SHIFT, other: CTRL_SHIFT },
  settings: { key: ",", label: ",", mac: MOD_ONLY, other: CTRL },
  cycleTab: { key: "tab", label: "Tab", mac: MOD_ONLY, other: CTRL },
  cycleTabBack: { key: "tab", label: "Tab", mac: MOD_SHIFT, other: CTRL_SHIFT },
});

export type ShortcutName = keyof typeof SHORTCUTS;

function combo(shortcut: Shortcut): Combo {
  return isMac ? shortcut.mac : shortcut.other;
}

/**
 * Whether an event is exactly this shortcut.
 *
 * Every modifier is compared, including the ones the shortcut doesn't use —
 * anything looser would let `Ctrl+Shift+D` also fire on `Ctrl+Alt+D`, and on
 * Linux would swallow shell keys the terminal needs.
 */
export function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  const wanted = combo(shortcut);

  if (
    event.ctrlKey !== !!wanted.ctrl ||
    event.metaKey !== !!wanted.meta ||
    event.altKey !== !!wanted.alt ||
    event.shiftKey !== !!wanted.shift
  ) {
    return false;
  }

  return shortcut.code
    ? event.code === shortcut.code
    : event.key.toLowerCase() === shortcut.key;
}

/** The plain modifier, for shortcuts described in prose ("⌘1-9"). */
export const MOD = isMac ? "⌘" : "Ctrl";

/** One label per key chip, for the shortcuts list and the command palette. */
export function keys(shortcut: Shortcut): string[] {
  const wanted = combo(shortcut);
  const parts: string[] = [];

  if (wanted.ctrl) parts.push(isMac ? "⌃" : "Ctrl");
  if (wanted.meta) parts.push("⌘");
  if (wanted.alt) parts.push(isMac ? "⌥" : "Alt");
  if (wanted.shift) parts.push(isMac ? "⇧" : "Shift");
  parts.push(shortcut.label);

  return parts;
}

/**
 * The same thing as one string, for tooltips. macOS runs its glyphs together
 * (`⌘⇧M`); everywhere else needs separators (`Ctrl+Shift+M`).
 */
export function text(shortcut: Shortcut): string {
  return keys(shortcut).join(isMac ? "" : "+");
}
