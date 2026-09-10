import { useCallback, useRef, useState } from "react";

/**
 * Drag and resize behaviour for the app's floating modals.
 *
 * Extracted from `BrowserModal`, which is still the awkward case: the browser
 * puts a *native* webview inside its frame, and repositioning that costs a
 * one-way IPC hop, so the webview visibly trails a modal being dragged. Hence
 * `interacting` — the browser hides the webview for the duration rather than
 * letting it lag. The editor draws its own content and doesn't need that, but
 * it does need every other manner here, and two copies of pointer-capture
 * arithmetic is one too many.
 *
 * Position starts as `null`, meaning "wherever the layout puts it" — that's how
 * a modal can be centred by flexbox until the user first moves it. Anything
 * that needs a concrete rect before then (resizing from a top or left edge)
 * measures the element and adopts it.
 */

export interface ModalPos {
  x: number;
  y: number;
}

export interface ModalSize {
  w: number;
  h: number;
}

/** Which edge or corner a resize is being driven from. */
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface Options {
  defaultSize: ModalSize;
  minSize: ModalSize;
  maxSize: ModalSize;
  /** Measured when a resize needs a concrete position to work from. */
  elementRef: React.RefObject<HTMLElement>;
}

export interface DraggableModal {
  pos: ModalPos | null;
  size: ModalSize;
  /** True while a drag or resize is in progress. */
  interacting: boolean;
  /** Spread onto the modal element. */
  style: React.CSSProperties;
  onDragStart: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent, edge?: ResizeEdge) => void;
  /** Put the modal somewhere specific — maximize, picture-in-picture, restore. */
  place: (pos: ModalPos | null, size: ModalSize) => void;
  /** Back to the layout's own placement at the default size. */
  reset: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Picture-in-picture geometry, shared by the editor and the browser.
 *
 * Proportions rather than fixed pixels: a hard-coded size is wrong on two
 * displays at once — the editor's original 560×420 was cramped on a laptop and
 * a postage stamp on a 5K panel. Clamped at both ends so it stays a usable
 * window without growing into a second full-screen modal.
 *
 * Both modals call this so the two modes match, and can't drift apart the next
 * time one of them is adjusted.
 */
const PIP_RATIO = { w: 0.55, h: 0.85 };
const PIP_MIN = { w: 520, h: 400 };
const PIP_MAX = { w: 900, h: 900 };

/** Measured from the bottom-right corner, clear of the window's own edges. */
const PIP_MARGIN = { right: 24, bottom: 32 };

/**
 * Fullscreen: the whole app window, edge to edge.
 *
 * The editor's old "maximize" inset itself by 16px, which read as neither one
 * thing nor the other — not full, but not obviously deliberate either. Both
 * modals now take the window outright, and square off their corners while they
 * hold it.
 */
export function fullscreenRect(): ModalPos & ModalSize {
  return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
}

export function pictureInPictureRect(): ModalPos & ModalSize {
  const w = Math.round(
    clamp(window.innerWidth * PIP_RATIO.w, PIP_MIN.w, PIP_MAX.w)
  );
  const h = Math.round(
    clamp(window.innerHeight * PIP_RATIO.h, PIP_MIN.h, PIP_MAX.h)
  );
  return {
    w,
    h,
    x: Math.max(0, window.innerWidth - w - PIP_MARGIN.right),
    y: Math.max(0, window.innerHeight - h - PIP_MARGIN.bottom),
  };
}

export function useDraggableModal({
  defaultSize,
  minSize,
  maxSize,
  elementRef,
}: Options): DraggableModal {
  const [pos, setPos] = useState<ModalPos | null>(null);
  const [size, setSize] = useState<ModalSize>(defaultSize);
  const [interacting, setInteracting] = useState(false);

  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null
  );
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    orig: ModalPos & ModalSize;
    edge: ResizeEdge;
  } | null>(null);

  /** The modal's current rect, whether or not it has been moved yet. */
  const measure = useCallback((): (ModalPos & ModalSize) | null => {
    const el = elementRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: pos?.x ?? rect.left,
      y: pos?.y ?? rect.top,
      w: size.w,
      h: size.h,
    };
  }, [elementRef, pos, size]);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();

      const rect = measure();
      if (!rect) return;

      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: rect.x,
        origY: rect.y,
      };
      setInteracting(true);

      const onMove = (ev: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        setPos({
          // Clamped at the top and left only: a modal dragged off the bottom of
          // the screen can be dragged back, but one whose title bar goes above
          // the top edge can't be grabbed again.
          x: Math.max(0, drag.origX + (ev.clientX - drag.startX)),
          y: Math.max(0, drag.origY + (ev.clientY - drag.startY)),
        });
      };
      const onUp = () => {
        dragRef.current = null;
        setInteracting(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [measure]
  );

  const onResizeStart = useCallback(
    (e: React.PointerEvent, edge: ResizeEdge = "se") => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = measure();
      if (!rect) return;

      // Dragging a top or left edge moves the modal as well as resizing it, so
      // from here on it needs a real position rather than the layout's.
      setPos({ x: rect.x, y: rect.y });

      resizeRef.current = { startX: e.clientX, startY: e.clientY, orig: rect, edge };
      setInteracting(true);

      const onMove = (ev: PointerEvent) => {
        const state = resizeRef.current;
        if (!state) return;

        const dx = ev.clientX - state.startX;
        const dy = ev.clientY - state.startY;
        const { orig } = state;
        const west = state.edge.includes("w");
        const north = state.edge.includes("n");
        const horizontal = state.edge.includes("e") || west;
        const vertical = state.edge.includes("s") || north;

        const w = horizontal
          ? clamp(orig.w + (west ? -dx : dx), minSize.w, maxSize.w)
          : orig.w;
        const h = vertical ? clamp(orig.h + (north ? -dy : dy), minSize.h, maxSize.h) : orig.h;

        setSize({ w, h });
        // Derived from the clamped size, not from the pointer: otherwise a
        // modal held at its minimum width keeps sliding sideways while the edge
        // stays put.
        setPos({
          x: west ? orig.x + (orig.w - w) : orig.x,
          y: north ? orig.y + (orig.h - h) : orig.y,
        });
      };
      const onUp = () => {
        resizeRef.current = null;
        setInteracting(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [measure, minSize.h, minSize.w, maxSize.h, maxSize.w]
  );

  const place = useCallback((next: ModalPos | null, nextSize: ModalSize) => {
    setPos(next);
    setSize(nextSize);
  }, []);

  const reset = useCallback(() => {
    setPos(null);
    setSize(defaultSize);
  }, [defaultSize]);

  const style: React.CSSProperties = pos
    ? { position: "fixed", left: pos.x, top: pos.y, width: size.w, height: size.h }
    : { width: size.w, height: size.h };

  return { pos, size, interacting, style, onDragStart, onResizeStart, place, reset };
}
