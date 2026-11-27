import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MakePrimary, PrimaryHome } from "../AppShell/PrimaryChrome";
import { invoke } from "@tauri-apps/api/core";
import {
  AlignLeft,
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardPaste,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  FilePlus,
  FolderInput,
  FolderOpen,
  FolderSearch,
  FolderTree,
  GitBranch,
  ListOrdered,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Redo2,
  Save,
  Scissors,
  Settings2,
  Star,
  Search,
  SquareArrowOutUpRight,
  TextSearch,
  TextSelect,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, releaseFront } from "../../services/overlay-stack";
import { useOverlayZSync } from "../../hooks/useOverlayZSync";
import {
  fullscreenRect,
  useDraggableModal,
} from "../../hooks/useDraggableModal";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { useOverlayRect } from "../../hooks/useOverlayRect";
import { BASE_SLOT_Z, useBaseSlot } from "../../hooks/useBaseSlot";
import { useEditorStore, restorableSession } from "../../stores/editorStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import {
  basename,
  deletePath,
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
import {
  clearDraft,
  listDrafts,
  saveDraft,
  Workspace,
} from "../../services/editor-session";
import {
  GitCommit,
  GitCommitFile,
  GitFile,
  GitBlame,
  GitFileDiff,
  gitCommit,
  gitCommitDiff,
  gitDiscard,
  gitFetch,
  gitFileDiff,
  gitBlame,
  gitFileHunks,
  gitPull,
  gitPush,
  gitStage,
  gitUnstage,
  isIgnored,
  repoRelative,
} from "../../services/git";
import { useGitStatus } from "../../hooks/useGitStatus";
import { lsp } from "../../services/lsp/manager";
import {
  defaultInterpreter,
  findInterpreters,
  Interpreter,
} from "../../services/lsp/python";
import { setLspHost } from "./lsp";
import { findBySlug, parseOutline } from "../../services/markdown-outline";
import { isLinux, isMac, platform } from "../../services/platform";
import { collapseHome, normalizeDir } from "../../services/recent-dirs";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ContextMenu";
import { DiffView } from "./DiffView";
import { EditorSettingsModal } from "./EditorSettingsModal";
import { EditorSurface, EditorSurfaceHandle, SurfaceCommand } from "./EditorSurface";
import { GoToLine } from "./GoToLine";
import { SourceControl } from "./SourceControl";
import { EditorTabs } from "./EditorTabs";
import { EditorStatusBar } from "./EditorStatusBar";
import { EditorDialog } from "./EditorDialog";
import { ExplorerChange, FileExplorer } from "./FileExplorer";
import { SegmentedTabs } from "../Shared/SegmentedTabs";
import { GlobalSearch } from "./GlobalSearch";
import { WorkspacePicker } from "./WorkspacePicker";
import { MarkdownPreview, MarkdownPreviewHandle } from "./MarkdownPreview";
import { QuickOpen } from "./QuickOpen";
import { AgentPanel } from "./AgentPanel";
import type { EditorContext } from "../../services/figycode-panel";

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

/**
 * The toolbar's own horizontal padding, and the divider's width, in pixels.
 *
 * Named because the panel controls' width is derived from them: the toolbar is
 * padded and the row below it is not, so a group that simply matched the
 * panel's width would sit one padding to the side of it. Mirrors `px-2` on the
 * toolbar and `.editor-divider` in the stylesheet — change either and change
 * these.
 */
const TOOLBAR_PAD = 8;
const DIVIDER_W = 4;

/**
 * Below this panel width the switcher's tabs lose their labels.
 *
 * Measured against what the three words need rather than picked round: at the
 * default 260 they sit comfortably, and by `MIN_EXPLORER` (180) they would be
 * ellipses. Half a word is worse than the icon alone, so they are dropped
 * rather than truncated.
 */
const LABELLED_CONTROLS = 230;

/**
 * The three modes the side column can be in.
 *
 * A table because they are three of a kind — the same control, the same
 * state, differing only in which value they select — and written out three
 * times they drifted: search was a loose button outside the group the other
 * two shared.
 */
const PANEL_MODES = [
  {
    id: "files" as const,
    label: "Files",
    aria: "Explorer",
    title: "Explorer — the file tree (⌘B)",
    icon: <FolderTree size={13} />,
  },
  {
    id: "search" as const,
    label: "Search",
    aria: "Search in folder",
    title: "Search in folder (⌘⇧F)",
    icon: <TextSearch size={13} />,
  },
  {
    id: "git" as const,
    label: "Git",
    aria: "Source control",
    // Filled in per render: it counts the changes.
    title: "Source control",
    icon: <GitBranch size={13} />,
  },
];

/** The editor itself never gets dragged narrower than this. */
const MIN_EDITOR = 320;

/** Debounce before a dirty buffer is journalled to storage. */
const JOURNAL_MS = 700;

/** Debounce before the Markdown preview re-renders while typing. */
const PREVIEW_MS = 200;

export interface EditorOpenRequest {
  path: string;
  line?: number;
  column?: number;
  /**
   * The folder the request came from — a pane's working directory, or the
   * Claude project the path was printed in.
   *
   * The editor reads only inside the folder it has open, so a file from
   * anywhere else is refused by the backend. This is what lets it adopt the
   * right workspace instead of reporting that the file the user just clicked
   * is "outside the folders open in the editor", which is true, unhelpful, and
   * not something they can act on.
   */
  root?: string;
  /** Bumped per request, so the same path can be asked for twice. */
  token: number;
}

interface EditorModalProps {
  visible: boolean;
  onClose: () => void;
  /** The focused terminal pane's working directory, if it has one. */
  cwd?: string;
  /**
   * This is the base: it fills the slot between the app header and the status
   * bar, never moves and cannot be put away. See `useBaseSlot`.
   */
  docked?: boolean;
  /** Opens a terminal tab rooted at a directory. */
  onOpenTerminal: (dir: string) => void;
  /** A file the app wants opened — a clicked path in terminal output. */
  openRequest: EditorOpenRequest | null;
  /**
   * Bumped when the app hands ⌘W over: the native Window menu owns that chord
   * on macOS, so it can't be claimed in the webview. See `AppShell`.
   */
  closeTabRequest: number;
  /**
   * Filled in with a handler for the chords the native menu owns — ⌘Z, ⇧⌘Z
   * and ⌘A — which all arrive this way and for the same reason.
   *
   * ⌘A is here because CodeMirror renders a *window* onto the document: only
   * the visible lines are in the DOM, so WebKit's own `selectAll:` selects the
   * viewport and a following ⌘C copied whatever happened to be on screen. The
   * editor has to set its own selection over the whole document instead.
   *
   * A callback rather than a counted prop: undo is held down and repeated, and
   * two presses in one React batch would collapse into a single re-render and
   * so into a single undo. It returns whether the editor took the chord, so
   * `AppShell` knows whether to fall back to the webview's own.
   */
  chordRef: React.MutableRefObject<
    ((command: "undo" | "redo" | "selectAll") => boolean) | null
  >;
}

/**
 * What a discard is actually going to do, spelled out.
 *
 * The two halves are not the same act: a tracked file is restored from the
 * index and the changes to it are gone, while an untracked one goes to the
 * trash and can be fetched back. Saying so is the difference between an
 * informed yes and a habitual one.
 */
function discardChoice(files: GitFile[]): string {
  const untracked = files.filter((file) => file.unstaged === "untracked").length;
  const tracked = files.length - untracked;

  const parts: string[] = [];
  if (tracked > 0) {
    parts.push(
      tracked === 1
        ? "The file goes back to its last staged or committed version, and the changes to it will be gone."
        : `${tracked} files go back to their last staged or committed versions, and the changes to them will be gone.`
    );
  }
  if (untracked > 0) {
    parts.push(
      untracked === 1
        ? "One file is untracked, so it is moved to the trash instead — git has no version of it to restore."
        : `${untracked} files are untracked, so they are moved to the trash instead — git has no versions of them to restore.`
    );
  }
  return parts.join(" ");
}

/**
 * A chord written the way the platform writes it — `⌘X`, or `Ctrl+X`.
 *
 * Only for the context menu's hint column. Everything in `SHORTCUTS` is
 * app-level and spelled there; these are the editor's own, and the ones the
 * webview provides for nothing.
 */
function chord(key: string, extra?: "shift" | "alt"): string {
  if (isMac) {
    return `${extra === "shift" ? "⇧" : extra === "alt" ? "⌥" : ""}⌘${key}`;
  }
  return `Ctrl+${extra === "shift" ? "Shift+" : extra === "alt" ? "Alt+" : ""}${key}`;
}

const REVEAL_LABEL =
  platform === "mac"
    ? "Reveal in Finder"
    : platform === "windows"
      ? "Show in Explorer"
      : "Open Containing Folder";

/**
 * What the diff tab is showing.
 *
 * Two shapes, because a diff of the working tree and a diff of one commit are
 * asked for differently — the first against HEAD, the second against a
 * commit's first parent — and the header has a revision to name in the second
 * case and not the first.
 */
type DiffTarget =
  | { kind: "working"; file: GitFile }
  | { kind: "commit"; commit: GitCommit; file: GitCommitFile };

/** The tab and the header label for either shape. */
function diffIdentity(target: DiffTarget): {
  relative: string;
  revision: string | null;
} {
  return target.kind === "working"
    ? { relative: target.file.relative, revision: null }
    : { relative: target.file.relative, revision: target.commit.short };
}

/** Where a right-click on the text opened, and what was selected at the time. */
interface SurfaceMenu {
  x: number;
  y: number;
  hasSelection: boolean;
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
/**
 * Whether `path` is inside `dir`, by the same rule the backend confines with.
 *
 * Segment-aware on purpose: a plain `startsWith` makes `/work/api-old` look
 * like it is inside `/work/api`, which would send the editor to the wrong
 * workspace and then fail to read the file anyway.
 */
function within(dir: string, path: string): boolean {
  const base = normalizeDir(dir);
  const target = isLinux ? path : path.toLowerCase();
  const root = isLinux ? base : base.toLowerCase();
  if (target === root) return true;
  return target.startsWith(root) && /[\\/]/.test(target.charAt(root.length));
}

/**
 * The home directory, asked for once and remembered.
 *
 * Asked for here rather than read from `collapseHome`, which also knows it:
 * that copy is set as a side effect inside `Terminal.tsx` after an IPC call,
 * so whether it is there yet when the editor first opens is a race. Losing
 * that race is silent and looks exactly like the bug it was meant to fix —
 * the check says "not home", the editor adopts home, and the file tree fills
 * with Downloads and Library.
 *
 * Memoised at module level, so every window and every open shares the one
 * call.
 */
let homeLookup: Promise<string | null> | null = null;

function homeDirectory(): Promise<string | null> {
  if (!homeLookup) {
    homeLookup = invoke<string>("get_home_dir").catch(() => null);
  }
  return homeLookup;
}

/**
 * Folders the editor will not take as a workspace, however it was asked.
 *
 * Not a preference — a workspace is recursively listed, recursively searched
 * and recursively *watched*, and at this size all three stop working at once:
 * the tree is unreadable, quick open gives up at its cap, and the watcher
 * spends a descriptor per directory until the kernel refuses it more. None of
 * these is anybody's project either, which is the simpler reason.
 *
 * Four of them: the filesystem root, the folder every account lives under, and
 * this account's own folder — the last being where a shell starts when it has
 * not been pointed anywhere, and so the one that kept arriving by accident.
 *
 * Applied to **every** route in, including a root remembered from a previous
 * session. One of those stored before this rule existed should not keep
 * reopening forever.
 */
function tooBroadForWorkspace(dir: string, home: string | null): boolean {
  const path = normalizeDir(dir.trim());
  if (!path) return true;
  // `/`, or a bare drive letter with or without its separator.
  if (path === "/" || /^[A-Za-z]:[/\\]?$/.test(path)) return true;
  // `/Users`, `/home`, `C:\Users` — the container, not an account.
  if (/^\/(Users|home)$/i.test(path)) return true;
  if (/^[A-Za-z]:[/\\]Users$/i.test(path)) return true;
  return !!home && sameFolder(path, home);
}

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
  closeTabRequest,
  chordRef,
  docked = false,
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
    diffLayout,
    diffStyle,
    settings: editorSettings,
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
    pathMoved,
    setLineEnding,
    setEncoding,
    setLanguage,
    setExplorerVisible,
    setExplorerWidth,
    setPreviewWidth,
    setShowHidden,
    setDiffLayout,
    setDiffStyle,
    setEditorSettings,
    setPythonPath,
    closeWorkspace,
    resetEditorSettings,
    toggleExpanded,
    collapse,
    collapseAll,
  } = useEditorStore();

  const theme = useThemeStore((s) => s.theme);
  const { settings } = useSettingsStore();

  /**
   * What the editor actually renders in.
   *
   * A blank face or a zero size means "follow the terminal", and it is a
   * sentinel rather than a copy of the terminal's value so that changing the
   * terminal still moves the editor for anyone who never chose one — which is
   * what somebody who never chose would expect.
   */
  const editorFont = useMemo(
    () => ({
      family: editorSettings.fontFamily || settings.fontFamily,
      size: editorSettings.fontSize || settings.fontSize,
    }),
    [editorSettings.fontFamily, editorSettings.fontSize, settings.fontFamily, settings.fontSize]
  );

  const [error, setError] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [surfaceMenu, setSurfaceMenu] = useState<SurfaceMenu | null>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * What a level of indentation is in the buffer in front.
   *
   * Mirrored into React state rather than read from the surface on render: the
   * surface detects it from the file when a buffer is first built, and a
   * component that reads a ref during render has no reason to re-render when
   * that answer arrives.
   */
  const [indent, setIndent] = useState({ useTabs: false, width: 2 });
  /** How the file in front differs from HEAD, for the change gutter. */
  const [gitDiff, setGitDiff] = useState<GitFileDiff | null>(null);
  /** Who last touched each line of the open file; see the effect below. */
  const [blame, setBlame] = useState<GitBlame | null>(null);
  /**
   * The file the blame in hand describes.
   *
   * Kept so that switching files clears the annotation *before* the new answer
   * arrives. Without it there is a frame or two where the new file is
   * annotated with the previous one's history — a real wrong answer rather
   * than a missing one, and the kind that gets believed.
   */
  const blamePath = useRef<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  /**
   * Bumped after the editor itself changes the repository.
   *
   * The watcher covers changes made anywhere else, `.git` included, so this is
   * only for the gap between a stage or a commit finishing and the debounced
   * watcher event arriving — which is long enough to look broken.
   */
  const [gitTick, setGitTick] = useState(0);
  /** What the diff tab is showing, or null when there is no diff tab. */
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  /**
   * Whether the diff tab is the one in front.
   *
   * Separate from `diffTarget` so the diff behaves like the tab it now is:
   * clicking a file tab moves away from it without closing it, and clicking it
   * again comes back. One piece of state for both would mean switching to a
   * file destroyed the diff, which is not what a tab does.
   */
  const [diffFocused, setDiffFocused] = useState(false);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  /** Files a discard is waiting to be confirmed for. */
  const [discardPrompt, setDiscardPrompt] = useState<GitFile[] | null>(null);
  /**
   * What the side panel is showing.
   *
   * One mode rather than a boolean per panel: they're mutually exclusive, and
   * separate flags would let two of them claim the column at once. The outline
   * used to be a third mode here; it lives inside the preview now, which frees
   * this column for the tree.
   */
  const [sidePanel, setSidePanel] = useState<"files" | "search" | "git">("files");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  /**
   * What the status bar's wrap indicator says.
   *
   * Seeded from the setting, exactly as the surface seeds its own wrap state —
   * a lazy initial value, so that the two agree at the start and then both let
   * the session's toggle own it. Hard-coding `false` here meant that with word
   * wrap on in the settings the indicator read "off" over an editor that was
   * plainly wrapping, and the first click on it turned wrapping *off* while
   * leaving the indicator unchanged.
   */
  const [wrapped, setWrapped] = useState(() => editorSettings.wordWrap);
  const [fullscreen, setFullscreen] = useState(false);
  /**
   * Keeps this window in front when it's opened or clicked.
   *
   * The value goes on the wrapper below, not on the frame: the wrapper is the
   * positioned element with a z-index, so it creates the stacking context the
   * frame lives in — which is why the editor's picture-in-picture used to sit
   * behind the browser's however high its own z-index was set.
   */
  const [frontZ, setFrontZ] = useState<number | null>(null);
  // The base never joins the stack — there is nothing for it to be raised
  // above, and claiming a rank would put it over every open window.
  const raise = useCallback(() => {
    if (docked) return;
    setFrontZ(claimFront("editor"));
  }, [docked]);
  // A claim by any overlay renumbers the rest; this re-reads ours.
  useOverlayZSync("editor", setFrontZ);

  /** Non-null only while the side panel's divider is being dragged. */
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  /** Ditto, for the preview's divider. */
  const [previewDragWidth, setPreviewDragWidth] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  /**
   * What the column opposite the explorer is showing.
   *
   * One column with modes rather than two columns that can both be
   * open, which makes the editor one symmetric idea: a panel on each
   * side of the buffer, each with a mode. The alternative — a third
   * fixed column — is 240px of a 960px window spent on chrome before
   * any text is shown, on a layout that already has to narrow its panes
   * in picture-in-picture to leave the editor anything.
   */
  const [rightPane, setRightPane] = useState<"none" | "preview" | "agent">("none");
  /** The preview is one of the column's modes; the rest of this file
      asks the question that way round. */
  const previewOpen = rightPane === "preview";
  const agentOpen = rightPane === "agent";
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
  /**
   * Whether the question "which folder" has been answered yet.
   *
   * Adopting one takes a round trip — the home lookup, then `fs_set_roots` —
   * and `root` is null throughout. Rendering the welcome on that alone would
   * flash "Open a folder to start" in front of somebody whose project is
   * already on its way, so the screen waits to be sure there is nothing
   * coming.
   */
  const [workspaceSettled, setWorkspaceSettled] = useState(false);
  /**
   * The home directory, for the one question that has to be asked of it:
   * is the folder on offer actually a project, or just where a shell starts?
   */
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [conflictFor, setConflictFor] = useState<string | null>(null);
  const [closePrompt, setClosePrompt] = useState<string | null>(null);
  const [saveAsFor, setSaveAsFor] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<ReturnType<typeof listDrafts> | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  /** A folder waiting on the user to deal with unsaved files first. */
  /**
   * A folder change waiting on the user to deal with unsaved files first.
   *
   * One shape for both, because they are the same question asked of the same
   * tabs: opening another folder and leaving this one each close everything
   * that is open, and only the verb differs. Two dialogs would be two places
   * to keep the save-all logic correct.
   */
  const [pendingWorkspace, setPendingWorkspace] = useState<
    { kind: "open"; root: string } | { kind: "close" } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void homeDirectory().then((home) => {
      if (!cancelled) setHomeDir(home);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const modalRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<EditorSurfaceHandle>(null);
  const initStarted = useRef(false);
  const sessionRestored = useRef(false);
  const journalTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** Where to put the cursor once the buffer being opened is live. */
  const pendingGoTo = useRef<{ bufferId: string; line: number; column: number } | null>(null);
  /**
   * Bumped every time a cursor move is queued, and depended on by the effect
   * that applies it.
   *
   * Without it the effect was keyed only on which buffer was active and how
   * many were open, so a jump *within the file already in front* changed
   * neither and never ran — which is exactly what picking a second hit in the
   * open file from folder search does. It queued the line and stopped there.
   */
  const [goToToken, setGoToToken] = useState(0);
  const lastRequest = useRef(0);
  /** The request a workspace switch has already been asked for, once. */
  const workspaceAsked = useRef(0);
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

  /*
    Only in picture-in-picture is this a *window*; otherwise it is a modal with
    a full-screen backdrop, and the stack's "no rectangle means it covers
    everything" is the right answer for that.
  */
  useOverlayRect("editor", modalRef, docked);

  /*
    Back to a window's own geometry when something else takes the primary
    slot: centred, default size, not fullscreen. See `useBaseSlot`.
  */
  const undock = useCallback(() => {
    setFullscreen(false);
    reset();
  }, [reset]);

  useBaseSlot(docked, place, undock);

  const { change, mechanism } = useFileWatcher(rootReady ? root : null, visible);

  const {
    repo: git,
    error: gitError,
    refresh: refreshGit,
    decorations: gitDecorations,
    ignored: gitIgnoredPaths,
    remote: gitRemote,
  } = useGitStatus(rootReady ? root : null, visible);

  /**
   * The watcher is the git refresh trigger.
   *
   * `.git` is inside the watched tree, so a commit, a checkout or a rebase in
   * the pane behind arrives as a filesystem event like anything else — no
   * polling, and no need for the editor to be the only thing allowed to touch
   * the repository.
   */
  useEffect(() => {
    if (!visible || change.token === 0) return;
    refreshGit();
  }, [change.token, visible, refreshGit]);

  useEffect(() => {
    if (visible) refreshGit();
  }, [visible, refreshGit]);

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
      /*
        Refused here rather than only where folders are suggested, because this
        is the one road every route in goes down — the picker, the welcome's
        list, the Open Folder dialog and a path clicked in terminal output. A
        browse dialog will happily hand back `/`, and the editor cannot usefully
        be rooted there; saying so is better than appearing to work and then
        spending the session walking the filesystem.
      */
      if (tooBroadForWorkspace(dir, homeDir)) {
        setError(
          `${basename(normalizeDir(dir)) || dir} is too broad to open as a folder — pick a project inside it.`
        );
        return;
      }

      // Re-opening the folder already open would discard its tabs to restore
      // the same ones; "Reload" passes `force` to ask for that on purpose.
      if (dir === root && !force) return;
      if (useEditorStore.getState().buffers.some((buffer) => buffer.dirty)) {
        setPendingWorkspace({ kind: "open", root: dir });
        return;
      }
      void enterWorkspace(dir);
    },
    [root, homeDir, enterWorkspace]
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

  /**
   * Leaves the folder without opening another.
   *
   * The backend's roots go with it, so a stale path cannot be read on behalf
   * of a window that has no folder; the watcher stops because `useFileWatcher`
   * is handed a null root and tears itself down.
   */
  const leaveWorkspace = useCallback(() => {
    surfaceRef.current?.forgetAll();
    setPreview(null);
    // The setters rather than `closeDiff`, which is declared further down and
    // would be a temporal-dead-zone throw read from here.
    setDiffTarget(null);
    setDiffFocused(false);
    setQuickOpen(false);
    setRootReady(false);
    setWorkspaceSettled(true);
    closeWorkspace();
    // Nothing to wait for: the editor is already showing the welcome by the
    // time this lands, and a failure means the roots were already gone.
    void setRoots([]).catch(() => {});
  }, [closeWorkspace]);

  const requestLeaveWorkspace = useCallback(() => {
    if (useEditorStore.getState().buffers.some((buffer) => buffer.dirty)) {
      setPendingWorkspace({ kind: "close" });
      return;
    }
    leaveWorkspace();
  }, [leaveWorkspace]);

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

  /** Queues a cursor move for a buffer that may not be live yet. */
  const queueGoTo = useCallback((bufferId: string, line: number, column: number) => {
    pendingGoTo.current = { bufferId, line, column };
    setGoToToken((token) => token + 1);
  }, []);

  const openPath = useCallback(
    async (path: string, line?: number, column?: number) => {
      const state = useEditorStore.getState();
      // Opening a file means showing it. Every route in comes through here —
      // the tree, quick open, a folder-search hit, a clicked path in terminal
      // output — so this is the one place the diff has to step aside.
      setDiffFocused(false);

      const existing = state.bufferFor(path);
      if (existing) {
        state.setActiveBuffer(existing.id);
        setPreview(null);
        if (line) queueGoTo(existing.id, line, column ?? 1);
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
        if (line) queueGoTo(id, line, column ?? 1);
        return id;
      } catch (e) {
        // Names the file first: the backend's message is about a path, and on
        // its own it doesn't say which of your tabs or clicks caused it.
        setError(`${basename(path)} could not be opened — ${e}`);
        return null;
      }
    },
    [queueGoTo]
  );

  openPathRef.current = openPath;

  // --- Language servers ------------------------------------------------------

  /**
   * Points the language-server manager at this workspace, and tells it what the
   * user has switched on.
   *
   * Changing either stops whatever was running: a server is scoped to a root,
   * and one left alive against a folder nobody has open is a process holding
   * memory for no reason. Turning the master switch off stops everything, which
   * is what makes the setting mean what it says.
   */
  /**
   * The interpreter chosen for this folder, if any.
   *
   * Null means "detect it", which the status-bar picker resolves to the
   * in-project environment when there is one — so the manager is told what the
   * user picked, and the picker owns the default.
   */
  const pythonPath = useMemo(
    () => workspaces.find((workspace) => workspace.root === root)?.pythonPath ?? null,
    [workspaces, root]
  );

  /**
   * The interpreter actually in force, which is the chosen one or the detected
   * one. Held here rather than in the picker because the *manager* needs it —
   * pyright has to be told before it resolves a single import — and the picker
   * is only rendered while a Python file is in front.
   */
  const [pythonInterpreters, setPythonInterpreters] = useState<Interpreter[]>([]);
  const [pythonLoading, setPythonLoading] = useState(false);

  const refreshInterpreters = useCallback(() => {
    if (!editorSettings.lsp) {
      setPythonInterpreters([]);
      return;
    }
    setPythonLoading(true);
    void findInterpreters(useEditorStore.getState().root)
      .then(setPythonInterpreters)
      .catch(() => setPythonInterpreters([]))
      .finally(() => setPythonLoading(false));
  }, [editorSettings.lsp]);

  useEffect(() => {
    if (!rootReady || !root || !editorSettings.lsp) {
      setPythonInterpreters([]);
      return;
    }
    refreshInterpreters();
  }, [root, rootReady, editorSettings.lsp, refreshInterpreters]);

  /** The in-project environment, when the user hasn't chosen one. */
  const detectedPython = useMemo(
    () => defaultInterpreter(pythonInterpreters)?.path ?? null,
    [pythonInterpreters]
  );

  useEffect(() => {
    lsp.configure({
      enabled: editorSettings.lsp,
      overrides: editorSettings.lspServers,
      custom: editorSettings.lspCustom,
      root: rootReady ? root : null,
      pythonPath: pythonPath ?? detectedPython,
    });
  }, [
    editorSettings.lsp,
    editorSettings.lspServers,
    editorSettings.lspCustom,
    root,
    rootReady,
    pythonPath,
    detectedPython,
  ]);

  /**
   * Everything the language-server features need from the editor around them.
   *
   * All outcomes rather than mechanisms — open this file, say this, apply these
   * edits — so `lsp/actions.ts` decides what should happen and this decides how
   * it looks. The edit paths matter most: they are how a rename reaches a file
   * the user has open, and they go through the surface so the change is one
   * undoable step rather than a write behind the buffer's back.
   */
  useEffect(() => {
    setLspHost({
      openPath: (path, line, column) => void openPath(path, line, column),
      root: () => useEditorStore.getState().root,
      report: setError,
      applyToOpenBuffer: (path, edits) =>
        surfaceRef.current?.applyServerEdits(path, edits) ?? false,
      openText: (path) => surfaceRef.current?.textOf(path) ?? null,
    });
  }, [openPath]);

  /**
   * Stops every server when the editor closes for good.
   *
   * Not when the modal is merely hidden: it is a modal that gets closed and
   * reopened constantly, and killing a `rust-analyzer` mid-index every time
   * would make the feature useless. The idle timer in the manager is what
   * handles a modal that stays closed — the debounce belongs on the stop.
   */
  useEffect(() => {
    return () => {
      void lsp.stopAll();
    };
  }, []);

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
      /*
        With no folder to adopt there is **no folder**, and the editor says so
        rather than finding one. It used to fall back to the home directory,
        which is not a project and is the one folder guaranteed to be enormous
        — so the first thing a new user saw was a tree of their entire home,
        Downloads and Library included, with no sign that picking a folder was
        a step they were meant to take. `WorkspaceWelcome` is what shows
        instead, and it is the only screen here that exists to be left.
      */
      const home = await homeDirectory();
      if (cancelled) return;

      /*
        **The shell's folder, or nothing.** The last session's folder is not a
        fallback: rejecting home and then quietly reopening whatever was last
        open puts you in a project you did not ask for, which is the thing
        being complained about rather than a lesser version of it.

        The terminal is the signal. Pointed at a project, that is the project.
        Pointed at home, it is not pointing anywhere, and the honest answer is
        to ask — the folder you were in last is still one click away in the
        welcome's Recent list, where choosing it is a choice.
      */
      const desired = cwd && !tooBroadForWorkspace(cwd, home) ? cwd : null;
      if (!desired || cancelled) {
        setWorkspaceSettled(true);
        return;
      }

      // Held across the restore for the same reason a switch holds it: an
      // empty tab strip mid-restore must not overwrite the folder's remembered
      // tab list.
      setRestoring(true);
      const canonical = await applyRoot(desired);
      if (!canonical) {
        setRestoring(false);
        setWorkspaceSettled(true);
        // Unlatched, so reopening the editor tries again rather than leaving it
        // permanently rootless with an error nobody can act on.
        initStarted.current = false;
        return;
      }
      setWorkspaceSettled(true);
      if (cancelled || sessionRestored.current) {
        setRestoring(false);
        return;
      }
      sessionRestored.current = true;

      /*
        The remembered tabs, but only when this is the folder they belong to.

        They are the *active* workspace's, so opening a different project and
        restoring them anyway meant asking for a dozen files that are outside
        the folder now open. Each one was refused and skipped, so it looked
        like nothing happened — a quiet dozen failed reads on every launch
        that started somewhere new.
      */
      const previous = restorableSession();
      const mine = sameFolder(canonical, previous.root);
      // Files that have since been deleted or moved out of the root are
      // skipped silently — a restored session shouldn't open with a stack of
      // errors about last week's branch.
      for (const path of (mine ? previous.openPaths : []).slice(0, 12)) {
        if (cancelled) return;
        await openPath(path).catch(() => null);
      }
      if (mine && previous.activePath && !cancelled) {
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
    /*
      Held, not decided, until home is known — and `homeDir` is a dependency so
      this runs again the moment it is. Deciding without it is exactly how a
      shell sitting in home became the workspace: the guard below reads `null`,
      says "not home", and the request is consumed before the answer arrives.
    */
    if (homeDir === null) return;
    // Cleared before the switch, not after: a cancelled switch must not be
    // retried on the next render.
    pendingAdopt.current = null;
    if (sameFolder(target, root)) return;
    // Same rule as the first open: a shell sitting in home is not a request to
    // make home the workspace, least of all over a project already open.
    if (tooBroadForWorkspace(target, homeDir)) return;
    requestWorkspace(target);
  }, [visible, rootReady, root, cwd, homeDir, requestWorkspace]);

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

    /*
      A file from somewhere else entirely — another project's folder, printed
      by a Claude conversation or a command run there. The backend confines
      reads to the open folder, so this has to move the workspace before the
      file can be read at all.

      The request isn't consumed here. `requestWorkspace` may take a detour
      through the unsaved-changes prompt, and when the root does change this
      effect runs again with the path now inside it and opens the file — which
      is also what makes a declined switch simply do nothing rather than lose
      the request.
    */
    if (!within(root, openRequest.path)) {
      if (workspaceAsked.current !== openRequest.token) {
        workspaceAsked.current = openRequest.token;
        // The folder the link came from, when the file is actually inside it —
        // a Claude project can reach folders outside its own root, and adopting
        // a root the file isn't under would fail the same way again. Otherwise
        // the file's own directory, which is always a folder that contains it.
        const origin = openRequest.root;
        requestWorkspace(origin && within(origin, openRequest.path) ? origin : dirname(openRequest.path));
      }
      return;
    }

    lastRequest.current = openRequest.token;
    void openPath(openRequest.path, openRequest.line, openRequest.column);
  }, [openRequest, visible, root, rootReady, openPath, requestWorkspace]);

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
  }, [activeBufferId, buffers.length, goToToken]);

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
      if (!buffer) return false;

      if (!buffer.path) {
        setSaveAsFor(bufferId);
        return false;
      }
      if (buffer.readonly) {
        setError(`${buffer.name} is read-only`);
        return false;
      }

      /*
        Formatted before the text is read, not after: the formatter rewrites the
        buffer through CodeMirror as one undoable edit, so what gets written is
        the formatted text and a ⌘Z puts back what was typed. Reading the content
        first would save the unformatted version and leave the buffer dirty again
        the moment the edit landed.

        A server without a formatter, or a buffer without a server, resolves
        false and the save carries on unformatted — that is not a failure worth
        a message.
      */
      if (useEditorStore.getState().settings.lspFormatOnSave) {
        try {
          await surfaceRef.current?.formatBuffer(bufferId);
        } catch {
          // Formatting is a convenience; never let it stop a save.
        }
      }

      const content = surfaceRef.current?.getContent(bufferId);
      if (content === null || content === undefined) return false;

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
        // Several servers only run their heavier checks on save — and some only
        // re-resolve imports then — so a save the server isn't told about is a
        // save whose diagnostics never update.
        surfaceRef.current?.notifySaved(bufferId);
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

  /**
   * Follows a rename or a move the explorer has already made on disk.
   *
   * The store re-points every affected tab; the surface has to be told
   * separately, because a buffer's CodeMirror record carries a path of its own.
   * That path is what a language server knows the document as and what an
   * incoming workspace edit is matched against, so a renamed file left holding
   * its old one had its edits written to disk behind the tab showing it — and
   * its server went on answering about a URI that no longer exists.
   *
   * Pushed from the store rather than re-derived here: `pathMoved` has already
   * done the prefix arithmetic for a whole folder that moved, and `repath`
   * ignores a buffer whose path didn't change.
   */
  const followMove = useCallback(
    (from: string, to: string) => {
      pathMoved(from, to);
      const surface = surfaceRef.current;
      if (!surface) return;
      for (const buffer of useEditorStore.getState().buffers) {
        if (buffer.path) surface.repath(buffer.id, buffer.path);
      }
    },
    [pathMoved]
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
  }, [visible, raise]);


  /**
   * Focus follows the editor when it opens.
   *
   * Nothing did this, and the effect was that the editor looked like it had no
   * keyboard at all: the modal drew over a terminal that still held focus, so
   * every keystroke — the editor's own chords, ⌘C and ⌘V included — went to the
   * shell underneath, and clicking into the text was the only way to wake it
   * up. The surface takes focus when it *activates* a buffer, which is why the
   * very first open worked and every reopen after it didn't: the tab was
   * already active, so there was nothing to activate.
   *
   * Deferred a frame because the modal has only just stopped being
   * `display: none` — CodeMirror measures against a laid-out element, and
   * `refresh` here is what stops the caret landing in the wrong column. With
   * no file open the modal itself takes focus, so its chords still work from
   * the empty state.
   *
   * `activeBufferId` is read through a ref rather than depended on: switching
   * tabs must not pull focus back out of the tree or the search panel.
   */
  const activeBufferRef = useRef(activeBufferId);
  activeBufferRef.current = activeBufferId;

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      surfaceRef.current?.refresh();
      if (activeBufferRef.current) surfaceRef.current?.focus();

      // Checked rather than assumed: with no file open there is no surface to
      // focus, and behind a binary preview the surface is `invisible` and
      // can't take focus even though a buffer is active. Either way the modal
      // holds the keyboard itself, so its own chords still land.
      const modal = modalRef.current;
      if (modal && !modal.contains(document.activeElement)) modal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

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

  /**
   * ⌘W, arriving by way of the native menu — see `AppShell` for why it can't
   * simply be bound here. Compared against the last count seen rather than
   * fired on every change, so the value the editor mounts with closes nothing.
   */
  const closeTabSeen = useRef(closeTabRequest);
  useEffect(() => {
    if (closeTabRequest === closeTabSeen.current) return;
    closeTabSeen.current = closeTabRequest;
    if (activeBufferId) requestCloseBuffer(activeBufferId);
  }, [closeTabRequest, activeBufferId, requestCloseBuffer]);

  /**
   * ⌘Z, ⇧⌘Z and ⌘A, by way of the native menu.
   *
   * Declined unless the text actually holds the keyboard: with the editor
   * hidden, or the caret in the search field or the quick-open box, these are
   * that field's and `AppShell` should let the webview have them.
   */
  useEffect(() => {
    chordRef.current = (command) => {
      const surface = surfaceRef.current;
      if (!visible || !surface?.hasFocus()) return false;
      surface.command(command);
      return true;
    };
    return () => {
      chordRef.current = null;
    };
  }, [visible, chordRef]);

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
   * Which side of the editor the explorer, search and git column takes.
   *
   * Declared up here because the resize callbacks below depend on it, and a
   * `const` read from a dependency array above its own declaration is a
   * temporal-dead-zone throw on every render rather than a lint.
   */
  const panelSide = editorSettings.sidePanelSide;

  /**
   * Drags the divider beside one of the side panes.
   *
   * `side` is which side of the editor the pane is on, and it decides the sign
   * of the whole gesture: a pane to the *right* of its divider grows as the
   * pointer moves left, one to the left grows as it moves right. Hard-coded to
   * the first, the explorer shrank when you dragged it wider the moment it
   * could sit on the left.
   *
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
        side: "left" | "right";
        onDrag: (width: number | null) => void;
        onCommit: (width: number) => void;
      }
    ) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      let latest = pane.width;

      const onMove = (ev: PointerEvent) => {
        const travelled = ev.clientX - startX;
        const next = pane.side === "right" ? pane.width - travelled : pane.width + travelled;
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
        // Whichever mode the right-hand column is in, it is the same
        // width out of the same total.
        max: paneLimit(
          MAX_EXPLORER,
          (previewOpen && isMarkdown) || agentOpen ? previewWidth : 0
        ),
        side: panelSide,
        onDrag: setDragWidth,
        onCommit: setExplorerWidth,
      }),
    [
      startPaneResize,
      explorerWidth,
      setExplorerWidth,
      paneLimit,
      previewOpen,
      agentOpen,
      isMarkdown,
      previewWidth,
      panelSide,
    ]
  );

  const startPreviewResize = useCallback(
    (e: React.PointerEvent) =>
      startPaneResize(e, {
        width: previewWidth,
        min: MIN_PREVIEW,
        max: paneLimit(MAX_PREVIEW, explorerVisible ? explorerWidth : 0),
        // The preview stays to the right of the text whichever side the panel
        // takes: panel, editor, preview is the arrangement every editor with
        // both has, and a preview on the left would put the rendered document
        // on the far side of the tree from the source it is of.
        side: "right",
        onDrag: setPreviewDragWidth,
        onCommit: setPreviewWidth,
      }),
    [startPaneResize, previewWidth, setPreviewWidth, paneLimit, explorerVisible, explorerWidth]
  );

  const toggleFullscreen = useCallback(() => {
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
  /*
    No folder, no panel. The explorer, search and source control all describe a
    folder, so with none open the column has nothing to say — and showed a
    blank 260px of chrome beside the one screen asking you to pick one.
  */
  const panelShown = explorerVisible && !!root;
  const previewShown = previewOpen && isMarkdown;
  /** Whether the column opposite the explorer is taking any width. */
  const rightShown = previewShown || agentOpen;

  /**
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
  /**
   * What the agent panel is handed, read at the moment a message is
   * sent.
   *
   * A function rather than a prop, because the selection changes on
   * every click of the mouse and a prop would re-render the panel's
   * whole transcript each time. Nothing here is watched; it is read
   * once, when somebody presses enter.
   *
   * Paths come out relative to the project, which is what the agent's
   * own tools take — an absolute path would be refused by the fence
   * the moment it tried to `read` it.
   */
  const lookAtEditor = useCallback((): EditorContext => {
    const open = buffers.find((buffer) => buffer.id === activeBufferId) ?? null;
    const within = (path: string | null) =>
      path && root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

    return {
      file: within(open?.path ?? null),
      // Names, not paths: the point is "these are the files in play",
      // and a column of absolute paths in a prompt is mostly the same
      // prefix repeated.
      tabs: buffers.filter((buffer) => buffer.id !== activeBufferId).map((b) => b.name),
      selection: surfaceRef.current?.getSelection() ?? null,
    };
  }, [buffers, activeBufferId, root]);

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
  // it closes rather than showing a stale document. The agent is about
  // whatever file is in front of it, so it survives the same switch.
  useEffect(() => {
    if (!activeBuffer || isMarkdown || !previewOpen) return;
    setRightPane("none");
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

  /**
   * Resolves once the surface has built a buffer's CodeMirror state.
   *
   * Opening a file only puts a buffer in the store; its document is created by
   * an effect, and asynchronously at that, because the grammar is a dynamic
   * import. So anything that has to *write into* a buffer it has just opened
   * must wait, exactly as the queued cursor move does — `setContent` on a
   * buffer with no record yet is a silent no-op.
   *
   * False means it never appeared, which is the caller's cue not to treat the
   * write as having happened.
   */
  const whenBufferLive = useCallback(
    (bufferId: string) =>
      new Promise<boolean>((resolve) => {
        let frames = 0;
        const attempt = () => {
          if (surfaceRef.current?.getContent(bufferId) != null) {
            resolve(true);
            return;
          }
          // Two seconds at 60Hz. A grammar chunk that hasn't arrived by then
          // is not going to.
          if (frames++ < 120) requestAnimationFrame(attempt);
          else resolve(false);
        };
        requestAnimationFrame(attempt);
      }),
    []
  );

  /**
   * Recovers journalled drafts from a session that ended badly.
   *
   * Two rules, and both exist because getting them wrong loses the work this
   * whole mechanism was built to keep:
   *
   * - The draft is written only once the buffer's document exists. Writing it
   *   immediately after opening the file landed on nothing, so the tab came
   *   back holding what was on *disk* while being marked unsaved.
   * - A draft is only forgotten once it has actually been restored. It used to
   *   be cleared whether or not the file could be reopened, so a draft for a
   *   file that had since been deleted, moved out of the workspace, or renamed
   *   was deleted along with it — permanently, and without a word.
   */
  const restoreDrafts = useCallback(
    async (drafts: ReturnType<typeof listDrafts>) => {
      setDraftPrompt(null);
      const kept: string[] = [];

      for (const { id, draft } of drafts) {
        const bufferId = draft.path
          ? await openPath(draft.path)
          : openScratch(draft.languageId);

        if (!bufferId || !(await whenBufferLive(bufferId))) {
          kept.push(draft.name);
          continue;
        }

        // `clean: false` — the draft differs from disk deliberately, so the
        // buffer has to come back dirty and saveable. The surface works out
        // and reports the dirtiness itself by comparing against the baseline,
        // which is also the honest answer when a draft turns out to match what
        // was saved after all.
        surfaceRef.current?.setContent(bufferId, draft.content, { clean: false });
        clearDraft(id);
      }

      if (kept.length > 0) {
        setError(
          `Could not reopen ${kept.join(", ")} — the unsaved changes are still stored and will be offered again.`
        );
      }
    },
    [openPath, openScratch, whenBufferLive]
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

  /**
   * Picks what the side column shows, opening it if it was collapsed.
   *
   * Clicking the tab you are already on collapses the column, which is what
   * every editor's activity bar does and the only way to get back to a full
   * width editor without hunting for the separate collapse button.
   */
  const openPanel = useCallback(
    (mode: "files" | "search" | "git") => {
      setSidePanel(mode);
      setExplorerVisible(true);
    },
    [setExplorerVisible]
  );

  const showPanel = useCallback(
    (mode: "files" | "search" | "git") => {
      if (explorerVisible && sidePanel === mode) {
        setExplorerVisible(false);
        return;
      }
      openPanel(mode);
    },
    [explorerVisible, sidePanel, setExplorerVisible, openPanel]
  );

  // --- Git -----------------------------------------------------------------

  /**
   * Whether the file in front is one git has been told to ignore.
   *
   * Worth its own check because an ignored file is *untracked*, and git reports
   * an untracked file as wholly new — so the change gutter marks every line as
   * added. On a build artefact, a lock file or a `.env` that is a column of
   * green down the whole buffer describing nothing: the file was never going to
   * be committed, so "all of this is new work" is not true in any useful sense.
   */
  const activeIgnored = useMemo(
    () => (activeBuffer?.path ? isIgnored(activeBuffer.path, gitIgnoredPaths) : false),
    [activeBuffer?.path, gitIgnoredPaths]
  );

  /** The file in front, as git names it. Null outside a repository. */
  const gitPath = useMemo(
    () =>
      git.root && activeBuffer?.path && !activeIgnored
        ? repoRelative(git.root, activeBuffer.path)
        : null,
    [git.root, activeBuffer?.path, activeIgnored]
  );

  /**
   * The change gutter's data for the open file.
   *
   * Refetched on the watcher rather than on the status list: a file that is
   * already "M" stays "M" when you save it again, so nothing in the status
   * would change, while the lines that differ change completely.
   */
  useEffect(() => {
    if (!visible || !root || !rootReady || !git.isRepo || !gitPath) {
      setGitDiff(null);
      return;
    }

    let cancelled = false;
    let settled = false;
    // Cleared only if the answer is slow: blanking the gutter on every save
    // and then filling it back in a frame later reads as a flicker.
    const blank = setTimeout(() => {
      if (!settled) setGitDiff(null);
    }, 150);

    void gitFileHunks(root, gitPath)
      .then((diff) => {
        settled = true;
        if (!cancelled) setGitDiff(diff);
      })
      .catch(() => {
        settled = true;
        // A file git can't diff — one just deleted underneath us, a submodule —
        // simply has no marks. Nothing to say about it.
        if (!cancelled) setGitDiff(null);
      });

    return () => {
      cancelled = true;
      clearTimeout(blank);
    };
  }, [visible, root, rootReady, git.isRepo, gitPath, change.token, gitTick]);

  /**
   * Who last changed each line of the open file.
   *
   * Refetched on the same signals as the change gutter, and for the same
   * reason: a commit, a checkout or a pull rewrites the answer for every line
   * while leaving the file on disk untouched.
   *
   * Cleared outright when there is nothing to ask about — no repository, no
   * path, or the setting off — rather than left holding the last file's blame,
   * which would annotate one file with another's history.
   *
   * A failure is not reported. `git blame` fails on a file git has never seen,
   * on one inside a submodule, and on a repository with no commits yet; none of
   * those is a problem the person reading the file has, and an error bar over
   * the editor would be the only way they ever heard about it.
   */
  useEffect(() => {
    if (!visible || !root || !rootReady || !git.isRepo || !gitPath || !editorSettings.gitBlame) {
      blamePath.current = null;
      setBlame(null);
      return;
    }

    // Only when the *file* changed. Refetching after a commit or a save is the
    // same file with new answers, and blanking the annotation there would make
    // it blink on every keystroke that triggers a status pass.
    if (blamePath.current !== gitPath) {
      blamePath.current = gitPath;
      setBlame(null);
    }

    let cancelled = false;
    void gitBlame(root, gitPath)
      .then((answer) => {
        if (!cancelled) setBlame(answer);
      })
      .catch(() => {
        if (!cancelled) setBlame(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    visible,
    root,
    rootReady,
    git.isRepo,
    gitPath,
    editorSettings.gitBlame,
    change.token,
    gitTick,
  ]);

  /**
   * Runs something that changes the repository.
   *
   * The refresh is in `finally` rather than after the await: a stage that
   * fails halfway has still changed the index, and a panel showing the state
   * from before is worse than one showing the mess.
   */
  const runGit = useCallback(
    async (action: (dir: string) => Promise<void>) => {
      if (!root) return;
      setGitBusy(true);
      try {
        await action(root);
      } finally {
        setGitBusy(false);
        setGitTick((tick) => tick + 1);
        refreshGit();
      }
    },
    [root, refreshGit]
  );

  /**
   * Throws away working-tree changes — the one git action here that destroys
   * something, hence the confirmation the caller has already collected.
   *
   * Untracked files are split out and deleted through the filesystem layer, so
   * they go to the trash. `git clean` would be the obvious spelling and it is
   * the wrong one: it unlinks, and "discard" on a file git has never seen
   * would then be the only unrecoverable button in the editor.
   */
  const discardFiles = useCallback(
    (files: GitFile[]) => {
      const untracked = files.filter((file) => file.unstaged === "untracked");
      const tracked = files.filter((file) => file.unstaged !== "untracked");

      void runGit(async (dir) => {
        if (tracked.length > 0) {
          await gitDiscard(dir, tracked.map((file) => file.relative));
        }
        for (const file of untracked) {
          await deletePath(file.path, true);
        }
      }).catch((e) => setError(String(e)));
    },
    [runGit]
  );

  /**
   * Makes the index match the panel's checkboxes, then commits.
   *
   * The panel doesn't show the index — see `SourceControl` — so it can't assume
   * anything about what is already staged. Unstaging the unticked files is the
   * half that's easy to forget and the half that matters: without it, a file
   * staged from the terminal and then unticked here would still be committed.
   *
   * Not routed through `runGit`, because the panel shows the failure itself,
   * next to the message box that caused it.
   */
  const commitFiles = useCallback(
    async (message: string, include: GitFile[]) => {
      if (!root) return;
      const included = new Set(include.map((file) => file.relative));
      const excluded = git.files.filter((file) => !included.has(file.relative));

      setGitBusy(true);
      try {
        if (excluded.length > 0) {
          await gitUnstage(root, excluded.map((file) => file.relative));
        }
        if (include.length > 0) {
          await gitStage(root, include.map((file) => file.relative));
        }
        await gitCommit(root, message);
      } finally {
        setGitBusy(false);
        setGitTick((tick) => tick + 1);
        refreshGit();
      }
    },
    [root, git.files, refreshGit]
  );

  const openDiff = useCallback((file: GitFile) => {
    setDiffTarget({ kind: "working", file });
    setDiffFocused(true);
  }, []);

  const openCommitDiff = useCallback((commit: GitCommit, file: GitCommitFile) => {
    setDiffTarget({ kind: "commit", commit, file });
    setDiffFocused(true);
  }, []);

  /**
   * Fetch and push, which are the only two things here that leave the machine.
   *
   * The error is re-thrown rather than shown in the error bar: the panel puts
   * it next to the button that caused it, and "everything up to date" or a
   * rejected non-fast-forward is about that button, not about the editor.
   */
  const syncRemote = useCallback(
    async (which: "fetch" | "pull" | "push"): Promise<string> => {
      if (!root) return "";
      setGitBusy(true);
      try {
        // Returned, not discarded: git reports a successful push on stderr, and
        // "Everything up-to-date" is an answer rather than a non-event.
        if (which === "fetch") return await gitFetch(root);
        if (which === "pull") return await gitPull(root);
        return await gitPush(root);
      } finally {
        setGitBusy(false);
        setGitTick((tick) => tick + 1);
        refreshGit();
      }
    },
    [root, refreshGit]
  );

  const closeDiff = useCallback(() => {
    setDiffTarget(null);
    setDiffFocused(false);
  }, []);

  /** True only when the diff is what the editor column is showing. */
  const diffShown = !!diffTarget && diffFocused;

  /** The diff text for whatever the panel asked to see. */
  useEffect(() => {
    if (!diffTarget || !root) return;

    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    setDiffText(null);

    const request =
      diffTarget.kind === "working"
        ? gitFileDiff(root, diffTarget.file.relative)
        : gitCommitDiff(root, diffTarget.commit.sha, diffTarget.file.relative);

    void request
      .then((text) => {
        if (cancelled) return;
        setDiffText(text);
        setDiffLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setDiffError(String(e));
        setDiffLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [diffTarget, root, change.token, gitTick]);

  /**
   * A working-tree diff for a file that has stopped having changes is an empty
   * panel, so it closes itself. A commit's diff is history and never goes
   * stale, which is why only one of the two is checked.
   */
  useEffect(() => {
    if (diffTarget?.kind !== "working") return;
    const still = git.files.some((file) => file.relative === diffTarget.file.relative);
    if (!still) closeDiff();
  }, [git.files, diffTarget, closeDiff]);

  // --- Go to line ----------------------------------------------------------

  /**
   * Where the view was when the overlay opened, so cancelling puts it back.
   *
   * The overlay scrolls the editor as the number is typed — which is the point
   * of it, and useless if abandoning the jump leaves you somewhere else.
   */
  const goToOrigin = useRef<number | null>(null);

  const openGoToLine = useCallback(() => {
    if (!activeBufferId) return;
    goToOrigin.current = surfaceRef.current?.topLine() ?? null;
    setGoToOpen(true);
  }, [activeBufferId]);

  /*
    Re-read on every tab switch, and once the buffer's state exists — which is
    asynchronous, because its grammar is a dynamic import, so a single read at
    activation lands before there is anything to read.
  */
  useEffect(() => {
    if (!activeBufferId) return;
    let frames = 0;
    let raf = 0;
    const read = () => {
      const surface = surfaceRef.current;
      if (surface?.getContent(activeBufferId) !== null && surface) {
        setIndent(surface.getIndent());
        return;
      }
      if (frames++ < 60) raf = requestAnimationFrame(read);
    };
    raf = requestAnimationFrame(read);
    return () => cancelAnimationFrame(raf);
  }, [activeBufferId, buffers.length]);

  const closeGoToLine = useCallback(() => {
    setGoToOpen(false);
    goToOrigin.current = null;
    surfaceRef.current?.focus();
  }, []);

  const previewGoToLine = useCallback((line: number | null) => {
    const target = line ?? goToOrigin.current;
    if (target !== null) surfaceRef.current?.scrollToLine(target);
  }, []);

  // --- Context menu --------------------------------------------------------

  /**
   * A right-click on the text.
   *
   * What was selected is read now rather than when an item is clicked: the menu
   * says "Copy" or "Copy Line" depending on it, and by the time the click
   * arrives the answer would be whatever the menu itself did to the selection.
   */
  const openSurfaceMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setSurfaceMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: surfaceRef.current?.hasSelection() ?? false,
    });
  }, []);

  const runSurfaceCommand = useCallback((command: SurfaceCommand) => {
    setSurfaceMenu(null);
    surfaceRef.current?.command(command);
  }, []);

  /** Copy Path and its relative twin; the failure is silent, as elsewhere. */
  const copyToClipboard = useCallback((text: string) => {
    setSurfaceMenu(null);
    void navigator.clipboard.writeText(text).catch(() => {});
  }, []);

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
        if (settingsOpen) setSettingsOpen(false);
        else if (quickOpen) setQuickOpen(false);
        else if (goToOpen) closeGoToLine();
        else if (diffShown) closeDiff();
        // Search and source control step back to the tree before Escape closes
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
            // Shows rather than toggles: a chord that closed the panel you
            // just asked for reads as a missed keystroke.
            openPanel("search");
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
      settingsOpen,
      quickOpen,
      goToOpen,
      closeGoToLine,
      diffShown,
      closeDiff,
      sidePanel,
      onClose,
      saveAll,
      saveActive,
      explorerVisible,
      setExplorerVisible,
      openPanel,
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

  /** Wide enough for the switcher's tabs to be worth labelling. */
  const wideControls =
    panelShown && (dragWidth ?? explorerWidth) >= LABELLED_CONTROLS;

  const gitPanelTitle = git.isRepo
    ? `Source control — ${git.files.length} change${git.files.length === 1 ? "" : "s"}`
    : "Source control";

  /**
   * The three controls that act on the side panel, kept with the panel.
   *
   * They move to whichever side it is on, because a button that opens a column
   * on the left does not belong at the far right of the bar — the eye looks for
   * the control where the thing it controls is, which is the whole reason an
   * activity bar sits against its own sidebar rather than opposite it.
   *
   * Reversed rather than written out twice, so the toggle stays the outermost
   * of the three either way: nearest the window's edge, and so nearest the
   * panel it shows and hides. Quick open and Settings stay put — a palette and
   * a dialog are not the panel's, and moving them would be moving furniture
   * for its own sake.
   *
   * The rule is the group's first child and so draws on whichever side faces
   * the rest of the bar; see `.editor-toolbar-sep`. Without it the panel's
   * controls and the file arrows run together into one row of icons with
   * nothing to say they do different things.
   *
   * **With the panel open the group is as wide as the panel**, which lands the
   * rule exactly on the panel's own divider and splits the bar where the view
   * below it is split — the Finder and Xcode arrangement, and the thing that
   * makes the icons read as belonging to the column rather than as floating
   * beside it. The width is the panel's, less the toolbar's padding, plus the
   * divider the rule stands in for; the row below the toolbar has no padding,
   * which is the whole of why that arithmetic is needed.
   *
   * Hidden, it has no width to spread into and collapses to the icons
   * themselves, which is the right answer for a group that is then pointing at
   * nothing.
   */
  /*
    Nothing to point at, so nothing to show.

    `panelShown` is already `explorerVisible && !!root`, so with no workspace
    the column cannot open — but its switcher was drawn anyway, offering Files,
    Search and Source Control for a folder that does not exist. Three tabs and
    a toggle that could not do anything, sitting beside a welcome screen whose
    whole message is "pick a folder first".
  */
  const panelControls = !root ? null : (
    <div
      className={`flex items-center gap-1 shrink-0 ${
        panelSide === "left" ? "flex-row-reverse" : ""
      }`}
      style={
        panelShown
          ? {
              width: (dragWidth ?? explorerWidth) - TOOLBAR_PAD + DIVIDER_W,
              // Never narrower than the icons: a panel dragged to its minimum
              // in picture-in-picture must not push them out of their own box.
              minWidth: "fit-content",
            }
          : undefined
      }
    >
      <span className="editor-toolbar-sep" aria-hidden />
      {/*
        The three things the side column can be, as one switcher rather than
        as a loose button and a pair. They are the same kind of choice — which
        mode the one column is in — and search sitting outside the group said
        they were not, which is exactly the confusion a radio group exists to
        remove.

        It grows into the width the group has, so with the panel open the tabs
        are the panel's width between them rather than three 20px glyphs at one
        end of a 260px space. `flex-1` here, unlike the source-control tabs it
        is drawn as: those carry one word each, these carry a word and an icon
        and look lopsided at three different widths.
      */}
      {/*
        The drawing window's switcher, which this now shares — see
        `SegmentedTabs`. It was three underlined tabs with a coloured fill on
        the selected one, which is a different shape for the same question the
        other window answers with a sliding pill.

        **`standby` is the editor's own addition to it.** The column can be
        collapsed while still being *on* Search, and those are two facts. The
        pill stays where it is and goes hollow, so the control says both: this
        mode, and not open right now. Collapsing used to leave all three
        looking alike, with nothing to say which one ⌘B would bring back.
      */}
      <SegmentedTabs
        segments={PANEL_MODES.map((mode) => ({
          value: mode.id,
          label: mode.label,
          icon: mode.icon,
          title: mode.id === "git" ? gitPanelTitle : mode.title,
          aria: mode.aria,
          /*
            The number, where the source-control panel's own Changes tab puts
            one — and the same chip, so the two agree about what it means. A
            bare dot said only "something"; this says how much, which is the
            question anybody glancing at it has.
          */
          badge:
            mode.id === "git" && git.files.length > 0 ? (
              <span
                className={`editor-scm-tabcount tabular-nums ${
                  panelShown && sidePanel === "git" ? "on" : ""
                }`}
              >
                {git.files.length}
              </span>
            ) : undefined,
        }))}
        value={sidePanel}
        onChange={showPanel}
        ariaLabel="Side panel"
        showLabels={wideControls}
        standby={!panelShown}
        className={panelShown ? "flex-1 min-w-0" : "shrink-0"}
      />
      <button
        className={`editor-btn p-1 rounded shrink-0 ${explorerVisible ? "on" : ""}`}
        onClick={() => setExplorerVisible(!explorerVisible)}
        title={explorerVisible ? "Hide the side panel (⌘B)" : "Show the side panel (⌘B)"}
        aria-label="Toggle the side panel"
      >
        {/*
          Two things at once, and it used to say only the first: which side the
          column is on, and whether it is there. The plain panel glyph was the
          same open and closed, so the button that hides the panel looked
          exactly like the button that brings it back.

          The paired icons carry both — the panel is drawn on its own side, and
          the arrow points the way pressing it would move things.
        */}
        {panelSide === "left" ? (
          explorerVisible ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />
        ) : explorerVisible ? (
          <PanelRightClose size={13} />
        ) : (
          <PanelRightOpen size={13} />
        )}
      </button>
    </div>
  );

  /**
   * The explorer, search or source control column, and its divider.
   *
   * Built once and placed on whichever side the setting asks for, rather than
   * written out twice: two copies of a 60-line subtree are two copies to keep
   * in step, and the divider has to sit between the column and the editor
   * either way — so on the left the divider follows the panel and on the right
   * it leads it.
   */
  const sidePanelColumn = (
    <>
      {panelSide === "right" && (
        <div
          className="editor-divider shrink-0"
          onPointerDown={startExplorerResize}
          role="separator"
          aria-orientation="vertical"
        />
      )}
      <div
        className={`shrink-0 min-h-0 editor-sidepanel on-${panelSide}`}
        style={{ width: (dragWidth ?? explorerWidth) }}
      >
        {sidePanel === "git" && root && rootReady ? (
          <SourceControl
            repo={git}
            dir={root}
            remote={gitRemote}
            error={gitError}
            busy={gitBusy}
            revision={`${gitTick}:${change.token}`}
            onRefresh={refreshGit}
            // The line comes from the conflict report, which links
            // each marker to the place it is.
            onOpenFile={(path, line) => void openPath(path, line)}
            onOpenDiff={openDiff}
            onOpenCommitDiff={openCommitDiff}
            onDiscard={setDiscardPrompt}
            onCommit={commitFiles}
            onFetch={() => syncRemote("fetch")}
            onPull={() => syncRemote("pull")}
            onPush={() => syncRemote("push")}
            onError={setError}
            onClose={() => setSidePanel("files")}
          />
        ) : sidePanel === "search" && root && rootReady ? (
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
            onMoved={followMove}
            onForgetExpanded={collapse}
            onError={setError}
            change={treeChange}
            gitFiles={gitDecorations.files}
            gitDirs={gitDecorations.dirs}
            gitIgnored={gitIgnoredPaths}
          />
        ) : null}
      </div>
      {panelSide === "left" && (
        <div
          className="editor-divider shrink-0"
          onPointerDown={startExplorerResize}
          role="separator"
          aria-orientation="vertical"
        />
      )}
    </>
  );

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
        className={`overlay-layer fixed inset-0 ${
          docked
            ? "flex"
            : `z-[240] items-start justify-center pt-[4vh] ${visible ? "flex" : "hidden"}`
        }`}
        style={{ zIndex: docked ? BASE_SLOT_Z : (frontZ ?? undefined) }}
        onPointerDownCapture={raise}
        /*
          A click beside a window does not close it.

          These windows hold work in progress — a request in flight, a buffer
          with unsaved edits, a conversation mid-turn — and a backdrop that
          dismisses on a stray click is how that gets lost by reaching for the
          thing behind it. They close by their own button, by Escape, or not at
          all. FigyCode never did dismiss this way; now none of them do.

          The layer still has to swallow the click rather than let it fall
          through to whatever is underneath.
        */
        onMouseDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <div
          ref={modalRef}
          /*
            Focusable so the modal can hold focus itself when no file is open.
            Its `onKeyDown` only fires for keys aimed at something inside it,
            and with an empty tab strip there is nothing inside it to aim at —
            so ⌘P, ⌘B and Escape had nowhere to land.
          */
          tabIndex={-1}
          className={`editor-modal overflow-hidden shadow-2xl flex flex-col focus:outline-none ${
            fullscreen || docked ? "editor-fullscreen" : "rounded-xl"
          }`}
          style={modalStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
          // Suppresses the webview's own menu over the chrome. The text surface
          // and the file tree raise their own instead.
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Tab strip, doubling as the drag handle */}
          <div className="flex items-stretch editor-chrome">
            <div
              className={`editor-brand editor-tabstrip flex items-center gap-2 pl-3 pr-2.5 shrink-0 ${
                docked ? "" : "cursor-grab active:cursor-grabbing"
              }`}
              onPointerDown={docked ? undefined : onDragStart}
            >
              {docked && <PrimaryHome className="-ml-1 mr-0.5" />}
              <img src="/logo.png" alt="" className="h-3.5 w-auto shrink-0" />
              <span className="editor-brand-title text-[11px] font-semibold whitespace-nowrap">
                Figy Code Editor
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <EditorTabs
                buffers={buffers}
                // Nulled while the diff is in front, or two tabs would look
                // active at once.
                activeBufferId={diffShown ? null : activeBufferId}
                diff={
                  diffTarget
                    ? {
                        // Literally this, and without an extension: it is not a
                        // file, and a tab reading `lib.rs` next to the tab for
                        // `lib.rs` would be two tabs claiming to be the same
                        // thing.
                        title: "diff-check",
                        detail: diffIdentity(diffTarget).revision
                          ? `${diffIdentity(diffTarget).relative} at ${
                              diffIdentity(diffTarget).revision
                            }`
                          : diffIdentity(diffTarget).relative,
                        active: diffFocused,
                        onSelect: () => setDiffFocused(true),
                        onClose: closeDiff,
                      }
                    : null
                }
                onSelect={(id) => {
                  setDiffFocused(false);
                  setActiveBuffer(id);
                }}
                onClose={requestCloseBuffer}
                onNewScratch={() => {
                  setDiffFocused(false);
                  openScratch();
                }}
                onReorder={reorderBuffers}
                onDragHandle={docked ? undefined : onDragStart}
              />
            </div>
            <div className="flex items-center gap-0.5 px-2 shrink-0 editor-tabstrip">
              {/*
                No window controls on the base. Every one of these is an answer
                to "put this away", and the base is what is left when
                everything is put away. Changing it is a settings decision.
              */}
              {!docked && (
                <>
                  <MakePrimary id="figy-code-editor" />
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
                </>
              )}
            </div>
          </div>

          {/* Breadcrumb / toolbar */}
          <div className="editor-chrome editor-toolbar flex items-center gap-1 px-2 py-1">
            {panelSide === "left" && panelControls}
            {/*
              These say "file", so they step away from the diff rather than
              paging the file underneath it out of sight.

              Gated on a workspace, not merely disabled by it: with no folder
              open there are no buffers to step between, so the pair sat greyed
              out beside the welcome screen the whole time it was up — and a
              control that is never enabled is not a control.
            */}
            {root && (
              <>
                <button
                  className="editor-btn p-1 rounded"
                  onClick={() => {
                    const index = buffers.findIndex((b) => b.id === activeBufferId);
                    setDiffFocused(false);
                    if (index > 0) setActiveBuffer(buffers[index - 1].id);
                  }}
                  disabled={
                    !diffShown && buffers.findIndex((b) => b.id === activeBufferId) <= 0
                  }
                  title="Previous file"
                  aria-label="Previous file"
                >
                  <ArrowLeft size={13} />
                </button>
                <button
                  className="editor-btn p-1 rounded"
                  onClick={() => {
                    const index = buffers.findIndex((b) => b.id === activeBufferId);
                    setDiffFocused(false);
                    if (index >= 0 && index < buffers.length - 1) {
                      setActiveBuffer(buffers[index + 1].id);
                    }
                  }}
                  disabled={
                    !diffShown &&
                    buffers.findIndex((b) => b.id === activeBufferId) >= buffers.length - 1
                  }
                  title="Next file"
                  aria-label="Next file"
                >
                  <ArrowRight size={13} />
                </button>
              </>
            )}

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
              {/*
                The crumbs are the *active file's* path, so with the diff in
                front they name a file you are not looking at — the last tab's,
                which is exactly as confusing as it sounds. The diff carries its
                own path in its header. The workspace chip above stays: it is
                the workspace switcher rather than part of a path, and it is the
                only way to reach it from here.
              */}
              {!diffShown &&
                crumbs.map((crumb) => (
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

            {/* Both act on the file, not on the diff. */}
            {activeBuffer && !diffShown && (
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

                  **The eye closes when the preview is open.** It used to be the
                  same open eye in both states, with nothing but a faint tint to
                  say which one you were in — so the button neither told you
                  whether the preview was showing nor what pressing it would do,
                  and the only way to find out was to press it. A struck-through
                  eye is the one glyph everybody already reads as "hide this".

                  The *label* stays "Preview" rather than flipping to "Hide":
                  it names the thing the button is about, and a word that
                  changes length makes the whole toolbar jump every time the
                  preview is toggled.
                */}
                {isMarkdown && (
                  <button
                    className={`editor-btn-text flex items-center gap-1.5 px-2 py-1 rounded shrink-0 ${
                      previewOpen ? "on" : ""
                    }`}
                    // The outline rides inside the preview now, so opening one
                    // brings the other with no panel juggling.
                    onClick={() =>
                      setRightPane((pane) => (pane === "preview" ? "none" : "preview"))
                    }
                    title={
                      previewOpen
                        ? "Hide the Markdown preview"
                        : "Show the Markdown preview"
                    }
                    aria-pressed={previewOpen}
                  >
                    {previewOpen ? <EyeOff size={12} /> : <Eye size={12} />}
                    <span className="text-[10px]">Preview</span>
                  </button>
                )}
              </>
            )}

            {/*
              The column's other mode.

              Beside Preview rather than in a menu, and gated on the
              *folder* rather than on a buffer: "what is in this project"
              is a fair question with no file open, and the panel says so
              itself when there is nothing to look at. Opening it closes
              the preview, which is the point of one column with modes —
              there is never a question of which of the two the editor is
              being squeezed by.
            */}
            {root && (
              <button
                className={`editor-btn-text flex items-center gap-1.5 px-2 py-1 rounded shrink-0 ${
                  agentOpen ? "on" : ""
                }`}
                onClick={() => setRightPane((pane) => (pane === "agent" ? "none" : "agent"))}
                title={agentOpen ? "Hide the agent" : "Ask the agent about this file"}
                aria-pressed={agentOpen}
              >
                <Bot size={12} />
                <span className="text-[10px]">Agent</span>
              </button>
            )}

            {/* Searches the workspace, so it needs one. */}
            {root && (
              <button
                className="editor-btn p-1 rounded"
                onClick={() => setQuickOpen(true)}
                title="Go to file (⌘P)"
                aria-label="Go to file"
              >
                <Search size={13} />
              </button>
            )}
            <button
              className={`editor-btn p-1 rounded ${settingsOpen ? "on" : ""}`}
              onClick={() => setSettingsOpen(true)}
              title="Editor settings"
              aria-label="Editor settings"
            >
              <Settings2 size={13} />
            </button>
            {panelSide === "right" && panelControls}
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
            {panelShown && panelSide === "left" && sidePanelColumn}

            <div className="flex-1 min-w-0 min-h-0 relative">
              {/*
                A diff takes the editor's whole column rather than the side
                panel's: it is the thing being read, and 300px of unified diff
                is not reading, it is guessing.
              */}
              {diffShown ? (
                <DiffView
                  name={basename(diffIdentity(diffTarget).relative)}
                  relative={diffIdentity(diffTarget).relative}
                  revision={diffIdentity(diffTarget).revision}
                  subject={
                    diffTarget.kind === "commit" ? diffTarget.commit.subject : null
                  }
                  diff={diffText}
                  loading={diffLoading}
                  error={diffError}
                  fontFamily={editorFont.family}
                  fontSize={editorFont.size}
                  layout={diffLayout}
                  style={diffStyle}
                  onSetLayout={setDiffLayout}
                  onSetStyle={setDiffStyle}
                  /* From a commit's diff, Edit opens the file as it is *now*.
                     Reconstructing the version at that commit would be a
                     read-only buffer of a file that also exists on disk, which
                     is two tabs for one path and a save that can't happen. */
                  onOpenFile={() => {
                    const path =
                      diffTarget.kind === "working"
                        ? diffTarget.file.path
                        : root
                          ? joinPath(root, diffIdentity(diffTarget).relative)
                          : null;
                    setDiffFocused(false);
                    if (path) void openPath(path);
                  }}
                  onClose={closeDiff}
                />
              ) : preview ? (
                <PreviewCard
                  preview={preview}
                  onDismiss={() => setPreview(null)}
                  onReveal={() => void revealPath(preview.path).catch((e) => setError(String(e)))}
                />
              ) : !root && workspaceSettled ? (
                <WorkspaceWelcome
                  workspaces={workspaces}
                  favorites={favorites}
                  cwd={cwd}
                  homeDir={homeDir}
                  onOpen={requestWorkspace}
                  onBrowse={browseForWorkspace}
                  onBrowseWorkspaces={() => setWorkspaceMenuOpen(true)}
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
              <div
                className={
                  diffShown || preview || !root || buffers.length === 0
                    ? "invisible absolute inset-0"
                    : "h-full"
                }
              >
                <EditorSurface
                  ref={surfaceRef}
                  bufferId={activeBufferId}
                  path={activeBuffer?.path ?? null}
                  initialContent={activeBuffer?.initialContent ?? ""}
                  languageId={activeBuffer?.languageId ?? "plaintext"}
                  readOnly={activeBuffer?.readonly ?? true}
                  highlight={!activeBuffer?.large}
                  dark={theme === "dark"}
                  fontFamily={editorFont.family}
                  fontSize={editorFont.size}
                  lineHeight={editorSettings.lineHeight}
                  settings={editorSettings}
                  workspaceRoot={rootReady ? root : null}
                  onDirtyChange={setDirty}
                  onCursorChange={onCursorChange}
                  onEdited={onEdited}
                  onScrollLine={onEditorScrollLine}
                  onSave={saveActive}
                  onSaveAll={saveAll}
                  onQuickOpen={() => setQuickOpen(true)}
                  onGlobalSearch={() => openPanel("search")}
                  onCloseTab={() => activeBufferId && requestCloseBuffer(activeBufferId)}
                  onToggleExplorer={() => setExplorerVisible(!explorerVisible)}
                  onSelectTab={(index) => {
                    if (!buffers[index]) return;
                    setDiffFocused(false);
                    setActiveBuffer(buffers[index].id);
                  }}
                  onContextMenu={openSurfaceMenu}
                  onGoToLine={openGoToLine}
                  gitDiff={gitDiff}
                  blame={blame}
                  gitRemote={gitRemote}
                />
              </div>
            </div>

            {/*
              One column, two modes, one divider and one stored width.

              The agent could have had a width of its own, and it would
              be a second number to drag, to persist and to subtract
              from the editor's share in `paneLimit`. They are never on
              screen together, so there is nothing for two numbers to
              disagree about.
            */}
            {rightShown && (
              <>
                <div
                  className="editor-divider shrink-0"
                  onPointerDown={startPreviewResize}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={agentOpen ? "Resize the agent panel" : "Resize the preview"}
                />
                <div
                  className="shrink-0 min-h-0"
                  style={{ width: (previewDragWidth ?? previewWidth) }}
                >
                  {agentOpen ? (
                    <AgentPanel
                      root={root}
                      look={lookAtEditor}
                      onClose={() => setRightPane("none")}
                    />
                  ) : (
                    <MarkdownPreview
                      ref={previewRef}
                      source={previewSource}
                      name={activeBuffer?.name ?? ""}
                      onScrollLine={onPreviewScrollLine}
                      activeLine={outlineLine}
                      onSelectHeading={goToHeading}
                      onFollowLink={followMarkdownLink}
                    />
                  )}
                </div>
              </>
            )}

            {panelShown && panelSide === "right" && sidePanelColumn}
          </div>

          <EditorStatusBar
            buffer={activeBuffer}
            cursor={cursor}
            wrapped={wrapped}
            bufferCount={buffers.length}
            watcherMechanism={mechanism}
            git={git}
            indent={indent}
            onSetIndent={(next) => {
              surfaceRef.current?.setIndent(next);
              setIndent(next);
            }}
            onOpenSourceControl={() => openPanel("git")}
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
            pythonRoot={rootReady ? root : null}
            pythonPath={pythonPath}
            pythonInterpreters={pythonInterpreters}
            pythonLoading={pythonLoading}
            onSetPythonPath={setPythonPath}
            onRefreshInterpreters={refreshInterpreters}
            onGoToLine={openGoToLine}
            // The primary is the size of the slot; there is nothing to
            // resize it against, so the grip is not offered.
            onResizeStart={docked ? undefined : onResizeStart}
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

          {goToOpen && activeBuffer && (
            <GoToLine
              currentLine={cursor.line}
              lineCount={surfaceRef.current?.lineCount() ?? 1}
              onPreview={previewGoToLine}
              onGo={(target) => {
                setGoToOpen(false);
                goToOrigin.current = null;
                surfaceRef.current?.goTo(target.line, target.column);
              }}
              onClose={closeGoToLine}
            />
          )}

          {settingsOpen && (
            <EditorSettingsModal
              settings={editorSettings}
              terminalFont={{ family: settings.fontFamily, size: settings.fontSize }}
              showHidden={showHidden}
              diffLayout={diffLayout}
              diffStyle={diffStyle}
              onChange={setEditorSettings}
              onSetShowHidden={setShowHidden}
              onSetDiffLayout={setDiffLayout}
              onSetDiffStyle={setDiffStyle}
              onReset={resetEditorSettings}
              onClose={() => {
                setSettingsOpen(false);
                surfaceRef.current?.focus();
              }}
            />
          )}

          {surfaceMenu && (
            <ContextMenu
              x={surfaceMenu.x}
              y={surfaceMenu.y}
              onDismiss={() => setSurfaceMenu(null)}
            >
              {activeBuffer ? (
                <>
                  {/* Cut and Copy fall back to the whole line when nothing is
                      selected, so the labels say which it would be. */}
                  <ContextMenuItem
                    icon={<Scissors size={12} />}
                    label={surfaceMenu.hasSelection ? "Cut" : "Cut Line"}
                    hint={chord("X")}
                    disabled={activeBuffer.readonly}
                    onClick={() => runSurfaceCommand("cut")}
                  />
                  <ContextMenuItem
                    icon={<Copy size={12} />}
                    label={surfaceMenu.hasSelection ? "Copy" : "Copy Line"}
                    hint={chord("C")}
                    onClick={() => runSurfaceCommand("copy")}
                  />
                  <ContextMenuItem
                    icon={<ClipboardPaste size={12} />}
                    label="Paste"
                    hint={chord("V")}
                    disabled={activeBuffer.readonly}
                    onClick={() => runSurfaceCommand("paste")}
                  />
                  <ContextMenuItem
                    icon={<TextSelect size={12} />}
                    label="Select All"
                    hint={chord("A")}
                    onClick={() => runSurfaceCommand("selectAll")}
                  />

                  <ContextMenuSeparator />
                  <ContextMenuItem
                    icon={<Undo2 size={12} />}
                    label="Undo"
                    hint={chord("Z")}
                    disabled={activeBuffer.readonly}
                    onClick={() => runSurfaceCommand("undo")}
                  />
                  <ContextMenuItem
                    icon={<Redo2 size={12} />}
                    label="Redo"
                    hint={chord("Z", "shift")}
                    disabled={activeBuffer.readonly}
                    onClick={() => runSurfaceCommand("redo")}
                  />

                  {/*
                    Only with a server attached. Offering "Go to Definition" on
                    a file nothing can answer for would be a menu item that
                    silently does nothing, which is worse than its absence.
                  */}
                  {editorSettings.lsp && activeBuffer.path && lsp.clientFor(activeBuffer.path) && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon={<Crosshair size={12} />}
                        label="Go to Definition"
                        hint="F12"
                        onClick={() => runSurfaceCommand("goToDefinition")}
                      />
                      <ContextMenuItem
                        icon={<Search size={12} />}
                        label="Find References"
                        hint="⇧F12"
                        onClick={() => runSurfaceCommand("findReferences")}
                      />
                      <ContextMenuItem
                        icon={<TextSearch size={12} />}
                        label="Go to Symbol…"
                        hint={chord("O", "shift")}
                        onClick={() => runSurfaceCommand("goToSymbol")}
                      />
                      <ContextMenuItem
                        icon={<PenLine size={12} />}
                        label="Rename Symbol…"
                        hint="F2"
                        disabled={activeBuffer.readonly}
                        onClick={() => runSurfaceCommand("rename")}
                      />
                      <ContextMenuItem
                        icon={<Wand2 size={12} />}
                        label="Quick Fix…"
                        hint={chord(".")}
                        disabled={activeBuffer.readonly}
                        onClick={() => runSurfaceCommand("codeActions")}
                      />
                      <ContextMenuItem
                        icon={<AlignLeft size={12} />}
                        label="Format Document"
                        disabled={activeBuffer.readonly}
                        onClick={() => runSurfaceCommand("format")}
                      />
                    </>
                  )}

                  <ContextMenuSeparator />
                  <ContextMenuItem
                    icon={<Search size={12} />}
                    label="Find…"
                    hint={chord("F")}
                    onClick={() => runSurfaceCommand("find")}
                  />
                  <ContextMenuItem
                    icon={<ListOrdered size={12} />}
                    label="Go to Line…"
                    hint={chord("G")}
                    onClick={() => {
                      setSurfaceMenu(null);
                      openGoToLine();
                    }}
                  />
                  <ContextMenuItem
                    icon={<Settings2 size={12} />}
                    label="Editor Settings…"
                    onClick={() => {
                      setSurfaceMenu(null);
                      setSettingsOpen(true);
                    }}
                  />
                  <ContextMenuItem
                    icon={<Save size={12} />}
                    label="Save"
                    hint={chord("S")}
                    disabled={activeBuffer.readonly}
                    onClick={() => {
                      setSurfaceMenu(null);
                      void saveActive();
                    }}
                  />

                  {activeBuffer.path && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon={<FolderTree size={12} />}
                        label="Reveal in Tree"
                        onClick={() => {
                          setSurfaceMenu(null);
                          revealInTree(dirname(activeBuffer.path!));
                        }}
                      />
                      <ContextMenuItem
                        icon={<Copy size={12} />}
                        label="Copy Path"
                        onClick={() => copyToClipboard(activeBuffer.path!)}
                      />
                      {root && (
                        <ContextMenuItem
                          icon={<Copy size={12} />}
                          label="Copy Relative Path"
                          onClick={() =>
                            copyToClipboard(relativeTo(root, activeBuffer.path!))
                          }
                        />
                      )}
                      <ContextMenuItem
                        icon={<SquareArrowOutUpRight size={12} />}
                        label={REVEAL_LABEL}
                        onClick={() => {
                          setSurfaceMenu(null);
                          void revealPath(activeBuffer.path!).catch((e) =>
                            setError(String(e))
                          );
                        }}
                      />
                    </>
                  )}
                </>
              ) : (
                /* Nothing open: the only useful actions are the ones that
                   would open something. */
                <>
                  <ContextMenuItem
                    icon={<FilePlus size={12} />}
                    label="New File"
                    onClick={() => {
                      setSurfaceMenu(null);
                      openScratch();
                    }}
                  />
                  <ContextMenuItem
                    icon={<Search size={12} />}
                    label="Quick Open…"
                    hint={chord("P")}
                    onClick={() => {
                      setSurfaceMenu(null);
                      setQuickOpen(true);
                    }}
                  />
                </>
              )}
            </ContextMenu>
          )}
        </div>

        {/*
          Discard is the one git action here that destroys work, so it asks —
          and it says which of the two things it is about to do, because
          "discard" means `git checkout` for a tracked file and a move to the
          trash for one git has never seen.
        */}
        {discardPrompt && discardPrompt.length > 0 && (
          <EditorDialog
            title={
              discardPrompt.length === 1
                ? discardPrompt[0].unstaged === "untracked"
                  ? "Move this file to the trash?"
                  : "Discard these changes?"
                : `Discard ${discardPrompt.length} files?`
            }
            message={discardChoice(discardPrompt)}
            detail={
              discardPrompt.length === 1
                ? discardPrompt[0].relative
                : discardPrompt.map((file) => file.relative).join(", ")
            }
            onCancel={() => setDiscardPrompt(null)}
            actions={[
              {
                label: "Discard",
                primary: true,
                danger: true,
                onClick: () => {
                  const files = discardPrompt;
                  setDiscardPrompt(null);
                  discardFiles(files);
                },
              },
              { label: "Cancel", onClick: () => setDiscardPrompt(null) },
            ]}
          />
        )}

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
            onCloseFolder={requestLeaveWorkspace}
            onForget={removeWorkspace}
            onToggleFavorite={toggleFavorite}
            onBrowse={browseForWorkspace}
            onClose={() => setWorkspaceMenuOpen(false)}
          />
        )}

        {pendingWorkspace && (
          <EditorDialog
            title="Unsaved changes"
            message={`${
              pendingWorkspace.kind === "close"
                ? "Leaving this workspace closes the tabs you have open."
                : "Switching workspace closes the tabs you have open."
            } ${buffers.filter((b) => b.dirty).length} of them have unsaved changes.`}
            detail={
              pendingWorkspace.kind === "open" ? pendingWorkspace.root : root ?? undefined
            }
            onCancel={() => setPendingWorkspace(null)}
            actions={[
              {
                label:
                  pendingWorkspace.kind === "close"
                    ? "Save all and leave"
                    : "Save all and switch",
                primary: true,
                onClick: () => {
                  const pending = pendingWorkspace;
                  setPendingWorkspace(null);
                  void (async () => {
                    for (const buffer of useEditorStore.getState().buffers) {
                      if (buffer.dirty && buffer.path) await saveBuffer(buffer.id);
                    }
                    // A buffer that still can't be saved — read-only, or a
                    // scratch file with no name — would be lost silently, so
                    // the whole thing is abandoned instead.
                    if (useEditorStore.getState().buffers.some((b) => b.dirty)) {
                      setError("Some files could not be saved, so the folder was not changed");
                      return;
                    }
                    if (pending.kind === "close") leaveWorkspace();
                    else await enterWorkspace(pending.root);
                  })();
                },
              },
              {
                label:
                  pendingWorkspace.kind === "close"
                    ? "Discard and leave"
                    : "Discard and switch",
                danger: true,
                onClick: () => {
                  const pending = pendingWorkspace;
                  setPendingWorkspace(null);
                  if (pending.kind === "close") leaveWorkspace();
                  else void enterWorkspace(pending.root);
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

/**
 * What the editor shows before a folder is chosen.
 *
 * The editor works *inside* one folder — the backend confines every read and
 * write to it, which is why a file from anywhere else is refused — so "which
 * folder" is not a setting, it is the first question. Before this the question
 * was never asked: the home directory was assumed, and a new user met a tree
 * of their entire home with no hint that picking a project was a step.
 *
 * Three ways in, in the order they are likely to be wanted: the folder the
 * focused shell is already sitting in, a folder opened before, and the system
 * picker. The first is the one that makes this disappear in a single click
 * most of the time — if you are working in a project, the terminal already
 * knows which.
 */
function WorkspaceWelcome({
  workspaces,
  favorites,
  cwd,
  homeDir,
  onOpen,
  onBrowse,
  onBrowseWorkspaces,
}: {
  workspaces: Workspace[];
  favorites: string[];
  /** The focused terminal pane's folder, when it has one. */
  cwd?: string;
  /** For telling a project apart from where a shell happens to start. */
  homeDir: string | null;
  onOpen: (root: string) => void;
  onBrowse: () => void;
  /** Opens the full workspace list — search, favourites, and forgetting. */
  onBrowseWorkspaces: () => void;
}) {
  /*
    Offered only when the shell is somewhere worth opening. In home it is not
    a shortcut, it is the thing this screen exists to avoid — and until the
    lookup lands it is not offered either, so the button can never appear and
    then turn out to have been home all along.
  */
  const fromTerminal =
    cwd && homeDir && !tooBroadForWorkspace(cwd, homeDir) ? cwd : null;
  /*
    Pinned first, then most recently opened — which is the order `workspaces`
    already arrives in, so a stable sort is all this needs. Capped, because
    this is a shortcut and the full list is one click away in the picker.
  */
  const pinned = new Set(favorites);
  const remembered = new Set([...workspaces.map((w) => w.root), ...favorites]).size;
  const recent = [...workspaces]
    // A folder stored before the rule existed is still in the list; offering
    // it here would be offering the one thing this screen exists to avoid.
    .filter((workspace) => !tooBroadForWorkspace(workspace.root, homeDir))
    .sort((a, b) => Number(pinned.has(b.root)) - Number(pinned.has(a.root)))
    .slice(0, 5);

  return (
    <div className="editor-welcome h-full w-full overflow-y-auto flex flex-col items-center justify-center gap-5 px-8 py-6">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <FolderTree size={26} className="editor-welcome-icon" />
        <div className="editor-placeholder-title text-[13px] font-semibold">
          Open a folder to start
        </div>
        <div className="editor-placeholder-text text-[11px] max-w-[380px] leading-relaxed">
          The editor works inside one folder at a time — its tree, its search
          and its source control are all about that folder.
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* The shell's folder, where there is one. Almost always the answer. */}
        {fromTerminal && (
          <button
            className="editor-welcome-primary flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={() => onOpen(fromTerminal)}
            title={`Open ${fromTerminal}`}
          >
            <FolderInput size={13} />
            <span className="truncate max-w-[200px]">
              {basename(fromTerminal) || fromTerminal}
            </span>
          </button>
        )}
        <button
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium ${
            fromTerminal ? "editor-welcome-secondary" : "editor-welcome-primary"
          }`}
          onClick={onBrowse}
        >
          <FolderOpen size={13} />
          Open Folder…
        </button>
        {/*
          The full list, where the five rows below are only the top of it:
          search, favourites, tab counts and forgetting all live there. Offered
          only once there is something in it — a button onto an empty list is
          a button that teaches you not to press it.
        */}
        {remembered > 0 && (
          <button
            className="editor-welcome-secondary flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={onBrowseWorkspaces}
            title="All the folders this editor remembers"
          >
            <FolderSearch size={13} />
            Workspaces…
          </button>
        )}
      </div>

      {recent.length > 0 && (
        <div className="editor-welcome-recent w-full max-w-[420px]">
          <div className="editor-welcome-label text-[9px] font-semibold uppercase tracking-wide px-1 pb-1">
            Recent
          </div>
          {recent.map((workspace) => (
            <button
              key={workspace.root}
              className="editor-welcome-row flex items-center gap-2 w-full px-2 py-1.5 rounded text-left"
              onClick={() => onOpen(workspace.root)}
              title={workspace.root}
            >
              <Star
                size={11}
                className={`shrink-0 ${
                  pinned.has(workspace.root)
                    ? "editor-welcome-pinned fill-current"
                    : "opacity-0"
                }`}
                aria-hidden
              />
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-[12px] truncate">
                  {basename(workspace.root) || workspace.root}
                </span>
                <span className="editor-welcome-path text-[10px] truncate">
                  {collapseHome(workspace.root)}
                </span>
              </span>
              {workspace.openPaths.length > 0 && (
                <span
                  className="editor-welcome-count text-[10px] shrink-0 tabular-nums"
                  title={`${workspace.openPaths.length} file${
                    workspace.openPaths.length === 1 ? "" : "s"
                  } were open`}
                >
                  {workspace.openPaths.length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
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
        Or pick something from the tree.
      </div>
    </div>
  );
}
