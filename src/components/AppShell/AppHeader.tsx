import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LayoutGrid, Settings as SettingsIcon } from "lucide-react";
import { SERVICES, service, serviceShortcut, type ServiceId } from "../../services/catalog";
import { keys } from "../../services/shortcuts";

/**
 * The app's own bar, above whatever is the base.
 *
 * It exists because the top of this window used to be the terminal's tab
 * strip, which was fine while the terminal was the only thing here and wrong
 * the moment it stopped being. A window whose chrome belongs to one of its
 * seven programs cannot show you the other six, and the six were reachable
 * only by already knowing their chord.
 *
 * So the header belongs to the app and to nothing in it: the mark, and a menu
 * of everything this window can open. Each service draws its own chrome inside
 * its own frame — the terminal's tabs, the editor's tab strip — whether that
 * frame is the base slot or a floating window.
 */

interface AppHeaderProps {
  /** The service filling the slot below, or null before one has been chosen. */
  baseId: ServiceId | null;
  /** Which services currently have a window open. */
  openIds: ReadonlySet<ServiceId>;
  /** Open one as a window, or focus it if it is already up. */
  onOpenService: (id: ServiceId) => void;
  /** Back to the services screen, where the primary is chosen. */
  onShowServices: () => void;
  /** True while that screen is already up. */
  servicesShown: boolean;
  onOpenSettings: () => void;
}

export function AppHeader({
  baseId,
  openIds,
  onOpenService,
  onShowServices,
  servicesShown,
  onOpenSettings,
}: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setMenuOpen(false);
    buttonRef.current?.focus();
  }, []);

  /*
    Dismissed by a click anywhere else, or by Escape.

    `pointerdown` rather than `click`: a menu that closes on click lets the
    click through to whatever was underneath it, so dismissing the menu over
    the terminal also moved the caret. Capturing on the way down closes it
    before the target sees anything.
  */
  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen, close]);

  const choose = useCallback(
    (id: ServiceId) => {
      setMenuOpen(false);
      onOpenService(id);
    },
    [onOpenService]
  );

  const base = baseId ? service(baseId) : null;

  return (
    /*
      `drag-region` so the window moves by its own bar, and `no-drag` on
      everything in it that is a control — the same pairing the tab strip used
      when it was the thing at the top. `pl-[72px]` is that bar's left gutter,
      inherited with the position.
    */
    <header className="drag-region flex h-9 shrink-0 items-center gap-2 border-b border-ft-border-subtle bg-ft-surface pl-[72px] pr-2 select-none">
      <div className="no-drag flex items-center gap-1.5">
        <img src="/logo.png" alt="" className="h-4 w-4 rounded" />
        <span className="text-[11.5px] font-semibold tracking-tight text-ft-text">
          Figylo
        </span>
      </div>

      <div className="relative no-drag">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors ${
            menuOpen
              ? "bg-ft-elevated text-ft-text"
              : "text-ft-text-secondary hover:bg-ft-elevated hover:text-ft-text"
          }`}
        >
          Services
          <ChevronDown size={11} className="opacity-60" />
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            role="menu"
            aria-label="Services"
            className="absolute left-0 top-full z-[300] mt-1 w-[290px] overflow-hidden rounded-lg border border-ft-border bg-ft-surface py-1 shadow-2xl"
          >
            {/*
              The way back to the screen the app opens on, where a service is
              made primary. The rows below open a window over whatever is
              primary, which is the other thing you can do with a service and
              deliberately not the same thing.
            */}
            <button
              type="button"
              role="menuitem"
              disabled={servicesShown}
              onClick={() => {
                setMenuOpen(false);
                onShowServices();
              }}
              className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[11.5px] text-ft-text transition-colors hover:bg-ft-elevated disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-ft-elevated text-ft-text-muted">
                <LayoutGrid size={13} />
              </span>
              All services
            </button>
            <div className="my-1 h-px bg-ft-border-subtle" />

            {SERVICES.map((def) => {
              const isBase = def.id === baseId;
              const shortcut = serviceShortcut(def);
              const Icon = def.icon;

              return (
                <button
                  key={def.id}
                  type="button"
                  role="menuitem"
                  disabled={!def.available}
                  onClick={() => choose(def.id)}
                  title={
                    def.available
                      ? def.tagline
                      : `${def.name} is not available on this platform`
                  }
                  className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-ft-elevated disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
                    style={{ backgroundColor: `${def.accent}1f`, color: def.accent }}
                  >
                    {def.image ? (
                      <img src={def.image} alt="" className="h-3.5 w-3.5" />
                    ) : (
                      <Icon size={13} />
                    )}
                  </span>

                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ft-text">
                    {def.name}
                  </span>

                  {/*
                    Three different things can be true of a row, and only one is
                    worth a word: it is the base, it is open, or neither — in
                    which case the chord that opens it is the useful thing to
                    say, because that is what the menu is teaching.
                  */}
                  {isBase ? (
                    <span className="flex shrink-0 items-center gap-1 text-[9.5px] font-medium uppercase tracking-wide text-ft-text-muted">
                      <Check size={11} style={{ color: def.accent }} />
                      Base
                    </span>
                  ) : openIds.has(def.id) ? (
                    <span className="shrink-0 text-[9.5px] font-medium uppercase tracking-wide text-ft-text-muted">
                      Open
                    </span>
                  ) : shortcut ? (
                    <span className="flex shrink-0 items-center gap-0.5">
                      {keys(shortcut).map((key) => (
                        <kbd
                          key={key}
                          className="rounded border border-ft-border-subtle bg-ft-bg px-1 py-px font-sans text-[9px] text-ft-text-muted"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/*
        The base's name, said once, where the window's title would be.

        Not a control — the base is changed in Settings, and a header that
        could change it with one click is a header that changes it by accident.
        It is here because a window that fills itself with a program should say
        which program, and with the terminal's tab strip no longer at the top
        there was nowhere else that did.
      */}
      <div className="no-drag pointer-events-none flex flex-1 items-center justify-center overflow-hidden">
        {base && (
          <span className="flex items-center gap-1.5 truncate text-[10.5px] text-ft-text-muted">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: base.accent }}
            />
            {base.name}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
        className="no-drag rounded p-1.5 text-ft-text-muted transition-colors hover:bg-ft-elevated hover:text-ft-text"
      >
        <SettingsIcon size={13} />
      </button>
    </header>
  );
}
