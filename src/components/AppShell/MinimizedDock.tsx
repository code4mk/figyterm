import { Code2, Globe, Send } from "lucide-react";

/**
 * The windows that can be put away, and brought back from the footer.
 *
 * A minimized window is not a closed one: it stays mounted, so a request in
 * flight, a conversation's pty and an unsaved buffer all carry on exactly as
 * they were. Closing already kept them too — see the `*Mounted` flags in
 * `AppShell` — but closing left nothing on screen to say so, which made "did
 * that keep running?" a question with no answer anywhere in the window. The
 * dock is that answer: what is still alive, in one row along the bottom.
 */
export type DockWindow = "browser" | "editor" | "claude" | "api";

/**
 * How each one appears in the dock.
 *
 * Claude Code carries its own mark because it is somebody else's program and
 * the window says so; the other three are ours and take the icon they already
 * have in the command palette, so the dock names them the way the rest of the
 * app does rather than inventing a second vocabulary.
 */
const WINDOWS: Record<DockWindow, { name: string; mark: React.ReactNode }> = {
  browser: { name: "Browser", mark: <Globe size={12} /> },
  editor: { name: "Editor", mark: <Code2 size={12} /> },
  claude: {
    name: "Claude Code",
    mark: <img src="/claude-code.png" alt="" className="dock-mark-image" />,
  },
  api: { name: "API", mark: <Send size={12} /> },
};

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
          const { name, mark } = WINDOWS[id];
          const badge = badges?.[id] ?? 0;

          return (
            <button
              key={id}
              className="dock-item flex items-center gap-1.5"
              onClick={() => onRestore(id)}
              title={`${name} — minimized, still running. Click to bring it back.`}
              aria-label={`Restore ${name}`}
            >
              <span className="dock-mark">{mark}</span>
              <span className="dock-name">{name}</span>
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
