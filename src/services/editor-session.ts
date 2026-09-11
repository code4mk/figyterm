/**
 * What the editor remembers between launches.
 *
 * Two separate things, deliberately kept apart:
 *
 * - **The session** — which folder was open, which tabs, where the modal sat.
 *   Losing it is an annoyance.
 * - **Drafts** — the text of buffers with unsaved changes. Losing *that* is
 *   losing the user's work, so it is written on a debounce while typing rather
 *   than only on a clean shutdown, and it survives a crash, a `kill -9`, or the
 *   window being closed with a dirty tab still open.
 *
 * Both live in `localStorage`, like `settings.ts`, and both are read through a
 * merge over defaults so that a shape change degrades instead of throwing.
 */

const SESSION_KEY = "figy-term-editor";
const DRAFT_PREFIX = "figy-term-editor-draft:";

/**
 * Bumped when the stored shape changes incompatibly. A mismatch is discarded
 * rather than migrated: it's a window position and a tab list, not data worth
 * writing migration code for.
 */
/**
 * Bumped when the stored shape changes incompatibly. A mismatch is discarded
 * rather than migrated: it's a window position and a tab list, not data worth
 * writing migration code for.
 *
 * v2 introduced workspaces — the tab list moved from being global to being per
 * folder, which is the whole point of them.
 */
const SESSION_VERSION = 2;

/** How many folders are remembered before the least recent is dropped. */
const MAX_WORKSPACES = 12;

/**
 * Drafts bigger than this aren't journalled. `localStorage` is a synchronous,
 * few-megabyte store shared with the rest of the app's state, and writing a
 * large minified file into it on every keystroke pause would be worse than the
 * problem it solves. Buffers that large are read-only anyway (see
 * `LARGE_FILE_BYTES` on the Rust side).
 */
const MAX_DRAFT_BYTES = 512 * 1024;

/**
 * One remembered folder, with the state that belongs to it.
 *
 * Tabs and expanded directories are per workspace because they mean nothing
 * outside it: switching to another project and finding the last one's files
 * still open is not a feature. Panel widths and the hidden-file toggle are
 * global — those are preferences about the editor, not about a folder.
 */
export interface Workspace {
  /** Canonical path, as the backend resolved it. */
  root: string;
  /** Paths of the tabs that were open, in tab order. */
  openPaths: string[];
  activePath: string | null;
  expanded: string[];
  /** Epoch millis, for ordering the switcher. */
  lastOpenedAt: number;
}

export interface PersistedSession {
  version: number;
  workspaces: Workspace[];
  /** Which workspace to reopen. */
  activeRoot: string | null;
  /**
   * Pinned folders, by canonical path.
   *
   * Kept apart from `workspaces` on purpose: a pin is "a folder I always want
   * one click away", which outlives forgetting that folder's tabs. Forgetting a
   * workspace therefore leaves its pin, and a pinned folder that isn't a
   * workspace yet becomes one when opened.
   *
   * Added without a version bump — `loadSession` merges over the defaults, so
   * an older stored session simply arrives with no favourites.
   */
  favorites: string[];
  showHidden: boolean;
  explorerVisible: boolean;
  explorerWidth: number;
  previewWidth: number;
  /**
   * How the diff view draws itself. Global rather than per workspace: it's a
   * preference about reading diffs, not about a project.
   *
   * Added without a version bump, like `favorites` — `loadSession` merges over
   * the defaults, so an older stored session simply arrives with the default.
   */
  diffLayout: DiffLayout;
  diffStyle: DiffStyle;
  settings: EditorSettings;
}

/**
 * The editor's own preferences.
 *
 * Its own, and not the terminal's `settings.ts`, for one concrete reason: the
 * editor was rendering in the *terminal's* font at the terminal's size, which
 * is a setting chosen for reading a shell. Code wants its own — often a
 * different face, almost always a different size — and a preference that can
 * only be right for one of the two panes is not one setting, it is two.
 *
 * Kept in the session blob rather than a store of its own because that is
 * already where the editor's other preferences live, and because the whole
 * editor is lazily loaded: nothing should read this until it is open.
 */
export interface EditorSettings {
  /**
   * Empty means "whatever the terminal is using".
   *
   * A sentinel rather than copying the terminal's value in, so that changing
   * the terminal's font still moves the editor for anyone who never set one —
   * which is the behaviour they would expect from never having chosen.
   */
  fontFamily: string;
  /** Zero means the same: follow the terminal. */
  fontSize: number;
  lineHeight: number;
  indentGuides: boolean;
  /** What indentation to use when a file's own can't be detected. */
  useTabs: boolean;
  indentWidth: number;
  /** Whether new buffers start wrapped; the status bar still toggles per session. */
  wordWrap: boolean;
  autoCloseBrackets: boolean;
  /** Completion from the words already in the document, in place of an LSP. */
  wordCompletion: boolean;
}

/** Both halves of one file, or one column with the removals in place. */
export type DiffLayout = "unified" | "split";

/**
 * Whose diff conventions to follow.
 *
 * Not a colour scheme — the presets differ in what they *show*: whether there
 * are `+`/`-` signs, one line-number column or two, a tint per row or bare
 * coloured text. They're the presentations people already know from the tools
 * they read diffs in, so nobody has to learn this one.
 */
export type DiffStyle = "github" | "gitlab" | "vscode" | "delta" | "plain";

export interface PersistedDraft {
  /** Null for a scratch buffer that was never saved anywhere. */
  path: string | null;
  name: string;
  languageId: string;
  content: string;
  /** The mtime the buffer was loaded at, for the conflict check on recovery. */
  mtime: number | null;
  savedAt: number;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontFamily: "",
  fontSize: 0,
  // CodeMirror's own default is 1.4; code at 1.55 is easier to scan and still
  // fits a useful number of lines in a modal this size.
  lineHeight: 1.55,
  indentGuides: true,
  useTabs: false,
  indentWidth: 2,
  wordWrap: false,
  autoCloseBrackets: true,
  wordCompletion: true,
};

const DEFAULT_SESSION: PersistedSession = {
  version: SESSION_VERSION,
  workspaces: [],
  activeRoot: null,
  favorites: [],
  showHidden: false,
  explorerVisible: true,
  explorerWidth: 260,
  previewWidth: 420,
  diffLayout: "unified",
  diffStyle: "github",
  settings: DEFAULT_EDITOR_SETTINGS,
};

/**
 * Numbers from storage are user-editable and reach CSS, so a hand-edited `0`
 * for the line height would collapse every line to nothing. Zero is legal for
 * the font size alone, where it means "follow the terminal".
 */
function clamp(value: number, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

const DIFF_LAYOUTS: DiffLayout[] = ["unified", "split"];
const DIFF_STYLES: DiffStyle[] = ["github", "gitlab", "vscode", "delta", "plain"];

export function loadSession(): PersistedSession {
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return { ...DEFAULT_SESSION };
    const parsed = JSON.parse(stored) as Partial<PersistedSession>;
    if (parsed.version !== SESSION_VERSION) return { ...DEFAULT_SESSION };
    const merged = { ...DEFAULT_SESSION, ...parsed };
    // Defended rather than trusted: this is user-editable storage, and a
    // malformed `workspaces` would otherwise crash the editor on open.
    merged.favorites = Array.isArray(merged.favorites)
      ? merged.favorites.filter((f): f is string => typeof f === "string" && f.length > 0)
      : [];
    merged.workspaces = Array.isArray(merged.workspaces)
      ? merged.workspaces.filter(
          (w): w is Workspace => !!w && typeof w.root === "string" && w.root.length > 0
        )
      : [];
    // Checked against the known values rather than trusted: these two reach
    // CSS as attribute selectors and a stored string from an older build (or a
    // hand-edited one) would silently render an unstyled diff.
    if (!DIFF_LAYOUTS.includes(merged.diffLayout)) {
      merged.diffLayout = DEFAULT_SESSION.diffLayout;
    }
    if (!DIFF_STYLES.includes(merged.diffStyle)) {
      merged.diffStyle = DEFAULT_SESSION.diffStyle;
    }
    /*
      Merged field by field rather than taken whole. A session written by an
      older build has no `settings` at all, and one written by a newer build
      may have fields this one has never heard of; spreading the defaults under
      it means a missing field is a default rather than `undefined` reaching a
      CSS property.
    */
    merged.settings = { ...DEFAULT_SESSION.settings, ...(parsed.settings ?? {}) };
    merged.settings.fontSize = clamp(merged.settings.fontSize, 0, 40);
    merged.settings.lineHeight = clamp(merged.settings.lineHeight, 1, 3);
    merged.settings.indentWidth = clamp(merged.settings.indentWidth, 1, 8);
    return merged;
  } catch {
    return { ...DEFAULT_SESSION };
  }
}

export function saveSession(session: Omit<PersistedSession, "version">): void {
  try {
    const workspaces = [...session.workspaces]
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, MAX_WORKSPACES);
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...session, workspaces, version: SESSION_VERSION })
    );
  } catch {
    // A full or unavailable store costs the session, not the edit.
  }
}

// ─── Drafts ─────────────────────────────────────────────────────────────────

/**
 * Journals a dirty buffer.
 *
 * Keyed by buffer id rather than path, so a scratch buffer with no path is
 * recoverable too, and two buffers on the same path (which shouldn't happen,
 * but did while tabs were being reworked) can't overwrite each other's draft.
 */
export function saveDraft(id: string, draft: PersistedDraft): void {
  try {
    if (draft.content.length > MAX_DRAFT_BYTES) return;
    localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify(draft));
  } catch {
    // Nothing useful to do — the buffer itself is still intact in memory.
  }
}

export function clearDraft(id: string): void {
  try {
    localStorage.removeItem(DRAFT_PREFIX + id);
  } catch {
    // As above.
  }
}

/** Every journalled draft, for the recovery prompt on launch. */
export function listDrafts(): { id: string; draft: PersistedDraft }[] {
  const found: { id: string; draft: PersistedDraft }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        found.push({ id: key.slice(DRAFT_PREFIX.length), draft: JSON.parse(raw) });
      } catch {
        // One unreadable draft shouldn't hide the others.
      }
    }
  } catch {
    return [];
  }
  return found.sort((a, b) => b.draft.savedAt - a.draft.savedAt);
}

export function clearAllDrafts(): void {
  listDrafts().forEach(({ id }) => clearDraft(id));
}
