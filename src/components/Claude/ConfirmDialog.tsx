import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * A question the window asks before doing something it can't undo for you.
 *
 * Its own rather than the editor's `EditorDialog`, which lives inside the
 * lazily-loaded editor bundle — and not the native `confirm()` either, which is
 * right for quitting the app (a decision about the whole process) but heavy for
 * a decision about one project inside one window.
 */

interface ConfirmDialogProps {
  /**
   * The question, in the dialog's own voice.
   *
   * The *title* is always "Claude Code" — the dialog says who is asking, not
   * what it is asking about, the way any application's alert does. Putting the
   * subject up there instead produced headings like "Close fig-alternative?",
   * which reads as though something called fig-alternative is being shut down
   * rather than as a question from this window about a project in it.
   */
  question: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  question,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focused on open so Enter confirms and Escape cancels without a trip to the
  // mouse — and because a dialog that takes no focus leaves the keyboard in the
  // terminal underneath, which is still listening.
  useEffect(() => confirmRef.current?.focus(), []);

  return (
    <div
      className="editor-dialog-backdrop absolute inset-0 z-[25] flex items-start justify-center pt-[14vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div
        className="editor-workspace-modal w-[420px] max-w-[92vw] rounded-xl flex flex-col overflow-hidden"
        role="alertdialog"
        aria-modal="true"
        aria-label={question}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Who is asking, matching the window's own header. */}
        <div className="editor-workspace-header flex items-center gap-2 px-4 py-2.5 shrink-0">
          <img src="/claude-code.png" alt="" className="claude-logo shrink-0" />
          <span className="editor-dialog-title text-[12px] font-semibold">Claude Code</span>
        </div>

        <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
          <AlertTriangle size={15} className="claude-warn shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="text-[12px] font-semibold">{question}</span>
            <span className="text-[11px] claude-muted">{body}</span>
          </div>
        </div>

        <div className="editor-workspace-footer flex items-center gap-2 px-4 py-2.5 shrink-0">
          <div className="flex-1" />
          <button
            className="editor-dialog-btn px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            className="editor-dialog-btn primary px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
