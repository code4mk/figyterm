import { ReactNode, useCallback, useEffect, useRef } from "react";

/**
 * The editor's right-click menus — the file tree's and the text surface's.
 *
 * Dismissal is what makes this worth sharing. A context menu has to close on an
 * outside press, on Escape, and on anything that moves whatever it was opened
 * over: a scroll, a resize, the window losing focus. The press listener runs in
 * the capture phase so nothing downstream can swallow it, which also means the
 * menu's own presses arrive here — hence the `contains` check, without which
 * the menu would close on the mousedown and the click would never reach the
 * item being chosen.
 *
 * Escape is stopped rather than let through. It reaches the window before the
 * modal's own key handler runs, and without stopping it one press both closed
 * the menu and closed the whole editor.
 *
 * Position is clamped after measuring rather than against a guessed size: these
 * menus differ in length, and a fixed guess either clips the long one or floats
 * the short one away from the pointer.
 */

/** Enough for the longest label plus its chord, so the menu doesn't jump. */
const MIN_WIDTH = 210;

/** Kept this far from every window edge. */
const GUTTER = 8;

interface ContextMenuProps {
  x: number;
  y: number;
  onDismiss: () => void;
  children: ReactNode;
}

export function ContextMenu({ x, y, onDismiss, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  /** Kept in a ref so the listeners below are attached exactly once. */
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  const close = useCallback(() => dismiss.current(), []);

  useEffect(() => {
    const onPress = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };

    window.addEventListener("mousedown", onPress, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    // Capture, because the scroller is a descendant and scroll doesn't bubble.
    window.addEventListener("scroll", close, true);

    return () => {
      window.removeEventListener("mousedown", onPress, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [close]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(GUTTER, Math.min(x, window.innerWidth - width - GUTTER))}px`;
    el.style.top = `${Math.max(GUTTER, Math.min(y, window.innerHeight - height - GUTTER))}px`;
  }, [x, y]);

  return (
    <div
      ref={ref}
      role="menu"
      className="editor-context-menu fixed z-[280] py-1 rounded-lg"
      style={{ left: x, top: y, minWidth: MIN_WIDTH }}
      /*
        The press is cancelled outright, not merely kept from bubbling. A
        mousedown inside the menu would otherwise move focus to the button —
        and in the text surface that means blurring the editor, so the command
        about to run would have no selection and nowhere to put the caret.
      */
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}

interface ContextMenuItemProps {
  icon: ReactNode;
  label: string;
  /** The chord that does the same thing, written the platform's way. */
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export function ContextMenuItem({
  icon,
  label,
  hint,
  onClick,
  disabled,
  danger,
}: ContextMenuItemProps) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      className={`editor-context-item flex items-center gap-2 w-full px-2.5 py-1 text-[11px] text-left ${
        danger ? "danger" : ""
      }`}
      onClick={onClick}
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span className="truncate flex-1">{label}</span>
      {hint && <span className="editor-context-hint shrink-0 text-[10px]">{hint}</span>}
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className="editor-context-sep" />;
}
