/**
 * Everything that can appear in the Figy Code transcript, drawn.
 *
 * One component per block kind, all of them stateless except for the tool
 * row — which owns whether its own body is open, because that is a fact about
 * the row and not about the conversation, and lifting it would mean the run
 * loop knew about disclosure triangles.
 *
 * The transcript is monospaced throughout. Not decoration: almost everything
 * in it is a path, a diff, a command or a count, and the one prose line per
 * turn reads perfectly well in the same face. A proportional font here would
 * mean choosing, per span, which of the two this is.
 */

import { useState } from "react";
import type { Block, DiffLine, Notice, ToolRow } from "../../services/figycode-demo";

/* ─── Inline emphasis ─────────────────────────────────────────────────────── */

/**
 * `**bold**`, and nothing else.
 *
 * A real agent streams markdown and will need a parser; a scripted one writes
 * its own lines, and the only thing those lines do is name a symbol. Shipping
 * a markdown dependency for that would be a decision made by the prototype on
 * behalf of the product.
 */
export function Emphasis({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="figy-strong">
            {part}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

/* ─── Diffs ───────────────────────────────────────────────────────────────── */

export function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="figy-diff">
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
 * The distinction is the one a reader actually scans for — "what did it *do*"
 * — so it is carried by the shape rather than by the verb, which is a word
 * among other words.
 */
const GLYPH: Record<ToolRow["kind"], string> = {
  read: "◇",
  search: "◇",
  edit: "◆",
  write: "◆",
  bash: "◆",
};

export function ToolCall({ tool }: { tool: ToolRow }) {
  const [open, setOpen] = useState(!!tool.open);
  const body = tool.diff ?? tool.output;
  const expandable = !!body && body.length > 0;

  return (
    <div className="figy-tool">
      <button
        type="button"
        className={`figy-tool-row ${expandable ? "expandable" : ""}`}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        /* Not a button at all when there is nothing behind it: a row that
           highlights on hover and then does nothing is a worse affordance
           than a row that never offered. */
        tabIndex={expandable ? 0 : -1}
        aria-expanded={expandable ? open : undefined}
      >
        <span className={`figy-tool-glyph ${tool.kind}`}>{GLYPH[tool.kind]}</span>
        <span className="figy-tool-name">{tool.name}</span>
        <span className="figy-tool-target">{tool.target}</span>
        {tool.added !== undefined && <span className="figy-add">+{tool.added}</span>}
        {tool.removed !== undefined && <span className="figy-del">-{tool.removed}</span>}
        {tool.meta && <span className="figy-tool-meta">· {tool.meta}</span>}
        {expandable && <span className="figy-caret">{open ? "▾" : "▸"}</span>}
      </button>

      {expandable && open && (
        <div className="figy-tool-body">
          {tool.diff ? (
            <Diff lines={tool.diff} />
          ) : (
            <pre className="figy-output">{tool.output!.join("\n")}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── A plan ──────────────────────────────────────────────────────────────── */

export function Plan({ steps, note }: { steps: string[]; note: string }) {
  return (
    <div className="figy-card figy-plan">
      <ol className="figy-plan-list">
        {steps.map((step, i) => (
          <li key={i}>
            <span className="figy-plan-no">{i + 1}</span>
            <span>
              <Emphasis text={step} />
            </span>
          </li>
        ))}
      </ol>
      <div className="figy-plan-note">{note}</div>
    </div>
  );
}

/* ─── To-dos ──────────────────────────────────────────────────────────────── */

const TODO_MARK = { done: "▣", doing: "▪", todo: "□" } as const;

export function Todos({
  items,
  hidden,
  onToggle,
}: {
  items: { text: string; state: "done" | "doing" | "todo" }[];
  hidden?: boolean;
  onToggle: () => void;
}) {
  const done = items.filter((i) => i.state === "done").length;

  return (
    <div className="figy-todos">
      <button type="button" className="figy-todos-head" onClick={onToggle}>
        <span className="figy-tool-glyph edit">◆</span>
        <span className="figy-tool-name">To-dos</span>
        <span className="figy-tool-meta">
          {done} of {items.length} · ctrl+t to {hidden ? "show" : "hide"}
        </span>
      </button>
      {!hidden && (
        <ul className="figy-todo-list">
          {items.map((item, i) => (
            <li key={i} className={`figy-todo ${item.state}`}>
              <span className="figy-todo-mark">{TODO_MARK[item.state]}</span>
              <span className="figy-todo-text">{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── A shell command the user ran ────────────────────────────────────────── */

export function ShellBlock({
  command,
  output,
  note,
}: {
  command: string;
  output: string[];
  note: string;
}) {
  return (
    <div className="figy-shell">
      <div className="figy-shell-cmd">
        <span className="figy-bang">!</span>
        <span>{command}</span>
      </div>
      <div className="figy-card figy-shell-out">
        {output.map((line, i) => (
          <div key={i} className="figy-shell-line">
            {/* A leading hash is a commit, and reads as one. */}
            {/^[0-9a-f]{7}\s/.test(line) ? (
              <>
                <span className="figy-sha">{line.slice(0, 7)}</span>
                {line.slice(7)}
              </>
            ) : (
              line
            )}
          </div>
        ))}
      </div>
      <div className="figy-shell-note">{note}</div>
    </div>
  );
}

/* ─── The end of a task ───────────────────────────────────────────────────── */

export function Summary({
  headline,
  stats,
  detail,
  files,
}: {
  headline: string;
  stats: string;
  detail: string;
  files: string[];
}) {
  return (
    <div className="figy-card figy-summary">
      <div className="figy-summary-head">
        <span className="figy-check">✓</span>
        <span className="figy-summary-headline">{headline}</span>
        <span className="figy-add">{stats.split(" ")[0]}</span>
        <span className="figy-del">{stats.split(" ")[1]}</span>
        <span className="figy-tool-meta">{detail}</span>
      </div>
      {files.map((file) => (
        <div key={file} className="figy-summary-file">
          <span className="figy-summary-status">{file.slice(0, 1)}</span>
          {file.slice(2)}
        </div>
      ))}
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

/* ─── What to do next ─────────────────────────────────────────────────────── */

export function Actions({
  chips,
  onAction,
}: {
  chips: { label: string; primary?: boolean }[];
  onAction: (label: string) => void;
}) {
  return (
    <div className="figy-actions">
      {chips.map((chip) => (
        <button
          key={chip.label}
          type="button"
          className={`figy-chip ${chip.primary ? "primary" : ""}`}
          onClick={() => onAction(chip.label)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

/* ─── A question that has already been answered ───────────────────────────── */

/**
 * Collapsed to one line once it is settled.
 *
 * The card is tall — a diff, four options and a keyboard line — and leaving
 * ten of them stacked in the scroll would bury the work between them. What is
 * worth keeping is that it was asked and what was said, which is a line.
 */
export function AnsweredPrompt({ title, answer }: { title: string; answer: string }) {
  return (
    <div className="figy-answered">
      <span className="figy-check">✓</span>
      <span className="figy-answered-title">{title}</span>
      <span className="figy-tool-meta">· {answer}</span>
    </div>
  );
}

/* ─── The two plain ones ──────────────────────────────────────────────────── */

export function UserTurn({ text }: { text: string }) {
  return (
    <div className="figy-user">
      <span className="figy-chevron">›</span>
      <span className="figy-user-text">{text}</span>
    </div>
  );
}

export function AssistantTurn({ text }: { text: string }) {
  return (
    <div className="figy-assistant">
      <span className="figy-f">ƒ</span>
      <span className="figy-assistant-text">
        <Emphasis text={text} />
      </span>
    </div>
  );
}

/** The union, dispatched. Keeps the switch out of the window itself. */
export function BlockView({
  block,
  onAction,
  onToggleTodos,
}: {
  block: Block;
  onAction: (label: string) => void;
  onToggleTodos: () => void;
}) {
  switch (block.kind) {
    case "user":
      return <UserTurn text={block.text} />;
    case "assistant":
      return <AssistantTurn text={block.text} />;
    case "tool":
      return <ToolCall tool={block.tool} />;
    case "plan":
      return <Plan steps={block.steps} note={block.note} />;
    case "todos":
      return <Todos items={block.items} hidden={block.hidden} onToggle={onToggleTodos} />;
    case "shell":
      return <ShellBlock command={block.command} output={block.output} note={block.note} />;
    case "summary":
      return (
        <Summary
          headline={block.headline}
          stats={block.stats}
          detail={block.detail}
          files={block.files}
        />
      );
    case "notice":
      return <NoticeBlock notice={block.notice} onAction={onAction} />;
    case "actions":
      return <Actions chips={block.chips} onAction={onAction} />;
    case "prompt":
      // The live one is drawn by the window, pinned above the composer; this
      // is only ever the settled version.
      return block.answer ? (
        <AnsweredPrompt title={block.prompt.title} answer={block.answer} />
      ) : null;
  }
}
