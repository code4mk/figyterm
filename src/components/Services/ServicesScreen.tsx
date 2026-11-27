import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Undo2 } from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { OVERLAY_Z_MAX } from "../../services/overlay-stack";
import {
  selectableServices,
  service,
  serviceShortcut,
  type ServiceId,
} from "../../services/catalog";
import { keys } from "../../services/shortcuts";

/**
 * The screen every launch opens on: everything this app can be.
 *
 * Figylo is seven programs sharing a window, and for as long as the terminal
 * was simply the thing that came up, six of them were reachable only by
 * already knowing their chord. This is the answer to that — not an onboarding
 * page shown once, but the home screen.
 *
 * It does one thing. A click opens a service, and that is the whole of its
 * behaviour: no context menu, no second gesture, no decision to make before
 * anything happens. Choosing which service *fills* the window used to be
 * asked here, which is asking somebody to choose between seven names before
 * they have seen any of them; it is asked in a window's own title bar now,
 * once you have one open and know whether you want to live in it. See
 * `MakePrimary`.
 *
 * It appears two ways, and the difference is only whether there is anything
 * behind it. With nothing primary it is the slot's content, because the window
 * has nothing else to show. With a primary it is a modal over it — asking what
 * else exists is not a reason to put away the thing being used, and the
 * previous arrangement, which swapped the primary out for this list, made it
 * one.
 */

interface ServicesScreenProps {
  /** The primary, marked on the grid. Null before one has been chosen. */
  current: ServiceId | null;
  /** Open it as a popup. This screen stays, so several can be opened in a row. */
  onOpen: (id: ServiceId) => void;
  /** Which services are already open as popups over this screen. */
  openIds: ReadonlySet<ServiceId>;
  /**
   * Back to the primary, without changing anything.
   *
   * Absent on a first run, when there is no primary to go back to and this
   * screen is the only thing the window has to show.
   */
  onDismiss?: () => void;
  /**
   * Gives the window back to this list, with nothing primary.
   *
   * Present only when something is. The primary is a choice, and a choice you
   * cannot take back is a trap — before this the only way out of one was into
   * another.
   */
  onRemovePrimary?: () => void;
  /** Over a primary rather than instead of one. */
  asModal?: boolean;
}

export function ServicesScreen({
  current,
  onOpen,
  openIds,
  onDismiss,
  onRemovePrimary,
  asModal = false,
}: ServicesScreenProps) {
  const options = selectableServices();
  const [focused, setFocused] = useState<ServiceId>(
    current && options.some((o) => o.id === current) ? current : options[0].id
  );
  const gridRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      /*
        Escape goes back to the primary, and only when there is one. On a
        first run there is nothing behind this screen, so a dismissal would
        empty the window.
      */
      if (event.key === "Escape" && onDismiss) {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      }

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
      gridRef.current?.querySelector<HTMLElement>(`[data-service="${next.id}"]`)?.focus();
    },
    [focused, options, onDismiss]
  );

  /*
    The keyboard starts on a card.

    `onKeyDown` is a React handler on the container, so it only sees keys from
    something inside it — with nothing focused, Escape and the arrows went to
    the document and this list answered neither. It matters most as a modal,
    where Escape is how anybody expects to leave.
  */
  useEffect(() => {
    const target = gridRef.current?.querySelector<HTMLElement>(
      `[data-service="${focused}"]`
    );
    target?.focus({ preventScroll: true });
    // Once, on open. The arrow handler moves focus itself afterwards, and
    // re-running this would take it back off whatever a pointer had reached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const body = (
    <div
      className={
        asModal
          ? "w-full max-w-[940px] overflow-y-auto rounded-2xl border border-ft-border bg-ft-bg shadow-2xl"
          : "h-full overflow-y-auto bg-ft-bg"
      }
      style={asModal ? { maxHeight: "min(78vh, 760px)" } : undefined}
      role={asModal ? "dialog" : undefined}
      aria-modal={asModal || undefined}
      aria-label={asModal ? "Services" : undefined}
      onKeyDown={onKeyDown}
    >
      <div
        className={
          asModal
            ? "w-full px-8 py-8"
            : "mx-auto w-full max-w-[940px] px-10 py-14"
        }
      >
        <header className="mb-10 flex items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="mb-4 flex items-center gap-2">
              <img src="/logo.png" alt="" className="h-5 w-5 rounded-[5px]" />
              <span className="text-[12px] font-semibold tracking-tight text-ft-text-secondary">
                Figylo
              </span>
            </div>
            {/*
              A heading, not a greeting. The screen's job is to make seven
              programs visible, so it names what is being chosen rather than
              saying hello — which also keeps it from reading like an
              onboarding step on the four-hundredth launch.
            */}
            <h1 className="text-[27px] font-semibold leading-tight tracking-[-0.02em] text-ft-text">
              Services
            </h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ft-text-muted">
              {current
                ? "Open one in a window. Set a primary from its title bar to have it fill this one."
                : "Open one in a window. Set a primary from its title bar to have it fill this one — until then, this is what the window shows."}
            </p>
          </div>

          {current && (
            <div className="flex shrink-0 items-center gap-2">
              {/*
                Undo the primary. It is a choice, and a choice with no way back
                is a trap — before this the only way out of one was into
                another.
              */}
              {onRemovePrimary && (
                <button
                  type="button"
                  onClick={onRemovePrimary}
                  title={`${service(current).name} stops filling the window`}
                  className="flex items-center gap-2 rounded-lg border border-ft-border-subtle px-3 py-2 text-[12px] text-ft-text-secondary transition-colors hover:border-ft-border hover:bg-ft-surface hover:text-ft-text"
                >
                  <Undo2 size={13} className="opacity-60" />
                  Remove primary
                </button>
              )}

              {onDismiss && (
                <button
                  type="button"
                  onClick={onDismiss}
                  className="flex items-center gap-2 rounded-lg border border-ft-border-subtle px-3 py-2 text-[12px] text-ft-text-secondary transition-colors hover:border-ft-border hover:bg-ft-surface hover:text-ft-text"
                >
                  <ArrowLeft size={13} className="opacity-60" />
                  <span className="max-w-[160px] truncate">{service(current).name}</span>
                  <kbd className="rounded border border-ft-border-subtle px-1.5 py-px font-sans text-[9.5px] text-ft-text-muted">
                    Esc
                  </kbd>
                </button>
              )}
            </div>
          )}
        </header>

        {/*
          One hairline between cards rather than a border around each. Seven
          separately outlined boxes read as seven unrelated things, and these
          are seven parts of one app; `gap-px` over the grid's own background
          is what draws the rule between them.
        */}
        <div
          ref={gridRef}
          className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-ft-border-subtle bg-ft-border-subtle sm:grid-cols-2 lg:grid-cols-3"
        >
          {options.map((def) => {
            const isCurrent = def.id === current;
            const isOpen = openIds.has(def.id);
            const shortcut = serviceShortcut(def);
            const Icon = def.icon;

            return (
              <button
                key={def.id}
                type="button"
                data-service={def.id}
                tabIndex={def.id === focused ? 0 : -1}
                onFocus={() => setFocused(def.id)}
                onClick={() => onOpen(def.id)}
                title={def.tagline}
                style={{ "--svc": def.accent } as CSSProperties}
                className="group relative flex min-h-[172px] flex-col items-start bg-ft-bg p-5 text-left transition-colors duration-150 hover:bg-ft-surface focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ft-accent"
              >
                {/*
                  The accent arrives on hover and nowhere else. Seven cards
                  each holding a saturated tile is a colour chart; one at a
                  time is a pointer.
                */}
                <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-[10px] border border-ft-border-subtle text-ft-text-secondary transition-colors duration-150 group-hover:border-[var(--svc)] group-hover:text-[var(--svc)] group-focus-visible:border-[var(--svc)] group-focus-visible:text-[var(--svc)]">
                  {def.image ? (
                    <img src={def.image} alt="" className="h-[19px] w-[19px]" />
                  ) : (
                    <Icon size={18} />
                  )}
                </span>

                <span className="mb-1.5 flex w-full items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium text-ft-text">
                    {def.name}
                  </span>
                  {def.badge && (
                    <span className="shrink-0 rounded-full border border-ft-border-subtle px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-ft-text-muted">
                      {def.badge}
                    </span>
                  )}
                </span>

                <p className="line-clamp-2 text-[12px] leading-[1.5] text-ft-text-muted">
                  {def.tagline}
                </p>

                {/*
                  The footer holds whichever single fact is worth saying, and
                  the chord otherwise — which is what this screen is quietly
                  teaching, so it is what shows when there is no news. It
                  fades in on hover, so seven rows of key caps are not the
                  first thing the page says.
                */}
                <span className="mt-auto flex h-[18px] w-full items-center gap-1.5 pt-4">
                  {isCurrent ? (
                    <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-ft-text-secondary">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: def.accent }}
                      />
                      Primary
                    </span>
                  ) : isOpen ? (
                    <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-ft-text-muted">
                      <span className="h-1.5 w-1.5 rounded-full bg-ft-text-muted" />
                      Open
                    </span>
                  ) : shortcut ? (
                    <span className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                      {keys(shortcut).map((key) => (
                        <kbd
                          key={key}
                          className="rounded border border-ft-border-subtle px-1.5 py-px font-sans text-[9.5px] text-ft-text-muted"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  if (!asModal) return body;

  return (
    <OverlayPortal>
      {/*
        Above every service window, so the list is never behind one of the
        things it lists. Below `APP_DIALOG_Z`, which Settings uses — that is a
        dialog raised *from* here and has to cover it.

        The backdrop dismisses, unlike a service window's. This holds nothing:
        it is a list, and clicking away from a list is how anybody closes one.
      */}
      <div
        className="fixed inset-0 flex items-start justify-center overflow-y-auto bg-black/50 px-6 py-[7vh] backdrop-blur-[2px]"
        style={{ zIndex: OVERLAY_Z_MAX + 1 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onDismiss?.();
        }}
      >
        {body}
      </div>
    </OverlayPortal>
  );
}
