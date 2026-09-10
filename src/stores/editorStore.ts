import { create } from "zustand";
import { basename, FileEncoding, LineEnding, OpenedFile } from "../services/editor-fs";
import { languageFor } from "../services/editor-lang";
import {
  clearDraft,
  DiffLayout,
  DiffStyle,
  loadSession,
  saveSession,
  Workspace,
} from "../services/editor-session";
import { isLinux } from "../services/platform";

/**
 * The editor's metadata, and nothing else.
 *
 * Buffer *text* is deliberately absent: CodeMirror owns each document, keeps its
 * own undo history and selection, and `EditorSurface` hands the current text
 * over on request. Putting a live document in here and re-rendering the tab
 * strip, the breadcrumb and the explorer on every keystroke is the standard way
 * an editor like this ends up feeling slow, and it's an easy mistake to make
 * because it looks tidier.
 *
 * `initialContent` is the one exception, and it is not live: it seeds
 * CodeMirror when a buffer is first shown, and is never written again.
 */

/**
 * How many files stay open at once. Past this, opening another closes the
 * least recently used *clean* buffer — a dirty one is never closed for you.
 */
const MAX_BUFFERS = 12;

/**
 * How the buffer stands against the file on disk.
 *
 * A boolean was not enough: a deleted file and an externally edited one need
 * different words and different offers, and collapsing them meant a file that
 * had been removed was reported as having "changed on disk", with a Reload
 * button that could only fail.
 */
export type DiskState = "ok" | "changed" | "missing";

export interface EditorBuffer {
  id: string;
  /** Null for a scratch buffer that has never been saved. */
  path: string | null;
  name: string;
  languageId: string;
  dirty: boolean;
  /** What the file's mtime was when loaded or last saved; the conflict check. */
  mtime: number | null;
  encoding: FileEncoding;
  lineEnding: LineEnding;
  readonly: boolean;
  /** Opened without highlighting because of its size. */
  large: boolean;
  /** Seed text for CodeMirror. Not updated as the user types. */
  initialContent: string;
  /** How this buffer stands against the file on disk. */
  disk: DiskState;
  /** For LRU eviction. */
  usedAt: number;
}

/** What `switchWorkspace` hands back for the modal to reopen. */
export interface WorkspaceRestore {
  openPaths: string[];
  activePath: string | null;
}

interface EditorStore {
  /** The folder the explorer is rooted at, canonicalised by the backend. */
  root: string | null;
  /** Every folder the editor remembers, most recently opened first. */
  workspaces: Workspace[];
  /** Pinned folder paths, shown on the picker's Favourites tab. */
  favorites: string[];
  /**
   * True while tabs are being reopened.
   *
   * Persisting rebuilds a workspace's tab list from whatever is currently open,
   * and during a switch that is briefly *nothing* — so without this the target
   * workspace's remembered tabs were overwritten with an empty list moments
   * before they could be restored, and every switch landed on an empty editor.
   */
  restoring: boolean;
  buffers: EditorBuffer[];
  activeBufferId: string | null;

  explorerVisible: boolean;
  explorerWidth: number;
  /** Width of the Markdown preview pane. */
  previewWidth: number;
  showHidden: boolean;
  /** Directories the explorer has expanded. */
  expanded: string[];

  diffLayout: DiffLayout;
  diffStyle: DiffStyle;

  setRoot: (root: string | null) => void;
  setRestoring: (restoring: boolean) => void;

  /**
   * Moves to another remembered folder.
   *
   * Saves the current workspace's tabs, clears them, and returns what the new
   * one had open — the modal does the reopening, since only it can read files.
   * Callers are expected to have dealt with unsaved buffers first.
   */
  switchWorkspace: (root: string) => WorkspaceRestore;
  /** Forgets a folder and everything remembered about it. */
  removeWorkspace: (root: string) => void;
  /** Pins or unpins a folder. */
  toggleFavorite: (root: string) => void;

  /** Focuses the buffer for `path` if it's open, otherwise adds one. */
  openFile: (path: string, file: OpenedFile) => string;
  openScratch: (languageId?: string) => string;
  closeBuffer: (id: string) => void;
  closeAllBuffers: () => void;
  setActiveBuffer: (id: string) => void;
  reorderBuffers: (from: number, to: number) => void;

  setDirty: (id: string, dirty: boolean) => void;
  markSaved: (id: string, mtime: number, path?: string) => void;
  setDiskState: (id: string, disk: DiskState) => void;
  /** After an external change was accepted: new text, new mtime, clean again. */
  reloadBuffer: (id: string, file: OpenedFile) => void;
  setLineEnding: (id: string, lineEnding: LineEnding) => void;
  setEncoding: (id: string, encoding: FileEncoding) => void;
  setLanguage: (id: string, languageId: string) => void;

  setExplorerVisible: (visible: boolean) => void;
  setExplorerWidth: (width: number) => void;
  setPreviewWidth: (width: number) => void;
  setShowHidden: (show: boolean) => void;
  setDiffLayout: (layout: DiffLayout) => void;
  setDiffStyle: (style: DiffStyle) => void;
  toggleExpanded: (path: string) => void;
  /** Removes one directory from the expanded set, never adds. */
  collapse: (path: string) => void;
  collapseAll: () => void;

  bufferFor: (path: string) => EditorBuffer | undefined;
  activeBuffer: () => EditorBuffer | undefined;
}

/**
 * Whether two paths name the same file.
 *
 * macOS and Windows preserve the case a name was created with but match without
 * it, so opening `Cta.tsx` and then `cta.tsx` must land on one tab, not two
 * that then race each other's saves. On Linux those are genuinely different
 * files and the comparison has to stay exact.
 */
function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return isLinux ? a === b : a.toLowerCase() === b.toLowerCase();
}

const stored = loadSession();

/**
 * The active workspace's entry, rebuilt from what's actually open.
 *
 * Called on every persist, so a workspace's remembered tabs are never more
 * than one action stale — which is what makes switching away and back land on
 * the same files.
 */
function foldWorkspaces(state: EditorStore): Workspace[] {
  if (!state.root) return state.workspaces;
  // Mid-restore the open tabs aren't representative of anything; leave the
  // stored lists alone until they are.
  if (state.restoring) return state.workspaces;

  const current: Workspace = {
    root: state.root,
    openPaths: state.buffers.map((b) => b.path).filter((p): p is string => !!p),
    activePath: state.buffers.find((b) => b.id === state.activeBufferId)?.path ?? null,
    expanded: state.expanded,
    lastOpenedAt:
      state.workspaces.find((w) => w.root === state.root)?.lastOpenedAt ?? Date.now(),
  };

  const others = state.workspaces.filter((w) => w.root !== state.root);
  return [current, ...others];
}

function persist(state: EditorStore): void {
  saveSession({
    workspaces: foldWorkspaces(state),
    activeRoot: state.root,
    favorites: state.favorites,
    showHidden: state.showHidden,
    explorerVisible: state.explorerVisible,
    explorerWidth: state.explorerWidth,
    previewWidth: state.previewWidth,
    diffLayout: state.diffLayout,
    diffStyle: state.diffStyle,
  });
}

function bufferFromFile(path: string, file: OpenedFile): EditorBuffer {
  return {
    id: crypto.randomUUID(),
    path,
    name: basename(path),
    languageId: file.large ? "plaintext" : languageFor(path),
    dirty: false,
    mtime: file.mtime,
    encoding: file.encoding,
    lineEnding: file.lineEnding,
    // A file we can't write, or one too big to edit comfortably, opens for
    // reading rather than accepting edits that would fail at save time.
    readonly: file.readonly || file.large,
    large: file.large,
    initialContent: file.content,
    disk: "ok",
    usedAt: Date.now(),
  };
}

const initialRoot = stored.activeRoot;
const initialWorkspace = stored.workspaces.find((w) => w.root === initialRoot);

export const useEditorStore = create<EditorStore>((set, get) => ({
  root: initialRoot,
  workspaces: stored.workspaces,
  favorites: stored.favorites,
  restoring: false,
  buffers: [],
  activeBufferId: null,

  explorerVisible: stored.explorerVisible,
  explorerWidth: stored.explorerWidth,
  previewWidth: stored.previewWidth,
  showHidden: stored.showHidden,
  expanded: initialWorkspace?.expanded ?? [],

  diffLayout: stored.diffLayout,
  diffStyle: stored.diffStyle,

  setRoot: (root) => {
    set((state) => {
      if (!root) return { root };
      // Opening a folder is what puts it in the switcher, and bumps it to the
      // top of the list.
      const existing = state.workspaces.find((w) => w.root === root);
      const entry: Workspace = existing
        ? { ...existing, lastOpenedAt: Date.now() }
        : { root, openPaths: [], activePath: null, expanded: [], lastOpenedAt: Date.now() };
      return {
        root,
        workspaces: [entry, ...state.workspaces.filter((w) => w.root !== root)],
        expanded: entry.expanded,
      };
    });
    persist(get());
  },

  setRestoring: (restoring) => {
    set({ restoring });
    // Writing on the way *out* of a restore is what commits the reopened tabs.
    // Without it they'd sit unpersisted until the next unrelated action, and a
    // crash in between would lose them.
    if (!restoring) persist(get());
  },

  /**
   * The whole switch, in one action.
   *
   * It has to be atomic. Doing it in two steps — point the root at the new
   * folder, then move the tabs — meant the persist inside the first step folded
   * the *old* folder's open tabs into the *new* folder's entry, so switching
   * reopened the previous workspace's files and lost the target's. Everything
   * that reads or writes the workspace list happens here, in order, before
   * anything persists.
   */
  switchWorkspace: (root) => {
    const state = get();

    // The outgoing folder's tabs, folded away before they're cleared —
    // otherwise switching back would find it empty.
    const saved = foldWorkspaces({ ...state, restoring: false });
    const target = saved.find((w) => w.root === root);
    const restore: WorkspaceRestore = {
      openPaths: target?.openPaths ?? [],
      activePath: target?.activePath ?? null,
    };

    state.buffers.forEach((buffer) => clearDraft(buffer.id));

    const entry: Workspace = target
      ? { ...target, lastOpenedAt: Date.now() }
      : { root, openPaths: [], activePath: null, expanded: [], lastOpenedAt: Date.now() };

    set({
      root,
      // The folder being opened goes to the top of the list.
      workspaces: [entry, ...saved.filter((w) => w.root !== root)],
      expanded: entry.expanded,
      buffers: [],
      activeBufferId: null,
      // Held until the modal has finished reopening the tabs.
      restoring: true,
    });
    persist(get());
    return restore;
  },

  removeWorkspace: (root) => {
    // The pin is deliberately kept: forgetting a folder's tabs is not the same
    // as no longer wanting it one click away.
    set((state) => ({ workspaces: state.workspaces.filter((w) => w.root !== root) }));
    persist(get());
  },

  toggleFavorite: (root) => {
    set((state) => ({
      favorites: state.favorites.includes(root)
        ? state.favorites.filter((f) => f !== root)
        : [...state.favorites, root],
    }));
    persist(get());
  },

  openFile: (path, file) => {
    const existing = get().buffers.find((b) => samePath(b.path, path));
    if (existing) {
      set((state) => ({
        activeBufferId: existing.id,
        buffers: state.buffers.map((b) =>
          b.id === existing.id ? { ...b, usedAt: Date.now() } : b
        ),
      }));
      persist(get());
      return existing.id;
    }

    const buffer = bufferFromFile(path, file);
    set((state) => {
      let buffers = [...state.buffers, buffer];

      // Evict the least recently used clean buffer. A dirty one is never
      // closed to make room — that would discard an edit to save a tab.
      if (buffers.length > MAX_BUFFERS) {
        const evictable = buffers
          .filter((b) => !b.dirty && b.id !== buffer.id)
          .sort((a, b) => a.usedAt - b.usedAt)[0];
        if (evictable) {
          clearDraft(evictable.id);
          buffers = buffers.filter((b) => b.id !== evictable.id);
        }
      }

      return { buffers, activeBufferId: buffer.id };
    });
    persist(get());
    return buffer.id;
  },

  openScratch: (languageId = "plaintext") => {
    const untitled = get().buffers.filter((b) => !b.path).length + 1;
    const buffer: EditorBuffer = {
      id: crypto.randomUUID(),
      path: null,
      name: `Untitled-${untitled}`,
      languageId,
      dirty: false,
      mtime: null,
      encoding: "utf-8",
      lineEnding: "lf",
      readonly: false,
      large: false,
      initialContent: "",
      disk: "ok",
      usedAt: Date.now(),
    };
    set((state) => ({ buffers: [...state.buffers, buffer], activeBufferId: buffer.id }));
    return buffer.id;
  },

  closeBuffer: (id) => {
    clearDraft(id);
    set((state) => {
      const index = state.buffers.findIndex((b) => b.id === id);
      const buffers = state.buffers.filter((b) => b.id !== id);

      // Focus follows the neighbour on the right, then the left — the same rule
      // the terminal tab bar uses.
      let activeBufferId = state.activeBufferId;
      if (state.activeBufferId === id) {
        const next = buffers[Math.min(index, buffers.length - 1)];
        activeBufferId = next ? next.id : null;
      }

      return { buffers, activeBufferId };
    });
    persist(get());
  },

  closeAllBuffers: () => {
    get().buffers.forEach((b) => clearDraft(b.id));
    set({ buffers: [], activeBufferId: null });
    persist(get());
  },

  setActiveBuffer: (id) => {
    set((state) => ({
      activeBufferId: id,
      buffers: state.buffers.map((b) => (b.id === id ? { ...b, usedAt: Date.now() } : b)),
    }));
    persist(get());
  },

  reorderBuffers: (from, to) => {
    set((state) => {
      if (from === to) return state;
      const buffers = [...state.buffers];
      const [moved] = buffers.splice(from, 1);
      if (!moved) return state;
      buffers.splice(to, 0, moved);
      return { buffers };
    });
    persist(get());
  },

  setDirty: (id, dirty) =>
    set((state) => ({
      buffers: state.buffers.map((b) => (b.id === id ? { ...b, dirty } : b)),
    })),

  markSaved: (id, mtime, path) =>
    set((state) => ({
      buffers: state.buffers.map((b) =>
        b.id === id
          ? {
              ...b,
              dirty: false,
              disk: "ok",
              mtime,
              path: path ?? b.path,
              name: path ? basename(path) : b.name,
              languageId: path ? languageFor(path) : b.languageId,
            }
          : b
      ),
    })),

  setDiskState: (id, disk) =>
    set((state) => ({
      buffers: state.buffers.map((b) => (b.id === id ? { ...b, disk } : b)),
    })),

  reloadBuffer: (id, file) =>
    set((state) => ({
      buffers: state.buffers.map((b) =>
        b.id === id
          ? {
              ...b,
              dirty: false,
              disk: "ok",
              mtime: file.mtime,
              encoding: file.encoding,
              lineEnding: file.lineEnding,
              readonly: file.readonly || file.large,
              large: file.large,
              initialContent: file.content,
            }
          : b
      ),
    })),

  setLineEnding: (id, lineEnding) =>
    set((state) => ({
      buffers: state.buffers.map((b) =>
        b.id === id ? { ...b, lineEnding, dirty: true } : b
      ),
    })),

  setEncoding: (id, encoding) =>
    set((state) => ({
      buffers: state.buffers.map((b) => (b.id === id ? { ...b, encoding, dirty: true } : b)),
    })),

  setLanguage: (id, languageId) =>
    set((state) => ({
      buffers: state.buffers.map((b) => (b.id === id ? { ...b, languageId } : b)),
    })),

  setExplorerVisible: (explorerVisible) => {
    set({ explorerVisible });
    persist(get());
  },

  setExplorerWidth: (explorerWidth) => {
    set({ explorerWidth });
    persist(get());
  },

  setPreviewWidth: (previewWidth) => {
    set({ previewWidth });
    persist(get());
  },

  setShowHidden: (showHidden) => {
    set({ showHidden });
    persist(get());
  },

  setDiffLayout: (diffLayout) => {
    set({ diffLayout });
    persist(get());
  },

  setDiffStyle: (diffStyle) => {
    set({ diffStyle });
    persist(get());
  },

  toggleExpanded: (path) => {
    set((state) => ({
      expanded: state.expanded.includes(path)
        ? state.expanded.filter((p) => p !== path)
        : [...state.expanded, path],
    }));
    persist(get());
  },

  collapse: (path) => {
    set((state) => ({ expanded: state.expanded.filter((p) => p !== path) }));
    persist(get());
  },

  collapseAll: () => {
    set({ expanded: [] });
    persist(get());
  },

  bufferFor: (path) => get().buffers.find((b) => samePath(b.path, path)),
  activeBuffer: () => get().buffers.find((b) => b.id === get().activeBufferId),
}));

/** The folder and tabs the last session left open, for restoring on first open. */
export function restorableSession(): {
  root: string | null;
  openPaths: string[];
  activePath: string | null;
} {
  return {
    root: initialRoot,
    openPaths: initialWorkspace?.openPaths ?? [],
    activePath: initialWorkspace?.activePath ?? null,
  };
}
