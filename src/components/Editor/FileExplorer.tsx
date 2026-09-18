import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FilePlus,
  FolderInput,
  FolderPlus,
  FoldVertical,
  Folder,
  FolderOpen,
  MessageSquare,
  Pencil,
  RefreshCw,
  SquareArrowOutUpRight,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  basename,
  createPath,
  deletePath,
  dirname,
  FileEntry,
  joinPath,
  listDir,
  relativeTo,
  renamePath,
  revealPath,
} from "../../services/editor-fs";
import {
  canMoveInto,
  cleanName,
  isUnder,
  newEntryParent,
} from "../../services/explorer-paths";
import { changeBadge, changeLabel, GitChange, isIgnored } from "../../services/git";
import { platform } from "../../services/platform";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ContextMenu";
import { FileIcon } from "./fileIcons";
import { EditorDialog } from "./EditorDialog";
import { MoveToFolder } from "./MoveToFolder";

/**
 * The file tree, pinned to the right of the editor.
 *
 * Virtualized, and not optionally: expanding `node_modules` in a real project
 * is 40,000 rows, and rendering that as DOM locks the window for seconds. Rows
 * are a fixed height, so the visible window is arithmetic rather than
 * measurement — which is the whole reason a tree like this can be virtualized
 * simply.
 *
 * Directory contents are loaded when a directory is expanded, never eagerly,
 * and are re-read when the watcher reports that something under them changed.
 */

/** Fixed, because the virtualizer depends on it. Matches the CSS row height. */
const ROW_HEIGHT = 22;

/** Rows rendered above and below the viewport, so scrolling doesn't flicker. */
const OVERSCAN = 8;

const INDENT = 12;

/**
 * How long a drag has to rest on a closed folder before it opens.
 *
 * Long enough that passing over a folder on the way somewhere else doesn't
 * open it, short enough to be quicker than dropping the drag to click the
 * chevron. The same "spring-loaded folder" delay Finder uses.
 */
const SPRING_DELAY = 600;

export interface ExplorerChange {
  paths: string[];
  overflow: boolean;
  /** Bumped per event, so identical payloads still trigger a reload. */
  token: number;
}

/**
 * The path segment marking the inline "new file" row.
 *
 * A NUL is used because no filesystem allows one in a name, so this can never
 * collide with a real path — which is the whole point of the sentinel. It is
 * written as an escape and named once rather than spelled as a literal byte at
 * each use: a raw NUL in the source makes the file read as *binary* to `grep`,
 * `git diff` and every editor's search, which is a high price for two strings.
 */
const DRAFT_MARK = "\u0000draft";

interface FileExplorerProps {
  root: string;
  activePath: string | null;
  showHidden: boolean;
  onToggleHidden: () => void;
  expanded: string[];
  onToggleExpand: (path: string) => void;
  onCollapseAll: () => void;
  onOpenFile: (path: string) => void;
  onOpenTerminal: (dir: string) => void;
  /**
   * Reports a rename or a move that has landed on disk, so the tabs can follow.
   *
   * The explorer knows the two paths and nothing about what is open, which is
   * why this leaves rather than being handled here.
   */
  onMoved: (from: string, to: string) => void;
  /**
   * Drops a remembered expansion that turned out not to exist.
   *
   * The expanded-directory list is persisted, so one bad entry — a folder since
   * deleted, renamed, or written by an earlier bug — is retried on every load
   * and reports the same error forever. Forgetting it is the only thing that
   * ends that, and it needs the store, which lives above this component.
   */
  onForgetExpanded: (path: string) => void;
  onError: (message: string) => void;
  change: ExplorerChange;
  /**
   * Git's verdict on each path, absolute-keyed.
   *
   * Handed in rather than fetched here: the source-control panel and the
   * change gutter need the same status, and three components each running
   * `git status` on the same watcher event is three processes for one answer.
   */
  gitFiles: Map<string, GitChange>;
  /** Directories with something changed inside them, so a collapsed one says so. */
  gitDirs: Set<string>;
  /**
   * Paths git is ignoring, with directories collapsed.
   *
   * Rows under one of these are dimmed. `node_modules` and `dist` are part of
   * the folder but not part of the *project*, and a tree that says so without
   * being read is the difference between scanning it and searching it.
   */
  gitIgnored: ReadonlySet<string>;
}

interface Row {
  entry: FileEntry;
  depth: number;
}

/** An in-progress "new file" or "new folder", shown as an editable row. */
interface Draft {
  parent: string;
  isDir: boolean;
}

interface Menu {
  x: number;
  y: number;
  entry: FileEntry | null;
}

const REVEAL_LABEL =
  platform === "mac" ? "Reveal in Finder" : platform === "windows" ? "Show in Explorer" : "Open Containing Folder";

export function FileExplorer({
  root,
  activePath,
  showHidden,
  onToggleHidden,
  expanded,
  onToggleExpand,
  onCollapseAll,
  onOpenFile,
  onOpenTerminal,
  onMoved,
  onForgetExpanded,
  onError,
  change,
  gitFiles,
  gitDirs,
  gitIgnored,
}: FileExplorerProps) {
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null);
  /** The entry the "Move to Folder…" picker is open for. */
  const [pendingMove, setPendingMove] = useState<FileEntry | null>(null);
  /**
   * Set when the root itself couldn't be read.
   *
   * `failedRef` stops the loader retrying forever, but on its own it leaves the
   * tree showing "Reading…" with nothing happening and no way to recover. This
   * mirrors the failure into state so the panel can say so and offer a retry.
   */
  const [rootError, setRootError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef<Set<string>>(new Set());
  /**
   * Directories whose read failed.
   *
   * Without this the loader spins: the effect below asks for any expanded
   * directory missing from `children`, a failed read removes it from
   * `children`, and that change re-runs the effect — an endless retry with an
   * error message per attempt.
   */
  const failedRef = useRef<Set<string>>(new Set());
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  /** The same set, for `load` to consult without being rebuilt on every change. */
  const expandedRef = useRef(expandedSet);
  expandedRef.current = expandedSet;

  // --- Loading -------------------------------------------------------------

  const load = useCallback(
    async (dir: string) => {
      if (loadingRef.current.has(dir)) return;
      loadingRef.current.add(dir);
      try {
        const entries = await listDir(dir, showHidden);
        failedRef.current.delete(dir);
        if (dir === root) setRootError(null);
        setChildren((prev) => new Map(prev).set(dir, entries));
      } catch (error) {
        // A directory that vanished or can't be read is reported once and
        // then left alone until something explicitly asks for it again.
        failedRef.current.add(dir);
        setChildren((prev) => {
          const next = new Map(prev);
          next.delete(dir);
          return next;
        });
        if (dir === root) {
          // The root is the panel's whole content, so it says so in place
          // rather than only as a dismissible error bar.
          setRootError(String(error));
        } else if (expandedRef.current.has(dir)) {
          /*
            A remembered expansion that no longer resolves. Silently forgotten
            rather than reported: the user didn't ask for it — a previous
            session did — and telling them about it every launch, with no way
            to act on it, is worse than dropping it.
          */
          onForgetExpanded(dir);
        } else {
          onError(String(error));
        }
      } finally {
        loadingRef.current.delete(dir);
      }
    },
    [showHidden, onError, onForgetExpanded, root]
  );

  /** Re-reads a directory even if it failed last time — the refresh path. */
  const reload = useCallback(
    (dir: string) => {
      failedRef.current.delete(dir);
      void load(dir);
    },
    [load]
  );

  // A different root, or a change to what counts as visible, invalidates
  // everything already read.
  useEffect(() => {
    setChildren(new Map());
    loadingRef.current.clear();
    failedRef.current.clear();
    setRootError(null);
  }, [root, showHidden]);

  useEffect(() => {
    if (!root) return;
    const wanted = [root, ...expanded.filter((path) => path.startsWith(root))];
    wanted.forEach((dir) => {
      if (!children.has(dir) && !failedRef.current.has(dir)) void load(dir);
    });
  }, [root, expanded, children, load]);

  /**
   * Re-reads what the watcher says changed.
   *
   * Only directories already loaded are re-read — a change deep inside a
   * collapsed subtree matters when it's expanded, not now — and an overflowing
   * burst (`git checkout`, `npm install`) reloads all of them rather than
   * itemising thousands of paths.
   */
  useEffect(() => {
    if (change.token === 0) return;

    if (change.overflow) {
      [...children.keys()].forEach(reload);
      return;
    }

    const dirty = new Set<string>();
    change.paths.forEach((path) => {
      // The path itself, when it *is* a loaded directory, and its parent, since
      // a created or deleted entry changes the listing that contains it.
      if (children.has(path)) dirty.add(path);
      const parent = dirname(path);
      if (children.has(parent)) dirty.add(parent);
    });
    dirty.forEach(reload);
    // Deliberately keyed on the token alone: re-running when `children` changes
    // would reload on every load, forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change.token]);

  // --- Rows ----------------------------------------------------------------

  const rows = useMemo(() => {
    const out: Row[] = [];

    const walk = (dir: string, depth: number) => {
      const entries = children.get(dir);
      if (!entries) return;

      for (const entry of entries) {
        out.push({ entry, depth });
        if (entry.isDir && expandedSet.has(entry.path)) {
          walk(entry.path, depth + 1);
        }
      }

      if (draft && draft.parent === dir) {
        /*
          The new-entry row goes *after* the directory's contents, which is
          roughly where the created file will be a moment later. At the top it
          sat above the folder's own listing, which read as belonging to
          whatever was above it instead. The effect below is what keeps that
          honest in a folder taller than the panel.
        */
        out.push({
          entry: {
            name: "",
            path: joinPath(dir, DRAFT_MARK),
            isDir: draft.isDir,
            isHidden: false,
            isSymlink: false,
            size: 0,
            mtime: 0,
            readonly: false,
          },
          depth,
        });
      }
    };

    walk(root, 0);
    return out;
  }, [children, expandedSet, root, draft]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
  );
  const visible = rows.slice(first, last);

  /** Where the new-entry row is, or -1 when nothing is being created. */
  const draftIndex = useMemo(
    () => (draft ? rows.findIndex((row) => row.entry.path.endsWith(DRAFT_MARK)) : -1),
    [draft, rows]
  );

  /*
    Brings the new-entry row into view.

    It sits at the bottom of its folder now, which in a folder taller than the
    panel means off-screen — a focused field nobody can see, where the typing
    goes nowhere visible. Keyed on the index alone so that a reload of the
    directory underneath doesn't drag the view back while the name is being
    typed.
  */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || draftIndex < 0) return;
    const top = draftIndex * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }
  }, [draftIndex]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  // --- Actions -------------------------------------------------------------

  const refresh = useCallback(() => {
    [...children.keys()].forEach(reload);
    // A root that failed to read is exactly what someone clicking Refresh is
    // trying to fix, so it gets another go too.
    if (!children.has(root)) reload(root);
  }, [children, reload, root]);

  /** Where a "new file" goes: into a directory, or beside a file. */
  const targetDirOf = useCallback(
    (entry: FileEntry | null): string => {
      if (!entry) return root;
      return entry.isDir ? entry.path : dirname(entry.path);
    },
    [root]
  );

  const startDraft = useCallback(
    (entry: FileEntry | null, isDir: boolean) => {
      const parent = targetDirOf(entry);
      // A closed folder is opened first, or the row would be created into
      // something the user can't see.
      if (entry?.isDir && !expandedSet.has(entry.path)) onToggleExpand(entry.path);
      setDraft({ parent, isDir });
      setMenu(null);
    },
    [targetDirOf, expandedSet, onToggleExpand]
  );

  /**
   * Where the header's two buttons create.
   *
   * The last open folder as the tree is drawn — so a file made while a folder
   * is open lands in it, and with everything collapsed it lands at the very
   * bottom of the root. See `newEntryParent`.
   */
  const headerParent = useMemo(
    () =>
      newEntryParent(
        rows.map((row) => ({
          path: row.entry.path,
          isDir: row.entry.isDir,
          expanded: expandedSet.has(row.entry.path),
        })),
        root
      ),
    [rows, expandedSet, root]
  );

  const startHeaderDraft = useCallback(
    (isDir: boolean) => {
      setDraft({ parent: headerParent, isDir });
      setMenu(null);
    },
    [headerParent]
  );

  /** How the header's buttons name their destination, for the tooltip. */
  const headerLabel =
    headerParent === root ? basename(root) || root : relativeTo(root, headerParent);

  const commitDraft = useCallback(
    async (name: string) => {
      const current = draft;
      setDraft(null);
      if (!current || !name.trim()) return;
      try {
        const created = await createPath(joinPath(current.parent, name.trim()), current.isDir);
        await load(current.parent);
        if (!current.isDir) onOpenFile(created);
      } catch (error) {
        onError(String(error));
      }
    },
    [draft, load, onOpenFile, onError]
  );

  /**
   * Drops what was read under a path that has just moved away.
   *
   * The listings are keyed by directory, so after a folder moves its old key
   * and every key beneath it describe somewhere that no longer exists. Left
   * alone they are only wasted memory — nothing walks to them any more — but
   * moving a folder *back* would then show the stale listing.
   */
  const forgetSubtree = useCallback((path: string) => {
    setChildren((prev) => {
      const next = new Map(prev);
      for (const dir of prev.keys()) {
        if (dir === path || isUnder(dir, path)) next.delete(dir);
      }
      return next;
    });
  }, []);

  const commitRename = useCallback(
    async (path: string, name: string) => {
      setRenaming(null);
      const trimmed = name.trim();
      if (!trimmed || trimmed === basename(path)) return;
      try {
        // The backend answers with the canonical destination, which is what the
        // tabs have to be re-pointed at — not the path we asked for.
        const moved = await renamePath(path, joinPath(dirname(path), trimmed));
        forgetSubtree(path);
        onMoved(path, moved);
        await load(dirname(path));
      } catch (error) {
        onError(String(error));
      }
    },
    [load, onError, onMoved, forgetSubtree]
  );

  const confirmDelete = useCallback(async () => {
    const entry = pendingDelete;
    setPendingDelete(null);
    if (!entry) return;
    try {
      await deletePath(entry.path, true);
      await load(dirname(entry.path));
    } catch (error) {
      onError(String(error));
    }
  }, [pendingDelete, load, onError]);

  const move = useCallback(
    async (from: string, toDir: string) => {
      // Into itself, into its own child, or back where it already is.
      if (!canMoveInto(from, toDir, dirname(from))) return;
      try {
        const moved = await renamePath(from, joinPath(toDir, basename(from)));
        forgetSubtree(from);
        onMoved(from, moved);
        await Promise.all([load(dirname(from)), load(toDir)]);
      } catch (error) {
        onError(String(error));
      }
    },
    [load, onError, onMoved, forgetSubtree]
  );

  /**
   * Says that a name field dropped something, rather than doing it silently.
   *
   * What gets dropped is invisible by definition, so without this the field
   * simply appears to ignore part of a paste.
   */
  const reportRejected = useCallback(
    (count: number) => {
      onError(
        `Removed ${count} character${count === 1 ? "" : "s"} a file name can't contain`
      );
    },
    [onError]
  );

  // --- Dragging ------------------------------------------------------------

  /**
   * What is being dragged, in a ref as well as in state.
   *
   * `dragover` fires continuously and is forbidden from reading
   * `dataTransfer` — the payload is only readable on drop — so remembering
   * what left is the only way to decide, while the pointer is still moving,
   * whether this target may have it.
   */
  const draggingRef = useRef<string | null>(null);
  const [dragging, setDraggingPath] = useState<string | null>(null);
  const setDragging = useCallback((path: string | null) => {
    draggingRef.current = path;
    setDraggingPath(path);
  }, []);

  /** A collapsed folder waiting to spring open, and the timer that will do it. */
  const springRef = useRef<{ path: string; timer: number } | null>(null);

  const cancelSpring = useCallback((path?: string | null) => {
    const pending = springRef.current;
    if (!pending) return;
    // With a path, only that folder's timer is cancelled: `dragenter` on the
    // next row arrives *before* `dragleave` on the last one, so cancelling
    // blindly would kill the spring the new row has just started.
    if (path && pending.path !== path) return;
    window.clearTimeout(pending.timer);
    springRef.current = null;
  }, []);

  const springOpen = useCallback(
    (path: string) => {
      if (springRef.current?.path === path) return;
      cancelSpring();
      springRef.current = {
        path,
        timer: window.setTimeout(() => {
          springRef.current = null;
          // Only if the drag is still going: the timer outliving it would
          // expand a folder seconds after the drop, for no visible reason.
          if (draggingRef.current) onToggleExpand(path);
        }, SPRING_DELAY),
      };
    },
    [cancelSpring, onToggleExpand]
  );

  const endDrag = useCallback(() => {
    cancelSpring();
    setDragging(null);
    setDragOver(null);
  }, [cancelSpring, setDragging]);

  /**
   * Offers `toDir` as the drop target, and says whether it took it.
   *
   * Not calling `preventDefault` is what refuses a drop in HTML's drag and
   * drop, and it is also what puts the "no" cursor under the pointer — so an
   * illegal target says so before the mouse is released rather than swallowing
   * the drop and doing nothing, which is what it did before.
   */
  const offerDrop = useCallback((e: React.DragEvent, toDir: string): boolean => {
    const from = draggingRef.current;
    if (!from || !canMoveInto(from, toDir, dirname(from))) {
      setDragOver((prev) => (prev === null ? prev : null));
      return false;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver((prev) => (prev === toDir ? prev : toDir));
    return true;
  }, []);

  const dropOn = useCallback(
    (e: React.DragEvent, toDir: string) => {
      e.preventDefault();
      // The ref is the drag we started; the payload is the fallback, since a
      // drag that began before this component re-rendered still carries it.
      const from = draggingRef.current || e.dataTransfer.getData("text/plain");
      endDrag();
      if (from) void move(from, toDir);
    },
    [endDrag, move]
  );

  /** Nothing should be left ticking when the panel goes away mid-drag. */
  useEffect(() => cancelSpring, [cancelSpring]);

  /**
   * Every folder the tree has seen, for the move picker.
   *
   * It builds its list from the project's *files*, which leaves out any folder
   * holding none — so an empty folder, and a folder holding only ignored files,
   * would be missing from the one place you would go to move something into it.
   * Taken from the listings rather than their keys, which would only be the
   * folders somebody had expanded.
   */
  const knownDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const [dir, entries] of children) {
      dirs.add(dir);
      for (const entry of entries) if (entry.isDir) dirs.add(entry.path);
    }
    return [...dirs];
  }, [children]);

  const copyToClipboard = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text).catch(() => {
        onError("Could not write to the clipboard");
      });
      setMenu(null);
    },
    [onError]
  );

  const dismissMenu = useCallback(() => setMenu(null), []);

  return (
    <div className="editor-explorer flex flex-col h-full min-h-0">
      {/*
        The header doubles as the drop target for the project root. Without it
        there is no way to drag something *out* of a folder once the tree is
        long enough to fill the panel — the empty space below the rows, the
        other root target, is then nowhere to be found.
      */}
      <div
        className={`editor-explorer-header flex items-center gap-1 px-2 h-[26px] shrink-0 ${
          dragOver === root ? "drop-root" : ""
        }`}
        onDragOver={(e) => offerDrop(e, root)}
        onDrop={(e) => dropOn(e, root)}
      >
        <span className="editor-explorer-title text-[10px] font-semibold uppercase tracking-wide truncate flex-1">
          {basename(root) || root}
        </span>
        {/* Both say where they will create, because that is the one thing
            about them that isn't obvious from the icon. */}
        <button
          className="editor-icon-btn p-0.5 rounded"
          onClick={() => startHeaderDraft(false)}
          title={`New file in ${headerLabel}`}
          aria-label={`New file in ${headerLabel}`}
        >
          <FilePlus size={12} />
        </button>
        <button
          className="editor-icon-btn p-0.5 rounded"
          onClick={() => startHeaderDraft(true)}
          title={`New folder in ${headerLabel}`}
          aria-label={`New folder in ${headerLabel}`}
        >
          <FolderPlus size={12} />
        </button>
        <button
          className="editor-icon-btn p-0.5 rounded"
          onClick={onToggleHidden}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
          aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
        >
          {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <button
          className="editor-icon-btn p-0.5 rounded"
          onClick={onCollapseAll}
          title="Collapse all"
          aria-label="Collapse all"
        >
          <FoldVertical size={12} />
        </button>
        <button
          className="editor-icon-btn p-0.5 rounded"
          onClick={refresh}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div
        ref={scrollRef}
        className={`editor-explorer-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden ${
          dragOver === root ? "drop-root" : ""
        }`}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        /*
          The empty space under the tree is the root. Guarded on the target
          being this element itself, because a row's own dragover bubbles up
          here and would otherwise re-aim every drop at the root.
        */
        onDragOver={(e) => {
          if (e.target === e.currentTarget) offerDrop(e, root);
        }}
        onDrop={(e) => {
          if (e.target === e.currentTarget) dropOn(e, root);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
      >
        {/* Sized to the full tree so the scrollbar is honest; rows are placed
            inside it by offset. */}
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {visible.map((row, index) => {
            const absolute = first + index;
            const isDraftRow = row.entry.name === "" && row.entry.path.includes(DRAFT_MARK);
            /*
              A file carries its own status; a directory carries the fact that
              something under it changed. The two are drawn differently — a
              letter for the file, a dot for the folder — because "M" on a
              folder would read as the folder itself being modified.
            */
            const gitChange = gitFiles.get(row.entry.path) ?? null;
            const gitInside = !gitChange && row.entry.isDir && gitDirs.has(row.entry.path);
            const ignored = isIgnored(row.entry.path, gitIgnored);

            return (
              <div
                key={isDraftRow ? "draft" : row.entry.path}
                style={{
                  position: "absolute",
                  top: absolute * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  left: 0,
                  right: 0,
                  paddingLeft: 4 + row.depth * INDENT,
                }}
                /*
                  `context-target` marks the row the open menu applies to. In a
                  deep tree the menu can sit over rows it has nothing to do
                  with, and without the mark there is nothing saying which entry
                  "Rename" or "Move to Trash" would act on.
                */
                className={`editor-row flex items-center gap-1.5 pr-2 ${
                  activePath === row.entry.path ? "active" : ""
                } ${menu?.entry?.path === row.entry.path ? "context-target" : ""} ${
                  dragOver === row.entry.path ? "drag-over" : ""
                } ${dragging === row.entry.path ? "dragging" : ""} ${
                  row.entry.isHidden ? "hidden-entry" : ""
                } ${
                  ignored ? "ignored-entry" : ""
                } ${
                  /* An ignored path has no meaningful git status — it is
                     untracked by definition — so the badge is suppressed rather
                     than marking every build artefact as new. */
                  ignored ? "" : gitChange ? `git-${gitChange}` : gitInside ? "git-inside" : ""
                }`}
                draggable={!isDraftRow && renaming !== row.entry.path}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", row.entry.path);
                  e.dataTransfer.effectAllowed = "move";
                  setDragging(row.entry.path);
                }}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  // A file's row means the folder it is in, so dropping next to
                  // a file lands where that file is — which is how it reads.
                  const target = row.entry.isDir ? row.entry.path : dirname(row.entry.path);
                  if (!offerDrop(e, target)) return;
                  // Held over a closed folder, it opens: dropping two levels
                  // down should not mean giving up on the drag to go and click
                  // the chevron first.
                  if (row.entry.isDir && !expandedSet.has(row.entry.path)) {
                    springOpen(row.entry.path);
                  }
                }}
                onDragLeave={() => {
                  // Named, never blanket: a file's row has no timer of its own,
                  // and cancelling without saying which would kill the one the
                  // folder the pointer just entered has started.
                  if (row.entry.isDir) cancelSpring(row.entry.path);
                }}
                onDrop={(e) => dropOn(e, row.entry.isDir ? row.entry.path : dirname(row.entry.path))}
                onClick={() => {
                  if (isDraftRow || renaming === row.entry.path) return;
                  if (row.entry.isDir) {
                    onToggleExpand(row.entry.path);
                  } else {
                    onOpenFile(row.entry.path);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (isDraftRow) return;
                  setMenu({ x: e.clientX, y: e.clientY, entry: row.entry });
                }}
              >
                {row.entry.isDir ? (
                  <>
                    <span className="editor-row-chevron shrink-0">
                      {expandedSet.has(row.entry.path) ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )}
                    </span>
                    {expandedSet.has(row.entry.path) ? (
                      <FolderOpen size={13} className="editor-icon-folder shrink-0" />
                    ) : (
                      <Folder size={13} className="editor-icon-folder shrink-0" />
                    )}
                  </>
                ) : (
                  <>
                    <span className="editor-row-chevron shrink-0" />
                    <FileIcon path={row.entry.path} />
                  </>
                )}

                {isDraftRow ? (
                  <NameInput
                    initial=""
                    placeholder={draft?.isDir ? "Folder name" : "File name"}
                    onCommit={commitDraft}
                    onCancel={() => setDraft(null)}
                    onRejected={reportRejected}
                  />
                ) : renaming === row.entry.path ? (
                  <NameInput
                    initial={row.entry.name}
                    onCommit={(name) => void commitRename(row.entry.path, name)}
                    onCancel={() => setRenaming(null)}
                    onRejected={reportRejected}
                  />
                ) : (
                  <>
                    <span
                      className="editor-row-name text-[12px] truncate"
                      title={row.entry.name}
                    >
                      {row.entry.name}
                      {row.entry.isSymlink && <span className="editor-row-link"> ↗</span>}
                    </span>
                    {gitChange ? (
                      <span
                        className="editor-row-git text-[10px] shrink-0 ml-auto"
                        title={changeLabel(gitChange)}
                        aria-label={changeLabel(gitChange)}
                      >
                        {changeBadge(gitChange)}
                      </span>
                    ) : gitInside ? (
                      <span
                        className="editor-row-git-dot shrink-0 ml-auto"
                        title="Something inside this folder has changed"
                        aria-hidden
                      />
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {rows.length === 0 && (
          <div className="editor-explorer-empty px-3 py-4 text-[11px]">
            {rootError ? (
              <div className="flex flex-col items-start gap-2">
                <span className="editor-explorer-error">{rootError}</span>
                <button
                  className="editor-btn-text px-2 py-1 rounded text-[11px]"
                  onClick={() => reload(root)}
                >
                  Try again
                </button>
              </div>
            ) : children.has(root) ? (
              "This folder is empty"
            ) : (
              "Reading…"
            )}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onDismiss={dismissMenu}>
          {menu.entry && !menu.entry.isDir && (
            <ContextMenuItem
              icon={<SquareArrowOutUpRight size={12} />}
              label="Open"
              onClick={() => {
                onOpenFile(menu.entry!.path);
                setMenu(null);
              }}
            />
          )}
          {menu.entry?.isDir && (
            <ContextMenuItem
              icon={<Terminal size={12} />}
              label="Open in Terminal"
              onClick={() => {
                onOpenTerminal(menu.entry!.path);
                setMenu(null);
              }}
            />
          )}
          {/*
            Hands the path to the Claude window as an `@` mention, which is how
            the CLI takes a file reference. It types into the conversation
            rather than sending anything: what to ask about the file is the
            user's to write, and a prompt we composed would be a guess.
          */}
          {menu.entry && (
            <ContextMenuItem
              icon={<MessageSquare size={12} />}
              label="Ask Claude about this"
              onClick={() => {
                void emit("claude://mention", { path: menu.entry!.path });
                setMenu(null);
              }}
            />
          )}
          <ContextMenuItem
            icon={<FilePlus size={12} />}
            label="New File"
            onClick={() => startDraft(menu.entry, false)}
          />
          <ContextMenuItem
            icon={<FolderPlus size={12} />}
            label="New Folder"
            onClick={() => startDraft(menu.entry, true)}
          />
          {menu.entry && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon={<Pencil size={12} />}
                label="Rename"
                onClick={() => {
                  setRenaming(menu.entry!.path);
                  setMenu(null);
                }}
              />
              <ContextMenuItem
                icon={<FolderInput size={12} />}
                label="Move to Folder…"
                onClick={() => {
                  setPendingMove(menu.entry);
                  setMenu(null);
                }}
              />
              <ContextMenuItem
                icon={<Copy size={12} />}
                label="Copy Path"
                onClick={() => copyToClipboard(menu.entry!.path)}
              />
              <ContextMenuItem
                icon={<Copy size={12} />}
                label="Copy Relative Path"
                onClick={() => copyToClipboard(relativeTo(root, menu.entry!.path))}
              />
              <ContextMenuItem
                icon={<SquareArrowOutUpRight size={12} />}
                label={REVEAL_LABEL}
                onClick={() => {
                  void revealPath(menu.entry!.path).catch((e) => onError(String(e)));
                  setMenu(null);
                }}
              />
              <ContextMenuSeparator />
              <ContextMenuItem
                icon={<Trash2 size={12} />}
                label="Move to Trash"
                danger
                onClick={() => {
                  setPendingDelete(menu.entry);
                  setMenu(null);
                }}
              />
            </>
          )}
        </ContextMenu>
      )}

      {pendingMove && (
        <MoveToFolder
          root={root}
          showHidden={showHidden}
          path={pendingMove.path}
          name={pendingMove.name}
          knownDirs={knownDirs}
          onMove={(toDir) => void move(pendingMove.path, toDir)}
          onClose={() => setPendingMove(null)}
          onError={onError}
        />
      )}

      {pendingDelete && (
        <EditorDialog
          title={pendingDelete.isDir ? "Move folder to trash?" : "Move file to trash?"}
          message={
            pendingDelete.isDir
              ? `“${pendingDelete.name}” and everything inside it will be moved to the trash.`
              : `“${pendingDelete.name}” will be moved to the trash.`
          }
          detail={pendingDelete.path}
          onCancel={() => setPendingDelete(null)}
          actions={[
            { label: "Move to Trash", onClick: () => void confirmDelete(), primary: true, danger: true },
            { label: "Cancel", onClick: () => setPendingDelete(null) },
          ]}
        />
      )}
    </div>
  );
}

/** The inline field used for both creating and renaming. */
function NameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
  onRejected,
}: {
  initial: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  /** Says how many characters a name couldn't hold, so it isn't dropped silently. */
  onRejected: (count: number) => void;
}) {
  // Cleaned on the way in as well as on the way through: a file that already
  // has one of these in its name is renamed by pressing Enter on what this
  // offers, which is the only repair the tree can make.
  const [value, setValue] = useState(() => cleanName(initial));
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Selects the stem and leaves the extension alone, so renaming
    // `Component.tsx` doesn't mean retyping `.tsx`.
    const dot = initial.lastIndexOf(".");
    if (dot > 0) {
      input.setSelectionRange(0, dot);
    } else {
      input.select();
    }
  }, [initial]);

  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className="editor-row-input flex-1 min-w-0 text-[12px] px-1 rounded"
      onChange={(e) => {
        const cleaned = cleanName(e.target.value);
        if (cleaned.length !== e.target.value.length) {
          onRejected(e.target.value.length - cleaned.length);
        }
        setValue(cleaned);
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onKeyUp={(e) => e.stopPropagation()}
      // Clicking away commits, which is what every file manager does.
      onBlur={() => (value.trim() && value !== initial ? onCommit(value) : onCancel())}
    />
  );
}
