import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, releaseFront } from "../../services/overlay-stack";
import { useOverlayRect } from "../../hooks/useOverlayRect";
import { useOverlayZSync } from "../../hooks/useOverlayZSync";
import { fullscreenRect, useDraggableModal } from "../../hooks/useDraggableModal";
import { BASE_SLOT_Z, useBaseSlot } from "../../hooks/useBaseSlot";

/**
 * The frame the terminal lives in — the base slot, or a window above it.
 *
 * The terminal used to be the thing every other window floated over, which is
 * why it had no frame at all: its tab strip was the app's chrome and its panes
 * filled whatever was left. That stopped being true when the base became a
 * choice, and a terminal that could not be a window was the one service you
 * could not get back to once something else held the slot.
 *
 * So it gets what the other six already had. The content is passed in rather
 * than built here because the panes, their sessions and the ⌘-chords that
 * drive them all live in `AppShell` and are wanted whether or not this frame
 * is floating; this is the frame, and only the frame.
 */

const MIN_SIZE = { w: 480, h: 320 };
const MAX_SIZE = { w: 2400, h: 1600 };
const DEFAULT_SIZE = { w: 900, h: 560 };

interface TerminalWindowProps {
  visible: boolean;
  /** Fills the base slot, never moves, and has no window controls. */
  docked?: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  /**
   * The tab strip, which is also this window's title bar.
   *
   * Handed back the two things a frame knows and a tab strip does not: where
   * the controls go, and what dragging the empty stretch should do.
   */
  chrome: (slots: {
    controls: ReactNode;
    onDragHandle?: (e: React.PointerEvent) => void;
  }) => ReactNode;
  /** The panes. */
  children: ReactNode;
}

export function TerminalWindow({
  visible,
  docked = false,
  onClose,
  onMinimize,
  chrome,
  children,
}: TerminalWindowProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const { style, onDragStart, place, reset } = useDraggableModal({
    defaultSize: DEFAULT_SIZE,
    minSize: MIN_SIZE,
    maxSize: MAX_SIZE,
    elementRef: modalRef,
  });

  useBaseSlot(docked, place);

  const [frontZ, setFrontZ] = useState<number | null>(null);
  // The base never joins the stack — there is nothing for it to be raised
  // above, and claiming a rank would put it over every open window.
  const raise = useCallback(() => {
    if (docked) return;
    setFrontZ(claimFront("terminal"));
  }, [docked]);
  useOverlayZSync("terminal", setFrontZ);
  // Registered either way: the browser's native webview has to know this
  // rectangle is here whether it is the base or a window above it.
  useOverlayRect("terminal", modalRef, visible || docked);

  useEffect(() => {
    if (docked) return;
    if (visible) {
      raise();
      return;
    }
    releaseFront("terminal");
    setFrontZ(null);
  }, [docked, visible, raise]);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((prev) => {
      if (prev) reset();
      else {
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

  /*
    No window controls on the base — minimize, maximize and close are all
    answers to "put this away", and the base is what is left when everything is
    put away. Changing it is a settings decision.
  */
  const controls = docked ? null : (
    <>
      {onMinimize && (
        <button
          className="tab-nav-btn flex items-center justify-center w-6 h-6 rounded"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onMinimize}
          title="Minimize — the shells keep running"
          aria-label="Minimize"
        >
          <Minus size={12} />
        </button>
      )}
      <button
        className="tab-nav-btn flex items-center justify-center w-6 h-6 rounded"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggleFullscreen}
        title={fullscreen ? "Restore" : "Maximize"}
        aria-label={fullscreen ? "Restore" : "Maximize"}
        aria-pressed={fullscreen}
      >
        {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      </button>
      <button
        className="tab-nav-btn flex items-center justify-center w-6 h-6 rounded"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
        title="Close — the shells keep running"
        aria-label="Close"
      >
        <X size={13} />
      </button>
    </>
  );

  const frame = (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal={false}
      aria-label="Terminal"
      className={`pointer-events-auto flex flex-col overflow-hidden bg-ft-bg ${
        docked ? "" : "border border-ft-border shadow-2xl"
      } ${fullscreen || docked ? "rounded-none" : "rounded-xl"}`}
      style={style}
      onPointerDownCapture={raise}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {chrome({ controls, onDragHandle: docked ? undefined : onDragStart })}
      <div className="flex-1 relative min-h-0 overflow-hidden">{children}</div>
    </div>
  );

  return (
    <OverlayPortal>
      {/*
        No backdrop, and no dismiss-on-click-outside. A terminal holds running
        processes and a half-typed command; a stray click beside it is not a
        reason to put it away, and this is the one window where that click is
        most likely to be aimed at the thing behind it.
      */}
      {/*
        Hidden with a class rather than unmounted, which matters more here than
        anywhere else: every pane is an xterm bound to a pty, and unmounting
        the tree would tear down the terminals and the shells running in them
        because a window was dismissed. The Claude and editor windows hide
        themselves for the same reason — see the `*Mounted` flags in
        `AppShell`, which is the other half of it.

        The base ignores `visible` entirely; that is what being the base means.
      */}
      <div
        className={`fixed inset-0 pointer-events-none ${
          docked
            ? ""
            : `items-start justify-center pt-[6vh] ${visible ? "flex" : "hidden"}`
        }`}
        style={{ zIndex: docked ? BASE_SLOT_Z : (frontZ ?? undefined) }}
      >
        {frame}
      </div>
    </OverlayPortal>
  );
}
