import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  FolderInput,
  Maximize2,
  Minimize2,
  PanelRight,
  PictureInPicture2,
  Save,
  Search,
  SquareArrowOutUpRight,
  TextSearch,
  X,
} from "lucide-react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, releaseFront } from "../../services/overlay-stack";
import {
  fullscreenRect,
  pictureInPictureRect,
  useDraggableModal,
} from "../../hooks/useDraggableModal";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { useEditorStore, restorableSession } from "../../stores/editorStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import {
  basename,
  dirname,
  FileEncoding,
  formatBytes,
  joinPath,
  LineEnding,
  readTextFile,
  relativeTo,
  revealPath,
  segmentsOf,
  setRoots,
  statPath,
  writeTextFile,
} from "../../services/editor-fs";
import { clearDraft, listDrafts, saveDraft } from "../../services/editor-session";
import { findBySlug, parseOutline } from "../../services/markdown-outline";
import { isLinux } from "../../services/platform";
import { normalizeDir } from "../../services/recent-dirs";
import { EditorSurface, EditorSurfaceHandle } from "./EditorSurface";
import { EditorTabs } from "./EditorTabs";
import { EditorStatusBar } from "./EditorStatusBar";
import { EditorDialog } from "./EditorDialog";
import { ExplorerChange, FileExplorer } from "./FileExplorer";
import { GlobalSearch } from "./GlobalSearch";
import { WorkspacePicker } from "./WorkspacePicker";
import { MarkdownPreview, MarkdownPreviewHandle } from "./MarkdownPreview";
import { QuickOpen } from "./QuickOpen";

/**
 * The embedded code editor.
 *
 * Unlike the browser modal, everything in here is ordinary React in the app's
 * own webview — no native child webview, so no bounds arithmetic, no DPI
 * factor, no hiding the content while the window is dragged, and no
 * platform-specific container. `docs/CODE-EDITOR.md` explains why that
 * difference is the right one.
 *
 * The modal stays mounted while closed, so open tabs, undo history and
 * selections survive being dismissed and reopened. What it gives up by doing
 * that is the file watcher — that's torn down with the modal, so changes made
 * while it was closed are reconciled when it becomes visible again.
 */

const MIN_SIZE = { w: 640, h: 420 };
const MAX_SIZE = { w: 2400, h: 1600 };
const DEFAULT_SIZE = { w: 1080, h: 680 };

const MIN_EXPLORER = 180;
const MAX_EXPLORER = 520;

const MIN_PREVIEW = 240;
const MAX_PREVIEW = 1200;

/** The editor itself never gets dragged narrower than this. */
const MIN_EDITOR = 320;

/** The same idea in picture-in-picture, where there is far less to go round. */
const MIN_PIP_EDITOR = 240;

/** Debounce before a dirty buffer is journalled to storage. */
const JOURNAL_MS = 700;

/** Debounce before the Markdown preview re-renders while typing. */
const PREVIEW_MS = 200;

export interface EditorOpenRequest {
  path: string;
  line?: number;
  column?: number;
  /** Bumped per request, so the same path can be asked for twice. */
  token: number;
}

interface EditorModalProps {
  visible: boolean;
  onClose: () => void;
  /** The focused terminal pane's working directory, if it has one. */
  cwd?: string;
  /** Opens a terminal tab rooted at a directory. */
  onOpenTerminal: (dir: string) => void;
  /** A file the app wants opened — a clicked path in terminal output. */
  openRequest: EditorOpenRequest | null;
}

/**
 * Whether two paths name the same folder.
 *
 * Case-insensitively off Linux, because macOS and Windows match that way — and
 * because the terminal's cwd comes from a scraped prompt, which is often cased
 * differently from the canonical path the backend returns. Getting this wrong
 * means the editor decides it needs to switch workspace on every open, which
 * loops.
 */
function sameFolder(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = normalizeDir(a);
  const right = normalizeDir(b);
  return isLinux ? left === right : left.toLowerCase() === right.toLowerCase();
}

/** A file that can't be edited, shown in place of the editor. */
interface Preview {
  path: string;
  kind: "binary" | "tooLarge";
  size: number;
}

export function EditorModal({
  visible,
  onClose,
  cwd,
  onOpenTerminal,
  openRequest,
}: EditorModalProps) {
  const {
    root,
    workspaces,
    favorites,
    buffers,
    activeBufferId,
    explorerVisible,
    explorerWidth,
    previewWidth,
    showHidden,
    expanded,
    setRoot,
    switchWorkspace,
    removeWorkspace,
    toggleFavorite,
    setRestoring,
    openScratch,
    closeBuffer,
    setActiveBuffer,
    reorderBuffers,
    setDirty,
    markSaved,
    setDiskState,
    reloadBuffer,
    setLineEnding,
    setEncoding,
    setLanguage,
    setExplorerVisible,
    setExplorerWidth,
    setPreviewWidth,
    setShowHidden,
    toggleExpanded,
    collapse,
    collapseAll,
  } = useEditorStore();

  const theme = useThemeStore((s) => s.theme);
  const { settings } = useSettingsStore();

  const [error, setError] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  /**
   * What the right-hand panel is showing.
   *
   * One mode rather than a boolean per panel: they're mutually exclusive, and
   * separate flags would let two of them claim the column at once. The outline
   * used to be a third mode here; it lives inside the preview now, which frees
   * this column for the tree.
   */
  const [sidePanel, setSidePanel] = useState<"files" | "search">("files");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [wrapped, setWrapped] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pipMode, setPipMode] = useState(false);
  /**
   * Keeps this window in front when it's opened or clicked.
   *
   * The value goes on the wrapper below, not on the frame: the wrapper is the
   * positioned element with a z-index, so it creates the stacking context the
   * frame lives in — which is why the editor's picture-in-picture used to sit
   * behind the browser's however high its own z-index was set.
   */
  const [frontZ, setFrontZ] = useState<number | null>(null);
  const raise = useCallback(() => setFrontZ(claimFront("editor")), []);

  /** Non-null only while the side panel's divider is being dragged. */
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  /** Ditto, for the preview's divider. */
  const [previewDragWidth, setPreviewDragWidth] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  /**
   * The Markdown the preview is rendering.
   *
   * CodeMirror owns the live document, so this is a debounced copy pulled from
   * the surface on edit. Rendering straight from every keystroke would re-parse
   * the whole file per character.
   */
  const [previewSource, setPreviewSource] = useState("");
  /**
   * The source line the outline should mark as current.
   *
   * Driven by scrolling rather than by the caret: "where am I in this
   * document" is a question about what's on screen, and the caret is often
   * somewhere else entirely — or off screen — while reading.
   */
  const [outlineLine, setOutlineLine] = useState(1);
  /**
   * Whether the backend has accepted the current root.
   *
   * The store restores `root` from the last session, so on the second launch it
   * is already set when the modal first renders — while `fs_set_roots` has not
   * been called yet, because that happens in an effect. Everything that touches
   * the filesystem is gated on this: without it the explorer's first
   * `fs_list_dir` raced the registration, came back "No workspace is open in
   * the editor", and the tree sat on "Reading…" for the rest of the session.
   */
  const [rootReady, setRootReady] = useState(false);
  const [conflictFor, setConflictFor] = useState<string | null>(null);
  const [closePrompt, setClosePrompt] = useState<string | null>(null);
  const [saveAsFor, setSaveAsFor] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<ReturnType<typeof listDrafts> | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  /** A folder waiting on the user to deal with unsaved files first. */
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<EditorSurfaceHandle>(null);
  const initStarted = useRef(false);
  const sessionRestored = useRef(false);
  const journalTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** Where to put the cursor once the buffer being opened is live. */
  const pendingGoTo = useRef<{ bufferId: string; line: number; column: number } | null>(null);
  const lastRequest = useRef(0);
  /** Tracks the visible transition, so adoption happens on open and only then. */
  const wasVisible = useRef(false);
  /** The folder an open is waiting to adopt, once the root is registered. */
  const pendingAdopt = useRef<string | null>(null);
  /**
   * `openPath`, reachable from callbacks declared above it.
   *
   * `enterWorkspace` has to reopen a workspace's files and is defined before
   * `openPath` for readability; this avoids ordering the two around each other.
   */
  const openPathRef = useRef<((path: string, line?: number, column?: number) => Promise<string | null>) | null>(null);
  /** `reconcile`, likewise reachable from callbacks declared above it. */
  const reconcileRef = useRef<((paths: string[] | null) => Promise<void>) | null>(null);
  /** `goToHeading`, reachable from callbacks declared above it. */
  const goToHeadingRef = useRef<((line: number) => void) | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRef = useRef<MarkdownPreviewHandle>(null);
  /**
   * Which pane is driving the current scroll sync.
   *
   * Scrolling one pane scrolls the other, which fires the other's scroll
   * handler, which would scroll the first back — the two panes fighting each
   * other to a standstill somewhere in the middle. Whoever moved first holds
   * this until the dust settles.
   */
  const scrollOwner = useRef<"editor" | "preview" | null>(null);
  const scrollRelease = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeBuffer = useMemo(
    () => buffers.find((b) => b.id === activeBufferId) ?? null,
    [buffers, activeBufferId]
  );
  const isMarkdown = activeBuffer?.languageId === "markdown";

  const {
    size: modalSize,
    style: modalStyle,
    onDragStart,
    onResizeStart,
    place,
    reset,
  } = useDraggableModal({
    defaultSize: DEFAULT_SIZE,
    minSize: MIN_SIZE,
    maxSize: MAX_SIZE,
    elementRef: modalRef,
  });

  const { change, mechanism } = useFileWatcher(rootReady ? root : null, visible);

  /**
   * What the explorer reacts to.
   *
   * The watcher is one source of "this changed"; an explicit reload is another.
   * Both funnel through here so the explorer has a single input to watch, and
   * a manual refresh doesn't have to pretend to be a filesystem event.
   */
  const [treeChange, setTreeChange] = useState<ExplorerChange>({
    paths: [],
    overflow: false,
    token: 0,
  });

  useEffect(() => {
    if (change.token === 0) return;
    setTreeChange(change);
  }, [change]);

  /** Asks the explorer to re-read every directory it has loaded. */
  const refreshTree = useCallback(() => {
    setTreeChange((prev) => ({ paths: [], overflow: true, token: prev.token + 1 }));
  }, []);

  // --- Roots ---------------------------------------------------------------

  /**
   * Points the editor at a folder.
   *
   * The backend canonicalises it and that canonical form is what's stored, so
   * the explorer, the breadcrumb and every path check agree on the root's name
   * — `/tmp` and `/private/tmp` being the same folder on macOS is exactly the
   * sort of thing that otherwise produces "outside the folders open in the
   * editor" for a file plainly inside the tree.
   */
  const registerRoot = useCallback(async (dir: string) => {
    // Cleared first: while a new root is being registered, the old one is no
    // longer the one the backend will accept.
    setRootReady(false);
    try {
      const canonical = await setRoots([dir]);
      if (canonical.length === 0) {
        setError(`Could not open ${dir}`);
        return null;
      }
      setRootReady(true);
      return canonical[0];
    } catch (e) {
      setError(String(e));
      return null;
    }
  }, []);

  /**
   * Registers a folder and adopts it as the root, without touching tabs.
   *
   * Only the first open uses this — nothing is open yet, so there are no tabs
   * to preserve. Switching folders goes through `enterWorkspace`, which has to
   * move the tabs in the same breath.
   */
  const applyRoot = useCallback(
    async (dir: string) => {
      const canonical = await registerRoot(dir);
      if (canonical) setRoot(canonical);
      return canonical;
    },
    [registerRoot, setRoot]
  );

  /**
   * Opens a folder as the workspace, restoring whatever it had open.
   *
   * Order matters: the backend has to accept the root before any file under it
   * can be read, so the tabs are reopened only after `applyRoot` resolves.
   */
  const enterWorkspace = useCallback(
    async (dir: string) => {
      // `registerRoot`, not `applyRoot`: adopting the root separately would
      // persist the outgoing folder's tabs into the incoming folder's entry
      // before `switchWorkspace` had a chance to move them.
      const canonical = await registerRoot(dir);
      if (!canonical) return;

      // Keyed on the canonical path, since that's what the store records — the
      // path the user picked may be a symlink or differ in case.
      const restore = switchWorkspace(canonical);
      surfaceRef.current?.forgetAll();
      setPreview(null);

      try {
        for (const path of restore.openPaths.slice(0, 12)) {
          // Files deleted or moved since the folder was last open are skipped
          // rather than reported: a restored workspace shouldn't greet you with
          // a stack of errors about last week's branch.
          await openPathRef.current?.(path).catch(() => null);
        }
        if (restore.activePath) {
          const buffer = useEditorStore.getState().bufferFor(restore.activePath);
          if (buffer) useEditorStore.getState().setActiveBuffer(buffer.id);
        }
      } finally {
        // Released even if a file threw, or the workspace's tab list would stay
        // frozen for the rest of the session.
        setRestoring(false);
      }
    },
    [registerRoot, switchWorkspace, setRestoring]
  );

  /**
   * Switching folders throws away the current tabs, so unsaved ones are dealt
   * with first. Drafts are journalled either way, but silently dropping a tab
   * someone was editing is not something to do on a menu click.
   */
  const requestWorkspace = useCallback(
    (dir: string, force = false) => {
      // Re-opening the folder already open would discard its tabs to restore
      // the same ones; "Reload" passes `force` to ask for that on purpose.
      if (dir === root && !force) return;
      if (useEditorStore.getState().buffers.some((buffer) => buffer.dirty)) {
        setPendingWorkspace(dir);
        return;
      }
      void enterWorkspace(dir);
    },
    [root, enterWorkspace]
  );

  /**
   * Re-reads the open folder from disk, keeping the tabs.
   *
   * It used to switch to the folder it was already on, which cycled the tabs
   * through close-and-reopen — losing undo history, cursors and folds to
   * arrive back where it started, and looking from the outside like the editor
   * had just emptied itself. What "reload" should mean is: re-read the tree,
   * and re-check the open files against disk.
   */
  const reloadWorkspace = useCallback(() => {
    if (!root) return;
    void (async () => {
      const canonical = await registerRoot(root);
      if (!canonical) return;
      refreshTree();
      await reconcileRef.current?.(null);
    })();
  }, [root, registerRoot, refreshTree]);

  const browseForWorkspace = useCallback(() => {
    void (async () => {
      try {
        const picked = await openFolderDialog({
          directory: true,
          multiple: false,
          title: "Open folder in the editor",
          defaultPath: root ?? undefined,
        });
        if (typeof picked === "string") requestWorkspace(picked);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [root, requestWorkspace]);

  const openPath = useCallback(
    async (path: string, line?: number, column?: number) => {
      const state = useEditorStore.getState();

      const existing = state.bufferFor(path);
      if (existing) {
        state.setActiveBuffer(existing.id);
        setPreview(null);
        if (line) pendingGoTo.current = { bufferId: existing.id, line, column: column ?? 1 };
        return existing.id;
      }

      try {
        const file = await readTextFile(path);

        if (file.kind === "missing") {
          // A file that has been deleted or moved. Said plainly, rather than
          // relaying the platform's `No such file or directory (os error 2)`.
          setError(
            `${basename(path)} could not be opened because the file was not found.`
          );
          return null;
        }

        if (file.kind !== "text") {
          // Nothing is loaded into the editor blind: a binary gets a card
          // saying what it is, with a way out to the file manager.
          setPreview({
            path,
            kind: file.kind === "binary" ? "binary" : "tooLarge",
            size: file.size,
          });
          return null;
        }
        const id = state.openFile(path, file);
        setPreview(null);
        if (line) pendingGoTo.current = { bufferId: id, line, column: column ?? 1 };
        return id;
      } catch (e) {
        // Names the file first: the backend's message is about a path, and on
        // its own it doesn't say which of your tabs or clicks caused it.
        setError(`${basename(path)} could not be opened — ${e}`);
        return null;
      }
    },
    []
  );

  openPathRef.current = openPath;

  /**
   * First open: establish a root, then put back the tabs from last time.
   *
   * The root is whatever was open before, else the focused pane's directory,
   * else home — so opening the editor from a shell sitting in a project lands
   * on that project.
   */
  useEffect(() => {
    if (!visible || initStarted.current) return;
    initStarted.current = true;

    let cancelled = false;
    void (async () => {
      // The focused pane's folder wins over the last session's: opening the
      // editor from a shell sitting in a project should land on that project.
      let desired = cwd ?? root ?? null;
      if (!desired) {
        desired = await invoke<string>("get_home_dir").catch(() => null);
      }
      if (!desired || cancelled) return;

      // Held across the restore for the same reason a switch holds it: an
      // empty tab strip mid-restore must not overwrite the folder's remembered
      // tab list.
      setRestoring(true);
      const canonical = await applyRoot(desired);
      if (!canonical) {
        setRestoring(false);
        // Unlatched, so reopening the editor tries again rather than leaving it
        // permanently rootless with an error nobody can act on.
        initStarted.current = false;
        return;
      }
      if (cancelled || sessionRestored.current) {
        setRestoring(false);
        return;
      }
      sessionRestored.current = true;

      const previous = restorableSession();
      // Files that have since been deleted or moved out of the root are
      // skipped silently — a restored session shouldn't open with a stack of
      // errors about last week's branch.
      for (const path of previous.openPaths.slice(0, 12)) {
        if (cancelled) return;
        await openPath(path).catch(() => null);
      }
      if (previous.activePath && !cancelled) {
        const buffer = useEditorStore.getState().bufferFor(previous.activePath);
        if (buffer) useEditorStore.getState().setActiveBuffer(buffer.id);
      }

      setRestoring(false);

      const drafts = listDrafts();
      if (drafts.length > 0 && !cancelled) setDraftPrompt(drafts);
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, root, cwd, applyRoot, openPath, setRestoring]);

  /**
   * Opening the editor adopts the focused pane's folder as the workspace.
   *
   * Only on the transition to visible, never while it's open: a long-running
   * command that `cd`s the shell must not pull the workspace out from under
   * someone mid-edit. `pendingAdopt` carries the folder across the wait for
   * the root to be registered, which on a first open has not happened yet.
   */
  useEffect(() => {
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (opening && cwd) pendingAdopt.current = cwd;
  }, [visible, cwd]);

  useEffect(() => {
    if (!visible || !rootReady || !root) return;
    const target = pendingAdopt.current;
    if (!target) return;
    // Cleared before the switch, not after: a cancelled switch must not be
    // retried on the next render.
    pendingAdopt.current = null;
    if (sameFolder(target, root)) return;
    requestWorkspace(target);
  }, [visible, rootReady, root, cwd, requestWorkspace]);

  // --- Opening files -------------------------------------------------------

  /**
   * A path handed over from outside — a clicked path in terminal output.
   *
   * The request isn't marked consumed until it can actually be acted on. The
   * app opens the editor and sets the request in the same update, so on the
   * first render the modal may still be invisible and rootless; swallowing the
   * request there would lose the file the user clicked.
   */
  useEffect(() => {
    if (!openRequest || !visible || !root || !rootReady) return;
    if (openRequest.token === lastRequest.current) return;
    lastRequest.current = openRequest.token;
    void openPath(openRequest.path, openRequest.line, openRequest.column);
  }, [openRequest, visible, root, rootReady, openPath]);

  /**
   * Reads the newly activated buffer's cursor into the status bar.
   *
   * Each tab keeps its own cursor, selection and scroll offset in its own
   * CodeMirror state; this is what makes the status bar agree. It retries for
   * a few frames because a buffer's state is built asynchronously — without
   * that, switching tabs left the previous tab's line number on screen.
   */
  useEffect(() => {
    if (!activeBufferId) {
      setCursor({ line: 1, column: 1 });
      return;
    }

    let frames = 0;
    let raf = 0;
    const attempt = () => {
      const position = surfaceRef.current?.getCursor(activeBufferId);
      if (position) {
        setCursor(position);
        return;
      }
      if (frames++ < 60) raf = requestAnimationFrame(attempt);
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [activeBufferId, buffers.length]);

  /**
   * Applies a queued cursor move once the buffer is actually live.
   *
   * A buffer's CodeMirror state is built asynchronously — its grammar is a
   * dynamic import — so "open this file at line 40" can't just call `goTo`
   * after activating the tab; there is nothing to move the cursor in yet.
   */
  useEffect(() => {
    const target = pendingGoTo.current;
    if (!target || target.bufferId !== activeBufferId) return;

    let frames = 0;
    let raf = 0;
    const attempt = () => {
      const surface = surfaceRef.current;
      if (surface?.getContent(target.bufferId) !== null && surface) {
        pendingGoTo.current = null;
        surface.goTo(target.line, target.column);
        return;
      }
      if (frames++ < 60) raf = requestAnimationFrame(attempt);
      else pendingGoTo.current = null;
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [activeBufferId, buffers.length]);

  // --- Saving --------------------------------------------------------------

  const journalNow = useCallback((bufferId: string) => {
    const buffer = useEditorStore.getState().buffers.find((b) => b.id === bufferId);
    const content = surfaceRef.current?.getContent(bufferId);
    if (!buffer || content === null || content === undefined) return;

    if (!buffer.dirty) {
      clearDraft(bufferId);
      return;
    }
    saveDraft(bufferId, {
      path: buffer.path,
      name: buffer.name,
      languageId: buffer.languageId,
      content,
      mtime: buffer.mtime,
      savedAt: Date.now(),
    });
  }, []);

  const saveBuffer = useCallback(
    async (bufferId: string, options?: { force?: boolean }): Promise<boolean> => {
      const buffer = useEditorStore.getState().buffers.find((b) => b.id === bufferId);
      const content = surfaceRef.current?.getContent(bufferId);
      if (!buffer || content === null || content === undefined) return false;

      if (!buffer.path) {
        setSaveAsFor(bufferId);
        return false;
      }
      if (buffer.readonly) {
        setError(`${buffer.name} is read-only`);
        return false;
      }

      try {
        const outcome = await writeTextFile(
          buffer.path,
          content,
          buffer.encoding,
          buffer.lineEnding,
          // Forcing means the user has already been asked and chose to
          // overwrite; the check is skipped rather than repeated.
          options?.force ? null : buffer.mtime
        );

        if (outcome.status === "conflict") {
          setDiskState(bufferId, "changed");
          setConflictFor(bufferId);
          return false;
        }

        markSaved(bufferId, outcome.mtime);
        surfaceRef.current?.markSaved(bufferId);
        clearDraft(bufferId);
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      }
    },
    [markSaved, setDiskState]
  );

  const saveActive = useCallback(() => {
    if (activeBufferId) void saveBuffer(activeBufferId);
  }, [activeBufferId, saveBuffer]);

  const saveAll = useCallback(() => {
    void (async () => {
      for (const buffer of useEditorStore.getState().buffers) {
        if (buffer.dirty && buffer.path) await saveBuffer(buffer.id);
      }
    })();
  }, [saveBuffer]);

  /** Gives a scratch buffer a name, then saves it. */
  const saveAs = useCallback(
    async (bufferId: string, name: string) => {
      setSaveAsFor(null);
      const trimmed = name.trim();
      if (!trimmed || !root) return;

      const buffer = useEditorStore.getState().buffers.find((b) => b.id === bufferId);
      const content = surfaceRef.current?.getContent(bufferId);
      if (!buffer || content === null || content === undefined) return;

      const path = joinPath(root, trimmed);
      try {
        const outcome = await writeTextFile(
          path,
          content,
          buffer.encoding,
          buffer.lineEnding,
          // A file being created can't have changed underneath us, and if
          // something is already there the create is the surprise — which the
          // backend reports rather than this silently overwriting it.
          null
        );
        markSaved(bufferId, outcome.mtime, path);
        surfaceRef.current?.markSaved(bufferId);
        clearDraft(bufferId);
      } catch (e) {
        setError(String(e));
      }
    },
    [root, markSaved]
  );

  const reloadFromDisk = useCallback(
    async (bufferId: string) => {
      const buffer = useEditorStore.getState().buffers.find((b) => b.id === bufferId);
      if (!buffer?.path) return;
      try {
        const file = await readTextFile(buffer.path);
        if (file.kind === "missing") {
          setDiskState(bufferId, "missing");
          return;
        }
        if (file.kind !== "text") return;
        reloadBuffer(bufferId, file);
        surfaceRef.current?.setContent(bufferId, file.content);
        clearDraft(bufferId);
      } catch (e) {
        setError(String(e));
      }
    },
    [reloadBuffer, setDiskState]
  );

  // --- Reconciling with the disk -------------------------------------------

  /**
   * Checks open buffers against the disk.
   *
   * A clean buffer is reloaded without asking — that's what the user wants when
   * they switch branches with a file open. A dirty one is only *flagged*:
   * throwing away an unsaved edit is never something to do automatically, so it
   * becomes a conflict the save path will refuse until the user decides.
   */
  const reconcile = useCallback(
    async (paths: string[] | null) => {
      const state = useEditorStore.getState();
      const changed = paths
        ? new Set(paths.map((p) => (isLinux ? p : p.toLowerCase())))
        : null;

      for (const buffer of state.buffers) {
        if (!buffer.path) continue;
        const key = isLinux ? buffer.path : buffer.path.toLowerCase();
        if (changed && !changed.has(key)) continue;

        try {
          const stat = await statPath(buffer.path);
          if (stat.mtime === buffer.mtime) continue;

          if (buffer.dirty) {
            state.setDiskState(buffer.id, "changed");
          } else {
            const file = await readTextFile(buffer.path);
            if (file.kind !== "text") continue;
            state.reloadBuffer(buffer.id, file);
            surfaceRef.current?.setContent(buffer.id, file.content);
          }
        } catch {
          /*
            The file can't be read at all — deleted, renamed, or moved out of
            the workspace. Flagged rather than closed: the buffer's contents may
            now be the only remaining copy, and saving it recreates the file.
          */
          state.setDiskState(buffer.id, "missing");
        }
      }
    },
    []
  );

  reconcileRef.current = reconcile;

  useEffect(() => {
    if (!visible || change.token === 0) return;
    void reconcile(change.overflow ? null : change.paths);
    // Keyed on the token so this fires once per burst.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change.token, visible]);

  /** Anything that happened while the editor was closed and unwatched. */
  useEffect(() => {
    if (!visible || !rootReady) return;
    void reconcile(null);
    surfaceRef.current?.refresh();
  }, [visible, rootReady, reconcile]);

  useEffect(() => {
    if (visible) {
      raise();
      return;
    }
    /*
      Released on close. It matters more than it looks: the editor stays mounted
      when dismissed, so without this its claim stayed on top of the stack and
      the browser — which hides its native page whenever something is in front
      of it — stayed blanked behind a window that was no longer there.
    */
    releaseFront("editor");
    setFrontZ(null);
  }, [visible, pipMode, raise]);

  // --- Closing tabs --------------------------------------------------------

  const requestCloseBuffer = useCallback(
    (bufferId: string) => {
      const buffer = useEditorStore.getState().buffers.find((b) => b.id === bufferId);
      if (!buffer) return;
      if (buffer.dirty) {
        setClosePrompt(bufferId);
        return;
      }
      surfaceRef.current?.forget(bufferId);
      closeBuffer(bufferId);
    },
    [closeBuffer]
  );

  const closeAfterPrompt = useCallback(
    (bufferId: string) => {
      setClosePrompt(null);
      surfaceRef.current?.forget(bufferId);
      closeBuffer(bufferId);
    },
    [closeBuffer]
  );

  // --- Terminal integration ------------------------------------------------

  const openTerminalAt = useCallback(
    (dir: string) => {
      onOpenTerminal(dir);
      onClose();
    },
    [onOpenTerminal, onClose]
  );

  // --- Explorer sizing -----------------------------------------------------

  /**
   * Drags a divider for one of the right-hand panes.
   *
   * Both panes sit to the right of the editor, so dragging left widens them.
   * The live width is local state and only committed to the store on release:
   * the store persists to `localStorage`, and writing that on every pointer
   * move would put a synchronous storage write in the middle of a drag.
   */
  const startPaneResize = useCallback(
    (
      e: React.PointerEvent,
      pane: {
        width: number;
        min: number;
        max: number;
        onDrag: (width: number | null) => void;
        onCommit: (width: number) => void;
      }
    ) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      let latest = pane.width;

      const onMove = (ev: PointerEvent) => {
        const next = pane.width - (ev.clientX - startX);
        latest = Math.min(pane.max, Math.max(pane.min, next));
        pane.onDrag(latest);
      };
      const onUp = () => {
        pane.onDrag(null);
        pane.onCommit(latest);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    []
  );

  /**
   * How wide a pane may get, given what else is on screen.
   *
   * The panes are fixed-width and the editor takes the rest, so without this a
   * wide drag squeezes the editor to nothing — `flex-1 min-w-0` shrinks all the
   * way to zero rather than pushing back.
   */
  const paneLimit = useCallback(
    (hardMax: number, otherPane: number) =>
      Math.max(MIN_EXPLORER, Math.min(hardMax, modalSize.w - otherPane - MIN_EDITOR)),
    [modalSize.w]
  );

  const startExplorerResize = useCallback(
    (e: React.PointerEvent) =>
      startPaneResize(e, {
        width: explorerWidth,
        min: MIN_EXPLORER,
        max: paneLimit(MAX_EXPLORER, previewOpen && isMarkdown ? previewWidth : 0),
        onDrag: setDragWidth,
        onCommit: setExplorerWidth,
      }),
    [startPaneResize, explorerWidth, setExplorerWidth, paneLimit, previewOpen, isMarkdown, previewWidth]
  );

  const startPreviewResize = useCallback(
    (e: React.PointerEvent) =>
      startPaneResize(e, {
        width: previewWidth,
        min: MIN_PREVIEW,
        max: paneLimit(MAX_PREVIEW, explorerVisible ? explorerWidth : 0),
        onDrag: setPreviewDragWidth,
        onCommit: setPreviewWidth,
      }),
    [startPaneResize, previewWidth, setPreviewWidth, paneLimit, explorerVisible, explorerWidth]
  );

  const toggleFullscreen = useCallback(() => {
    setPipMode(false);
    setFullscreen((prev) => {
      if (prev) {
        reset();
      } else {
        const rect = fullscreenRect();
        place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
      }
      return !prev;
    });
  }, [place, reset]);

  /**
   * Picture-in-picture: a small, always-on-top editor with no backdrop.
   *
   * It parks bottom-right, out of the way of a shell being typed into, which is
   * the case it exists for — keeping a file in view while working in the
   * terminal. The side panel and the preview are left out at this size rather
   * than squeezed: two 260px panes in a 560px window would leave no editor.
   */
  const togglePip = useCallback(() => {
    setFullscreen(false);
    setPipMode((prev) => {
      if (prev) {
        reset();
      } else {
        const rect = pictureInPictureRect();
        place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
      }
      return !prev;
    });
  }, [place, reset]);

  const panelShown = explorerVisible;
  const previewShown = previewOpen && isMarkdown;

  /**
   * A pane's width as the layout should use it.
   *
   * In picture-in-picture the whole window is 560px, so a 260px tree plus a
   * 420px preview would leave the editor at nothing — the panes are narrowed to
   * fit instead of being hidden. Hiding them was the first attempt and it made
   * the tree's toggle look broken: pressing it changed a flag that the layout
   * then ignored.
   */
  const paneWidth = useCallback(
    (width: number) =>
      pipMode ? Math.min(width, Math.max(140, modalSize.w - MIN_PIP_EDITOR)) : width,
    [pipMode, modalSize.w]
  );

  /** Keeps a fullscreen modal the size of the window it's filling. */
  useEffect(() => {
    if (!fullscreen) return;
    const follow = () => {
      const rect = fullscreenRect();
      place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
    };
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [fullscreen, place]);

  // --- Editing callbacks ---------------------------------------------------

  /**
   * Pulls the text the preview should render.
   *
   * The live CodeMirror document is the truth once it exists — but a buffer
   * that has just been opened doesn't have one yet: its state is built
   * asynchronously because the grammar is a dynamic import. Reading it too
   * early returned nothing, so following a link to another Markdown file
   * previewed it as "Nothing to preview yet" and stayed that way until the next
   * edit or tab switch.
   *
   * The store's loaded text covers exactly that gap, and for a file this new it
   * *is* the document.
   */
  const refreshPreview = useCallback(() => {
    const state = useEditorStore.getState();
    const id = state.activeBufferId;
    if (!id) {
      setPreviewSource("");
      return;
    }

    const live = surfaceRef.current?.getContent(id);
    if (live !== null && live !== undefined) {
      setPreviewSource(live);
      return;
    }
    setPreviewSource(state.buffers.find((buffer) => buffer.id === id)?.initialContent ?? "");
  }, []);

  /** Whether anything on screen is rendering the Markdown text. */
  const markdownShown = isMarkdown && previewOpen;

  // Switching tabs, or opening either view, needs a full read; typing is
  // handled by the debounce in `onEdited`.
  useEffect(() => {
    if (!markdownShown) return;
    refreshPreview();
  }, [markdownShown, activeBufferId, refreshPreview]);

  // A preview left open is meaningless once the active tab is source code, so
  // it closes rather than showing a stale document.
  useEffect(() => {
    if (!activeBuffer || isMarkdown || !previewOpen) return;
    setPreviewOpen(false);
  }, [activeBuffer, isMarkdown, previewOpen]);

  const onEdited = useCallback(
    (bufferId: string) => {
      if (markdownShown && bufferId === activeBufferId) {
        if (previewTimer.current) clearTimeout(previewTimer.current);
        previewTimer.current = setTimeout(refreshPreview, PREVIEW_MS);
      }

      const timers = journalTimers.current;
      const existing = timers.get(bufferId);
      if (existing) clearTimeout(existing);
      timers.set(
        bufferId,
        setTimeout(() => {
          timers.delete(bufferId);
          journalNow(bufferId);
        }, JOURNAL_MS)
      );
    },
    [journalNow, markdownShown, activeBufferId, refreshPreview]
  );

  const onCursorChange = useCallback((line: number, column: number) => {
    setCursor({ line, column });
  }, []);

  useEffect(() => {
    return () => {
      journalTimers.current.forEach((timer) => clearTimeout(timer));
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, []);

  /** Recovers journalled drafts from a session that ended badly. */
  const restoreDrafts = useCallback(
    async (drafts: ReturnType<typeof listDrafts>) => {
      setDraftPrompt(null);
      for (const { id, draft } of drafts) {
        if (draft.path) {
          const bufferId = await openPath(draft.path);
          if (bufferId) {
            // `clean: false` — the draft differs from disk deliberately, so the
            // buffer has to come back dirty and saveable.
            surfaceRef.current?.setContent(bufferId, draft.content, { clean: false });
            setDirty(bufferId, true);
          }
          clearDraft(id);
        } else {
          const bufferId = openScratch(draft.languageId);
          surfaceRef.current?.setContent(bufferId, draft.content, { clean: false });
          setDirty(bufferId, true);
          clearDraft(id);
        }
      }
    },
    [openPath, openScratch, setDirty]
  );

  /**
   * Follows a link clicked in the preview.
   *
   * Three kinds, and the two that matter here are the ones a browser can't
   * help with:
   *
   * - `#anchor` scrolls to that heading, matched the way GitHub slugifies them,
   *   so a hand-written table of contents in the document works.
   * - A path opens that file in the editor, resolved against the folder the
   *   current file is in — which is what makes `../README.md` mean what it says.
   *   The backend canonicalises, so `..` needs no handling here, and the
   *   workspace check still applies: a link out of the open folder is refused
   *   rather than followed.
   *
   * `http(s)` never reaches this — `Markdown` sends those to the system browser.
   */
  const followMarkdownLink = useCallback(
    (href: string) => {
      const decoded = (() => {
        try {
          // Spaces in a path arrive percent-encoded.
          return decodeURIComponent(href);
        } catch {
          return href;
        }
      })();

      if (decoded.startsWith("#")) {
        const heading = findBySlug(parseOutline(previewSource), decoded);
        if (heading) goToHeadingRef.current?.(heading.line);
        else setError(`No heading matches ${decoded}`);
        return;
      }

      const buffer = useEditorStore.getState().activeBuffer();
      if (!buffer?.path) return;

      // An anchor on a file link is dropped: the target's headings aren't known
      // until it's open, and opening it is the useful half.
      const [target] = decoded.split("#");
      if (!target) return;

      const absolute = /^([A-Za-z]:[\\/]|[\\/]|~)/.test(target)
        ? target
        : joinPath(dirname(buffer.path), target);
      void openPathRef.current?.(absolute);
    },
    [previewSource]
  );

  /** Holds the sync lock briefly, so the echo from the other pane is ignored. */
  const holdScroll = useCallback((owner: "editor" | "preview") => {
    scrollOwner.current = owner;
    if (scrollRelease.current) clearTimeout(scrollRelease.current);
    // Long enough to cover the other pane's scroll event and the frame it is
    // coalesced into; short enough that taking over the other pane feels
    // immediate.
    scrollRelease.current = setTimeout(() => {
      scrollOwner.current = null;
    }, 150);
  }, []);

  const onEditorScrollLine = useCallback(
    (line: number) => {
      setOutlineLine(line);
      if (!previewOpen || scrollOwner.current === "preview") return;
      holdScroll("editor");
      previewRef.current?.scrollToLine(line);
    },
    [previewOpen, holdScroll]
  );

  const onPreviewScrollLine = useCallback(
    (line: number) => {
      setOutlineLine(line);
      if (scrollOwner.current === "editor") return;
      holdScroll("preview");
      surfaceRef.current?.scrollToLine(line);
    },
    [holdScroll]
  );

  useEffect(
    () => () => {
      if (scrollRelease.current) clearTimeout(scrollRelease.current);
    },
    []
  );

  /**
   * Jumps to a heading picked in the outline.
   *
   * Both views move: the editor's cursor, and the preview if it's open. Which
   * one the user is looking at depends on what they're doing, and moving only
   * one of them leaves the other visibly out of step.
   */
  const goToHeading = useCallback(
    (line: number) => {
      holdScroll("editor");
      setOutlineLine(line);
      surfaceRef.current?.goTo(line);
      previewRef.current?.scrollToLine(line, true);
    },
    [holdScroll]
  );

  goToHeadingRef.current = goToHeading;

  // --- Keyboard ------------------------------------------------------------

  /**
   * The editor's own chords.
   *
   * Propagation is stopped per chord, never up front. Swallowing everything
   * meant that with the editor open none of the app's shortcuts worked — ⌘T
   * opened no terminal tab, because the chord died here before reaching the
   * window handler in `AppShell`. The same mistake was in the browser modal.
   *
   * Plain keystrokes are let through untouched: every app shortcut requires a
   * modifier, so typing into the editor can't trigger one.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // CodeMirror's keymap runs first and marks what it consumed. Stopping
      // here as well keeps ⌘S from saving twice and ⌘P from toggling quick
      // open open-then-closed.
      if (e.defaultPrevented) {
        e.stopPropagation();
        return;
      }

      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (quickOpen) setQuickOpen(false);
        // Search and the outline step back to the tree before Escape closes
        // the whole editor.
        else if (sidePanel !== "files") setSidePanel("files");
        else onClose();
        return;
      }

      if (!mod) return;

      /** Marks a chord as the editor's, so it goes no further. */
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      switch (e.key.toLowerCase()) {
        case "s":
          claim();
          if (e.altKey) saveAll();
          else saveActive();
          break;
        case "p":
          claim();
          setQuickOpen(true);
          break;
        case "f":
          if (e.shiftKey) {
            claim();
            setSidePanel("search");
            setExplorerVisible(true);
          }
          break;
        case "b":
          claim();
          setExplorerVisible(!explorerVisible);
          break;
        case "w":
          claim();
          if (activeBufferId) requestCloseBuffer(activeBufferId);
          break;
        default:
          // Not ours — ⌘T, ⌘⇧M and the rest reach the app as usual.
          break;
      }
    },
    [
      quickOpen,
      sidePanel,
      onClose,
      saveAll,
      saveActive,
      explorerVisible,
      setExplorerVisible,
      activeBufferId,
      requestCloseBuffer,
    ]
  );

  // --- Breadcrumb ----------------------------------------------------------

  const crumbs = useMemo(() => {
    if (!activeBuffer?.path || !root) return [];
    const relative = relativeTo(root, activeBuffer.path);
    const parts = segmentsOf(relative);
    let walked = root;
    return parts.map((part, index) => {
      walked = joinPath(walked, part);
      return { label: part, path: walked, isLast: index === parts.length - 1 };
    });
  }, [activeBuffer?.path, root]);

  /** Expands the explorer down to a directory, so a crumb click reveals it. */
  const revealInTree = useCallback(
    (path: string) => {
      if (!root) return;
      setExplorerVisible(true);
      setSidePanel("files");
      const relative = relativeTo(root, path);
      let walked = root;
      for (const part of segmentsOf(relative)) {
        walked = joinPath(walked, part);
        // Read fresh each time: `toggleExpanded` has already changed the list
        // by the second iteration, and a stale copy would collapse the
        // directory it had just expanded.
        const state = useEditorStore.getState();
        if (!state.expanded.includes(walked)) state.toggleExpanded(walked);
      }
    },
    [root, setExplorerVisible]
  );

  const terminalFolderDiffers = !!cwd && !!root && cwd !== root;

  const conflictBuffer = conflictFor
    ? buffers.find((b) => b.id === conflictFor) ?? null
    : null;
  const closeBufferTarget = closePrompt
    ? buffers.find((b) => b.id === closePrompt) ?? null
    : null;
  const saveAsBuffer = saveAsFor ? buffers.find((b) => b.id === saveAsFor) ?? null : null;

  return (
    <OverlayPortal>
      {/*
        `visible` toggles the display utility rather than the `hidden`
        attribute. Tailwind's preflight sets `[hidden] { display: none }` with
        no `!important`, and `.flex` has the same specificity but comes later in
        the stylesheet — so `hidden` lost to `display: flex` and the modal never
        went away. Closing it looked like a dead button.
      */}
      <div
        className={`fixed inset-0 z-[240] items-start justify-center pt-[4vh] ${
          visible ? "flex" : "hidden"
        } ${pipMode ? "editor-backdrop-pip" : ""}`}
        style={{ zIndex: frontZ ?? undefined }}
        onPointerDownCapture={raise}
        /*
          Clicking outside hides the editor, as the other overlays do. Nothing
          is lost by it: the modal stays mounted, so buffers, undo history and
          selections are all still there when it reopens, and dirty buffers are
          journalled to storage regardless. In picture-in-picture there is no
          backdrop to click — the class below makes it click-through.
        */
        onMouseDown={(e) => {
          if (!pipMode && e.target === e.currentTarget) onClose();
        }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <div
          ref={modalRef}
          className={`editor-modal overflow-hidden shadow-2xl flex flex-col ${
            pipMode ? "editor-pip" : ""
          } ${fullscreen ? "editor-fullscreen" : "rounded-xl"}`}
          style={modalStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Tab strip, doubling as the drag handle */}
          <div className="flex items-stretch editor-chrome">
            <div
              className="editor-brand editor-tabstrip flex items-center gap-2 pl-3 pr-2.5 shrink-0 cursor-grab active:cursor-grabbing"
              onPointerDown={onDragStart}
            >
              <img src="/logo.png" alt="" className="h-3.5 w-auto shrink-0" />
              <span className="editor-brand-title text-[11px] font-semibold whitespace-nowrap">
                Code Editor
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <EditorTabs
                buffers={buffers}
                activeBufferId={activeBufferId}
                onSelect={setActiveBuffer}
                onClose={requestCloseBuffer}
                onNewScratch={() => openScratch()}
                onReorder={reorderBuffers}
                onDragHandle={onDragStart}
              />
            </div>
            <div className="flex items-center gap-0.5 px-2 shrink-0 editor-tabstrip">
              <button
                className={`editor-btn p-1 rounded ${pipMode ? "on" : ""}`}
                onClick={togglePip}
                title={pipMode ? "Exit picture-in-picture" : "Picture-in-picture"}
                aria-label={pipMode ? "Exit picture-in-picture" : "Picture-in-picture"}
              >
                <PictureInPicture2 size={12} />
              </button>
              <button
                className={`editor-btn p-1 rounded ${fullscreen ? "on" : ""}`}
                onClick={toggleFullscreen}
                title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
              <button
                className="editor-btn editor-btn-close p-1 rounded"
                onClick={onClose}
                title="Close editor"
                aria-label="Close editor"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Breadcrumb / toolbar */}
          <div className="editor-chrome editor-toolbar flex items-center gap-1 px-2 py-1">
            <button
              className="editor-btn p-1 rounded"
              onClick={() => {
                const index = buffers.findIndex((b) => b.id === activeBufferId);
                if (index > 0) setActiveBuffer(buffers[index - 1].id);
              }}
              disabled={buffers.findIndex((b) => b.id === activeBufferId) <= 0}
              title="Previous file"
              aria-label="Previous file"
            >
              <ArrowLeft size={13} />
            </button>
            <button
              className="editor-btn p-1 rounded"
              onClick={() => {
                const index = buffers.findIndex((b) => b.id === activeBufferId);
                if (index >= 0 && index < buffers.length - 1) {
                  setActiveBuffer(buffers[index + 1].id);
                }
              }}
              disabled={
                buffers.findIndex((b) => b.id === activeBufferId) >= buffers.length - 1
              }
              title="Next file"
              aria-label="Next file"
            >
              <ArrowRight size={13} />
            </button>

            <div className="editor-breadcrumb flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden px-1">
              {root && (
                <button
                  className={`editor-crumb editor-crumb-root shrink-0 ${
                    workspaceMenuOpen ? "open" : ""
                  }`}
                  onClick={() => setWorkspaceMenuOpen(true)}
                  title={`${root} — click to switch workspace`}
                  aria-haspopup="dialog"
                >
                  <span className="truncate">{basename(root) || root}</span>
                  <ChevronDown size={10} className="shrink-0 opacity-60" />
                </button>
              )}
              {crumbs.map((crumb) => (
                <span key={crumb.path} className="flex items-center gap-0.5 min-w-0">
                  <ChevronRight size={11} className="editor-crumb-sep shrink-0" />
                  <button
                    className={`editor-crumb truncate ${crumb.isLast ? "current" : ""}`}
                    onClick={() =>
                      revealInTree(crumb.isLast ? dirname(crumb.path) : crumb.path)
                    }
                    title={crumb.path}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </div>

            {terminalFolderDiffers && (
              <button
                className="editor-btn-text flex items-center gap-1 px-1.5 py-0.5 rounded shrink-0"
                onClick={() => cwd && requestWorkspace(cwd)}
                title={`Open the focused terminal's folder — ${cwd}`}
              >
                <FolderInput size={12} />
                <span className="text-[10px]">{basename(cwd!)}</span>
              </button>
            )}

            {activeBuffer && (
              <>
                <button
                  className="editor-btn p-1 rounded"
                  onClick={saveActive}
                  disabled={!activeBuffer.dirty || activeBuffer.readonly}
                  title="Save (⌘S)"
                  aria-label="Save"
                >
                  <Save size={13} />
                </button>
                {/*
                  Labelled, not just an icon: it was an unmarked eye among six
                  other glyphs, which is not discoverable for the one action a
                  Markdown file is most often opened for.
                */}
                {isMarkdown && (
                  <button
                    className={`editor-btn-text flex items-center gap-1.5 px-2 py-1 rounded shrink-0 ${
                      previewOpen ? "on" : ""
                    }`}
                    // The outline rides inside the preview now, so opening one
                    // brings the other with no panel juggling.
                    onClick={() => setPreviewOpen((open) => !open)}
                    title={previewOpen ? "Hide the Markdown preview" : "Preview Markdown"}
                    aria-pressed={previewOpen}
                  >
                    <Eye size={12} />
                    <span className="text-[10px]">Preview</span>
                  </button>
                )}
              </>
            )}

            <button
              className="editor-btn p-1 rounded"
              onClick={() => setQuickOpen(true)}
              title="Go to file (⌘P)"
              aria-label="Go to file"
            >
              <Search size={13} />
            </button>
            <button
              className={`editor-btn p-1 rounded ${sidePanel === "search" ? "on" : ""}`}
              onClick={() => {
                setSidePanel((mode) => (mode === "search" ? "files" : "search"));
                setExplorerVisible(true);
              }}
              title="Search in folder (⌘⇧F)"
              aria-label="Search in folder"
            >
              <TextSearch size={13} />
            </button>
            <button
              className={`editor-btn p-1 rounded ${explorerVisible ? "on" : ""}`}
              onClick={() => setExplorerVisible(!explorerVisible)}
              title="Toggle the file tree (⌘B)"
              aria-label="Toggle the file tree"
            >
              <PanelRight size={13} />
            </button>
          </div>

          {error && (
            <div className="editor-error flex items-center gap-2 px-3 py-1.5 text-[11px]">
              <CircleAlert size={12} className="shrink-0" />
              <span className="flex-1 truncate">{error}</span>
              <button className="editor-btn p-0.5 rounded shrink-0" onClick={() => setError(null)}>
                <X size={11} />
              </button>
            </div>
          )}

          {activeBuffer && activeBuffer.disk !== "ok" && (
            <div className="editor-conflict flex items-center gap-2 px-3 py-1.5 text-[11px]">
              <CircleAlert size={12} className="shrink-0" />
              <span className="flex-1 truncate">
                {activeBuffer.disk === "missing"
                  ? `${activeBuffer.name} was not found on disk — it may have been deleted or moved.`
                  : `${activeBuffer.name} changed on disk since you opened it.`}
              </span>

              {/*
                Reload only makes sense against a file that still exists.
                Offering it for a missing one gave a button whose only possible
                outcome was another error.
              */}
              {activeBuffer.disk === "changed" ? (
                <button
                  className="editor-btn-text px-1.5 py-0.5 rounded shrink-0 text-[10px]"
                  onClick={() => void reloadFromDisk(activeBuffer.id)}
                >
                  Reload
                </button>
              ) : (
                <button
                  className="editor-btn-text px-1.5 py-0.5 rounded shrink-0 text-[10px]"
                  onClick={() => void saveBuffer(activeBuffer.id, { force: true })}
                  title="Write this buffer back to disk, recreating the file"
                >
                  Save to recreate
                </button>
              )}

              <button
                className="editor-btn-text px-1.5 py-0.5 rounded shrink-0 text-[10px]"
                onClick={() => setDiskState(activeBuffer.id, "ok")}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Editor and side panel */}
          <div className="flex-1 min-h-0 flex overflow-hidden">
            <div className="flex-1 min-w-0 min-h-0 relative">
              {preview ? (
                <PreviewCard
                  preview={preview}
                  onDismiss={() => setPreview(null)}
                  onReveal={() => void revealPath(preview.path).catch((e) => setError(String(e)))}
                />
              ) : buffers.length === 0 ? (
                <EmptyState
                  onQuickOpen={() => setQuickOpen(true)}
                  onNewFile={() => openScratch()}
                />
              ) : null}

              {/*
                Kept mounted even while a preview or the empty state is showing,
                so switching back to a tab doesn't rebuild every document.
              */}
              <div className={preview || buffers.length === 0 ? "invisible absolute inset-0" : "h-full"}>
                <EditorSurface
                  ref={surfaceRef}
                  bufferId={activeBufferId}
                  initialContent={activeBuffer?.initialContent ?? ""}
                  languageId={activeBuffer?.languageId ?? "plaintext"}
                  readOnly={activeBuffer?.readonly ?? true}
                  highlight={!activeBuffer?.large}
                  dark={theme === "dark"}
                  fontFamily={settings.fontFamily}
                  fontSize={settings.fontSize}
                  onDirtyChange={setDirty}
                  onCursorChange={onCursorChange}
                  onEdited={onEdited}
                  onScrollLine={onEditorScrollLine}
                  onSave={saveActive}
                  onSaveAll={saveAll}
                  onQuickOpen={() => setQuickOpen(true)}
                  onGlobalSearch={() => {
                    setSidePanel("search");
                    setExplorerVisible(true);
                  }}
                  onCloseTab={() => activeBufferId && requestCloseBuffer(activeBufferId)}
                  onToggleExplorer={() => setExplorerVisible(!explorerVisible)}
                  onSelectTab={(index) => {
                    if (buffers[index]) setActiveBuffer(buffers[index].id);
                  }}
                />
              </div>
            </div>

            {previewShown && (
              <>
                <div
                  className="editor-divider shrink-0"
                  onPointerDown={startPreviewResize}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize the preview"
                />
                <div
                  className="shrink-0 min-h-0"
                  style={{ width: paneWidth(previewDragWidth ?? previewWidth) }}
                >
                  <MarkdownPreview
                    ref={previewRef}
                    source={previewSource}
                    name={activeBuffer?.name ?? ""}
                    onScrollLine={onPreviewScrollLine}
                    activeLine={outlineLine}
                    onSelectHeading={goToHeading}
                    onFollowLink={followMarkdownLink}
                  />
                </div>
              </>
            )}

            {panelShown && (
              <>
                <div
                  className="editor-divider shrink-0"
                  onPointerDown={startExplorerResize}
                  role="separator"
                  aria-orientation="vertical"
                />
                <div
                  className="shrink-0 min-h-0"
                  style={{ width: paneWidth(dragWidth ?? explorerWidth) }}
                >
                  {sidePanel === "search" && root && rootReady ? (
                    <GlobalSearch
                      root={root}
                      onOpen={(path, line, column) => void openPath(path, line, column)}
                      onClose={() => setSidePanel("files")}
                    />
                  ) : root && rootReady ? (
                    <FileExplorer
                      root={root}
                      activePath={activeBuffer?.path ?? null}
                      showHidden={showHidden}
                      onToggleHidden={() => setShowHidden(!showHidden)}
                      expanded={expanded}
                      onToggleExpand={toggleExpanded}
                      onCollapseAll={collapseAll}
                      onOpenFile={(path) => void openPath(path)}
                      onOpenTerminal={openTerminalAt}
                      onForgetExpanded={collapse}
                      onError={setError}
                      change={treeChange}
                    />
                  ) : null}
                </div>
              </>
            )}
          </div>

          <EditorStatusBar
            buffer={activeBuffer}
            cursor={cursor}
            wrapped={wrapped}
            bufferCount={buffers.length}
            watcherMechanism={mechanism}
            onToggleWrap={() => {
              surfaceRef.current?.command("toggleWrap");
              setWrapped(surfaceRef.current?.isWrapped() ?? false);
            }}
            onSetLanguage={(id) => activeBufferId && setLanguage(activeBufferId, id)}
            onSetLineEnding={(value: LineEnding) =>
              activeBufferId && setLineEnding(activeBufferId, value)
            }
            onSetEncoding={(value: FileEncoding) =>
              activeBufferId && setEncoding(activeBufferId, value)
            }
            onGoToLine={() => surfaceRef.current?.command("gotoLine")}
            onResizeStart={onResizeStart}
          />

          {quickOpen && root && rootReady && (
            <QuickOpen
              root={root}
              showHidden={showHidden}
              recentPaths={buffers
                .filter((b) => b.path)
                .sort((a, b) => b.usedAt - a.usedAt)
                .map((b) => b.path!)}
              onPick={(path) => void openPath(path)}
              onClose={() => {
                setQuickOpen(false);
                surfaceRef.current?.focus();
              }}
              onError={setError}
            />
          )}
        </div>

        {conflictBuffer && (
          <EditorDialog
            title="This file changed on disk"
            message={`${conflictBuffer.name} was modified by something else since you opened it. Saving now would overwrite those changes.`}
            detail={conflictBuffer.path ?? undefined}
            onCancel={() => setConflictFor(null)}
            actions={[
              {
                label: "Overwrite",
                danger: true,
                onClick: () => {
                  setConflictFor(null);
                  void saveBuffer(conflictBuffer.id, { force: true });
                },
              },
              {
                label: "Reload from disk",
                onClick: () => {
                  setConflictFor(null);
                  void reloadFromDisk(conflictBuffer.id);
                },
              },
              { label: "Cancel", primary: true, onClick: () => setConflictFor(null) },
            ]}
          />
        )}

        {closeBufferTarget && (
          <EditorDialog
            title="Save before closing?"
            message={`${closeBufferTarget.name} has unsaved changes.`}
            detail={closeBufferTarget.path ?? undefined}
            onCancel={() => setClosePrompt(null)}
            actions={[
              {
                label: "Save",
                primary: true,
                onClick: () => {
                  const id = closeBufferTarget.id;
                  setClosePrompt(null);
                  void saveBuffer(id).then((saved) => {
                    if (saved) closeAfterPrompt(id);
                  });
                },
              },
              {
                label: "Discard",
                danger: true,
                onClick: () => closeAfterPrompt(closeBufferTarget.id),
              },
              { label: "Cancel", onClick: () => setClosePrompt(null) },
            ]}
          />
        )}

        {saveAsBuffer && (
          <EditorDialog
            title="Save as"
            message="Name this file. It will be created in the folder the editor has open."
            detail={root ?? undefined}
            prompt={{
              initial: `${saveAsBuffer.name}.txt`,
              placeholder: "filename.txt",
              onSubmit: (name) => void saveAs(saveAsBuffer.id, name),
            }}
            onCancel={() => setSaveAsFor(null)}
            actions={[]}
          />
        )}

        {workspaceMenuOpen && (
          <WorkspacePicker
            root={root}
            workspaces={workspaces}
            favorites={favorites}
            onOpen={requestWorkspace}
            onReload={reloadWorkspace}
            onForget={removeWorkspace}
            onToggleFavorite={toggleFavorite}
            onBrowse={browseForWorkspace}
            onClose={() => setWorkspaceMenuOpen(false)}
          />
        )}

        {pendingWorkspace && (
          <EditorDialog
            title="Unsaved changes"
            message={`Switching folders closes the tabs you have open. ${
              buffers.filter((b) => b.dirty).length
            } of them have unsaved changes.`}
            detail={pendingWorkspace}
            onCancel={() => setPendingWorkspace(null)}
            actions={[
              {
                label: "Save all and switch",
                primary: true,
                onClick: () => {
                  const target = pendingWorkspace;
                  setPendingWorkspace(null);
                  void (async () => {
                    for (const buffer of useEditorStore.getState().buffers) {
                      if (buffer.dirty && buffer.path) await saveBuffer(buffer.id);
                    }
                    // A buffer that still can't be saved — read-only, or a
                    // scratch file with no name — would be lost silently, so
                    // the switch is abandoned instead.
                    if (useEditorStore.getState().buffers.some((b) => b.dirty)) {
                      setError("Some files could not be saved, so the folder was not changed");
                      return;
                    }
                    await enterWorkspace(target);
                  })();
                },
              },
              {
                label: "Discard and switch",
                danger: true,
                onClick: () => {
                  const target = pendingWorkspace;
                  setPendingWorkspace(null);
                  void enterWorkspace(target);
                },
              },
              { label: "Cancel", onClick: () => setPendingWorkspace(null) },
            ]}
          />
        )}

        {draftPrompt && draftPrompt.length > 0 && (
          <EditorDialog
            title="Recover unsaved changes?"
            message={`${draftPrompt.length} ${
              draftPrompt.length === 1 ? "file has" : "files have"
            } unsaved changes from your last session.`}
            detail={draftPrompt.map(({ draft }) => draft.name).join(", ")}
            onCancel={() => setDraftPrompt(null)}
            actions={[
              {
                label: "Recover",
                primary: true,
                onClick: () => void restoreDrafts(draftPrompt),
              },
              {
                label: "Discard",
                danger: true,
                onClick: () => {
                  draftPrompt.forEach(({ id }) => clearDraft(id));
                  setDraftPrompt(null);
                },
              },
              { label: "Later", onClick: () => setDraftPrompt(null) },
            ]}
          />
        )}
      </div>
    </OverlayPortal>
  );
}

/** Shown for a file the editor won't load. */
function PreviewCard({
  preview,
  onDismiss,
  onReveal,
}: {
  preview: Preview;
  onDismiss: () => void;
  onReveal: () => void;
}) {
  return (
    <div className="editor-placeholder h-full w-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <CircleAlert size={22} className="editor-placeholder-icon" />
      <div className="editor-placeholder-title text-[12px]">
        {preview.kind === "binary"
          ? "This looks like a binary file"
          : "This file is too large to open"}
      </div>
      <div className="editor-placeholder-text text-[11px]">
        {basename(preview.path)} · {formatBytes(preview.size)}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <button className="editor-btn-text px-2 py-1 rounded text-[11px]" onClick={onReveal}>
          <span className="flex items-center gap-1.5">
            <SquareArrowOutUpRight size={12} />
            Show in file manager
          </span>
        </button>
        <button className="editor-btn-text px-2 py-1 rounded text-[11px]" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function EmptyState({
  onQuickOpen,
  onNewFile,
}: {
  onQuickOpen: () => void;
  onNewFile: () => void;
}) {
  return (
    <div className="editor-placeholder h-full w-full flex flex-col items-center justify-center gap-3">
      <div className="editor-placeholder-title text-[12px]">No file open</div>
      <div className="flex items-center gap-2">
        <button className="editor-btn-text px-2 py-1 rounded text-[11px]" onClick={onQuickOpen}>
          Go to file
        </button>
        <button className="editor-btn-text px-2 py-1 rounded text-[11px]" onClick={onNewFile}>
          New untitled file
        </button>
      </div>
      <div className="editor-placeholder-text text-[11px]">
        Or pick something from the tree on the right.
      </div>
    </div>
  );
}
