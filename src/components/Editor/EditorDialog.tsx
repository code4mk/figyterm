import { useEffect, useRef, useState } from "react";

/**
 * A small prompt for the questions the editor has to ask before doing something
 * irreversible — deleting a file, discarding an edit, overwriting a file that
 * changed on disk.
 *
 * Not `window.confirm`: that blocks the webview's event loop, can't be styled,
 * and on Linux draws a GTK dialog that looks nothing like the rest of the app.
 * Not Headless UI's `Dialog` either — that makes `#root` inert, which is the
 * problem `OverlayPortal` exists to work around, and the editor is already
 * inside that portal.
 *
 * It renders `fixed` and centred rather than inside its caller, so a prompt
 * raised from the 260px file explorer isn't squeezed into it.
 */

export interface DialogAction {
  label: string;
  onClick: () => void;
  /** The action the Enter key takes and the eye goes to. */
  primary?: boolean;
  /** Destructive actions are coloured as such. */
  danger?: boolean;
}

interface EditorDialogProps {
  title: string;
  message: string;
  /** Extra detail, shown smaller — a path, or what will be lost. */
  detail?: string;
  /**
   * Turns the dialog into a prompt. When set, `actions` may be empty: the
   * dialog supplies its own submit and cancel, and Enter submits the field.
   */
  prompt?: {
    initial: string;
    placeholder?: string;
    submitLabel?: string;
    onSubmit: (value: string) => void;
  };
  actions: DialogAction[];
  onCancel: () => void;
}

export function EditorDialog({
  title,
  message,
  detail,
  prompt,
  actions,
  onCancel,
}: EditorDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(prompt?.initial ?? "");

  useEffect(() => {
    if (prompt) {
      const input = inputRef.current;
      input?.focus();
      // Selects the stem, leaving any extension alone.
      const dot = (prompt.initial ?? "").lastIndexOf(".");
      if (input && dot > 0) input.setSelectionRange(0, dot);
      else input?.select();
      return;
    }
    // Focus moves into the dialog so Enter and Escape work without a click,
    // and so the keystroke doesn't reach the editor behind it.
    const primary = cardRef.current?.querySelector<HTMLButtonElement>("[data-primary]");
    (primary ?? cardRef.current)?.focus();
  }, [prompt]);

  const resolved: DialogAction[] =
    prompt && actions.length === 0
      ? [
          {
            label: prompt.submitLabel ?? "Save",
            primary: true,
            onClick: () => value.trim() && prompt.onSubmit(value),
          },
          { label: "Cancel", onClick: onCancel },
        ]
      : actions;

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const primary = resolved.find((a) => a.primary) ?? resolved[0];
      primary?.onClick();
    }
  };

  return (
    <div
      className="editor-dialog-backdrop fixed inset-0 z-[300] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="editor-dialog w-[380px] max-w-[90vw] rounded-xl p-4 outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-dialog-title text-[13px] font-semibold">{title}</div>
        <div className="editor-dialog-message mt-1.5 text-[12px] leading-relaxed">
          {message}
        </div>
        {detail && (
          <div className="editor-dialog-detail mt-1.5 text-[11px] truncate" title={detail}>
            {detail}
          </div>
        )}
        {prompt && (
          <input
            ref={inputRef}
            value={value}
            placeholder={prompt.placeholder}
            spellCheck={false}
            autoComplete="off"
            className="editor-dialog-input w-full mt-3 px-2 py-1.5 rounded-md text-[12px] outline-none"
            onChange={(e) => setValue(e.target.value)}
            onPaste={(e) => e.stopPropagation()}
          />
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          {resolved.map((action) => (
            <button
              key={action.label}
              data-primary={action.primary ? "" : undefined}
              onClick={action.onClick}
              className={`editor-dialog-btn px-3 py-1.5 rounded-md text-[11px] font-medium ${
                action.danger ? "danger" : action.primary ? "primary" : ""
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
