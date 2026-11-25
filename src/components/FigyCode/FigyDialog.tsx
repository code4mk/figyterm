/**
 * The shell every dialog in this window shares.
 *
 * There are three — settings, earlier conversations, tokens and spend —
 * and they were three different things: one dialog and two screens that
 * replaced the transcript. The screens were wrong for the same reason
 * the settings screen was. Looking at what a session has spent is not
 * leaving the conversation, it is looking at something *about* the
 * conversation, and coming back should not be an action.
 *
 * So they are all dialogs, and the frame is written once. A backdrop
 * that dims rather than hides, a card that scrolls inside itself, a
 * header with the one close button, and an optional footer. Three copies
 * of this would have drifted apart on padding within a month — the
 * window has the scars from exactly that, in the four permission cards
 * that became one.
 */

import type { ReactNode } from "react";
import { X } from "lucide-react";

export function Dialog({
  title,
  wide,
  footer,
  onClose,
  children,
}: {
  title: string;
  /** For the one with a tab column beside its content. */
  wide?: boolean;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    /*
      Over the window, not over the app.

      A child of the FigyCode window, so it moves with it, resizes with
      it, and cannot end up covering a terminal somebody is watching.
      `mousedown` on the backdrop closes — on the way down rather than
      the way up, so nothing underneath is half-pressed first.
    */
    <div className="figy-dialog-layer" onMouseDown={onClose}>
      <div
        className={`figy-dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="figy-dialog-head">
          <span className="figy-dialog-title">{title}</span>
          <button
            type="button"
            className="figy-iconbtn"
            onClick={onClose}
            title="Close"
            aria-label={`Close ${title.toLowerCase()}`}
          >
            <X size={12} />
          </button>
        </header>

        {children}

        {footer && <footer className="figy-dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}
