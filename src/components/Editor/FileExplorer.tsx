import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FilePlus,
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
import { changeBadge, changeLabel, GitChange, isIgnored } from "../../services/git";
import { platform } from "../../services/platform";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ContextMenu";
import { FileIcon } from "./fileIcons";
import { EditorDialog } from "./EditorDialog";

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
  depth: number;
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

      if (draft && draft.parent === dir) {
        // The new-entry row sits at the top of its directory, where the eye
        // already is after clicking "New File".
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

      for (const entry of entries) {
        out.push({ entry, depth });
        if (entry.isDir && expandedSet.has(entry.path)) {
          walk(entry.path, depth + 1);
        }
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
      if (entry?.isDir && !expandedSet.has(entry.path)) onToggleExpand(entry.path);
      // Depth is the parent's depth plus one; found from the row we came from,
      // falling back to the root's children.
      const parentRow = rows.find((row) => row.entry.path === parent);
      setDraft({ parent, isDir, depth: parentRow ? parentRow.depth + 1 : 0 });
      setMenu(null);
    },
    [targetDirOf, expandedSet, onToggleExpand, rows]
  );

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

  const commitRename = useCallback(
    async (path: string, name: string) => {
      setRenaming(null);
      const trimmed = name.trim();
      if (!trimmed || trimmed === basename(path)) return;
      try {
        await renamePath(path, joinPath(dirname(path), trimmed));
        await load(dirname(path));
      } catch (error) {
        onError(String(error));
      }
    },
    [load, onError]
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
      // Moving a directory into itself or its own child would destroy it.
      if (from === toDir || toDir.startsWith(from + "/") || toDir.startsWith(from + "\\")) {
        return;
      }
      if (dirname(from) === toDir) return;
      try {
        await renamePath(from, joinPath(toDir, basename(from)));
        await Promise.all([load(dirname(from)), load(toDir)]);
      } catch (error) {
        onError(String(error));
      }
    },
    [load, onError]
  );

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
      <div className="editor-explorer-header flex items-center gap-1 px-2 h-[26px] shrink-0">
        <span className="editor-explorer-title text-[10px] font-semibold uppercase tracking-wide truncate flex-1">
          {basename(root) || root}
        </span>
        <button
          className="editor-icon-btn p-0.5 rounded"
          onClick={() => startDraft(null, false)}
          title="New file"
          aria-label="New file"
        >
          <FilePlus size={12} />
        </button>
        <button
          className="editor-icon-btn p-0.5 rounded"
          onClick={() => startDraft(null, true)}
          title="New folder"
          aria-label="New folder"
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
        className="editor-explorer-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
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
                } ${row.entry.isHidden ? "hidden-entry" : ""} ${
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
                }}
                onDragOver={(e) => {
                  if (!row.entry.isDir) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOver(row.entry.path);
                }}
                onDragLeave={() => setDragOver((prev) => (prev === row.entry.path ? null : prev))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const from = e.dataTransfer.getData("text/plain");
                  if (from && row.entry.isDir) void move(from, row.entry.path);
                }}
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
                  />
                ) : renaming === row.entry.path ? (
                  <NameInput
                    initial={row.entry.name}
                    onCommit={(name) => void commitRename(row.entry.path, name)}
                    onCancel={() => setRenaming(null)}
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
}: {
  initial: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
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
      onChange={(e) => setValue(e.target.value)}
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
