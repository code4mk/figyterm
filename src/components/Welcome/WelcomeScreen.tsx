import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import {
  selectableServices,
  service,
  serviceShortcut,
  type ServiceId,
} from "../../services/catalog";
import { keys } from "../../services/shortcuts";

/**
 * The first thing a new install shows: what this app is, and which part of it
 * you want in front of you.
 *
 * Figylo had grown into seven programs sharing a window, and said so nowhere.
 * The terminal was the base because it was the first one written, and the other
 * six were discoverable only by already knowing their chord — so an install
 * opened on a shell and looked like a terminal that had taken a long time to
 * build. This is the page that says otherwise, and the choice it asks for is
 * the one that makes the rest of the app visible.
 *
 * Choosing is not a commitment: the base is a setting like any other, every
 * service stays one chord away whichever is chosen, and the footer says so.
 * The point of asking here is that it is the one moment somebody is actually
 * reading the window rather than trying to get work done in it.
 */

interface WelcomeScreenProps {
  /**
   * The current base, when this page is reopened to change it. Null on a first
   * run, which is the case it is really for.
   */
  initial?: ServiceId | null;
  /** Chose one. The caller stores it and stamps `welcomedAt`. */
  onChoose: (id: ServiceId) => void;
}

export function WelcomeScreen({ initial = null, onChoose }: WelcomeScreenProps) {
  const options = selectableServices();
  /*
    Nothing is selected until somebody selects something.

    Preselecting the terminal would have been the friendly-looking default and
    the wrong one: a highlighted card and an enabled button is a page you can
    dismiss without reading, and it would have delivered exactly the install
    this page exists to stop — a terminal, chosen by us, that the other six
    services hide behind.
  */
  const [selected, setSelected] = useState<ServiceId | null>(
    initial && options.some((o) => o.id === initial) ? initial : null
  );
  const gridRef = useRef<HTMLDivElement>(null);

  const confirm = useCallback(() => {
    if (selected) onChoose(selected);
  }, [onChoose, selected]);

  /*
    The grid is a radio group, so the arrow keys move the selection rather than
    the focus — that is what a radio group does, and it is why each card is a
    `radio` rather than a button. Enter confirms from anywhere on the page, so
    the keyboard never has to find the button at the bottom.

    Escape is deliberately not bound. There is nothing behind this page yet, and
    a dismissal that silently picked for you is how an onboarding step becomes a
    thing people complain they never saw.
  */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        confirm();
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
      // From nothing, either arrow direction starts at the near end rather
      // than wrapping off an index of -1.
      const index = selected
        ? options.findIndex((o) => o.id === selected)
        : step > 0
          ? -1
          : 0;
      const next = options[(index + step + options.length) % options.length];
      setSelected(next.id);
      // Follow the selection with the focus, or the screen reader announces a
      // card the keyboard is no longer on.
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-service="${next.id}"]`)
        ?.focus();
    },
    [confirm, options, selected]
  );

  useEffect(() => {
    // The first card, so the keyboard has somewhere to be. It is focused, not
    // selected — arrowing from here still has to land on something before the
    // button turns on.
    const target = selected ?? options[0]?.id;
    gridRef.current?.querySelector<HTMLElement>(`[data-service="${target}"]`)?.focus();
    // Once, on open. Afterwards the arrow handler moves the focus itself, and
    // re-running this would fight a pointer user for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosen = selected ? service(selected) : null;

  return (
    <OverlayPortal>
      {/*
        z-[700] is above APP_DIALOG_Z (600), which is itself above every overlay
        rank. Nothing else should be open on a first run, but "should" is not a
        z-index, and a dialog drawing over the one page that has to be answered
        is not a bug worth leaving to chance.
      */}
      <div
        className="fixed inset-0 z-[700] overflow-y-auto bg-ft-bg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onKeyDown={onKeyDown}
      >
        {/*
          A wash of the selected service's accent behind the header, so the
          page answers the choice rather than only recording it. It is the one
          piece of colour on the page that moves, which is what makes it read
          as feedback instead of decoration.
        */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[320px] transition-opacity duration-500"
          style={{
            background: chosen
              ? `radial-gradient(60% 100% at 50% 0%, ${chosen.accent}22 0%, transparent 70%)`
              : undefined,
          }}
          aria-hidden
        />

        <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 py-12">
          <header className="mb-10 flex flex-col items-center text-center">
            <img src="/logo.png" alt="" className="mb-5 h-14 w-14 rounded-2xl" />
            <h1
              id="welcome-title"
              className="text-[26px] font-semibold tracking-tight text-ft-text"
            >
              Welcome to Figylo
            </h1>
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ft-text-secondary">
              Seven programs in one window — a terminal, two coding agents, an
              editor, a REST client, a drawing board and a browser. Pick the one
              you want in front of you.
            </p>
          </header>

          <div
            ref={gridRef}
            role="radiogroup"
            aria-label="Choose the service that fills the window"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {options.map((def) => {
              const isSelected = def.id === selected;
              const shortcut = serviceShortcut(def);
              const Icon = def.icon;

              return (
                <button
                  key={def.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  data-service={def.id}
                  tabIndex={isSelected || (!selected && def.id === options[0]?.id) ? 0 : -1}
                  onClick={() => setSelected(def.id)}
                  onDoubleClick={confirm}
                  className={`group relative flex flex-col rounded-xl border p-4 text-left transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ft-accent ${
                    isSelected
                      ? "border-transparent bg-ft-elevated shadow-lg"
                      : "border-ft-border-subtle bg-ft-surface hover:border-ft-border hover:bg-ft-elevated"
                  }`}
                  style={
                    isSelected
                      ? { boxShadow: `0 0 0 2px ${def.accent}, 0 8px 24px -12px ${def.accent}99` }
                      : undefined
                  }
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
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
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
                    </span>
                    {/*
                      The tick marks the base, not "installed" — every service is
                      present either way. It sits where a selection control would
                      and is hidden from the reader, which already hears the
                      radio's checked state.
                    */}
                    {isSelected && (
                      <Check size={15} style={{ color: def.accent }} aria-hidden />
                    )}
                  </div>

                  <p className="mb-3 line-clamp-3 flex-1 text-[11.5px] leading-relaxed text-ft-text-secondary">
                    {def.tagline}
                  </p>

                  <div className="flex h-4 items-center gap-1">
                    {shortcut ? (
                      <>
                        {keys(shortcut).map((key) => (
                          <kbd
                            key={key}
                            className="rounded border border-ft-border-subtle bg-ft-bg px-1.5 py-px font-sans text-[9.5px] text-ft-text-muted"
                          >
                            {key}
                          </kbd>
                        ))}
                      </>
                    ) : (
                      <span className="text-[9.5px] text-ft-text-muted">
                        Always a click away
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <footer className="mt-10 flex flex-col items-center gap-4 border-t border-ft-border-subtle pt-7">
            <p className="max-w-lg text-center text-[11.5px] leading-relaxed text-ft-text-muted">
              {chosen ? (
                <>
                  <span className="text-ft-text-secondary">{chosen.name}</span>{" "}
                  will fill the window. Everything else opens over it in its own
                  window, and keeps running when you close it. You can change
                  this whenever you like in Settings.
                </>
              ) : (
                <>
                  Whichever you pick fills the window. The rest stay one chord
                  away, each in its own window, and you can change your mind
                  whenever you like in Settings.
                </>
              )}
            </p>
            <button
              type="button"
              onClick={confirm}
              disabled={!chosen}
              className="rounded-lg px-5 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ft-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ft-bg disabled:cursor-not-allowed disabled:bg-ft-elevated disabled:text-ft-text-muted disabled:hover:opacity-100"
              style={chosen ? { backgroundColor: chosen.accent } : undefined}
            >
              {chosen ? `Start with ${chosen.short}` : "Pick one to continue"}
            </button>
          </footer>
        </div>
      </div>
    </OverlayPortal>
  );
}
