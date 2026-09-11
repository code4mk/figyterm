import { useMemo, useState } from "react";
import { CornerDownLeft, ListOrdered } from "lucide-react";

/**
 * Go to line, as the editor's own overlay.
 *
 * CodeMirror's `gotoLine` is a `window.prompt`-shaped dialog wedged into a
 * panel: an unstyled text field, a "go" button, and no indication of what it
 * accepts or how long the file is. Three things are worth having instead, and
 * all three need the input parsed as it is typed rather than on submit:
 *
 * - **Say where it will land.** "Line 412 of 890" under the field is the
 *   difference between typing a number and guessing one.
 * - **Say when it won't.** A line past the end is clamped rather than refused,
 *   and it says so before Enter, not after.
 * - **Preview it.** The editor scrolls to the line as you type, without moving
 *   the caret; cancelling puts the view back where it was.
 *
 * The accepted syntax is CodeMirror's own, kept deliberately: `412`, `412:8`
 * for a column, `+20` / `-20` relative to the cursor, and a `%` suffix for a
 * proportion of the file. It's a superset of what anyone types by reflex.
 */

export interface GoToTarget {
  line: number;
  column: number;
  /** True when the typed line was past the end and got clamped. */
  clamped: boolean;
}

interface GoToLineProps {
  /** Where the cursor is now — the origin for a relative jump. */
  currentLine: number;
  lineCount: number;
  /** Fired as the input changes, for the scroll preview. Null while unparsed. */
  onPreview: (line: number | null) => void;
  onGo: (target: GoToTarget) => void;
  onClose: () => void;
}

const SYNTAX = /^([+-])?(\d+)?(:\d+)?(%)?$/;

/**
 * The typed value as a destination, or null if it isn't one yet.
 *
 * Exported for the tests this repo doesn't have yet, and because the parse is
 * the whole component — everything else is markup around it.
 */
export function parseGoTo(
  value: string,
  currentLine: number,
  lineCount: number
): GoToTarget | null {
  const match = SYNTAX.exec(value.trim());
  if (!match) return null;

  const [, sign, digits, colon, percent] = match;
  if (!digits && !colon) return null;

  const column = colon ? Math.max(1, Number(colon.slice(1))) : 1;
  let line = digits ? Number(digits) : currentLine;

  if (digits && percent) {
    // A proportion of the file: `50%` is halfway, `+10%` ten percent further
    // down from here.
    const fraction = sign
      ? currentLine / lineCount + (line / 100) * (sign === "-" ? -1 : 1)
      : line / 100;
    line = Math.round(fraction * lineCount);
  } else if (digits && sign) {
    line = currentLine + line * (sign === "-" ? -1 : 1);
  }

  const clampedLine = Math.min(Math.max(line, 1), lineCount);
  return { line: clampedLine, column, clamped: clampedLine !== line };
}

export function GoToLine({
  currentLine,
  lineCount,
  onPreview,
  onGo,
  onClose,
}: GoToLineProps) {
  const [value, setValue] = useState("");

  const target = useMemo(
    () => parseGoTo(value, currentLine, lineCount),
    [value, currentLine, lineCount]
  );

  const change = (next: string) => {
    setValue(next);
    const parsed = parseGoTo(next, currentLine, lineCount);
    onPreview(parsed ? parsed.line : null);
  };

  const cancel = () => {
    onPreview(null);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (target) onGo(target);
      else cancel();
    }
  };

  return (
    <div
      className="editor-overlay-backdrop absolute inset-0 z-[260] flex items-start justify-center pt-[8%]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        className="editor-palette w-[380px] max-w-[92%] rounded-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-palette-field flex items-center gap-2 px-3 py-2">
          <ListOrdered size={13} className="editor-palette-icon shrink-0" />
          <input
            autoFocus
            value={value}
            onChange={(e) => change(e.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => e.stopPropagation()}
            onPaste={(e) => e.stopPropagation()}
            placeholder={`Line number (1–${lineCount})`}
            spellCheck={false}
            inputMode="numeric"
            aria-label="Go to line"
            className="editor-palette-input flex-1 min-w-0 bg-transparent outline-none text-[12px] tabular-nums"
          />
          <button
            className="editor-goto-go flex items-center gap-1 px-1.5 py-0.5 rounded shrink-0 text-[10px]"
            onClick={() => (target ? onGo(target) : cancel())}
            disabled={!target}
            title="Go"
          >
            <CornerDownLeft size={11} />
          </button>
        </div>

        <div className="editor-goto-status flex items-center gap-2 px-3 py-1.5 text-[10px]">
          {target ? (
            <>
              <span className="editor-goto-target tabular-nums">
                Line {target.line}
                {target.column > 1 && `, column ${target.column}`}
              </span>
              <span className="editor-goto-of tabular-nums">of {lineCount}</span>
              {target.clamped && (
                <span className="editor-goto-warn">past the end — clamped</span>
              )}
            </>
          ) : (
            <span className="editor-goto-syntax">
              {value.trim()
                ? "Not a line number"
                : `Cursor on line ${currentLine}. Also accepts 412:8, +20, -20, 50%`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
