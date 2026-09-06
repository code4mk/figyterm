import { Sparkles, X } from "lucide-react";

interface UpdateToastProps {
  visible: boolean;
  version: string;
  /** Opens the update dialog. Hides the toast without marking it dismissed. */
  onView: () => void;
  /** Explicit dismissal — this version won't prompt again. */
  onDismiss: () => void;
}

/**
 * A passive, corner-anchored nudge. Deliberately not a modal: interrupting a
 * terminal on launch to announce a point release would be worse than useless.
 */
export function UpdateToast({ visible, version, onView, onDismiss }: UpdateToastProps) {
  if (!visible) return null;

  return (
    <div className="fixed bottom-11 right-4 z-40 animate-slide-up">
      <div className="settings-modal flex items-center gap-3 pl-4 pr-2.5 py-2.5 rounded-xl shadow-lg max-w-xs">
        <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-ft-accent/10 shrink-0">
          <Sparkles size={14} className="text-ft-accent" />
        </div>

        <div className="min-w-0">
          <p className="text-[11px] font-medium text-ft-text">
            FigyTerm {version} is available
          </p>
          <button
            onClick={onView}
            className="text-[10px] text-ft-accent hover:underline"
          >
            See what's new
          </button>
        </div>

        <button
          onClick={onDismiss}
          title="Dismiss"
          className="flex items-center justify-center w-6 h-6 shrink-0 rounded-md text-ft-text-muted hover:text-ft-text hover:bg-ft-surface transition-colors"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
