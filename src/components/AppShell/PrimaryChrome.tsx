import { createContext, useContext, type ReactNode } from "react";
import { LayoutGrid } from "lucide-react";

/**
 * The way back to the services screen, lodged in the primary service's own bar.
 *
 * The window used to carry two headers and two footers whenever a service was
 * primary: the app's pair and the service's own. One of each is right, and the
 * service's is the one that stays — it is the thing being used, it knows what
 * its own bar should say, and a Figylo strip above it was a title bar for a
 * program that was already titled.
 *
 * Almost nothing was lost with the app's bars. The theme switch, settings,
 * updates and the system monitor are all in the native Menu, which is where
 * they belonged and where they already were; the status bar was a second place
 * to reach them. What the Menu has no entry for is "show me the other six", so
 * that one button rides in the primary's bar instead, at the left end where a
 * bar's own content is not.
 *
 * A context rather than a prop because it sits six components deep inside
 * windows that have no reason to know the app exists, and threading a callback
 * through each of them to reach one button in a header would make every
 * service's signature a little bit about the shell around it.
 */

const PrimaryChromeContext = createContext<(() => void) | null>(null);

export function PrimaryChromeProvider({
  onShowServices,
  children,
}: {
  onShowServices: () => void;
  children: ReactNode;
}) {
  return (
    <PrimaryChromeContext.Provider value={onShowServices}>
      {children}
    </PrimaryChromeContext.Provider>
  );
}

/**
 * The mark at the left of the primary's bar. Goes back to the services screen.
 *
 * Rendered only by a service that is primary — a floating window has its own
 * close button and the screen behind it to return to, so it needs no way out.
 */
export function PrimaryHome({ className = "" }: { className?: string }) {
  const onShowServices = useContext(PrimaryChromeContext);
  if (!onShowServices) return null;

  return (
    <button
      type="button"
      onClick={onShowServices}
      onPointerDown={(e) => e.stopPropagation()}
      title="All services"
      aria-label="All services"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-ft-text-muted transition-colors hover:bg-ft-elevated hover:text-ft-text ${className}`}
    >
      <LayoutGrid size={13} />
    </button>
  );
}
