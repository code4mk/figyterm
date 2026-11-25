/**
 * Everything that can appear in the Figy Code transcript, drawn.
 *
 * Five kinds — a turn from each side, a tool call, a notice, and the plan —
 * down from ten. The rest drew a scripted transcript: command output cards,
 * a task summary, a plan card. They were good and they are in the history;
 * each comes back with the tool that produces it, as the list just did with
 * `todo_write`. A renderer with nothing on the other end of it is a state
 * nobody can reason about and the first thing to rot.
 *
 * The transcript is monospaced throughout. Not decoration: almost
 * everything in it is a path, a diff, a command or a count, and the one
 * prose line per turn reads perfectly well in the same face.
 */

import { memo, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Markdown } from "../Updates/Markdown";
import {
  formatElapsed,
  type Block,
  type DiffLine,
  type Notice,
  type TodoItem,
  type ToolRow,
} from "../../services/figycode-blocks";

/**
 * How much of a result a row shows before it has to be asked twice.
 *
 * Opening a row is a cheap act and it should stay one: a
 * four-hundred-line file between the question above and the answer
 * below is not an expansion, it is losing your place.
 */
const CAPPED_LINES = 18;

/**
 * A clock that only runs while the row does.
 *
 * On the row rather than passed down from the turn, because a turn
 * that has been going two minutes says nothing about whether *this*
 * call is stuck — which is the question somebody has when a row has
 * been spinning and nothing else has happened.
 *
 * A second is the right resolution: this is read, not raced.
 */
function useElapsed(since: number | undefined, running: boolean | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !since) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [running, since]);
  return since && running ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

/** The last `n` lines, which are the ones still moving. */
function tail(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

/* ─── Copying ─────────────────────────────────────────────────────────────── */

/**
 * The button every code block gets in the corner.
 *
 * A transcript is read, and then one piece of it is wanted somewhere else
 * — a command to run by hand, a diff to paste into a message. Selecting
 * monospaced text across a scrolling pane with the mouse is the worst way
 * to do that, and it is the only way without this.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={`figy-copy ${copied ? "done" : ""}`}
      title={copied ? "Copied" : label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          // Long enough to be seen, short enough that the button is ready
          // again before anybody tries twice.
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

/* ─── Diffs ───────────────────────────────────────────────────────────────── */

export function Diff({ lines }: { lines: DiffLine[] }) {
  const added = lines.filter((line) => line.sign === "+").length;
  const removed = lines.filter((line) => line.sign === "-").length;
  const text = lines
    .filter((line) => line.sign !== "…")
    .map((line) => `${line.sign === " " ? " " : line.sign}${line.text}`)
    .join("\n");

  return (
    <div className="figy-diff">
      {/*
        A header, because a diff with no scale on it makes the reader
        count rows to find out whether this was a tweak or a rewrite.
      */}
      <div className="figy-diff-head">
        {added > 0 && <span className="figy-add">+{added}</span>}
        {removed > 0 && <span className="figy-del">-{removed}</span>}
        <span className="figy-diff-head-spacer" />
        <CopyButton text={text} label="Copy this change" />
      </div>
      {lines.map((line, i) =>
        line.sign === "…" ? (
          <div key={i} className="figy-diff-gap">
            …
          </div>
        ) : (
          <div
            key={i}
            className={`figy-diff-line ${
              line.sign === "+" ? "add" : line.sign === "-" ? "del" : ""
            }`}
          >
            <span className="figy-diff-no">{line.no ?? ""}</span>
            <span className="figy-diff-sign">{line.sign === " " ? "" : line.sign}</span>
            <span className="figy-diff-text">{line.text}</span>
          </div>
        )
      )}
    </div>
  );
}

/* ─── A tool call ─────────────────────────────────────────────────────────── */

/**
 * Hollow for the calls that only look, filled for the ones that change
 * something.
 *
 * The distinction is the one a reader actually scans for — "what did it
 * *do*" — so it is carried by the shape rather than by the verb, which is a
 * word among other words.
 */
const GLYPH: Record<ToolRow["kind"], string> = {
  read: "◇",
  search: "◇",
  edit: "◆",
  write: "◆",
  bash: "◆",
};

export function ToolCall({ tool }: { tool: ToolRow }) {
  /*
    `null` until somebody clicks: a diff opens itself and output does not.

    What changed is the answer to the question an edit was asked, so
    hiding it behind a triangle makes the reader click every row. A
    command's four hundred lines of build log is the opposite — it is
    there to be opened when something went wrong.

    It cannot be a plain `useState(!!tool.diff)`, because the row exists
    before its result does: the initial value would be read while the call
    was still running, and the diff would arrive to find the row shut.
  */
  const [toggled, setToggled] = useState<boolean | null>(null);
  /*
    A second limit inside the first.

    Opening a row should not mean a four-hundred-line file between
    the question above it and the answer below. The body is capped
    and scrolls; "show all" takes the lid off for the one row where
    somebody wants the whole thing.
  */
  const [whole, setWhole] = useState(false);
  const seconds = useElapsed(tool.startedAt, tool.running);
  const body = tool.diff ?? tool.output;

  /*
    How far it has got, while it is getting there.

    A spinner says a thing is happening. It does not say whether it
    is happening *to* anything, which is the question after the
    first ten seconds — and with a file being written or a build
    running, the answer is a number that goes up.
  */
  const progress = tool.writing
    ? `${tool.writing.split("\n").length} lines`
    : tool.live
      ? `${tool.live.length} lines`
      : "";
  const expandable = !!body && body.length > 0;
  const open = toggled ?? !!tool.diff;

  /** What opening would show, so the triangle is worth pressing. */
  const size = tool.diff
    ? `${tool.diff.filter((line) => line.sign === "+" || line.sign === "-").length} changed`
    : tool.output
      ? `${tool.output.length} lines`
      : "";

  return (
    <div className="figy-tool">
      <button
        type="button"
        className={`figy-tool-row ${expandable ? "expandable" : ""}`}
        onClick={expandable ? () => setToggled(!open) : undefined}
        tabIndex={expandable ? 0 : -1}
        aria-expanded={expandable ? open : undefined}
      >
        {/* While it runs there is no result to glyph, and a spinner in the
            same place says the row is not finished rather than that it
            found nothing. */}
        {tool.running ? (
          <span className="figy-tool-spinner" aria-hidden />
        ) : (
          <span className={`figy-tool-glyph ${tool.kind}`}>{GLYPH[tool.kind]}</span>
        )}
        <span className="figy-tool-name">{tool.name}</span>
        {/*
          The reason, and the thing it acted on — but only until the
          result can say that itself.

          Every tool's first line of output names its own subject:
          `src/main.rs · 1 line`, `. — 3 folders, 12 files`,
          `exit 0 in 27.0s` over a `$ docker build …` a line below.
          So once that lands, a target on the row is the same string
          a second time, and the row was spending its width on
          something the reader had already read.

          While it runs there is no summary yet, and the target is
          the only thing identifying the row — so it stays until
          there is something better.
        */}
        {tool.target && !tool.meta && (
          <span className="figy-tool-target">{tool.target}</span>
        )}
        {tool.why && <span className="figy-tool-why">{tool.why}</span>}
        {tool.added !== undefined && <span className="figy-add">+{tool.added}</span>}
        {tool.removed !== undefined && <span className="figy-del">-{tool.removed}</span>}
        {tool.meta && (
          <span
            className={`figy-tool-meta ${tool.failed ? "failed" : ""} ${
              tool.refused ? "refused" : ""
            }`}
          >
            {tool.meta}
          </span>
        )}
        {/*
          While it runs, how long and how far — in the place the
          result's summary will take when there is one.
        */}
        {tool.running && (seconds > 0 || progress) && (
          <span className="figy-tool-ticking">
            {progress && <span>{progress}</span>}
            {seconds > 0 && <span className="figy-tool-seconds">{formatElapsed(seconds * 1000)}</span>}
          </span>
        )}

        {expandable && (
          <span className="figy-tool-size">
            {size}
            <span className="figy-caret">{open ? "▾" : "▸"}</span>
          </span>
        )}
      </button>

      {/*
        The file, as it is written.

        `write` is instant and its *content* takes half a minute to
        arrive, so this is the only part of creating a file anybody
        can watch. The tail rather than the head, because the line
        being written is the one that is moving.
      */}
      {tool.running && tool.writing && (
        <pre className="figy-tool-live code">{tail(tool.writing, 12)}</pre>
      )}

      {/*
        What it is saying while it says it.

        The last few lines only: what somebody watching a build wants
        is the line it is on, and the forty before it are scrollback
        they can read in full the second it finishes. Replaced by the
        real output when the tool returns, which is why this is a
        separate field and not an early `output`.
      */}
      {tool.running && tool.live && tool.live.length > 0 && (
        <pre className="figy-tool-live">{tool.live.join("\n")}</pre>
      )}

      {expandable && open && (
        <>
          <div className={`figy-tool-body ${whole ? "whole" : ""}`}>
            {tool.diff ? (
              <Diff lines={tool.diff} />
            ) : (
              <div className="figy-output-wrap">
                <CopyButton text={tool.output!.join("\n")} label="Copy this output" />
                <pre className="figy-output">{tool.output!.join("\n")}</pre>
              </div>
            )}
          </div>
          {/*
            Offered only when there is more than the box is showing.
            A button that says "show all 6 lines" over six lines is
            a button that teaches people to ignore buttons.
          */}
          {(body?.length ?? 0) > CAPPED_LINES && (
            <button type="button" className="figy-tool-more" onClick={() => setWhole(!whole)}>
              {whole ? "Collapse" : `Show all ${body!.length} lines`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* ─── Something went wrong, or nearly did ─────────────────────────────────── */

const NOTICE_GLYPH: Record<Notice["tone"], string> = {
  stop: "⌞",
  warn: "!",
  info: "◔",
  error: "✕",
};

export function NoticeBlock({
  notice,
  onAction,
}: {
  notice: Notice;
  onAction: (label: string) => void;
}) {
  return (
    <div className={`figy-card figy-notice ${notice.tone}`}>
      <div className="figy-notice-main">
        <div className="figy-notice-title">
          <span className="figy-notice-glyph">{NOTICE_GLYPH[notice.tone]}</span>
          {notice.title}
        </div>
        <div className="figy-notice-body">{notice.body}</div>
      </div>
      {notice.actions && (
        <div className="figy-notice-actions">
          {notice.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`figy-chip ${action.primary ? "primary" : ""}`}
              onClick={() => onAction(action.label)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── The plan ────────────────────────────────────────────────────────────── */

/**
 * The to-do list, which is the one block that is a *state* rather than
 * something that happened.
 *
 * So there is only ever one of it, and a new `todo_write` moves it to the
 * end of the transcript instead of adding a second. Ten copies of a list
 * down the scroll would bury the work between them, and the question this
 * answers — *where is it up to* — is only ever about the latest.
 *
 * Memoised for the same reason the assistant turn is: it sits above a
 * streaming answer and has not changed.
 */
export const Todos = memo(function Todos({ items }: { items: TodoItem[] }) {
  const done = items.filter((item) => item.status === "done").length;

  return (
    <div className="figy-todos">
      <div className="figy-todos-head">
        <span className="figy-todos-title">Plan</span>
        <span className="figy-todos-count">
          {done} of {items.length} done
        </span>
      </div>
      {items.map((item, i) => (
        <div className={`figy-todo ${item.status}`} key={`${i}-${item.text}`}>
          {/*
            The glyph carries the state, because that is what gets
            scanned — the colour is a second signal for the one line
            that matters and not the only one, which keeps the list
            readable for anybody who cannot tell the two greens apart.
          */}
          <span className="figy-todo-mark" aria-hidden>
            {item.status === "done" ? "✓" : item.status === "running" ? "▸" : "○"}
          </span>
          <span className="figy-todo-text">{item.text}</span>
        </div>
      ))}
    </div>
  );
});

/* ─── The two plain ones ──────────────────────────────────────────────────── */

/**
 * What the person said, marked the way they said it.
 *
 * It used to be a tinted box with a coloured bar down its left edge,
 * which is `.figy-notice` — the shape this window uses for "the turn
 * failed", "earlier turns summarised", "stopped after 40 steps". So
 * the one thing in the transcript the *person* wrote was drawn as a
 * message from the machine, and `yes` arrived looking like a
 * warning.
 *
 * It wears the composer's own `›` now. That is the glyph in the box
 * they typed it into, so the line reads as the thing they typed
 * rather than as something the window is telling them — and the
 * assistant's turn keeps its dot, so the two sides of the
 * conversation are told apart by their marks rather than by one of
 * them being in a box.
 */
export function UserTurn({
  text,
  images,
}: {
  text: string;
  images?: { url: string; name: string }[];
}) {
  return (
    <div className="figy-user">
      <span className="figy-user-mark" aria-hidden>
        ›
      </span>
      <div className="figy-user-said">
        {text && <div className="figy-user-text">{text}</div>}
        {/*
          What was sent with it, at the size of a thumbnail.

          Shown at all because a transcript that does not include
          the picture is a transcript where half the question is
          missing — scroll back to "why is this misaligned?" and
          there is nothing to see.
        */}
        {images && images.length > 0 && (
          <div className="figy-user-images">
            {images.map((one, i) => (
              <img
                className="figy-user-image"
                key={`${i}-${one.name}`}
                src={one.url}
                alt={one.name}
                title={one.name}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What the model said, as Markdown.
 *
 * Models write Markdown — headings, lists, tables, fenced code — and this
 * window used to render one thing from it, `**bold**`, with everything
 * else arriving as the characters the model typed. A numbered list came
 * out as `1. 2. 3.` run together in one paragraph, and a fenced block was
 * three backticks and its content as prose.
 *
 * The renderer is the repository's own, the one the release notes and the
 * editor's `.md` preview already use. It builds React elements and never
 * touches `dangerouslySetInnerHTML`, which matters more here than
 * anywhere else in the app: this is a language model's output, going
 * straight onto a page, and "we sanitised it correctly" is a weaker claim
 * than "there is no HTML path at all".
 *
 * `compact` rather than `document`: these are a few sentences between
 * tool calls, not a file being read. It is also the variant without
 * Mermaid, which is right — a diagram in a one-line answer is not a thing
 * to render, and the component behind it is a megabyte.
 *
 * **Memoised**, because the last block of a streaming turn re-renders on
 * every token and the ones above it have not changed. Without this, a
 * long answer re-parses the whole transcript per token.
 */
export const AssistantTurn = memo(function AssistantTurn({ text }: { text: string }) {
  return (
    /*
      No mark at all.

      It had a dot, in the same gutter as the user's `›` and a tool
      row's glyph — four different symbols in one narrow column,
      three of them trying to say "a new thing starts here". The
      agent's prose does not need to say it: everything in this
      transcript that is not marked *is* the agent. The gutter is for
      the things that have to be told apart, and the plain text is
      the default voice.

      It keeps the indent, so the column holds whether a line is
      marked or not.
    */
    <div className="figy-assistant">
      <div className="figy-assistant-text">
        <Markdown source={text} variant="compact" />
      </div>
    </div>
  );
});

/** The union, dispatched. Keeps the switch out of the window itself. */
export function BlockView({
  block,
  onAction,
}: {
  block: Block;
  onAction: (label: string) => void;
}) {
  switch (block.kind) {
    case "user":
      return <UserTurn text={block.text} images={block.images} />;
    case "assistant":
      return <AssistantTurn text={block.text} />;
    case "tool":
      return <ToolCall tool={block.tool} />;
    case "notice":
      return <NoticeBlock notice={block.notice} onAction={onAction} />;
    case "todos":
      return <Todos items={block.items} />;
  }
}
