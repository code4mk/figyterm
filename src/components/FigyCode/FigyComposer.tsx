/**
 * The bottom of the window: what is running, what could be completed, and the
 * box you type in.
 *
 * The box is a card with two rows rather than a line with a glyph in front of
 * it. The second row is why: `@`, `/` and `!` are the three things this window
 * can do that a chat box cannot, and they were discoverable only by being
 * told about them in a hint that disappeared the moment anyone typed. They are
 * buttons now, beside the two settings most likely to be changed mid-task —
 * the permission mode and the model — and the send key, which is a control and
 * not a piece of folklore.
 *
 * None of it holds state. The composer's state *is* the conversation's state,
 * and splitting them produced two versions of "is a run in progress".
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { ArrowUp, AtSign, Slash, Square, Terminal } from "lucide-react";

/* ─── The running line ────────────────────────────────────────────────────── */

export function RunningLine({
  label,
  elapsed,
  tokens,
  background,
  onBackground,
}: {
  label: string;
  elapsed: string;
  tokens: string;
  background: string | null;
  onBackground: () => void;
}) {
  return (
    <div className="figy-running">
      <span className="figy-spinner" aria-hidden />
      <span className="figy-running-label">{label}</span>
      <span className="figy-running-meta">
        {elapsed} · ↓ {tokens} tokens · esc to interrupt
      </span>

      <div className="figy-running-spacer" />

      {background && (
        <button type="button" className="figy-bg-chip" onClick={onBackground}>
          <span className="figy-bg-dot" />1 background task · {background} · ctrl+b
        </button>
      )}
    </div>
  );
}

/* ─── The completion popup ────────────────────────────────────────────────── */

export interface PopupItem {
  /** What goes into the box when this row is taken. */
  value: string;
  label: string;
  meta?: string;
}

export function CompletionPopup({
  items,
  selected,
  hint,
  empty,
  onSelect,
  onChoose,
}: {
  items: PopupItem[];
  selected: number;
  /** The keyboard line, which belongs to the popup and not to the status bar. */
  hint: string;
  /**
   * Shown in place of the rows when there are none, and the reason the popup
   * opens at all with nothing in it: no folder, a folder that would not
   * read, an index still building and a query that matches nothing are four
   * different situations that look identical as an absence.
   */
  empty?: string | null;
  onSelect: (index: number) => void;
  onChoose: (index: number) => void;
}) {
  if (items.length === 0 && !empty) return null;

  if (items.length === 0) {
    return (
      <div className="figy-popup">
        <div className="figy-popup-empty">{empty}</div>
      </div>
    );
  }

  return (
    <div className="figy-popup" role="listbox">
      <div className="figy-popup-list">
        {items.map((item, i) => (
          <button
            key={item.value}
            type="button"
            role="option"
            aria-selected={i === selected}
            className={`figy-popup-row ${i === selected ? "on" : ""}`}
            onMouseEnter={() => onSelect(i)}
            /* Mouse-down rather than click: the box must not lose focus
               between pressing and releasing, or the caret jumps and the
               completion lands somewhere nobody pointed at. */
            onMouseDown={(e) => {
              e.preventDefault();
              onChoose(i);
            }}
          >
            <span className="figy-popup-label">{item.label}</span>
            {item.meta && <span className="figy-popup-meta">{item.meta}</span>}
          </button>
        ))}
      </div>
      <div className="figy-popup-hint">{hint}</div>
    </div>
  );
}

/* ─── The box ─────────────────────────────────────────────────────────────── */

export interface ComposerHandle {
  focus: () => void;
  caret: () => number;
  setCaret: (at: number) => void;
}

interface ComposerProps {
  value: string;
  shell: boolean;
  placeholder: string;
  /** Live, so the Stop button can take the send button's place. */
  running: boolean;
  modeLabel: string;
  modeTone: "ask" | "accept" | "plan";
  /**
   * The model picker, which lives beside the send button rather than in
   * the status bar.
   *
   * Passed in rather than built here: it needs the model list and the
   * command that saves a choice, and threading four more props through
   * the composer to assemble it internally would make this component
   * know about settings. It is a control the composer places, not one
   * it owns.
   */
  modelPicker: ReactNode;
  onChange: (value: string) => void;
  onCaret: () => void;
  onInsert: (token: "@" | "/" | "!") => void;
  onCycleMode: () => void;
  onSend: () => void;
  onStop: () => void;
}

/** Seven lines, then it scrolls. Past that the box is eating the transcript. */
const MAX_HEIGHT = 150;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    value,
    shell,
    placeholder,
    running,
    modeLabel,
    modeTone,
    modelPicker,
    onChange,
    onCaret,
    onInsert,
    onCycleMode,
    onSend,
    onStop,
  },
  ref
) {
  const area = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    caret: () => area.current?.selectionStart ?? 0,
    setCaret: (at: number) => area.current?.setSelectionRange(at, at),
  }));

  /*
    Grow with the text, to a limit.

    `rows` cannot do this — a prompt of two sentences is one line or six
    depending on how wide the window has been dragged, and only the layout
    knows which. Reset to `auto` first or the box can only ever get taller.
  */
  const fit = useCallback(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(fit, [fit, value]);

  /*
    And again when the box changes width, which is the half that was
    missing.

    The same sentence is one line in a wide window and three in a
    narrow one, and the only thing that knows is the layout. Measuring
    on every keystroke and never on a resize meant dragging the window
    in left the text wrapped inside a box still one line tall —
    scrolling under its own placeholder while you typed.

    A `ResizeObserver` rather than a window listener: this window is
    dragged and resized by its own corner, and the viewport never
    changes at all.

    **Width only.** `fit` sets the height of the element being
    observed, so reacting to every change is a loop that feeds itself
    — the browser calls it "ResizeObserver loop completed with
    undelivered notifications" and it runs until the layout happens to
    settle. The width is the only thing that can make the text wrap
    differently, and it is the only thing this reacts to.
  */
  const lastWidth = useRef(0);
  useEffect(() => {
    const el = area.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (Math.abs(width - lastWidth.current) < 1) return;
      lastWidth.current = width;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  const empty = !value.trim();

  return (
    <div className={`figy-composer ${shell ? "shell" : ""}`}>
      <div className="figy-composer-top">
        <span className={`figy-composer-glyph ${shell ? "shell" : ""}`}>{shell ? "!" : "›"}</span>
        <textarea
          ref={area}
          className="figy-composer-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          /* Keys are handled by the window, which the event reaches by
             bubbling — one handler, so Escape cannot mean two things
             depending on where the focus happens to be. */
          onKeyUp={onCaret}
          onClick={onCaret}
          aria-label="Message FigyCode"
        />
      </div>

      <div className="figy-composer-bar">
        <button
          type="button"
          className="figy-tool-btn"
          onClick={() => onInsert("@")}
          title="Mention a file or folder (@)"
          aria-label="Mention a file"
        >
          <AtSign size={12} />
        </button>
        <button
          type="button"
          className="figy-tool-btn"
          onClick={() => onInsert("/")}
          title="Commands (/)"
          aria-label="Commands"
        >
          <Slash size={12} />
        </button>
        <button
          type="button"
          className={`figy-tool-btn ${shell ? "on" : ""}`}
          onClick={() => onInsert("!")}
          title="Run a shell command (!)"
          aria-label="Shell mode"
          aria-pressed={shell}
        >
          <Terminal size={12} />
        </button>

        <div className="figy-composer-spacer" />

        <button
          type="button"
          className={`figy-pill ${modeTone}`}
          onClick={onCycleMode}
          title="Permission mode — shift+tab cycles"
        >
          <span className={`figy-mode-dot ${modeTone}`} />
          {modeLabel}
        </button>
        {modelPicker}

        {running ? (
          <button type="button" className="figy-send stop" onClick={onStop} title="Interrupt (esc)">
            <Square size={10} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="figy-send"
            onClick={onSend}
            disabled={empty}
            title={empty ? "Type something first" : "Send (↵)"}
            aria-label="Send"
          >
            <ArrowUp size={13} />
          </button>
        )}
      </div>
    </div>
  );
});
