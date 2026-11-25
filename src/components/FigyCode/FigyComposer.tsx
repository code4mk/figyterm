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
  useState,
  type ReactNode,
} from "react";
import { ArrowUp, AtSign, Slash, Square, Terminal, X } from "lucide-react";
import { formatBytes, type Attachment } from "../../services/figycode-attach";
import { formatDuration } from "../../services/figycode-background";

/* ─── The running line ────────────────────────────────────────────────────── */

export function RunningLine({
  label,
  elapsed,
  tokens,
}: {
  label: string;
  elapsed: string;
  tokens: string;
}) {
  return (
    <div className="figy-running">
      <span className="figy-spinner" aria-hidden />
      <span className="figy-running-label">{label}</span>
      <span className="figy-running-meta">
        {elapsed} · ↓ {tokens} tokens · esc to interrupt
      </span>

      <div className="figy-running-spacer" />
    </div>
  );
}

/**
 * What is running in the background, and what it is doing.
 *
 * Its own row, **outside** the running line, which is where it used to
 * be and was the bug: a background job's whole reason for existing is
 * that it outlives the turn that started it, and a chip inside the
 * turn's own spinner could only be seen while the turn was still
 * going. A five-minute build started by a ten-second turn was
 * invisible for four minutes and fifty seconds.
 *
 * Named by command rather than by id. `bg_1` is the agent's handle for
 * it; `docker build` is what the person started.
 *
 * ## The log
 *
 * Clicking a row opens what it has written, live. That was the gap
 * after the bar existed: it said a build was running and for how long,
 * which answers *whether* and not *what* — and "what" is the whole
 * question somebody has while watching a build they cannot see. The
 * agent could read the output all along; the person could not.
 *
 * The tail rather than the whole thing, because a Docker build writes
 * a few thousand lines and the interesting one is always the last.
 */
export function BackgroundBar({
  jobs,
  open,
  log,
  onOpen,
  onStop,
}: {
  jobs: { id: string; command: string; ms: number; lines: number }[];
  /** Which job's log is showing, if any. One at a time. */
  open: string | null;
  /** The open job's output, newest last. */
  log: string[];
  onOpen: (id: string | null) => void;
  onStop: (id: string) => void;
}) {
  if (jobs.length === 0) return null;

  return (
    <div className="figy-bg-bar">
      {jobs.map((job) => {
        const showing = open === job.id;
        return (
          <div className="figy-bg-job" key={job.id}>
            <div className="figy-bg-row">
              {/*
                The row is the control. A separate disclosure triangle
                beside a command, a clock and a Stop button is a fourth
                thing to aim at in a row 24px tall.
              */}
              <button
                type="button"
                className="figy-bg-open"
                onClick={() => onOpen(showing ? null : job.id)}
                aria-expanded={showing}
                title={showing ? "Hide the output" : "Show what it is doing"}
              >
                <span className="figy-bg-dot" />
                <span className="figy-bg-cmd">{job.command}</span>
              </button>
              <span className="figy-bg-time">{formatDuration(job.ms)}</span>
              <button
                type="button"
                className="figy-bg-stop"
                onClick={() => onStop(job.id)}
                title={`Stop ${job.command}`}
                aria-label={`Stop ${job.command}`}
              >
                Stop
              </button>
            </div>

            {showing && (
              <div className="figy-bg-log">
                {log.length > 0 ? (
                  <JobLog lines={log} />
                ) : (
                  <p className="figy-bg-quiet">
                    {job.lines > 0 ? "Reading the output…" : "Nothing written yet."}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A live log, following its own tail.
 *
 * Without the follow this is the first 180px of a build log — which is
 * `#1 [internal] load build definition` for as long as anybody cares
 * to watch it, while the line that matters scrolls past unseen below.
 *
 * It follows only while the reader is already at the bottom, which is
 * the same rule the transcript uses: scrolling up to read an error and
 * being dragged back down by the next line is the bug every streaming
 * log ships with.
 */
function JobLog({ lines }: { lines: string[] }) {
  const box = useRef<HTMLPreElement>(null);
  const following = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <pre
      ref={box}
      className="figy-output figy-bg-out"
      onScroll={(e) => {
        const el = e.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.join("\n")}
    </pre>
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
  /** Pictures attached to the message being written. */
  attachments: Attachment[];
  /** Files pasted or dropped on the composer. */
  onFiles: (files: File[]) => void;
  onRemoveFile: (id: string) => void;
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
    attachments,
    onFiles,
    onRemoveFile,
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

  const empty = !value.trim() && attachments.length === 0;
  const [over, setOver] = useState(false);

  /** Whatever a drop or a paste is actually carrying. */
  const filesIn = (data: DataTransfer | null): File[] =>
    data ? Array.from(data.files) : [];

  return (
    <div
      className={`figy-composer ${shell ? "shell" : ""} ${over ? "over" : ""}`}
      /*
        A drop anywhere on the box, not only on the text.

        `dragover` has to be prevented for a drop to fire at all,
        which is the web's oldest trap: without it the browser
        navigates to the file and the window is gone.
      */
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        const files = filesIn(e.dataTransfer);
        if (files.length === 0) return;
        e.preventDefault();
        setOver(false);
        onFiles(files);
      }}
    >
      {/*
        What is attached, above the text rather than below it: it was
        attached before the sentence was written, and it is the thing
        the sentence is about.
      */}
      {attachments.length > 0 && (
        <div className="figy-attachments">
          {attachments.map((one) => (
            <div className="figy-attachment" key={one.id}>
              <img className="figy-attachment-thumb" src={one.url} alt="" />
              <span className="figy-attachment-name truncate" title={one.name}>
                {one.name}
              </span>
              <span className="figy-attachment-size">{formatBytes(one.bytes)}</span>
              <button
                type="button"
                className="figy-iconbtn"
                onClick={() => onRemoveFile(one.id)}
                title="Remove"
                aria-label={`Remove ${one.name}`}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
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
          /*
            A pasted screenshot has no text to insert, so the default
            paste does nothing at all and it looks like the window
            ignored you. Text pastes are left alone.
          */
          onPaste={(e) => {
            const files = filesIn(e.clipboardData);
            if (files.length === 0) return;
            e.preventDefault();
            onFiles(files);
          }}
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
