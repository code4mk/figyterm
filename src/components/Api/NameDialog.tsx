/**
 * A box that asks for a name.
 *
 * Making a workspace and renaming one are the same question — what should this
 * be called — and two dialogs for one question is two places to fix the next
 * thing about how it behaves.
 *
 * Not the editor's `EditorDialog`, which is a message and some buttons with
 * nowhere to type.
 */

import { useEffect, useRef, useState } from "react";

interface NameDialogProps {
  title: string;
  label: string;
  value: string;
  placeholder?: string;
  confirmLabel: string;
  /** A line under the field, where there is something worth knowing. */
  note?: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function NameDialog({
  title,
  label,
  value,
  placeholder,
  confirmLabel,
  note,
  onConfirm,
  onClose,
}: NameDialogProps) {
  const [name, setName] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Selected, not just focused: a rename usually replaces the name rather
    // than appending to it, and the other case is one arrow key away.
    input.select();
  }, []);

  const trimmed = name.trim();
  const confirm = () => {
    if (trimmed === "") return;
    onConfirm(trimmed);
    onClose();
  };

  return (
    <div
      className="api-dialog-scrim"
      onClick={onClose}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="api-dialog"
        style={{ width: 380 }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "Enter") {
            event.preventDefault();
            confirm();
          }
          // Nothing below sees these: ⌘S and the tab shortcuts would
          // otherwise fire while a name is being typed.
          event.stopPropagation();
        }}
      >
        <div className="api-dialog-head">
          <span className="api-dialog-title">{title}</span>
        </div>

        <div className="api-dialog-body">
          <label className="api-dialog-row">
            <span className="api-dialog-label">{label}</span>
            <input
              ref={inputRef}
              className="api-url flex-1 min-w-0"
              value={name}
              spellCheck={false}
              placeholder={placeholder}
              onChange={(event) => setName(event.target.value)}
              aria-label={label}
            />
          </label>
          {note && <p className="api-dialog-note">{note}</p>}
        </div>

        <div className="api-dialog-foot">
          <button className="api-button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="api-button" disabled={trimmed === ""} onClick={confirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
