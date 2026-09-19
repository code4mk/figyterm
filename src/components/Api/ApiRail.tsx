/**
 * The sidebar: an icon strip, and one of three sections beside it.
 *
 * The strip is what makes the three sections findable. They used to be three
 * text buttons sharing a row with the import and add buttons, which meant the
 * selected one was distinguishable from the actions only by reading it.
 *
 * Inside the collections section, a flat list of rows with a depth number
 * rather than nested components: the tree is assembled and searched in
 * `services/api/tree.ts`, where it is tested, and this file is the drawing of
 * it. That division is what keeps the drag arithmetic — which row, which
 * parent, which index — out of a render.
 *
 * Dropping has three zones per row: the top and bottom eighths mean "before"
 * and "after", and the middle means "inside" when the row can hold things. It
 * is the one interaction here worth being fussy about, because a drag that
 * lands somewhere unintended silently reorganises someone's work.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  FolderClosed,
  FolderOpen,
  GitMerge,
  FolderPlus,
  Globe,
  History,
  Layers,
  PanelLeftClose,
  Plus,
  Play,
  Search,
  Trash2,
  Upload,
  Variable,
} from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { EditorDialog } from "../Editor/EditorDialog";
import { RailView, useApiStore } from "../../stores/apiStore";
import { buildTree, isWithin, siblingsOf, TreeRow } from "../../services/api/tree";
import { formatDuration, statusTone, timeAgo, toneClass } from "../../services/api/format";
import { ItemKind } from "../../types/api";
import { WorkspacePicker } from "./WorkspacePicker";
import { NameDialog } from "./NameDialog";

/** Where a drop would land, relative to the row under the pointer. */
type DropZone = "before" | "inside" | "after";

interface Menu {
  x: number;
  y: number;
  row: TreeRow;
}

/** A pending delete: what to say about it, and what it does. */
interface Confirming {
  title: string;
  message: string;
  detail?: string;
  run: () => void;
}

/** The colour a method chip takes. Reads at a glance, which is the whole job. */
function methodClass(method: string | null): string {
  switch ((method ?? "GET").toUpperCase()) {
    case "POST":
      return "text-ft-success";
    case "PUT":
    case "PATCH":
      return "text-ft-warning";
    case "DELETE":
      return "text-ft-error";
    case "HEAD":
    case "OPTIONS":
      return "text-ft-text-muted";
    default:
      return "text-ft-accent";
  }
}

/** Long methods would push every name out of line, so they are shortened
 * rather than allowed to set the column width. */
function methodLabel(method: string | null): string {
  const name = (method ?? "GET").toUpperCase();
  return name === "OPTIONS" ? "OPTS" : name === "DELETE" ? "DEL" : name;
}

const SECTIONS: { view: RailView; title: string; icon: typeof Layers; hint: string }[] = [
  { view: "collections", title: "Collections", icon: Layers, hint: "Collections" },
  { view: "environments", title: "Environments", icon: Variable, hint: "Environments" },
  { view: "history", title: "History", icon: History, hint: "History" },
];

/** One hairline per level of nesting. A tree four deep with nothing but
 * padding is a list you have to count. */
function Guides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} className="api-indent" aria-hidden />
      ))}
    </>
  );
}

export function ApiRail() {
  const collections = useApiStore((s) => s.collections);
  const workspaces = useApiStore((s) => s.workspaces);
  const workspaceId = useApiStore((s) => s.workspaceId);
  const openWorkspace = useApiStore((s) => s.openWorkspace);
  const createWorkspace = useApiStore((s) => s.createWorkspace);
  const renameWorkspace = useApiStore((s) => s.renameWorkspace);
  const deleteWorkspace = useApiStore((s) => s.deleteWorkspace);
  const items = useApiStore((s) => s.items);
  const expanded = useApiStore((s) => s.expanded);
  const query = useApiStore((s) => s.query);
  const rail = useApiStore((s) => s.rail);
  const railCollapsed = useApiStore((s) => s.railCollapsed);
  const history = useApiStore((s) => s.history);
  const tabs = useApiStore((s) => s.tabs);
  const activeTabId = useApiStore((s) => s.activeTabId);

  const setQuery = useApiStore((s) => s.setQuery);
  const setRail = useApiStore((s) => s.setRail);
  const toggleRail = useApiStore((s) => s.toggleRail);
  const railWidth = useApiStore((s) => s.railWidth);
  const setRailWidth = useApiStore((s) => s.setRailWidth);
  const toggleExpanded = useApiStore((s) => s.toggleExpanded);
  const createCollection = useApiStore((s) => s.createCollection);
  const createItem = useApiStore((s) => s.createItem);
  const renameItem = useApiStore((s) => s.renameItem);
  const renameCollection = useApiStore((s) => s.renameCollection);
  const deleteItem = useApiStore((s) => s.deleteItem);
  const deleteCollection = useApiStore((s) => s.deleteCollection);
  const duplicateItem = useApiStore((s) => s.duplicateItem);
  const moveItem = useApiStore((s) => s.moveItem);
  const openItem = useApiStore((s) => s.openItem);
  const openScope = useApiStore((s) => s.openScope);
  const openExample = useApiStore((s) => s.openExample);
  const renameExample = useApiStore((s) => s.renameExample);
  const deleteExample = useApiStore((s) => s.deleteExample);
  const storeExamples = useApiStore((s) => s.examples);
  const openHistory = useApiStore((s) => s.openHistory);
  const clearHistory = useApiStore((s) => s.clearHistory);
  const environments = useApiStore((s) => s.environments);
  const importFiles = useApiStore((s) => s.importFiles);
  const importDirectory = useApiStore((s) => s.importDirectory);
  const exportCollection = useApiStore((s) => s.exportCollection);
  const exportEnvironment = useApiStore((s) => s.exportEnvironment);
  const deleteEnvironment = useApiStore((s) => s.deleteEnvironment);
  const suggestedFileName = useApiStore((s) => s.suggestedFileName);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useApiStore((s) => s.setActiveEnvironment);
  const openEnvironment = useApiStore((s) => s.openEnvironment);
  const openRunner = useApiStore((s) => s.openRunner);

  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** What is about to be deleted, and what to do if it is confirmed. */
  const [confirming, setConfirming] = useState<Confirming | null>(null);

  /**
   * Dragging the sidebar wider or narrower.
   *
   * Pointer capture rather than listeners on `window`: it keeps the events
   * coming when the pointer leaves the handle — which it does immediately,
   * because the handle is 7px wide and the pointer is moving — and it releases
   * on its own if the button comes up somewhere unexpected.
   *
   * The width is measured from the rail's own left edge, so it is right
   * regardless of what is to the left of the window.
   */
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const section = handle.previousElementSibling;
    if (!section) return;

    const left = section.getBoundingClientRect().left;
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();

    const onMove = (move: PointerEvent) => setRailWidth(move.clientX - left);
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  /**
   * Closing the menu.
   *
   * It used to close only on a click *inside the rail*, which is the one place
   * somebody with a menu open is least likely to click next. A pointer down
   * anywhere else, Escape, a scroll or the window losing focus all dismiss it
   * now — the set of things that mean "I am done with this".
   *
   * Captured, because the panes underneath stop propagation of their own
   * clicks and a bubbling listener would never hear them.
   */
  useEffect(() => {
    if (!menu) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Stopped here, or the window's own Escape would close the whole
      // window behind the menu that was being dismissed.
      event.stopPropagation();
      event.preventDefault();
      setMenu(null);
    };
    const close = () => setMenu(null);

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  /** Moves the menu back on screen when it was opened near an edge. */
  useEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;

    const box = element.getBoundingClientRect();
    const overflowX = Math.max(0, box.right - window.innerWidth + 8);
    const overflowY = Math.max(0, box.bottom - window.innerHeight + 8);
    if (overflowX === 0 && overflowY === 0) return;

    element.style.left = `${Math.max(8, menu.x - overflowX)}px`;
    element.style.top = `${Math.max(8, menu.y - overflowY)}px`;
  }, [menu]);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** A workspace being named — a new one when `id` is null. */
  const [namingWorkspace, setNamingWorkspace] = useState<{
    id: string | null;
    name: string;
  } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; zone: DropZone } | null>(null);
  /** One clock for the whole list, rather than one per row. */
  const now = useMemo(() => Date.now(), [history]);

  const rows = useMemo(
    () => buildTree(collections, items, { expanded, query, examples: storeExamples }),
    [collections, items, expanded, query, storeExamples]
  );

  const needle = query.trim().toLowerCase();
  const shownEnvironments = useMemo(
    () =>
      needle === ""
        ? environments
        : environments.filter(
            (environment) =>
              environment.name.toLowerCase().includes(needle) ||
              environment.variables.some((variable) =>
                variable.key.toLowerCase().includes(needle)
              )
          ),
    [environments, needle]
  );
  const shownHistory = useMemo(
    () =>
      needle === ""
        ? history
        : history.filter(
            (entry) =>
              entry.url.toLowerCase().includes(needle) ||
              entry.method.toLowerCase().includes(needle)
          ),
    [history, needle]
  );

  // Whatever row the active tab is on — a request, a folder or a collection.
  // One id rather than three, because the rail marks one row either way.
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const openRowId = active ? (active.itemId ?? active.scopeId) : null;

  /** Turns a pointer position over a row into where the drop would go. */
  const zoneFor = useCallback((row: TreeRow, event: React.DragEvent): DropZone => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const offset = (event.clientY - box.top) / box.height;
    const canHold = row.kind !== "request";
    if (!canHold) return offset < 0.5 ? "before" : "after";
    if (offset < 0.25) return "before";
    if (offset > 0.75) return "after";
    return "inside";
  }, []);

  const onDrop = useCallback(
    async (row: TreeRow, zone: DropZone) => {
      const id = dragging;
      setDragging(null);
      setDropAt(null);
      if (!id) return;

      const moving = items.find((item) => item.id === id);
      if (!moving) return;

      // Into itself, or into its own child, would detach the subtree from the
      // tree and leave it reachable from nothing.
      if (row.kind !== "collection" && isWithin(items, id, row.id)) return;

      if (zone === "inside") {
        const parentId = row.kind === "collection" ? null : row.id;
        const collectionId = row.collectionId;
        const siblings = siblingsOf(items, collectionId, parentId).filter(
          (item) => item.id !== id
        );
        await moveItem(id, collectionId, parentId, siblings.length);
        return;
      }

      if (row.kind === "collection") {
        // Above or below a collection means the top level of it.
        const siblings = siblingsOf(items, row.id, null).filter((item) => item.id !== id);
        await moveItem(id, row.id, null, zone === "before" ? 0 : siblings.length);
        return;
      }

      const target = items.find((item) => item.id === row.id);
      if (!target) return;
      const parentId = target.parentId ?? null;
      const siblings = siblingsOf(items, target.collectionId, parentId).filter(
        (item) => item.id !== id
      );
      const index = siblings.findIndex((item) => item.id === target.id);
      await moveItem(
        id,
        target.collectionId,
        parentId,
        zone === "before" ? Math.max(0, index) : index + 1
      );
    },
    [dragging, items, moveItem]
  );

  /**
   * Picking files to import.
   *
   * Directories are allowed in the same dialog: a folder of exports is how
   * people usually have them, and importing thirty files one at a time is not
   * a migration anybody finishes.
   */
  const pickAndImport = async () => {
    const picked = await openDialog({
      multiple: true,
      directory: false,
      filters: [{ name: "Collections and environments", extensions: ["json"] }],
      title: "Import collections",
    });
    if (!picked) return;
    await importFiles(Array.isArray(picked) ? picked : [picked]);
  };

  const pickFolderAndImport = async () => {
    const picked = await openDialog({ directory: true, title: "Import a folder of exports" });
    if (!picked || Array.isArray(picked)) return;
    await importDirectory(picked);
  };

  /** Writing one back out, to wherever the save dialog says. */
  const exportTo = async (id: string, kind: "collection" | "environment") => {
    const path = await saveDialog({
      defaultPath: suggestedFileName(id, kind),
      filters: [{ name: "JSON", extensions: ["json"] }],
      title: kind === "collection" ? "Export collection" : "Export environment",
    });
    if (!path) return;
    if (kind === "collection") await exportCollection(id, path);
    else await exportEnvironment(id, path);
  };

  /**
   * Deleting, which always asks first.
   *
   * It used to ask only for a collection or a non-empty folder, on the grounds
   * that a request is one row and trivially remade — which is true right up
   * until the row was somebody's afternoon of getting the headers right. A
   * dialog is one keystroke to dismiss and there is no undo behind any of
   * this, so everything asks, and what it says names exactly what goes.
   *
   * The app's own dialog rather than the native one: `confirm()` from the
   * plugin blocks, cannot be styled, and on Linux draws something that looks
   * nothing like the rest of the window. It is the same component the editor
   * uses for the same question.
   */
  const remove = (row: TreeRow) => {
    if (row.kind === "example") {
      setConfirming({
        title: "Delete this example?",
        message: `"${row.name}" is a saved response. The request it belongs to is not affected.`,
        run: () => void deleteExample(row.id),
      });
      return;
    }

    const inside = items.filter(
      (item) =>
        (row.kind === "collection" && item.collectionId === row.id) ||
        (row.kind === "folder" && isWithin(items, row.id, item.id) && item.id !== row.id)
    ).length;

    const what = row.kind === "collection" ? "collection" : row.kind;
    setConfirming({
      title: `Delete this ${what}?`,
      message:
        inside === 0
          ? `"${row.name}" will be deleted. This cannot be undone.`
          : `"${row.name}" and the ${inside} item${inside === 1 ? "" : "s"} inside it will be deleted. This cannot be undone.`,
      detail: row.kind === "request" ? (row.url ?? undefined) : undefined,
      run: () => {
        if (row.kind === "collection") void deleteCollection(row.id);
        else void deleteItem(row.id);
      },
    });
  };

  const addTo = async (row: TreeRow, kind: ItemKind) => {
    const parentId = row.kind === "collection" ? null : row.id;
    const collectionId = row.collectionId;
    const id = await createItem(
      collectionId,
      parentId,
      kind,
      kind === "folder" ? "New folder" : "New request"
    );
    setMenu(null);
    if (id && kind === "request") void openItem(id);
    if (id) setRenaming(id);
  };

  const section = SECTIONS.find((entry) => entry.view === rail)!;
  const counts: Record<RailView, number> = {
    collections: collections.length,
    environments: environments.length,
    history: history.length,
  };

  return (
    <div className="flex h-full min-h-0 shrink-0">
      {/* ─── The strip ─────────────────────────────────────────────────── */}
      <div className="api-icon-strip flex w-11 shrink-0 flex-col items-center gap-1 py-2 border-r border-ft-border bg-ft-tab">
        {SECTIONS.map(({ view, icon: Icon, hint }) => (
          <button
            key={view}
            className={`api-icon-tab ${rail === view && !railCollapsed ? "selected" : ""}`}
            onClick={() => setRail(view)}
            title={railCollapsed || rail !== view ? hint : `${hint} — click to collapse`}
            aria-label={hint}
            aria-current={rail === view && !railCollapsed}
          >
            <Icon size={16} />
            {counts[view] > 0 && <span className="api-icon-count">{counts[view]}</span>}
          </button>
        ))}

        <div className="flex-1" />

        <button
          className="api-icon-tab"
          onClick={() => toggleRail()}
          title={railCollapsed ? "Show the sidebar" : "Collapse the sidebar"}
          aria-label={railCollapsed ? "Show the sidebar" : "Collapse the sidebar"}
        >
          <PanelLeftClose
            size={15}
            className={railCollapsed ? "rotate-180 transition-transform" : "transition-transform"}
          />
        </button>
      </div>

      {/* ─── The section ───────────────────────────────────────────────── */}
      {!railCollapsed && (
        <div
          className="api-rail flex h-full min-h-0 shrink-0 flex-col border-r border-ft-border bg-ft-tab"
          style={{ width: railWidth }}
        >
          <div className="flex items-center gap-1 px-2 h-8 shrink-0 border-b border-ft-border">
            <span className="flex-1 min-w-0 truncate text-[11px] font-semibold tracking-wide text-ft-text uppercase">
              {section.title}
            </span>

            {/* Labelled, not just drawn.
                An arrow and a plus are two of the most overloaded icons there
                are, and "which one imports" is not a question a title row
                should make anybody hover to answer. The words are what make
                these findable; the icons make them quick once found. */}
            {rail === "collections" && (
              <>
                <button
                  className="api-rail-button"
                  onClick={() => void pickAndImport()}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    void pickFolderAndImport();
                  }}
                  title="Import a collection or environment — right-click for a whole folder of them"
                  aria-label="Import a collection"
                >
                  <Upload size={12} />
                  Import
                </button>
                <button
                  className="api-rail-button primary"
                  onClick={() => void createCollection("New collection")}
                  title="New collection"
                  aria-label="New collection"
                >
                  <FolderPlus size={12} />
                  New
                </button>
              </>
            )}

            {rail === "environments" && (
              <>
                <button
                  className="api-rail-button"
                  onClick={() => void pickAndImport()}
                  title="Import an environment"
                  aria-label="Import an environment"
                >
                  <Upload size={12} />
                  Import
                </button>
                <button
                  className="api-rail-button primary"
                  onClick={() => openEnvironment("new")}
                  title="New environment"
                  aria-label="New environment"
                >
                  <Plus size={12} />
                  New
                </button>
              </>
            )}

            {rail === "history" && history.length > 0 && (
              <button
                className="api-rail-button danger"
                onClick={() =>
                  setConfirming({
                    title: "Clear the history?",
                    message: `All ${history.length} sent request${
                      history.length === 1 ? "" : "s"
                    } will be forgotten, with their responses. Your collections are not affected.`,
                    run: () => void clearHistory(),
                  })
                }
                title="Forget every request listed here"
                aria-label="Clear history"
              >
                <Trash2 size={12} />
                Clear
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 px-2 h-7 shrink-0 border-b border-ft-border-subtle">
            <Search size={11} className="text-ft-text-muted shrink-0" />
            <input
              className="api-rail-search flex-1 min-w-0"
              value={query}
              spellCheck={false}
              placeholder={
                rail === "collections"
                  ? "Search name, method or URL"
                  : rail === "environments"
                    ? "Search environments and variables"
                    : "Search sent requests"
              }
              onChange={(e) => setQuery(e.target.value)}
              aria-label={`Search ${section.title.toLowerCase()}`}
            />
            {query !== "" && (
              <button
                className="api-rail-action"
                onClick={() => setQuery("")}
                title="Clear the search"
                aria-label="Clear the search"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            {rail === "environments" ? (
              shownEnvironments.length === 0 ? (
                <div className="px-3 py-4 text-[11px] leading-relaxed text-ft-text-muted">
                  {environments.length === 0 ? (
                    <>
                      No environments yet. Make one with the <b>+</b> above, or import
                      one, and use its variables anywhere as{" "}
                      <code>{"{{like_this}}"}</code>.
                    </>
                  ) : (
                    "Nothing matches."
                  )}
                </div>
              ) : (
                shownEnvironments.map((environment) => {
                  const inUse = environment.id === activeEnvironmentId;
                  // Two different "selected"s, and they are not the same
                  // thing: the tab you are *looking at*, and the environment
                  // requests actually resolve with. A row can be either,
                  // both, or neither, so they get different marks — the bar
                  // down the left for the open tab, the tick for in use.
                  const open = openRowId === environment.id;

                  return (
                  <div
                    key={environment.id}
                    className={`api-row group flex items-center gap-1 pr-1 ${open ? "open" : ""} ${
                      inUse ? "in-use" : ""
                    }`}
                    style={{ paddingLeft: 4 }}
                    onClick={() => openEnvironment(environment.id)}
                    title={
                      inUse
                        ? "In use — its variables are what requests resolve with"
                        : "Open this environment"
                    }
                  >
                    {/* The tick is the answer to "which one is in use", and it
                        holds its column whether or not it is showing, so the
                        names do not shift as the selection moves. */}
                    <button
                      className={`api-env-tick ${inUse ? "on" : ""}`}
                      disabled={environment.isGlobal}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveEnvironment(inUse ? null : environment.id);
                      }}
                      title={
                        environment.isGlobal
                          ? "Globals always apply, whichever environment is selected"
                          : inUse
                            ? "In use — click to stop using it"
                            : "Use this environment"
                      }
                      aria-label={
                        inUse ? `Stop using ${environment.name}` : `Use ${environment.name}`
                      }
                      aria-pressed={inUse}
                    >
                      {environment.isGlobal ? <Globe size={11} /> : inUse ? <Check size={12} /> : null}
                    </button>

                    <span
                      className={`flex-1 min-w-0 truncate text-[11px] ${
                        inUse ? "font-semibold text-ft-text" : "text-ft-text"
                      }`}
                    >
                      {environment.isGlobal ? "Globals" : environment.name}
                    </span>

                    {inUse && (
                      <span className="shrink-0 text-[9px] uppercase tracking-wide text-ft-accent">
                        in use
                      </span>
                    )}
                    {environment.conflictedAt !== null && (
                      <GitMerge size={11} className="shrink-0 text-ft-warning" />
                    )}
                    <span className="shrink-0 text-[10px] text-ft-text-muted tabular-nums">
                      {environment.variables.length}
                    </span>
                    <button
                      className="api-row-action"
                      onClick={(e) => {
                        e.stopPropagation();
                        void exportTo(environment.id, "environment");
                      }}
                      title="Export"
                      aria-label={`Export ${environment.name}`}
                    >
                      <Download size={11} />
                    </button>
                    <button
                      className="api-row-action danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirming({
                          title: "Delete this environment?",
                          message: `"${environment.name}" and its ${environment.variables.length} variable${
                            environment.variables.length === 1 ? "" : "s"
                          } will be deleted. Anything using them will stop resolving.`,
                          run: () => void deleteEnvironment(environment.id),
                        });
                      }}
                      title="Delete"
                      aria-label={`Delete ${environment.name}`}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  );
                })
              )
            ) : rail === "history" ? (
              shownHistory.length === 0 ? (
                <div className="px-3 py-4 text-[11px] text-ft-text-muted">
                  {history.length === 0
                    ? "Every request you send is listed here."
                    : "Nothing matches."}
                </div>
              ) : (
                shownHistory.map((entry) => (
                  <button
                    key={entry.id}
                    className="api-history-row flex w-full items-center gap-2 px-2 py-1 text-left"
                    onClick={() => void openHistory(entry.id)}
                    title={entry.url}
                  >
                    <span
                      className={`api-method-chip ${methodClass(entry.method)}`}
                    >
                      {methodLabel(entry.method)}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[11px] text-ft-text">
                      {entry.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")}
                    </span>
                    {entry.status !== null ? (
                      <span
                        className={`shrink-0 text-[10px] tabular-nums ${toneClass(
                          statusTone(entry.status)
                        )}`}
                      >
                        {entry.status}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10px] text-ft-error">failed</span>
                    )}
                    <span className="w-12 shrink-0 text-right text-[9px] tabular-nums text-ft-text-muted">
                      {entry.durationMs === null
                        ? timeAgo(entry.sentAt, now)
                        : formatDuration(entry.durationMs)}
                    </span>
                  </button>
                ))
              )
            ) : rows.length === 0 ? (
              <div className="px-3 py-4 text-[11px] leading-relaxed text-ft-text-muted">
                {query ? (
                  "Nothing matches."
                ) : (
                  <>
                    No collections yet. The <b>+</b> above makes one; requests live
                    inside it. Already have exports? The arrow imports them.
                  </>
                )}
              </div>
            ) : (
              rows.map((row) => {
                const isOpen = openRowId !== null && row.id === openRowId;
                const drop = dropAt?.id === row.id ? dropAt.zone : null;
                const holder = row.kind === "folder" || row.kind === "collection";
                const example = row.kind === "example";

                return (
                  <div
                    key={row.id}
                    className={`api-row group flex items-center pr-1 ${isOpen ? "open" : ""} ${
                      drop ? `drop-${drop}` : ""
                    } ${dragging === row.id ? "dragging" : ""}`}
                    // An example belongs to its request and is ordered within
                    // it; there is nowhere else in the tree for it to go.
                    draggable={row.kind !== "collection" && !example && renaming !== row.id}
                    onDragStart={(e) => {
                      setDragging(row.id);
                      e.dataTransfer.effectAllowed = "move";
                      // Firefox refuses to start a drag without payload.
                      e.dataTransfer.setData("text/plain", row.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropAt(null);
                    }}
                    onDragOver={(e) => {
                      if (!dragging || dragging === row.id || example) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDropAt({ id: row.id, zone: zoneFor(row, e) });
                    }}
                    onDragLeave={() => setDropAt((at) => (at?.id === row.id ? null : at))}
                    onDrop={(e) => {
                      e.preventDefault();
                      void onDrop(row, zoneFor(row, e));
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, row });
                    }}
                    // A folder and a collection are things you can open, not
                    // just things that expand — they carry auth, scripts,
                    // variables and a description that everything inside
                    // inherits. Clicking does both, because somebody opening a
                    // folder usually wants to see inside it too.
                    onClick={() => {
                      // An example opens its request and shows that answer —
                      // an example on its own has no URL bar to belong to.
                      if (row.kind === "example") {
                        if (row.parentId) void openExample(row.parentId, row.id);
                        return;
                      }
                      if (row.kind === "request") {
                        void openItem(row.id);
                        return;
                      }
                      openScope(row.kind, row.id);
                      if (!row.expanded) toggleExpanded(row.id);
                    }}
                  >
                    <Guides depth={row.depth} />

                    {/* The twisty collapses without opening the tab: closing a
                        folder to get it out of the way should not also bring
                        its settings to the front. */}
                    <button
                      className="w-3.5 shrink-0 text-ft-text-muted disabled:opacity-0"
                      disabled={!row.hasChildren}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(row.id);
                      }}
                      tabIndex={row.hasChildren ? 0 : -1}
                      aria-label={row.expanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
                      aria-expanded={row.hasChildren ? row.expanded : undefined}
                    >
                      {row.hasChildren ? (
                        row.expanded ? (
                          <ChevronDown size={11} />
                        ) : (
                          <ChevronRight size={11} />
                        )
                      ) : null}
                    </button>

                    {row.kind === "request" ? (
                      <span className={`api-method-chip ${methodClass(row.method)}`}>
                        {methodLabel(row.method)}
                      </span>
                    ) : row.kind === "folder" ? (
                      <span className="mr-1.5 shrink-0 text-ft-text-muted">
                        {row.expanded ? <FolderOpen size={12} /> : <FolderClosed size={12} />}
                      </span>
                    ) : example ? (
                      // "e.g." where a request has its method, because that is
                      // what the column means: what kind of row this is. The
                      // status follows the name instead — it still tells a kept
                      // 200 from a kept 422, which is the reason for keeping
                      // both, but it is not what the row *is*.
                      <span className="api-method-chip">
                        <span className="api-eg">e.g.</span>
                      </span>
                    ) : null}

                    {renaming === row.id ? (
                      <input
                        className="api-cell flex-1"
                        autoFocus
                        defaultValue={row.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const name = e.target.value.trim();
                          if (name && name !== row.name) {
                            if (row.kind === "collection") void renameCollection(row.id, name);
                            else if (row.kind === "example") void renameExample(row.id, name);
                            else void renameItem(row.id, name);
                          }
                          setRenaming(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") {
                            (e.target as HTMLInputElement).value = row.name;
                            setRenaming(null);
                          }
                          e.stopPropagation();
                        }}
                      />
                    ) : (
                      <span
                        className={`flex-1 min-w-0 truncate text-[11px] ${
                          row.kind === "collection"
                            ? "font-semibold text-ft-text"
                            : "text-ft-text"
                        }`}
                        title={row.url ?? row.name}
                      >
                        {row.name}
                      </span>
                    )}

                    {example && row.status !== null && (
                      <span
                        className={`shrink-0 text-[10px] tabular-nums ${toneClass(
                          statusTone(row.status)
                        )}`}
                      >
                        {row.status}
                      </span>
                    )}

                    {/* A copy a sync kept because both sides had changed the row.
                        Badged rather than hidden: it is somebody's work, and the
                        only person who can decide what to do with it is looking at
                        the rail. */}
                    {row.conflicted && (
                      <GitMerge
                        size={11}
                        className="shrink-0 text-ft-warning"
                        aria-label="A conflicted copy kept by a sync"
                      />
                    )}

                    {/* On hover as well as on right-click. An action reachable
                        only from a context menu is one most people never find. */}
                    {holder && (
                      <button
                        className="api-row-action"
                        onClick={(e) => {
                          e.stopPropagation();
                          void addTo(row, "request");
                        }}
                        title="New request here"
                        aria-label={`New request in ${row.name}`}
                      >
                        <Plus size={12} />
                      </button>
                    )}
                    <button
                      className="api-row-action"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu({ x: e.clientX, y: e.clientY, row });
                      }}
                      title="More"
                      aria-label={`More actions for ${row.name}`}
                    >
                      <Ellipsis size={12} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Which body of work this is, along the bottom.

              At the foot rather than the head: it is the widest fact here and
              also the one changed least often, and a picker over the list
              would put the thing you touch once a week above the thing you
              touch every minute. */}
          <div className="flex items-center px-1.5 h-9 shrink-0 border-t border-ft-border">
            <WorkspacePicker
              workspaces={workspaces}
              activeId={workspaceId}
              onOpen={(id) => void openWorkspace(id)}
              onCreate={() => setNamingWorkspace({ id: null, name: "" })}
              onRename={(workspace) =>
                setNamingWorkspace({ id: workspace.id, name: workspace.name })
              }
              onDelete={(workspace) =>
                setConfirming({
                  title: `Delete the workspace "${workspace.name}"?`,
                  message:
                    "Every collection, environment and piece of history in it goes with it. This cannot be undone.",
                  run: () => void deleteWorkspace(workspace.id),
                })
              }
            />
          </div>
        </div>
      )}

      {/* The drag handle. A hairline with a wide hit area over it, like every
          other divider in this window — a 1px target is a target nobody hits
          on the first go. */}
      {!railCollapsed && (
        <div
          className="api-rail-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sidebar"
          onPointerDown={startResize}
          onDoubleClick={() => setRailWidth(240)}
          title="Drag to resize · double-click to reset"
        />
      )}

      {/* Naming a workspace — a new one, or one being renamed. The same box
          either way: it asks for a name, and the only difference is what it
          does with it. */}
      {namingWorkspace && (
        <NameDialog
          title={namingWorkspace.id ? "Rename workspace" : "New workspace"}
          label="Name"
          value={namingWorkspace.name}
          placeholder="Personal"
          confirmLabel={namingWorkspace.id ? "Rename" : "Create"}
          note={
            namingWorkspace.id
              ? undefined
              : "A workspace keeps its own collections, environments and history. Nothing is copied into a new one."
          }
          onConfirm={(name) => {
            if (namingWorkspace.id) void renameWorkspace(namingWorkspace.id, name);
            else void createWorkspace(name);
          }}
          onClose={() => setNamingWorkspace(null)}
        />
      )}

      {confirming && (
        <EditorDialog
          title={confirming.title}
          message={confirming.message}
          detail={confirming.detail}
          onCancel={() => setConfirming(null)}
          actions={[
            {
              label: "Delete",
              danger: true,
              primary: true,
              onClick: () => {
                confirming.run();
                setConfirming(null);
              },
            },
            { label: "Cancel", onClick: () => setConfirming(null) },
          ]}
        />
      )}

      {menu && (
        <div
          ref={menuRef}
          className="api-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label={menu.row.name}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="api-menu-title">{menu.row.name}</span>
          {(menu.row.kind === "folder" || menu.row.kind === "collection") && (
            <>
              <button className="api-menu-item" onClick={() => void addTo(menu.row, "request")}>
                <Plus size={12} /> New request
              </button>
              <button className="api-menu-item" onClick={() => void addTo(menu.row, "folder")}>
                <FolderPlus size={12} /> New folder
              </button>
              <button
                className="api-menu-item"
                onClick={() => {
                  const row = menu.row;
                  setMenu(null);
                  openRunner({
                    kind: row.kind === "collection" ? "collection" : "folder",
                    id: row.id,
                    name: row.name,
                  });
                }}
              >
                <Play size={12} /> Run…
              </button>
              <div className="api-menu-rule" />
            </>
          )}
          <button
            className="api-menu-item"
            onClick={() => {
              setRenaming(menu.row.id);
              setMenu(null);
            }}
          >
            Rename
          </button>
          {/* An example is a stored answer, not a request: there is nothing to
              duplicate it into. */}
          {menu.row.kind === "folder" || menu.row.kind === "request" ? (
            <button
              className="api-menu-item"
              onClick={() => {
                void duplicateItem(menu.row.id);
                setMenu(null);
              }}
            >
              <Copy size={12} /> Duplicate
            </button>
          ) : null}
          {menu.row.kind === "collection" && (
            <button
              className="api-menu-item"
              onClick={() => {
                const id = menu.row.id;
                setMenu(null);
                void exportTo(id, "collection");
              }}
            >
              <Download size={12} /> Export…
            </button>
          )}
          <div className="api-menu-rule" />
          <button
            className="api-menu-item danger"
            onClick={() => {
              const row = menu.row;
              setMenu(null);
              remove(row);
            }}
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
