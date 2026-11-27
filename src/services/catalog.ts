import {
  Code2,
  Globe,
  PenLine,
  Send,
  Sparkles,
  Terminal as TerminalIcon,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { SHORTCUTS, type ShortcutName } from "./shortcuts";
import { EMBEDDED_BROWSER_SUPPORTED } from "./platform";

/**
 * Figylo's services, in one table.
 *
 * Until now every surface that needed to name a service kept its own list: the
 * command palette spelled them one way, the minimized dock another, the native
 * menu a third, and the marketing site a fourth. Adding Figy Man meant finding
 * all four. Worse, the four disagreed — the dock called the API client "API",
 * the palette called it "API Client", and the site called it Figy Man, which is
 * its actual name.
 *
 * So this is the single source. Names, taglines and accents are taken verbatim
 * from `frontend/lib/services.ts`, which is the published catalogue; the fields
 * past `tagline` are what the app needs and the site does not — which window
 * each one is, which shortcut opens it, and whether this platform can run it.
 *
 * One entry per service. If a name has to change, it changes here.
 */

export type ServiceId =
  | "figy-terminal"
  | "claude-code"
  | "figy-harness"
  | "figy-code-editor"
  | "figy-man"
  | "figy-drawing"
  | "figy-browser";

export interface ServiceDef {
  id: ServiceId;
  /** Full name, as the site's H1 has it. */
  name: string;
  /** Short name for the dock, tabs and anywhere the full one won't fit. */
  short: string;
  /** One sentence, from the site. Shown on the welcome page's cards. */
  tagline: string;
  /** Hex, from the site. Tints the card and marks the base in the status bar. */
  accent: string;
  icon: LucideIcon;
  /**
   * Claude Code ships its own mark, and it is somebody else's program — the
   * window says so rather than dressing it in one of our glyphs. Where this is
   * set it wins over `icon`.
   */
  image?: string;
  /** The chord that opens it as a window. The terminal has none; it is reached
   * by being the base, or from the palette when it is not. */
  shortcut?: ShortcutName;
  badge?: "New" | "Preview";
  /**
   * Whether this platform can run it at all.
   *
   * Only the browser is ever false: it puts a native child webview inside its
   * frame, and there are platforms where that cannot be positioned. An
   * unavailable service is absent from the welcome page and can never be the
   * base, so there is no way to choose a window that will not open.
   */
  available: boolean;
}

export const SERVICES: ServiceDef[] = [
  {
    id: "figy-terminal",
    name: "Figy Terminal",
    short: "Terminal",
    tagline:
      "Panes, tabs, search, history, a system monitor and a command palette — the terminal fundamentals, done properly.",
    accent: "#94a3b8",
    icon: TerminalIcon,
    available: true,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    short: "Claude Code",
    tagline:
      "A project-shaped window for the Claude Code CLI, where switching projects never kills the conversation you left running.",
    accent: "#e08a5f",
    icon: Sparkles,
    image: "/claude-code.png",
    shortcut: "claude",
    badge: "New",
    available: true,
  },
  {
    id: "figy-harness",
    name: "Figy Harness",
    short: "Harness",
    tagline:
      "Figylo's own coding agent: a turn loop in Rust, a sandbox that already existed, and language server tools no CLI agent can offer.",
    accent: "#6366f1",
    icon: Wand2,
    shortcut: "figyCode",
    badge: "Preview",
    available: true,
  },
  {
    id: "figy-code-editor",
    name: "Figy Code Editor",
    short: "Editor",
    tagline:
      "A real editor over the shell — CodeMirror 6, file tabs, a file tree, a fuzzy finder and project-wide search, one shortcut away.",
    accent: "#38bdf8",
    icon: Code2,
    shortcut: "editor",
    available: true,
  },
  {
    id: "figy-man",
    name: "Figy Man",
    short: "Figy Man",
    tagline:
      "A REST client in the terminal, with your existing collections imported and exported unharmed.",
    accent: "#34d399",
    icon: Send,
    shortcut: "api",
    badge: "New",
    available: true,
  },
  {
    id: "figy-drawing",
    name: "Figy Drawing",
    short: "Drawing",
    tagline:
      "An Excalidraw canvas and a rich-text notes pane, saved as named projects, autosaved as you draw.",
    accent: "#f472b6",
    icon: PenLine,
    shortcut: "drawing",
    badge: "New",
    available: true,
  },
  {
    id: "figy-browser",
    name: "Figy Browser",
    short: "Browser",
    tagline:
      "A real native webview with tabs and an address bar, docked inside the terminal — not an iframe.",
    accent: "#22d3ee",
    icon: Globe,
    shortcut: "browser",
    available: EMBEDDED_BROWSER_SUPPORTED,
  },
];

const BY_ID = new Map(SERVICES.map((service) => [service.id, service]));

/**
 * Throws on an unknown id rather than returning undefined.
 *
 * Every caller here holds an id that came out of this table or out of settings
 * that this table validated, so a miss is a programming error and not a case to
 * branch on. `baseService()` below is where a stale stored id is dealt with.
 */
export function service(id: ServiceId): ServiceDef {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown service: ${id}`);
  return found;
}

/** What the welcome page offers, and what Settings lists. */
export function selectableServices(): ServiceDef[] {
  return SERVICES.filter((s) => s.available);
}

/**
 * The stored base, made safe — or null, meaning nobody has chosen one.
 *
 * There is deliberately no default. The terminal was the base for as long as
 * it was the only thing here, and leaving it as the fallback would have meant
 * every install still opened on a shell and looked like a terminal — which is
 * the exact impression the welcome page exists to correct. So an install with
 * no answer yet has no base, and the welcome page is what fills the window
 * until there is one.
 *
 * Null also covers the recoverable failures: a service dropped from the table,
 * or one that is unavailable on this platform after a settings file travelled
 * between machines — the browser is the one that can. Rather than silently
 * substituting a service nobody picked, the window asks again.
 */
export function resolveBase(stored: string | null | undefined): ServiceId | null {
  const found = stored ? BY_ID.get(stored as ServiceId) : undefined;
  return found?.available ? found.id : null;
}

/** The chord that opens a service, spelled for this platform. */
export function serviceShortcut(def: ServiceDef) {
  return def.shortcut ? SHORTCUTS[def.shortcut] : null;
}
