/**
 * The open requests, folders, collections and environments, across the top.
 *
 * A dot rather than an asterisk for unsaved changes, and it is only ever a
 * *difference from the collection* — never a warning that something is about to
 * be lost. Drafts are written to the session as they are typed, so closing a
 * tab with a dot on it costs nothing; that is why there is no confirmation
 * here, and why there should not be one.
 *
 * Twenty tabs is an ordinary afternoon, so the strip scrolls: arrows at each
 * end when there is more than fits, a wheel that scrolls sideways without
 * Shift, and the selected tab kept in view when it is chosen from somewhere
 * else — the sidebar, a console line, an example.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FolderClosed,
  Layers,
  Plus,
  RefreshCw,
  Variable,
  X,
} from "lucide-react";
import { isDirty, Tab } from "../../stores/apiStore";

interface RequestTabsProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Closes everything, or everything but one. */
  onCloseMany: (keep?: string) => void;
  onNew: () => void;
  /**
   * The environment picker, drawn at the right-hand end of the strip.
   *
   * Passed in rather than built here: which environment is in use is not a
   * fact about tabs, and this component would otherwise need the store. It
   * belongs on this row because it applies to the tab that is open — up in the
   * title bar it read as a property of the window.
   */
  trailing?: React.ReactNode;
}

/** How far an arrow moves the strip: most of a screen, with a little kept for
 * context so it does not feel like teleporting. */
const STEP = 0.8;

export function RequestTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onCloseMany,
  onNew,
  trailing,
}: RequestTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  /** Where the right-click menu is, and which tab it is about. */
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Same dismissal rules as the sidebar's menu: anywhere else, Escape, or the
  // window losing focus. Captured, because the panes stop their own clicks.
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  const activeRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  /** Which arrows are worth drawing. A pixel of slack: a strip scrolled to the
   * end is rarely at exactly `scrollWidth`. */
  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    setOverflow({
      left: strip.scrollLeft > 1,
      right: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1,
    });
  }, []);

  useLayoutEffect(measure, [measure, tabs.length]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    // Re-measured on a resize of the window *and* of the strip itself, which
    // changes when the sidebar collapses without the window moving at all.
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [measure]);

  /**
   * Keeps the selected tab visible.
   *
   * It is selected from all over the place — the sidebar, an example, a console
   * line, ⌘W closing its neighbour — and a strip that scrolls only when you
   * drag it leaves the tab you just chose off the end of it.
   */
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  const scrollBy = (direction: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollBy({ left: direction * strip.clientWidth * STEP, behavior: "smooth" });
  };

  return (
    <div className="api-tabstrip flex items-center h-7 shrink-0 border-b border-ft-border">
      {overflow.left && (
        <button
          className="api-tabstrip-arrow"
          onClick={() => scrollBy(-1)}
          title="Scroll tabs left"
          aria-label="Scroll tabs left"
        >
          <ChevronLeft size={13} />
        </button>
      )}

      <div
        ref={stripRef}
        className="api-tabstrip-scroller flex items-center gap-0.5 px-1 flex-1 min-w-0"
        onScroll={measure}
        onWheel={(e) => {
          // A trackpad already sends `deltaX`; a wheel mouse only has `deltaY`
          // and would otherwise do nothing at all here.
          if (e.deltaX !== 0 || !stripRef.current) return;
          stripRef.current.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((tab) => {
          const dirty = isDirty(tab);
          const selected = tab.id === activeTabId;

          return (
            <div
              key={tab.id}
              ref={selected ? activeRef : undefined}
              className={`api-request-tab group ${selected ? "selected" : ""}`}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => {
                // Middle-click closes, as in every tab strip.
                if (e.button === 1) onClose(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: tab.id });
              }}
              title={
                tab.kind === "request" ? tab.draft.url || tab.name : `${tab.name} — ${tab.kind}`
              }
            >
              {tab.sendingId && <span className="api-tab-sending" />}
              {/* A folder, collection or environment tab has no method to
                  show, so it carries the same icon the sidebar gives that row.
                  Without one it reads as a request whose method failed. */}
              {tab.kind === "collection" ? (
                <Layers size={11} className="shrink-0 text-ft-text-muted" />
              ) : tab.kind === "folder" ? (
                <FolderClosed size={11} className="shrink-0 text-ft-text-muted" />
              ) : tab.kind === "environment" ? (
                <Variable size={11} className="shrink-0 text-ft-text-muted" />
              ) : tab.kind === "sync" ? (
                <RefreshCw size={11} className="shrink-0 text-ft-text-muted" />
              ) : tab.kind === "example" ? (
                // The word, not an icon, and before the name: an example is
                // not a request with a different method, and "e.g." is what
                // anybody who has kept a response already reads it as.
                <span className="api-eg">e.g.</span>
              ) : null}
              <span className="max-w-[140px] truncate">{tab.name}</span>
              <button
                className="api-request-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                title="Close tab"
                aria-label={`Close ${tab.name}`}
              >
                {/* The dot gives way to the close button on hover, so the row
                    never grows or shifts as the pointer crosses it. */}
                {dirty ? (
                  <>
                    <span className="api-tab-dot group-hover:hidden" />
                    <X size={11} className="hidden group-hover:block" />
                  </>
                ) : (
                  <X size={11} />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {overflow.right && (
        <button
          className="api-tabstrip-arrow"
          onClick={() => scrollBy(1)}
          title="Scroll tabs right"
          aria-label="Scroll tabs right"
        >
          <ChevronRight size={13} />
        </button>
      )}

      {/* Outside the scroller, so it stays reachable however many tabs there
          are — a new-tab button you have to scroll to is one nobody finds. */}
      <button
        className="api-tabstrip-arrow shrink-0"
        onClick={onNew}
        title="New request"
        aria-label="New request"
      >
        <Plus size={13} />
      </button>

      {trailing && (
        <div className="ml-auto flex items-center shrink-0 pl-2 pr-1">{trailing}</div>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="api-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="api-menu-item"
            onClick={() => {
              onClose(menu.id);
              setMenu(null);
            }}
          >
            Close
            <span className="api-menu-key">⌘W</span>
          </button>
          <button
            className="api-menu-item"
            disabled={tabs.length < 2}
            onClick={() => {
              onCloseMany(menu.id);
              setMenu(null);
            }}
          >
            Close others
          </button>
          <div className="api-menu-rule" />
          <button
            className="api-menu-item danger"
            onClick={() => {
              onCloseMany();
              setMenu(null);
            }}
          >
            Close all
          </button>
        </div>
      )}
    </div>
  );
}
