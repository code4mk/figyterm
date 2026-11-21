/**
 * The drawing window.
 *
 * The frame only: drag, resize, picture-in-picture, fullscreen, and the two
 * bars. The scene and everything that saves it live in `DrawingCanvas`, and the
 * project list lives in the store — this component is the thing that puts them
 * on screen together.
 *
 * Built on the same primitives as the browser and editor windows
 * (`useDraggableModal`, `OverlayPortal`, the overlay stack), so it stacks and
 * behaves like they do.
 *
 * There is no Save button, and there is not going to be one. Saving is
 * automatic; the status bar says when it last happened, which is the whole of
 * the feedback and is enough precisely because there is nothing to press.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, PanelLeft, PictureInPicture2, X } from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, releaseFront } from "../../services/overlay-stack";
import { useOverlayZSync } from "../../hooks/useOverlayZSync";
import {
  fullscreenRect,
  pictureInPictureRect,
  useDraggableModal,
} from "../../hooks/useDraggableModal";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useDrawingStore } from "../../stores/drawingStore";
import { PaneTabs } from "./PaneTabs";
import { DrawingCanvas } from "./DrawingCanvas";
import { DrawingNotes } from "./DrawingNotes";
import { DrawingRail } from "./DrawingRail";
import { DrawingEmpty } from "./DrawingEmpty";

export interface DrawingModalProps {
  visible: boolean;
  onClose: () => void;
}

const MIN_SIZE = { w: 640, h: 480 };
const MAX_SIZE = { w: 2400, h: 1600 };
const DEFAULT_SIZE = { w: 1060, h: 720 };

/** `14:32`, in the user's locale. Absolute rather than relative because the bar
 * is glanced at, and "2 minutes ago" needs a timer to stay true. */
function savedAtLabel(at: number | null): string {
  if (!at) return "Not saved yet";
  const time = new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Saved ${time}`;
}

export function DrawingModal({ visible, onClose }: DrawingModalProps) {
  const [pipMode, setPipMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  const projects = useDrawingStore((s) => s.projects);
  const activeId = useDrawingStore((s) => s.activeId);
  const ready = useDrawingStore((s) => s.ready);
  const lastSavedAt = useDrawingStore((s) => s.lastSavedAt);
  const saveError = useDrawingStore((s) => s.saveError);
  const hydrate = useDrawingStore((s) => s.hydrate);
  const create = useDrawingStore((s) => s.create);
  const railCollapsed = useDrawingStore((s) => s.railCollapsed);
  const toggleRail = useDrawingStore((s) => s.toggleRail);
  const pane = useDrawingStore((s) => s.pane);
  const setPane = useDrawingStore((s) => s.setPane);
  const rename = useDrawingStore((s) => s.rename);

  const active = projects.find((p) => p.id === activeId) ?? null;

  // ─── Renaming from the title ─────────────────────────────────────────────

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  const startRename = useCallback(() => {
    if (!active) return;
    setDraft(active.name);
    setRenaming(true);
  }, [active]);

  /**
   * Commits the rename, or quietly drops it.
   *
   * The store already refuses an empty name — a project with no name is worse
   * than a project with a dull one — so this only has to stop sending it, and
   * leave the field's own text behind when it does.
   */
  const commitRename = useCallback(() => {
    setRenaming(false);
    const name = draft.trim();
    if (active && name && name !== active.name) rename(active.id, name);
  }, [active, draft, rename]);

  /*
    A rename belongs to the drawing it was started on. Switching project while
    the field is open would otherwise commit the old name onto the new one.
  */
  useEffect(() => setRenaming(false), [activeId]);

  const { style, onDragStart, onResizeStart, place, reset } = useDraggableModal({
    defaultSize: DEFAULT_SIZE,
    minSize: MIN_SIZE,
    maxSize: MAX_SIZE,
    elementRef: modalRef,
  });

  // ─── Stacking ────────────────────────────────────────────────────────────

  const [frontZ, setFrontZ] = useState<number | null>(null);
  const raise = useCallback(() => setFrontZ(claimFront("drawing")), []);
  // A claim by any overlay renumbers the rest; this re-reads ours.
  useOverlayZSync("drawing", setFrontZ);

  useEffect(() => {
    if (visible) {
      raise();
      return;
    }
    releaseFront("drawing");
    setFrontZ(null);
  }, [visible, raise]);

  // ─── Projects ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (visible) void hydrate();
  }, [visible, hydrate]);

  /**
   * A first-run window gets something to draw on.
   *
   * `hasEverHadProjects` is what keeps this from fighting the delete button:
   * without it, removing the last drawing would immediately conjure a new one
   * and the empty state could never be seen. So it fires for a list that has
   * never held anything, and never again in this session.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (!visible || !ready || seeded.current) return;
    seeded.current = true;
    if (projects.length === 0) void create();
  }, [visible, ready, projects.length, create]);

  // ─── Window modes ────────────────────────────────────────────────────────

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

  useEffect(() => {
    if (!fullscreen) return;
    const follow = () => {
      const rect = fullscreenRect();
      place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
    };
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [fullscreen, place]);

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

  /**
   * Escape closes the window.
   *
   * Stopped here rather than bubbling to the shell, and *not* taken when
   * Excalidraw is using it — a linear editor, a context menu or a dialog inside
   * the canvas all want Escape first, and they mark the event handled.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  if (!visible) return null;

  const modal = (
    <div
      ref={modalRef}
      /*
        A window, and it says so now. Its name goes in the label because the
        several states of this window look alike from the outside, and "Draw"
        alone does not say which drawing is open.
      */
      role="dialog"
      aria-modal={!pipMode}
      aria-label={active ? `Draw — ${active.name}` : "Draw"}
      className={`drawing-modal flex flex-col overflow-hidden ${
        fullscreen ? "rounded-none" : "rounded-xl"
      }`}
      style={pipMode ? { ...style, zIndex: frontZ ?? undefined } : style}
      onPointerDownCapture={raise}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
      tabIndex={-1}
    >
      {/*
        The title bar, and the drag handle.

        It used to borrow the browser window's chrome — `browser-chrome`,
        `browser-tabstrip`, `browser-brand` — for the stated reason that the
        windows would then line up. They did, at the cost of wearing a *tab
        strip* in a window that has no tabs: hence the `pt-1.5 pb-0` with a
        `pb-1.5` on each child, which is the geometry a row of tabs needs to
        sit on a baseline and which here only made every control hang.

        So it is the drawing window's own bar now, in the language the Claude
        window settled: three zones, one mark, and the thing you are looking at
        in the middle. Heights still match, because both are 44px — matching by
        agreement rather than by inheritance.
      */}
      <header
        className="drawing-header flex items-center gap-2 px-2 select-none cursor-grab active:cursor-grabbing"
        onPointerDown={onDragStart}
      >
        <div
          className="flex items-center gap-1.5 shrink-0"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className={`drawing-iconbtn ${railCollapsed ? "" : "on"}`}
            onClick={toggleRail}
            title={railCollapsed ? "Show drawings" : "Hide drawings"}
            aria-label={railCollapsed ? "Show drawings" : "Hide drawings"}
            aria-expanded={!railCollapsed}
          >
            <PanelLeft size={13} />
          </button>
          {/*
            One mark, not two.

            The brand carried FigyTerm's logo *and* Excalidraw's, on the
            argument that the window is one hosting the other. The Claude
            window makes the same argument and draws one mark, because whose
            window it is belongs in the title and a second logo beside the
            first only makes the corner busy. The same holds here.
          */}
          <span className="drawing-mark">
            <img src="/excalidraw.png" alt="" />
          </span>
          <span className="drawing-brand-title">Draw</span>
        </div>

        <span className="drawing-sep" />

        {/*
          The drawing's name — the subject of the window.

          It was an 11px muted string at the end of a row of controls, which is
          to say the quietest thing in the bar was the only one that said what
          you were looking at. It is the title now, and double-clicking it
          renames in place: the rail could already do that and the title bar is
          where anyone would try it first.
        */}
        <div className="drawing-locator flex items-center flex-1 min-w-0">
          {renaming && active ? (
            <input
              autoFocus
              className="drawing-rename-input min-w-0 flex-1"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={commitRename}
              onPaste={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  // Claimed, so the window's own Escape leaves it alone — this
                  // is a rename being abandoned, not a window being closed.
                  e.preventDefault();
                  setRenaming(false);
                }
              }}
              spellCheck={false}
              aria-label="Drawing name"
            />
          ) : active ? (
            <button
              className="drawing-locator-name truncate"
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={startRename}
              title={`${active.name}\nDouble-click to rename`}
            >
              {active.name}
            </button>
          ) : (
            <span className="drawing-locator-name idle">No drawing</span>
          )}
        </div>

        <div
          className="flex items-center gap-1 shrink-0"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {active && (
            <PaneTabs pane={pane} onChange={setPane} hasNotes={(active.noteChars ?? 0) > 0} />
          )}

          <span className="drawing-sep" />

          <button
            className={`drawing-iconbtn ${pipMode ? "on" : ""}`}
            onClick={togglePip}
            title={pipMode ? "Leave picture-in-picture" : "Picture-in-picture"}
            aria-label="Picture in picture"
            aria-pressed={pipMode}
          >
            <PictureInPicture2 size={12} />
          </button>
          <button
            className={`drawing-iconbtn ${fullscreen ? "on" : ""}`}
            onClick={toggleFullscreen}
            title={fullscreen ? "Restore" : "Maximize"}
            aria-label={fullscreen ? "Restore" : "Maximize"}
            aria-pressed={fullscreen}
          >
            {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            className="drawing-iconbtn danger"
            onClick={onClose}
            title="Close — your work is already saved"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>
      </header>

      {/* Rail, then canvas. The canvas is keyed by project, so switching
          remounts it with the right scene rather than reconciling into it. */}
      <div className="drawing-body flex-1 min-h-0 flex">
        {!railCollapsed && <DrawingRail />}
        <div className="drawing-canvas relative flex-1 min-w-0">
          {active ? (
            // Keyed by project, so switching project remounts and flushes. The
            // pane is *not* in the key: leaving `both` for `draw` should not
            // reload the canvas that was already on screen.
            pane === "both" ? (
              <Group orientation="horizontal" className="h-full w-full">
                <Panel minSize="25%" defaultSize="58%">
                  <DrawingCanvas key={active.id} projectId={active.id} />
                </Panel>
                <Separator className="drawing-split-handle" />
                <Panel minSize="25%" defaultSize="42%">
                  <DrawingNotes key={active.id} projectId={active.id} />
                </Panel>
              </Group>
            ) : pane === "draw" ? (
              <DrawingCanvas key={active.id} projectId={active.id} />
            ) : (
              <DrawingNotes key={active.id} projectId={active.id} />
            )
          ) : ready ? (
            <DrawingEmpty onCreate={() => void create()} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-ft-text-muted text-xs">
              Opening…
            </div>
          )}
        </div>
      </div>

      {/*
        The status bar.

        There is no Save button and there is not going to be one — this bar is
        the whole of the feedback, which is why the saved time sits at the end
        of it rather than in a toast that has gone by the time you look up.
      */}
      <div className="drawing-statusbar flex items-center gap-2 px-3 shrink-0">
        {saveError ? (
          <span className="drawing-status-error truncate" role="status">
            {saveError}
          </span>
        ) : (
          <>
            {/* The count follows the pane, because "12 items" beside a page of
                prose is a number about something you cannot see. */}
            <span className="truncate">
              {active
                ? pane === "draw"
                  ? `${active.elementCount} item${active.elementCount === 1 ? "" : "s"}`
                  : `${active.noteChars ?? 0} character${
                      (active.noteChars ?? 0) === 1 ? "" : "s"
                    }`
                : "—"}
            </span>
            <span className="drawing-status-dot" aria-hidden />
            <span className="truncate" role="status">
              {savedAtLabel(lastSavedAt)}
            </span>
          </>
        )}

        <div className="flex-1" />

        {/*
          The shared grip, rather than a bare div with a cursor on it — the
          same element the editor and Claude windows put in the same corner.
        */}
        <div
          className="editor-resize-handle"
          onPointerDown={(e) => onResizeStart(e, "se")}
          title="Resize"
          role="separator"
          aria-orientation="horizontal"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="editor-resize-icon">
            <path
              d="M9 1L1 9M9 5L5 9"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );

  if (pipMode) return <OverlayPortal>{modal}</OverlayPortal>;

  return (
    <OverlayPortal>
      <div
        className="fixed inset-0 z-[250] flex items-start justify-center pt-[6vh]"
        style={{ zIndex: frontZ ?? undefined }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        {modal}
      </div>
    </OverlayPortal>
  );
}
