/**
 * A right-click menu, wherever one is wanted.
 *
 * One component rather than one per pane: the rail grew its own, the tab strip
 * grew a second, and a third written for the response would be three places to
 * fix the next thing anybody notices about how menus dismiss.
 *
 * Portalled to the body and positioned from the pointer, then nudged back
 * inside the window — a menu opened near the bottom right would otherwise
 * hang off the edge with its last item unreachable.
 *
 * Dismissal is captured, not bubbled. The panes this opens over stop
 * propagation of their own pointer events, and a bubbling listener never hears
 * them; a menu that survives the click that was meant to dismiss it is the one
 * thing a menu must never do.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  /** A rule between groups. Everything else is ignored on one. */
  separator?: boolean;
  label?: string;
  /** Right-aligned, for a shortcut or a size. */
  detail?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Drawn in the warning colour — deletes and the like. */
  danger?: boolean;
}

interface ContextMenuProps {
  /** Where the pointer was. */
  x: number;
  y: number;
  /** A heading, when it says something the items do not. */
  title?: string;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, title, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y });

  // Nudged inside the window before it is painted, so it never appears off the
  // edge for a frame on its way back in.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setAt({
      left: Math.max(6, Math.min(x, window.innerWidth - box.width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - box.height - 6)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Stopped here, or the window's own Escape would close everything
      // behind the menu that was being dismissed.
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    // A scroll under it, the window losing focus, a resize: all of them mean
    // "I am done with this", and all of them would leave it pointing at
    // something that has moved.
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="api-menu"
      style={{ left: at.left, top: at.top }}
      role="menu"
      aria-label={title}
      onContextMenu={(event) => event.preventDefault()}
    >
      {title && <span className="api-menu-title">{title}</span>}

      {items.map((item, index) =>
        item.separator ? (
          <div key={`rule-${index}`} className="api-menu-rule" />
        ) : (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            className={`api-menu-item ${item.danger ? "danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon}
            <span className="api-menu-label">{item.label}</span>
            {item.detail && <span className="api-menu-detail">{item.detail}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  );
}
