import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  FolderMinus,
  FolderPlus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
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
   * Leaves the open folder without opening another.
   *
   * Distinct from forgetting one: the folder keeps its place in this list and
   * its remembered tabs, and the editor goes back to asking which project you
   * want. Absent when there is no folder to close.
   */
  onCloseFolder: () => void;
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
  onCloseFolder,
  onForget,
  onToggleFavorite,
  onBrowse,
  onClose,
}: WorkspacePickerProps) {
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<"all" | "favorites">("all");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Whether Reload has just run, so the button can say so.
   *
   * The reload happens to the tree and the open buffers behind this dialog,
   * where none of it is visible — without an acknowledgement the click looks
   * like nothing happened, which is what makes people press it again. It
   * clears itself after a moment so a second reload is available.
   */
  const [reloaded, setReloaded] = useState(false);
  useEffect(() => {
    if (!reloaded) return;
    const timer = setTimeout(() => setReloaded(false), 1400);
    return () => clearTimeout(timer);
  }, [reloaded]);

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
      {/*
        520px, like every other dialog in this family.

        It was 540 — the odd one of the five that share
        `.editor-workspace-modal`, by twenty pixels nobody chose. Open it after
        the Projects picker and the difference is visible as a jump.
      */}
      <div
        className="editor-workspace-modal w-[520px] max-w-[92vw] max-h-[70vh] rounded-xl flex flex-col overflow-hidden"
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

        {/*
          `pt-3` is not decoration. This row had `pb-2` and no top padding at
          all, so the tabs sat flush against the header's bottom border — two
          different things touching, with the gap only underneath them. The
          space above a group is what says the group is separate from what is
          above it.
        */}
        <div className="editor-workspace-tabs flex items-center gap-1 px-3.5 pt-3 pb-2.5 shrink-0">
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
          {/*
            The field keeps focus the whole time the dialog is open — the arrow
            keys are handled on the backdrop, so nothing else ever takes it.
            That is what makes `aria-activedescendant` the right way to say
            which row is current: the focus never moves, so a screen reader is
            told about the selection instead of being left to infer it.
          */}
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onPaste={(e) => e.stopPropagation()}
            placeholder="Filter folders…"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls="workspace-list"
            aria-activedescendant={rows[selected] ? `workspace-row-${selected}` : undefined}
            aria-label="Filter folders"
            className="editor-palette-input flex-1 min-w-0 bg-transparent outline-none text-[12px]"
          />
        </div>

        <div
          ref={listRef}
          id="workspace-list"
          role="listbox"
          aria-label="Folders"
          className="flex-1 min-h-0 overflow-y-auto py-1"
        >
          {/*
            No "N folders" heading here any more. The tabs above already carry
            the counts, so it printed the same number twice, twenty pixels
            apart — and it was the only thing the row wrapper existed for.
          */}
          {rows.map((row, index) => (
            <div
              key={row.path}
              id={`workspace-row-${index}`}
              data-row={index}
              role="option"
              aria-selected={index === selected}
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
                  {row.isCurrent && <Check size={12} className="editor-workspace-check" />}
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
                Every row but the one currently open can be forgotten. The open
                folder is excluded because forgetting it would leave the editor
                with no root.
              */}
              {!row.isCurrent && row.isWorkspace && (
                <button
                  className="editor-workspace-remove p-1 rounded shrink-0"
                  onClick={() => onForget(row.path)}
                  title="Forget this workspace — the folder itself is not touched"
                  aria-label={`Forget ${basename(row.path)}`}
                >
                  <Trash2 size={12} />
                  <span className="editor-workspace-remove-label text-[10px]">Forget</span>
                </button>
              )}
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

        {/*
          The footer, which used to overflow its own dialog.

          Three buttons and a sentence were packed into one row: ~340px of
          controls and a ~190px hint inside 492px of content width, so at the
          dialog's *own* size the hint was already being squeezed, and at
          `max-w-[92vw]` on a small window it was worse.

          Two changes. The hint becomes a key chip rather than a sentence — the
          rows above have a visible **Forget** button, so the shortcut needs
          naming, not explaining. And the buttons sort themselves by what they
          act on: **Reload** and **Close Folder** are about the folder already
          open, so they group together on the left of the cluster, while
          **Open Folder…** opens a different one and takes the primary slot at
          the trailing edge, where a dialog's confirming action belongs.

          `flex-wrap` is the floor: on a narrow window the row becomes two
          rows rather than a line of clipped buttons.
        */}
        <div className="editor-workspace-footer flex flex-wrap items-center gap-2 px-3.5 py-2.5 shrink-0">
          {/*
            One cap per key.

            `⌘⌫` in a single cap put two symbols of near-identical weight
            against each other with nothing between them, which reads as one
            unfamiliar glyph rather than as a chord. They are two keys, so they
            get two caps — the gap does the work a `+` would, without the third
            symbol. (The navigator's `⌘P` stays one cap on purpose: a modifier
            and a *letter* are legible together; two symbols are not.)
          */}
          <span className="editor-workspace-hint flex items-center gap-1.5 text-[10px] shrink-0">
            <span className="flex items-center gap-1">
              <kbd className="editor-workspace-kbd">⌘</kbd>
              <kbd className="editor-workspace-kbd">⌫</kbd>
            </span>
            forget
          </span>

          <div className="flex-1 min-w-[8px]" />

          {/*
            Reload does **not** close the dialog, where it used to.

            The other two footer buttons change which workspace you are in, so
            dismissing is right — the thing the dialog was about is gone. A
            reload changes nothing: it re-reads the same folder from disk and
            keeps your tabs, and you are still in it afterwards. Closing on it
            threw the list away as a side effect of refreshing, and made the
            button feel like a navigation.

            It does have to say something, though, because the refresh happens
            behind this dialog where you cannot see it — hence the brief
            acknowledgement on the button itself.
          */}
          {root && (
            <button
              className="editor-dialog-btn flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium shrink-0"
              onClick={() => {
                onReload();
                setReloaded(true);
              }}
              disabled={reloaded}
              title="Re-read this folder from disk — open tabs are kept"
            >
              {reloaded ? <Check size={12} /> : <RefreshCw size={12} />}
              {reloaded ? "Reloaded" : "Reload"}
            </button>
          )}

          {/*
            **Leave Workspace**, not *Close Folder*.

            Two things were wrong with the old name. "Close" is the most
            overloaded verb in this app — it closes a tab (⌘W), it closes the
            editor window (✕), and here it closed neither — and "Folder"
            pointed at the wrong object: nothing happens to the folder, which
            is still on disk with its files in it. What ends is your *session*
            in it.

            "Leave" also pairs correctly with **Forget** in the rows above, and
            the pair is the whole distinction: leaving is for now and keeps the
            remembered tabs, forgetting throws them away. Two verbs that sound
            different because they are.

            It stays next to Reload because both act on the workspace that is
            open, and away from Forget for the same reason.
          */}
          {root && (
            <button
              className="editor-dialog-btn flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium shrink-0"
              onClick={() => {
                onCloseFolder();
                onClose();
              }}
              title="Stop working in this folder — it keeps its place here, with its tabs"
            >
              <FolderMinus size={12} />
              Leave Workspace
            </button>
          )}

          <button
            className="editor-dialog-btn primary flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium shrink-0"
            onClick={() => {
              onBrowse();
              onClose();
            }}
          >
            <FolderPlus size={12} />
            Open Folder…
          </button>
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

