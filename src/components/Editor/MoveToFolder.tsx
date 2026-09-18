import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Search } from "lucide-react";
import { basename, dirname, joinPath, listFiles, relativeTo } from "../../services/editor-fs";
import { canMoveInto, isUnder, samePath } from "../../services/explorer-paths";
import { fuzzyFilter } from "../../services/fuzzy";
import { scrollIntoViewWithin } from "../../services/scroll";

/**
 * "Move to Folder…" — a folder tree to pick a destination out of.
 *
 * Dragging is the direct way to move something and stays the primary one, but
 * it only works between two rows on screen at the same time. Moving a file from
 * `src/components/Editor` to `src-tauri/src/commands` by dragging means
 * scrolling a tree with the mouse held down, which is the interaction everybody
 * hates.
 *
 * It is a *tree*, not a list, because the answer to "which folder" is usually
 * several levels down and the levels are how people know they have the right
 * one: three folders called `commands`, `components` and `common` are told
 * apart by what they sit under. Typing switches to a flat fuzzy list, for when
 * the destination is already known by name.
 *
 * The folders come from `fs_list_files` — already there for ⌘P, capped and
 * `.gitignore`d on the Rust side — plus every folder the explorer has seen,
 * which is what puts a folder with no files in it on the list at all. That is
 * the whole tree in one call, so expanding a row costs nothing.
 */

/** Rows shown in the flat list while filtering. */
const MAX_RESULTS = 60;

interface MoveToFolderProps {
  root: string;
  showHidden: boolean;
  /** What is being moved. */
  path: string;
  name: string;
  /** Every folder the explorer has seen, including ones holding no files. */
  knownDirs: string[];
  onMove: (toDir: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/** A folder as the tree draws it. */
interface Row {
  dir: string;
  depth: number;
  hasChildren: boolean;
  /** False for the folder itself, its descendants, and where it already is. */
  allowed: boolean;
}

export function MoveToFolder({
  root,
  showHidden,
  path,
  name,
  knownDirs,
  onMove,
  onClose,
  onError,
}: MoveToFolderProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root]));
  const [selected, setSelected] = useState<string | null>(null);
  /** Which visible row the keyboard is on. */
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const parent = useMemo(() => dirname(path), [path]);

  useEffect(() => {
    let cancelled = false;
    void listFiles(root, showHidden)
      .then((result) => {
        if (!cancelled) setFiles(result.files);
      })
      .catch((error) => {
        if (cancelled) return;
        // The explorer's own folders are still a usable tree, so a failure here
        // degrades rather than emptying the dialog.
        setFiles([]);
        onError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [root, showHidden, onError]);

  /** Every folder in the project, and which folders sit directly inside each. */
  const tree = useMemo(() => {
    const dirs = new Set<string>([root, ...knownDirs]);
    // Every directory on the way to a file is a directory in the project.
    for (const file of files ?? []) {
      let dir = dirname(joinPath(root, file));
      while (dir.length > root.length && !dirs.has(dir)) {
        dirs.add(dir);
        dir = dirname(dir);
      }
    }

    const byParent = new Map<string, string[]>();
    for (const dir of dirs) {
      if (samePath(dir, root)) continue;
      const key = dirname(dir);
      const siblings = byParent.get(key);
      if (siblings) siblings.push(dir);
      else byParent.set(key, [dir]);
    }
    for (const siblings of byParent.values()) {
      siblings.sort((a, b) => basename(a).localeCompare(basename(b)));
    }
    return byParent;
  }, [files, root, knownDirs]);

  /**
   * Opens the tree down to where the thing being moved lives.
   *
   * Landing on a collapsed root would make every move start with the same four
   * clicks, and the folder you are moving *out of* is the one that says where
   * you are.
   */
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      let dir = parent;
      for (;;) {
        next.add(dir);
        if (samePath(dir, root)) break;
        const up = dirname(dir);
        // `dirname("/")` is `/`: without this, a path that never reaches the
        // root spins forever.
        if (!up || up === dir) break;
        dir = up;
      }
      return next;
    });
  }, [parent, root]);

  /** The tree, flattened to what is on screen. */
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      out.push({
        dir,
        depth,
        hasChildren: (tree.get(dir)?.length ?? 0) > 0,
        allowed: canMoveInto(path, dir, parent),
      });
      if (!expanded.has(dir)) return;
      for (const child of tree.get(dir) ?? []) {
        // The folder being moved is not a place to move it to, and neither is
        // anything inside it — so the whole branch is left out rather than
        // shown greyed, which would only invite clicking it.
        if (samePath(child, path) || isUnder(child, path)) continue;
        walk(child, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [tree, expanded, root, path, parent]);

  /** While filtering, the flat list replaces the tree. */
  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return null;
    const candidates: { dir: string; label: string }[] = [];
    const add = (dir: string) => {
      if (!canMoveInto(path, dir, parent) || samePath(dir, path) || isUnder(dir, path)) return;
      candidates.push({ dir, label: samePath(dir, root) ? basename(root) : relativeTo(root, dir) });
    };
    add(root);
    for (const siblings of tree.values()) siblings.forEach(add);
    return fuzzyFilter(candidates, trimmed, (c) => c.label, MAX_RESULTS);
  }, [query, tree, root, path, parent]);

  /** What the arrows and Enter act on, tree or list. */
  const visible = useMemo(
    () => (results ? results.map((r) => r.item.dir) : rows.map((row) => row.dir)),
    [results, rows]
  );

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    const list = listRef.current;
    scrollIntoViewWithin(list, list?.children[cursor] as HTMLElement | undefined);
  }, [cursor, visible.length]);

  const toggle = (dir: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const commit = (dir: string | null) => {
    if (!dir || !canMoveInto(path, dir, parent)) return;
    onMove(dir);
    onClose();
  };

  /** Moves the keyboard cursor, and with it the chosen destination. */
  const moveCursor = (delta: number) => {
    const next = Math.min(Math.max(cursor + delta, 0), visible.length - 1);
    setCursor(next);
    const dir = visible[next];
    if (dir && canMoveInto(path, dir, parent)) setSelected(dir);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const at = visible[cursor];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveCursor(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveCursor(-1);
        break;
      case "ArrowRight":
        // Only in the tree, and only where there is something to open —
        // otherwise this is the caret moving through what was typed.
        if (results || !at || expanded.has(at) || !(tree.get(at)?.length ?? 0)) break;
        e.preventDefault();
        toggle(at);
        break;
      case "ArrowLeft":
        if (results || !at || !expanded.has(at)) break;
        e.preventDefault();
        toggle(at);
        break;
      case "Enter":
        e.preventDefault();
        // Whatever the footer says it will do — never the row the cursor
        // happens to be resting on in the tree, which starts on the root.
        commit(destination);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  /*
    Filtering and browsing choose differently, and deliberately. The list is a
    search result: the row under the cursor *is* the answer, as in ⌘P. The tree
    is somewhere to look around, where the pointer passing over a folder on the
    way to another one must not change what would be moved.
  */
  const destination = results ? visible[cursor] ?? null : selected;
  const canCommit = !!destination && canMoveInto(path, destination, parent);

  return (
    <div
      className="editor-overlay-backdrop fixed inset-0 z-[300] flex items-start justify-center pt-[10%]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div
        className="editor-palette w-[460px] max-w-[92%] rounded-xl overflow-hidden flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-palette-head px-3 py-2 text-[11px] truncate" title={path}>
          Move <span className="editor-palette-subject">{name}</span> to…
        </div>

        <div className="editor-palette-field flex items-center gap-2 px-3 py-2">
          <Search size={13} className="editor-palette-icon shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => e.stopPropagation()}
            onPaste={(e) => e.stopPropagation()}
            placeholder={files ? "Filter folders, or browse below" : "Reading the project…"}
            spellCheck={false}
            className="editor-palette-input flex-1 min-w-0 bg-transparent outline-none text-[12px]"
          />
        </div>

        <div ref={listRef} className="editor-palette-list max-h-[320px] overflow-y-auto py-1">
          {results
            ? results.map((result, index) => (
                <div
                  key={result.item.dir}
                  className={`editor-palette-row flex items-center gap-2 px-3 py-1.5 ${
                    index === cursor ? "selected" : ""
                  }`}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => commit(result.item.dir)}
                >
                  <Folder size={13} className="editor-icon-folder shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-[12px]">
                    <Highlighted text={result.item.label} matches={result.matches} />
                  </span>
                </div>
              ))
            : rows.map((row, index) => (
                <div
                  key={row.dir}
                  className={`editor-palette-row editor-move-row flex items-center gap-1.5 pr-3 py-1 ${
                    index === cursor ? "selected" : ""
                  } ${destination === row.dir && row.allowed ? "picked" : ""} ${
                    row.allowed ? "" : "disabled"
                  }`}
                  style={{ paddingLeft: 10 + row.depth * 12 }}
                  onClick={() => {
                    // One click picks the folder; the chevron alone opens it.
                    // A folder that can't be moved into is still a way through,
                    // so clicking one opens it instead of picking it.
                    setCursor(index);
                    if (row.allowed) setSelected(row.dir);
                    else if (row.hasChildren) toggle(row.dir);
                  }}
                  onDoubleClick={() => commit(row.dir)}
                >
                  <span
                    className="editor-row-chevron shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (row.hasChildren) toggle(row.dir);
                    }}
                  >
                    {row.hasChildren ? (
                      expanded.has(row.dir) ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )
                    ) : null}
                  </span>
                  {expanded.has(row.dir) && row.hasChildren ? (
                    <FolderOpen size={13} className="editor-icon-folder shrink-0" />
                  ) : (
                    <Folder size={13} className="editor-icon-folder shrink-0" />
                  )}
                  <span className="flex-1 min-w-0 truncate text-[12px]">
                    {samePath(row.dir, root) ? basename(root) || root : basename(row.dir)}
                  </span>
                  {samePath(row.dir, parent) && (
                    <span className="editor-move-here text-[10px] shrink-0">already here</span>
                  )}
                </div>
              ))}

          {results?.length === 0 && (
            <div className="editor-palette-empty px-3 py-5 text-center text-[11px]">
              No matching folder
            </div>
          )}
        </div>

        <div className="editor-move-footer flex items-center gap-2 px-3 py-2">
          <span className="editor-move-target flex-1 min-w-0 truncate text-[11px]" title={destination ?? ""}>
            {canCommit && destination
              ? `→ ${samePath(destination, root) ? basename(root) || root : relativeTo(root, destination)}`
              : "Pick a folder"}
          </span>
          <button
            className="editor-dialog-btn px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="editor-dialog-btn primary px-3 py-1.5 rounded-md text-[11px] font-medium"
            disabled={!canCommit}
            onClick={() => commit(destination)}
          >
            Move
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shows which characters the query matched. */
function Highlighted({ text, matches }: { text: string; matches: number[] }) {
  const hits = new Set(matches);
  return (
    <>
      {[...text].map((char, index) => (
        <span key={index} className={hits.has(index) ? "editor-palette-match" : ""}>
          {char}
        </span>
      ))}
    </>
  );
}
