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
import {
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PictureInPicture2,
  X,
} from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, releaseFront } from "../../services/overlay-stack";
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

  const active = projects.find((p) => p.id === activeId) ?? null;

  const { style, onDragStart, onResizeStart, place, reset } = useDraggableModal({
    defaultSize: DEFAULT_SIZE,
    minSize: MIN_SIZE,
    maxSize: MAX_SIZE,
    elementRef: modalRef,
  });

  // ─── Stacking ────────────────────────────────────────────────────────────

  const [frontZ, setFrontZ] = useState<number | null>(null);
  const raise = useCallback(() => setFrontZ(claimFront("drawing")), []);

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
      className={`drawing-modal flex flex-col overflow-hidden bg-ft-bg border border-ft-border shadow-2xl ${
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
        Title bar — also the drag handle. It borrows the browser window's
        chrome classes rather than rolling its own padding, so the three
        windows line up: open the browser and the drawing side by side and
        their headers are the same height.
      */}
      <div
        className="browser-chrome browser-tabstrip drawing-titlebar flex items-center gap-1 px-2 pt-1.5 pb-0 select-none cursor-grab active:cursor-grabbing"
        onPointerDown={onDragStart}
      >
        <div className="browser-brand flex items-center gap-2 pl-1 pr-2.5 mr-1 pb-1.5 shrink-0">
          <img src="/logo.png" alt="" className="h-3.5 w-auto shrink-0" />
          <img src="/excalidraw.png" alt="" className="drawing-logo shrink-0" />
          <span className="browser-brand-title text-[11px] font-semibold whitespace-nowrap">
            Draw
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-1 min-w-0 pb-1.5">
          <button
            className="shrink-0 rounded p-1 text-ft-text-muted hover:bg-ft-bg-tertiary"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleRail}
            title={railCollapsed ? "Show drawings" : "Hide drawings"}
            aria-label={railCollapsed ? "Show drawings" : "Hide drawings"}
            aria-expanded={!railCollapsed}
          >
            {railCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>

          {active && (
            <PaneTabs
              pane={pane}
              onChange={setPane}
              hasNotes={(active.noteChars ?? 0) > 0}
            />
          )}

          <span className="min-w-0 truncate text-[11px] text-ft-text-muted">
            {active?.name ?? "No drawing"}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0 pb-1.5">
          <button
            className={`p-1.5 rounded hover:bg-ft-bg-tertiary ${pipMode ? "text-ft-accent" : "text-ft-text-muted"}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={togglePip}
            title={pipMode ? "Exit picture-in-picture" : "Picture-in-picture"}
            aria-label={pipMode ? "Exit picture-in-picture" : "Picture-in-picture"}
          >
            <PictureInPicture2 size={14} />
          </button>
          <button
            className={`p-1.5 rounded hover:bg-ft-bg-tertiary ${fullscreen ? "text-ft-accent" : "text-ft-text-muted"}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleFullscreen}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="p-1.5 rounded text-ft-text-muted hover:bg-red-500/20 hover:text-red-400"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
            title="Close drawing"
            aria-label="Close drawing"
          >
            <X size={14} />
          </button>
        </div>
      </div>

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

      {/* Status bar */}
      <div className="drawing-statusbar flex items-center justify-between gap-2 px-3 h-6 bg-ft-bg-secondary border-t border-ft-border text-[10px] text-ft-text-muted">
        <span className="truncate">
          {saveError ? (
            <span className="text-red-400">{saveError}</span>
          ) : (
            <>
              {/* The count follows the pane, because "12 items" beside a page
                  of prose is a number about something you cannot see. */}
              {active
                ? pane === "draw"
                  ? `${active.elementCount} item${active.elementCount === 1 ? "" : "s"}`
                  : `${active.noteChars ?? 0} character${(active.noteChars ?? 0) === 1 ? "" : "s"}`
                : "—"}
              {" · "}
              {savedAtLabel(lastSavedAt)}
            </>
          )}
        </span>
        <div
          className="cursor-se-resize p-1 shrink-0"
          onPointerDown={(e) => onResizeStart(e, "se")}
          title="Resize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-ft-text-muted">
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
