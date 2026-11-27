import { service, type ServiceId } from "../../services/catalog";

/**
 * The windows that have been put away, and brought back from the footer.
 *
 * A minimized window is not a closed one: it stays mounted, so a request in
 * flight, a conversation's pty and an unsaved buffer all carry on exactly as
 * they were. Closing already kept them too — see the `*Mounted` flags in
 * `AppShell` — but closing left nothing on screen to say so, which made "did
 * that keep running?" a question with no answer anywhere in the window. The
 * dock is that answer: what is still alive, in one row along the bottom.
 *
 * Names and marks come from the service catalogue rather than from a list kept
 * here. They used to be kept here, and had drifted: this row called the API
 * client "API" while the palette called it "API Client" and the site called it
 * Figy Man, which is its name.
 */

/**
 * Anything but the base can be put away.
 *
 * It is `ServiceId` rather than a type of its own because the dock no longer
 * has a different idea of what a window is from the rest of the app — the
 * terminal included, which could not be minimized while it was the floor
 * everything else stood on.
 */
export type DockWindow = ServiceId;

interface MinimizedDockProps {
  /** In the order they were put away, so the row does not reshuffle itself. */
  windows: DockWindow[];
  onRestore: (window: DockWindow) => void;
  /** Per window, something small worth saying while it is out of sight. */
  badges?: Partial<Record<DockWindow, number>>;
}

export function MinimizedDock({ windows, onRestore, badges }: MinimizedDockProps) {
  if (windows.length === 0) return null;

  return (
    <>
      <div className="dock flex items-center gap-1" role="group" aria-label="Minimized windows">
        {windows.map((id) => {
          const def = service(id);
          const Icon = def.icon;
          const badge = badges?.[id] ?? 0;

          return (
            <button
              key={id}
              className="dock-item flex items-center gap-1.5"
              onClick={() => onRestore(id)}
              title={`${def.name} — minimized, still running. Click to bring it back.`}
              aria-label={`Restore ${def.name}`}
            >
              {/*
                Claude Code carries its own mark because it is somebody else's
                program and the window says so; ours take the icon the rest of
                the app already gives them.
              */}
              <span className="dock-mark">
                {def.image ? (
                  <img src={def.image} alt="" className="dock-mark-image" />
                ) : (
                  <Icon size={12} />
                )}
              </span>
              <span className="dock-name">{def.short}</span>
              {/*
                A count rather than a dot: the thing worth knowing about a
                minimized window is how much of it is waiting, and "3" says
                that where a light only says "something".
              */}
              {badge > 0 && <span className="dock-badge">{badge}</span>}
            </button>
          );
        })}
      </div>

      {/*
        Drawn here rather than by the status bar, because only this component
        knows whether there is anything to separate — the bar is handed an
        element either way, and an empty dock would otherwise leave a rule
        floating next to the monitor button.
      */}
      <div className="dock-divider" />
    </>
  );
}
