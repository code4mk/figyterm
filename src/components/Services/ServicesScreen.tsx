import { useCallback, useEffect, useRef, useState } from "react";
import { Check, PanelTop, SquareArrowOutUpRight } from "lucide-react";
import {
  selectableServices,
  serviceShortcut,
  type ServiceDef,
  type ServiceId,
} from "../../services/catalog";
import { keys } from "../../services/shortcuts";

/**
 * The screen every launch opens on: everything this app can be.
 *
 * Figylo is seven programs sharing a window, and for as long as the terminal
 * was simply the thing that came up, six of them were reachable only by
 * already knowing their chord. This is the answer to that — not an onboarding
 * page shown once and never again, but the home screen. Open the app and the
 * services are what you see.
 *
 * Two things can be done with a service, and they are genuinely different:
 * make it the primary, which fills the window and is what you came here to
 * work in, or open it, which puts it in a popup over whatever is primary. The
 * first is the common one, so it is what a plain click does; both are on the
 * right-click menu, because a one-click action with no second route is a
 * feature people never find.
 *
 * "Open" rather than "open in a window", deliberately. This app has real
 * windows — ⌘N makes one, with its own tabs and its own shells — and a popup
 * inside this one is not that. Borrowing the word would have left the app's
 * one genuinely new-window action indistinguishable from the six that are
 * nothing of the kind.
 */

interface ServicesScreenProps {
  /** The primary from last time, marked on the grid. Null if never set. */
  current: ServiceId | null;
  /** Fill the window with this service, and leave this screen. */
  onSetPrimary: (id: ServiceId) => void;
  /** Open it as a popup over the primary. This screen stays, so several can be. */
  onOpen: (id: ServiceId) => void;
  /** Which services are already open as popups over this screen. */
  openIds: ReadonlySet<ServiceId>;
}

interface MenuState {
  service: ServiceDef;
  x: number;
  y: number;
}

/** Roughly the menu's size, for keeping it inside the window. */
const MENU_W = 210;
const MENU_H = 84;

export function ServicesScreen({
  current,
  onSetPrimary,
  onOpen,
  openIds,
}: ServicesScreenProps) {
  const options = selectableServices();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [focused, setFocused] = useState<ServiceId>(
    current && options.some((o) => o.id === current) ? current : options[0].id
  );
  const gridRef = useRef<HTMLDivElement>(null);

  const openMenu = useCallback((event: React.MouseEvent, def: ServiceDef) => {
    event.preventDefault();
    // Clamped so a right-click near the right or bottom edge does not put the
    // menu where it cannot be read.
    setMenu({
      service: def,
      x: Math.min(event.clientX, window.innerWidth - MENU_W - 8),
      y: Math.min(event.clientY, window.innerHeight - MENU_H - 8),
    });
  }, []);

  /*
    Dismissed by a click anywhere else, or by Escape.

    `pointerdown` on the capture phase rather than `click`: a menu that closes
    on click lets the same click through to the card underneath, which would
    make the primary out of whatever the menu happened to be covering.
  */
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (step === 0) return;
      event.preventDefault();

      const index = options.findIndex((o) => o.id === focused);
      const next = options[(index + step + options.length) % options.length];
      setFocused(next.id);
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-service="${next.id}"]`)
        ?.focus();
    },
    [focused, options]
  );

  return (
    <div className="h-full overflow-y-auto bg-ft-bg" onKeyDown={onKeyDown}>
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 py-10">
        <header className="mb-8 flex flex-col items-center text-center">
          <img src="/logo.png" alt="" className="mb-4 h-12 w-12 rounded-2xl" />
          <h1 className="text-[22px] font-semibold tracking-tight text-ft-text">
            Figylo
          </h1>
          <p className="mt-1.5 text-[12.5px] text-ft-text-secondary">
            Click a service to make it primary. Right-click for more.
          </p>
        </header>

        <div
          ref={gridRef}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {options.map((def) => {
            const isCurrent = def.id === current;
            const shortcut = serviceShortcut(def);
            const Icon = def.icon;

            return (
              <button
                key={def.id}
                type="button"
                data-service={def.id}
                tabIndex={def.id === focused ? 0 : -1}
                onFocus={() => setFocused(def.id)}
                onClick={() => onSetPrimary(def.id)}
                onContextMenu={(event) => openMenu(event, def)}
                title={def.tagline}
                className="group relative flex flex-col rounded-xl border border-ft-border-subtle bg-ft-surface p-4 text-left transition-all duration-150 hover:border-ft-border hover:bg-ft-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-ft-accent"
              >
                <div className="mb-3 flex items-center gap-2.5">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: `${def.accent}1f`, color: def.accent }}
                  >
                    {def.image ? (
                      <img src={def.image} alt="" className="h-[18px] w-[18px]" />
                    ) : (
                      <Icon size={17} />
                    )}
                  </span>

                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-ft-text">
                      {def.name}
                    </span>
                    {def.badge && (
                      <span
                        className="shrink-0 rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                        style={{ backgroundColor: `${def.accent}24`, color: def.accent }}
                      >
                        {def.badge}
                      </span>
                    )}
                  </span>

                  {/*
                    Two different facts, and both are worth one word: this is
                    what filled the window last time, or it is already open as
                    a popup over this screen right now.
                  */}
                  {isCurrent ? (
                    <span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-ft-text-muted">
                      <Check size={11} style={{ color: def.accent }} />
                      Primary
                    </span>
                  ) : openIds.has(def.id) ? (
                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-ft-text-muted">
                      Open
                    </span>
                  ) : null}
                </div>

                <p className="mb-3 line-clamp-3 flex-1 text-[11.5px] leading-relaxed text-ft-text-secondary">
                  {def.tagline}
                </p>

                <div className="flex h-4 items-center gap-1">
                  {shortcut ? (
                    keys(shortcut).map((key) => (
                      <kbd
                        key={key}
                        className="rounded border border-ft-border-subtle bg-ft-bg px-1.5 py-px font-sans text-[9.5px] text-ft-text-muted"
                      >
                        {key}
                      </kbd>
                    ))
                  ) : (
                    <span className="text-[9.5px] text-ft-text-muted">
                      No shortcut
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {menu && (
        <div
          role="menu"
          aria-label={menu.service.name}
          className="fixed z-[320] w-[210px] overflow-hidden rounded-lg border border-ft-border bg-ft-surface py-1 shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          // The dismissing listener is on capture, so the menu's own clicks
          // have to say they are not an outside click.
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onSetPrimary(menu.service.id);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[11.5px] text-ft-text transition-colors hover:bg-ft-elevated"
          >
            <PanelTop size={13} className="shrink-0 text-ft-text-muted" />
            Set as primary
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onOpen(menu.service.id);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[11.5px] text-ft-text transition-colors hover:bg-ft-elevated"
          >
            <SquareArrowOutUpRight size={13} className="shrink-0 text-ft-text-muted" />
            Open
          </button>
        </div>
      )}
    </div>
  );
}
