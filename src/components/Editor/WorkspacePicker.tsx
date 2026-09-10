import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderPlus, RefreshCw, Search, Star, Trash2, X } from "lucide-react";
import { scrollIntoViewWithin } from "../../services/scroll";
import { basename } from "../../services/editor-fs";
import { collapseHome } from "../../services/recent-dirs";
import type { Workspace } from "../../services/editor-session";

/**
 * The workspace picker.
 *
 * A modal rather than a dropdown from the breadcrumb, for two reasons: the
 * breadcrumb bar is `overflow-hidden` so an absolutely-positioned menu was
 * clipped to its height and rendered invisibly, and a list you can filter and
 * delete rows from wants more room than a bar can give.
 *
 * It lists only folders that have been opened *in the editor*, each with its
 * own tabs and expanded tree. It briefly also offered directories from the
 * shell's history, which turned out to be noise: `cd` goes to plenty of places
 * that are nobody's project, and the list they produced needed pruning more
 * often than it saved a trip to the folder picker.
 *
 * Two tabs. **All** is every remembered folder, pinned ones first. **Favourites**
 * is the pinned set on its own, which is what you want once the list is long
 * enough that scanning it costs more than a click. A pin outlives forgetting a
 * folder's tabs, so a favourite can appear here without being a workspace yet;
 * opening it makes it one.
 */

interface WorkspacePickerProps {
  root: string | null;
  workspaces: Workspace[];
  /** Pinned folder paths. */
  favorites: string[];
  onOpen: (root: string) => void;
  /** Re-reads the open folder from disk, keeping its tabs. */
  onReload: () => void;
  /**
   * Forgets a folder: its remembered tabs and expanded tree. The folder itself
   * is not touched.
   */
  onForget: (path: string) => void;
  onToggleFavorite: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}

interface Row {
  path: string;
  /** Open tab count, for workspaces that have any. */
  tabs: number;
  isCurrent: boolean;
  isFavorite: boolean;
  /** False for a pin whose folder has been forgotten as a workspace. */
  isWorkspace: boolean;
}

export function WorkspacePicker({
  root,
  workspaces,
  favorites,
  onOpen,
  onReload,
  onForget,
  onToggleFavorite,
  onBrowse,
  onClose,
}: WorkspacePickerProps) {
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<"all" | "favorites">("all");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const pinned = useMemo(() => new Set(favorites), [favorites]);

  const rows = useMemo(() => {
    const known = new Set(workspaces.map((w) => w.root));

    const all: Row[] = [
      ...workspaces.map((w) => ({
        path: w.root,
        tabs: w.openPaths.length,
        isCurrent: w.root === root,
        isFavorite: pinned.has(w.root),
        isWorkspace: true,
      })),
      // Pins whose workspace has since been forgotten still belong in the list.
      ...favorites
        .filter((path) => !known.has(path))
        .map((path) => ({
          path,
          tabs: 0,
          isCurrent: path === root,
          isFavorite: true,
          isWorkspace: false,
        })),
    ];

    // Pinned first, then by how recently they were opened — which is the order
    // `workspaces` already arrives in, so a stable sort is all this needs.
    const ordered = [...all].sort(
      (a, b) => Number(b.isFavorite) - Number(a.isFavorite)
    );

    const scoped = tab === "favorites" ? ordered.filter((r) => r.isFavorite) : ordered;

    const query = filter.trim().toLowerCase();
    if (!query) return scoped;
    // Matched against the whole path, not just the folder name: `src/api` and
    // `web/api` are told apart by what's in front of them.
    return scoped.filter((row) => row.path.toLowerCase().includes(query));
  }, [workspaces, favorites, pinned, root, filter, tab]);

  useEffect(() => setSelected(0), [filter, tab]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`);
    scrollIntoViewWithin(listRef.current, row);
  }, [selected]);

  const choose = (row: Row) => {
    // Re-opening the folder already open would throw away its tabs to restore
    // the same ones; the "Reload" row is the way to ask for that deliberately.
    if (!row.isCurrent) onOpen(row.path);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, rows.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (rows[selected]) choose(rows[selected]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
      case "Backspace":
      case "Delete": {
        // Only with a modifier — plain Backspace belongs to the filter field —
        // and never the folder currently open.
        const row = rows[selected];
        if ((e.metaKey || e.ctrlKey) && row && !row.isCurrent) {
          e.preventDefault();
          onForget(row.path);
        }
        break;
      }
    }
  };

  return (
    <div
      className="editor-dialog-backdrop fixed inset-0 z-[300] flex items-start justify-center pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div
        className="editor-workspace-modal w-[540px] max-w-[92vw] max-h-[70vh] rounded-xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Workspaces"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-workspace-header flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <span className="editor-dialog-title text-[13px] font-semibold flex-1">
            Workspaces
          </span>
          <button
            className="editor-icon-btn p-1 rounded"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>

        <div className="editor-workspace-tabs flex items-center gap-1 px-3.5 pb-2 shrink-0">
          <TabButton
            active={tab === "all"}
            onClick={() => setTab("all")}
            label="All"
            count={workspaces.length}
          />
          <TabButton
            active={tab === "favorites"}
            onClick={() => setTab("favorites")}
            label="Favourites"
            count={favorites.length}
            icon={<Star size={11} className={tab === "favorites" ? "fill-current" : ""} />}
          />
        </div>

        <div className="editor-workspace-search flex items-center gap-2 px-3.5 py-2 shrink-0">
          <Search size={12} className="editor-palette-icon shrink-0" />
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onPaste={(e) => e.stopPropagation()}
            placeholder="Filter folders…"
            spellCheck={false}
            className="editor-palette-input flex-1 min-w-0 bg-transparent outline-none text-[12px]"
          />
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-1">
          {rows.map((row, index) => (
            <div key={row.path}>
              {index === 0 && (
                <SectionLabel
                  text={`${rows.length} ${rows.length === 1 ? "folder" : "folders"}`}
                />
              )}
              <div
                  data-row={index}
                  className={`editor-workspace-item group flex items-center gap-2.5 px-3.5 py-2 ${
                    index === selected ? "selected" : ""
                  } ${row.isCurrent ? "current" : ""}`}
                  onMouseEnter={() => setSelected(index)}
                >
                  <button
                    className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                    onClick={() => choose(row)}
                    title={row.path}
                  >
                    <span className="w-3.5 shrink-0 flex items-center">
                      {row.isCurrent && (
                        <Check size={12} className="editor-workspace-check" />
                      )}
                    </span>
                    <span className="flex flex-col min-w-0">
                      <span className="text-[12px] truncate">
                        {basename(row.path) || row.path}
                      </span>
                      <span className="editor-workspace-path text-[10px] truncate">
                        {collapseHome(row.path)}
                      </span>
                    </span>
                  </button>

                  {row.tabs ? (
                    <span
                      className="editor-workspace-count text-[10px] shrink-0"
                      title={`${row.tabs} open ${row.tabs === 1 ? "file" : "files"}`}
                    >
                      {row.tabs}
                    </span>
                  ) : null}

                  {/*
                    A pin is available on every row, the open folder included —
                    that's usually the one you want to keep to hand.
                  */}
                  <button
                    className={`editor-workspace-star p-1 rounded shrink-0 ${
                      row.isFavorite ? "on" : ""
                    }`}
                    onClick={() => onToggleFavorite(row.path)}
                    title={row.isFavorite ? "Remove from favourites" : "Add to favourites"}
                    aria-pressed={row.isFavorite}
                    aria-label={
                      row.isFavorite
                        ? `Unpin ${basename(row.path)}`
                        : `Pin ${basename(row.path)}`
                    }
                  >
                    <Star size={12} className={row.isFavorite ? "fill-current" : ""} />
                  </button>

                  {/*
                    Every row but the one currently open can be forgotten. The
                    open folder is excluded because forgetting it would leave
                    the editor with no root.
                  */}
                  {!row.isCurrent && row.isWorkspace && (
                    <button
                      className="editor-workspace-remove p-1 rounded shrink-0"
                      onClick={() => onForget(row.path)}
                      title="Forget this workspace — the folder itself is not touched"
                      aria-label={`Forget ${basename(row.path)}`}
                    >
                      <Trash2 size={12} />
                      <span className="editor-workspace-remove-label text-[10px]">
                        Forget
                      </span>
                    </button>
                  )}
              </div>
            </div>
          ))}

          {rows.length === 0 && (
            <div className="editor-workspace-empty px-3.5 py-6 text-center text-[11px]">
              {filter.trim()
                ? "No folders match that."
                : tab === "favorites"
                  ? "No favourites yet — star a folder to pin it here."
                  : "No folders remembered yet."}
            </div>
          )}
        </div>

        <div className="editor-workspace-footer flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <button
            className="editor-dialog-btn primary flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={() => {
              onBrowse();
              onClose();
            }}
          >
            <FolderPlus size={12} />
            Open Folder…
          </button>
          {root && (
            <button
              className="editor-dialog-btn flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium"
              onClick={() => {
                onReload();
                onClose();
              }}
              title="Re-read this folder from disk — open tabs are kept"
            >
              <RefreshCw size={12} />
              Reload
            </button>
          )}
          <div className="flex-1" />
          <span className="editor-workspace-hint text-[10px]">
            ⌘⌫ forgets the highlighted folder
          </span>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon?: React.ReactNode;
}) {
  return (
    <button
      className={`editor-workspace-tab flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] ${
        active ? "active" : ""
      }`}
      onClick={onClick}
      aria-pressed={active}
    >
      {icon}
      {label}
      <span className="editor-workspace-tab-count text-[10px]">{count}</span>
    </button>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div className="editor-workspace-heading px-3.5 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wide">
      {text}
    </div>
  );
}
