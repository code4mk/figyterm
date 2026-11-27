import { createContext, useContext, type ReactNode } from "react";
import { LayoutGrid, PanelTop } from "lucide-react";
import { isMac } from "../../services/platform";
import type { ServiceId } from "../../services/catalog";

/**
 * The two app-level buttons a service's own title bar carries.
 *
 * The window used to put a Figylo header above whatever was primary and a
 * Figylo status bar below it, so a service that drew its own — and most do —
 * showed two of each. The service's bar is the one that stayed: it is the
 * thing being used, and a strip above it was a title bar for a program that
 * was already titled.
 *
 * Almost nothing was lost with the app's bars. The theme switch, settings,
 * updates and the system monitor are all in the native Menu, which is where
 * they belonged. What had nowhere else to go is the pair here, and they are
 * opposites — one per state:
 *
 *   - `MakePrimary`, on a popup: take the whole window.
 *   - `PrimaryHome`, on the primary: back to all services.
 *
 * A context rather than props because these sit several components deep
 * inside windows that have no reason to know the app exists, and threading
 * callbacks through each of them to reach one button in a header would make
 * every service's signature a little bit about the shell around it.
 */

interface PrimaryChromeValue {
  onShowServices: () => void;
  onSetPrimary: (id: ServiceId) => void;
}

const PrimaryChromeContext = createContext<PrimaryChromeValue | null>(null);

export function PrimaryChromeProvider({
  value,
  children,
}: {
  value: PrimaryChromeValue;
  children: ReactNode;
}) {
  return (
    <PrimaryChromeContext.Provider value={value}>{children}</PrimaryChromeContext.Provider>
  );
}

/**
 * Promotes this popup to the primary. Rendered by a floating window only.
 *
 * This is where the decision belongs. Choosing a primary from a grid of seven
 * cards is choosing between names; choosing it from the window you already
 * have open, after using it, is choosing between things you have seen. So the
 * launcher just opens, and the question of what fills the window is asked
 * here, next to the other two things you can do to a window.
 */
export function MakePrimary({ id, className = "" }: { id: ServiceId; className?: string }) {
  const chrome = useContext(PrimaryChromeContext);
  if (!chrome) return null;

  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => chrome.onSetPrimary(id)}
      title="Set as primary — fills the window"
      aria-label="Set as primary"
      className={`no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded text-ft-text-muted transition-colors hover:bg-ft-elevated hover:text-ft-text ${className}`}
    >
      <PanelTop size={13} />
    </button>
  );
}

/**
 * The mark at the left of the primary's bar. Goes back to the services screen.
 *
 * It also carries two things that have nothing to do with it and everything to
 * do with being first in the topmost bar, which is what it is:
 *
 *   - the macOS traffic lights' gutter. The tab strip used to reserve it,
 *     because the tab strip used to be the top bar. Each primary's own bar is
 *     the top bar now, so each needs the gutter, and this is the one element
 *     all seven of them already render.
 *   - somewhere to grab the window. `-webkit-app-region: drag` cannot go on a
 *     header full of buttons without killing every one of them, so it goes on
 *     this spacer, which is nothing but space.
 */
export function PrimaryHome({ className = "" }: { className?: string }) {
  const chrome = useContext(PrimaryChromeContext);
  if (!chrome) return null;

  return (
    <>
      {isMac && <span className="drag-region h-full w-[62px] shrink-0" aria-hidden />}
      <button
        type="button"
        onClick={chrome.onShowServices}
        onPointerDown={(e) => e.stopPropagation()}
        title="All services"
        aria-label="All services"
        className={`no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded text-ft-text-muted transition-colors hover:bg-ft-elevated hover:text-ft-text ${className}`}
      >
        <LayoutGrid size={13} />
      </button>
    </>
  );
}
