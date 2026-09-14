/**
 * The project list: search, favourites, and the four things you can do to a
 * drawing.
 *
 * Shaped like the editor's `WorkspacePicker` rows — a filterable list with
 * pinning, the current row marked, and the destructive action hidden until you
 * hover — but it is a rail rather than an overlay, because a drawing app's
 * project list is primary navigation and not a jump-to dialog.
 *
 * Row actions are inline icons rather than a `⋯` popover on purpose: a popover
 * is a second focus trap, an outside-click listener and a positioning problem,
 * and the repo already reveals actions on hover in exactly this way.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, FileText, Pencil, Plus, Search, Star, Trash2, X } from "lucide-react";
import { useDrawingStore } from "../../stores/drawingStore";
import { DrawingProject, searchProjects } from "../../services/drawing-project";
import { scrollIntoViewWithin } from "../../services/scroll";

/** How often the rows re-render so `3m ago` does not sit there saying `3m ago`
 * an hour later. A minute is the smallest unit any of them show. */
const TICK_MS = 60_000;

/** `2h ago`, and `just now` for anything under a minute. */
function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A group label with its size, so the rail reads as a list and not a heap. */
function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-1 pt-3 first:pt-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-ft-text-muted">
        {label}
      </span>
      <span className="text-[9px] tabular-nums text-ft-text-muted/60">{count}</span>
    </div>
  );
}

function itemsLabel(count: number): string {
  if (count === 0) return "empty";
  return `${count} item${count === 1 ? "" : "s"}`;
}

export function DrawingRail() {
  const projects = useDrawingStore((s) => s.projects);
  const activeId = useDrawingStore((s) => s.activeId);
  const query = useDrawingStore((s) => s.query);
  const setQuery = useDrawingStore((s) => s.setQuery);
  const create = useDrawingStore((s) => s.create);
  const select = useDrawingStore((s) => s.select);
  const rename = useDrawingStore((s) => s.rename);
  const toggleFavorite = useDrawingStore((s) => s.toggleFavorite);
  const remove = useDrawingStore((s) => s.remove);
  const duplicate = useDrawingStore((s) => s.duplicate);

  /** The row being renamed, and the text in its box. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** The row asking "really?". Only ever one. */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** Where the arrow keys are, which is not the same as which drawing is open:
   * you can walk the list without opening anything until you press Enter. */
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const searching = query.trim().length > 0;
  const rows = useMemo(() => searchProjects(projects, query), [projects, query]);

  // Re-render on a timer so the relative timestamps stay true while the window
  // sits open. Cheap: a rail of rows, once a minute.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  /**
   * The open drawing's position, which is what the cursor is pinned to.
   *
   * Tracking an id rather than an index is the difference between the
   * highlight following your drawing and the highlight staying on row 3 while
   * a different drawing moves into row 3.
   */
  const activeIndex = rows.findIndex((p) => p.id === activeId);

  useEffect(() => {
    setCursor(activeIndex >= 0 ? activeIndex : 0);
  }, [activeIndex, query]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`);
    scrollIntoViewWithin(listRef.current, row);
  }, [cursor]);

  const startRename = useCallback((project: DrawingProject) => {
    setConfirmId(null);
    setRenamingId(project.id);
    setDraft(project.name);
  }, []);

  /** Commits the draft. A blank one reverts — see `rename` in the store. */
  const commitRename = useCallback(() => {
    if (renamingId) rename(renamingId, draft);
    setRenamingId(null);
  }, [renamingId, draft, rename]);

  /** A new drawing lands selected and in rename mode with its name selected, so
   * naming it is one gesture and skipping the naming is also one gesture. */
  const handleNew = useCallback(async () => {
    setQuery("");
    const id = await create();
    setRenamingId(id);
    setDraft(useDrawingStore.getState().projects.find((p) => p.id === id)?.name ?? "");
  }, [create, setQuery]);

  const handleDuplicate = useCallback(
    async (id: string) => {
      setConfirmId(null);
      await duplicate(id);
    },
    [duplicate]
  );

  const renderRow = (project: DrawingProject, index: number) => {
    const isActive = project.id === activeId;
    const isRenaming = project.id === renamingId;
    const isConfirming = project.id === confirmId;
    const isCursor = index === cursor;

    if (isConfirming) {
      return (
        <div
          key={project.id}
          data-row={index}
          className="mx-1.5 my-0.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2"
        >
          <div className="truncate text-[11px] text-ft-text">Delete “{project.name}”?</div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              className="rounded bg-red-500/80 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-red-500"
              onClick={() => {
                setConfirmId(null);
                void remove(project.id);
              }}
            >
              Delete
            </button>
            <button
              className="rounded px-2 py-0.5 text-[10px] text-ft-text-muted hover:bg-ft-bg-tertiary"
              onClick={() => setConfirmId(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    // Three states that must never be confused for one another: the drawing
    // that is open (accent bar, solid background), the row the keyboard is on
    // (a wash, no bar), and the rest. The open one wins when they coincide.
    return (
      <div
        key={project.id}
        data-row={index}
        onMouseEnter={() => setCursor(index)}
        aria-current={isActive ? "true" : undefined}
        className={`group relative mx-1.5 my-0.5 flex items-center gap-1.5 rounded-md py-1.5 pl-3 pr-1.5 transition-colors ${
          isActive
            ? "bg-ft-bg-tertiary"
            : isCursor
              ? "bg-ft-bg-tertiary/40"
              : "hover:bg-ft-bg-tertiary/30"
        }`}
      >
        {isActive && (
          <span
            aria-hidden
            className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-ft-accent"
          />
        )}
        {isRenaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commitRename}
            onPaste={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                // Claimed, so the modal's Escape handler leaves it alone.
                e.preventDefault();
                setRenamingId(null);
              }
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-ft-border bg-ft-bg px-1.5 py-0.5 text-[12px] text-ft-text outline-none"
          />
        ) : (
          <button
            className="flex min-w-0 flex-1 flex-col items-start text-left"
            onClick={() => select(project.id)}
            onDoubleClick={() => startRename(project)}
            title={project.name}
          >
            <span
              className={`w-full truncate text-[12px] leading-tight ${
                isActive ? "font-medium text-ft-text" : "text-ft-text/85"
              }`}
            >
              {project.name}
            </span>
            <span className="mt-0.5 flex w-full items-center gap-1 text-[10px] leading-tight text-ft-text-muted">
              <span className="truncate">
                {itemsLabel(project.elementCount)} · {relativeTime(project.updatedAt)}
              </span>
              {/* Marks a project whose notes have something in them, so the
                  other half of it is not invisible from out here. */}
              {(project.noteChars ?? 0) > 0 && (
                <FileText size={9} className="shrink-0 opacity-70" aria-label="has notes" />
              )}
            </span>
          </button>
        )}

        {!isRenaming && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              className={`rounded p-1 hover:bg-ft-bg-secondary ${
                project.favorite
                  ? "text-yellow-400"
                  : "text-ft-text-muted opacity-0 group-hover:opacity-100"
              }`}
              onClick={() => toggleFavorite(project.id)}
              title={project.favorite ? "Remove from favourites" : "Add to favourites"}
              aria-pressed={project.favorite}
            >
              <Star size={12} className={project.favorite ? "fill-current" : ""} />
            </button>
            <button
              className="rounded p-1 text-ft-text-muted opacity-0 hover:bg-ft-bg-secondary group-hover:opacity-100"
              onClick={() => startRename(project)}
              title="Rename"
              aria-label={`Rename ${project.name}`}
            >
              <Pencil size={12} />
            </button>
            <button
              className="rounded p-1 text-ft-text-muted opacity-0 hover:bg-ft-bg-secondary group-hover:opacity-100"
              onClick={() => void handleDuplicate(project.id)}
              title="Duplicate"
              aria-label={`Duplicate ${project.name}`}
            >
              <Copy size={12} />
            </button>
            <button
              className="rounded p-1 text-ft-text-muted opacity-0 hover:bg-red-500/20 hover:text-red-400 group-hover:opacity-100"
              onClick={() => setConfirmId(project.id)}
              title="Delete"
              aria-label={`Delete ${project.name}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>
    );
  };

  const favourites = rows.filter((p) => p.favorite);
  const rest = rows.filter((p) => !p.favorite);

  return (
    <div className="drawing-rail flex w-[232px] shrink-0 flex-col border-r border-ft-border bg-ft-bg-secondary">
      {/* Search + new */}
      <div className="flex items-center gap-1.5 border-b border-ft-border px-2 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-ft-border bg-ft-bg px-2 py-1">
          <Search size={11} className="shrink-0 text-ft-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPaste={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // Escape clears the query. With nothing to clear it belongs to
              // the window, so it is *not* stopped and bubbles up to close it.
              if (e.key === "Escape") {
                if (query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                }
                return;
              }
              // Everything else is typing, and must not reach the shell's
              // shortcut handler — `⌘⇧X` in a search box is an X.
              e.stopPropagation();

              // The list is driven from the search box, so finding a drawing
              // and opening it never needs the mouse or a focus change.
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((i) => Math.min(i + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const row = rows[cursor];
                if (row) select(row.id);
              }
            }}
            placeholder="Search drawings…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-ft-text outline-none placeholder:text-ft-text-muted"
          />
          {query && (
            <button
              className="shrink-0 rounded p-0.5 text-ft-text-muted hover:text-ft-text"
              onClick={() => setQuery("")}
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <button
          className="shrink-0 rounded-md bg-ft-accent p-1.5 text-white opacity-90 hover:opacity-100"
          onClick={() => void handleNew()}
          title="New drawing"
          aria-label="New drawing"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* List */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-ft-text-muted">
            {searching ? "No drawings match that." : "No drawings yet."}
          </div>
        )}

        {/*
          While a query is active the headings collapse into one ranked list:
          you searched, so the best match belongs at the top whether or not it
          has a star.
        */}
        {/* Indices are positions in `rows`, not in the group being rendered, so
            the arrow keys walk the list as it is drawn — favourites first. */}
        {searching ? (
          rows.map(renderRow)
        ) : (
          <>
            {favourites.length > 0 && (
              <>
                <SectionHeading label="Favourites" count={favourites.length} />
                {favourites.map((p) => renderRow(p, rows.indexOf(p)))}
              </>
            )}
            {rest.length > 0 && (
              <>
                {favourites.length > 0 && (
                  <SectionHeading label="All drawings" count={rest.length} />
                )}
                {rest.map((p) => renderRow(p, rows.indexOf(p)))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
