/**
 * `/tools` — what the model is offered, and what that costs to offer.
 *
 * This was a notice: one line saying how many tools there are and a
 * run-together list of their names. The count is the least interesting
 * fact about a tool list, and the names are the second least.
 *
 * ## What the screen is actually for
 *
 * Every tool definition sits in the **cached prefix of every request
 * for the whole session**. Order on the wire is `tools → system →
 * messages`, so the tool list is the *first* thing the provider reads
 * and the first thing a cache lookup matches on. That has two
 * consequences worth a dialog:
 *
 * 1. A tool you never call still costs its definition on every turn.
 *    "Twenty-four tools" is a fact about the window; "1.2k tokens
 *    before you have said anything" is a fact about the bill.
 * 2. Changing the set mid-session invalidates everything after it —
 *    which is why the set is decided once at session start and frozen,
 *    and why the tool picker narrows the list *before* the first
 *    request rather than per turn.
 *
 * So the figures come first and the table is sorted by what each
 * definition weighs, descending. A list sorted alphabetically answers
 * "is `grep` there"; sorted by size it answers "what am I paying for",
 * which is the question somebody opened this to ask.
 */

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import { formatTokens } from "../../services/figycode-blocks";
import type { ContextBreakdown, ToolInfo } from "../../services/figycode-agent";
import { CLASS_NOTE, TOOLS_EMPTY, toolsView } from "../../services/figycode-views";
import { Dialog } from "./FigyDialog";

export function ToolsDialog({
  tools,
  /**
   * The breakdown, for what the tool picker did on the last message.
   *
   * The whole point of the picker is that fewer are offered than
   * exist, and it is the one thing about it that cannot be seen
   * anywhere else: a picker that silently fell back offers everything,
   * which is right during a turn and indistinguishable from being
   * switched off.
   */
  context,
  onClose,
}: {
  tools: ToolInfo[];
  context: ContextBreakdown | null;
  onClose: () => void;
}) {
  /** Which description is open. One at a time: they are paragraphs. */
  const [open, setOpen] = useState<string | null>(null);

  /*
    Every figure, the order and the footnote come from `toolsView`,
    which the editor panel's tools view renders too — so the two cannot
    count the same definitions differently.
  */
  const view = useMemo(() => toolsView(tools, context), [tools, context]);
  const { rows, total, offered } = view;

  if (rows.length === 0) {
    return (
      <Dialog title="Tools" onClose={onClose}>
        <div className="figy-dialog-body">
          <div className="figy-empty">{TOOLS_EMPTY}</div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Tools" onClose={onClose}>
      <div className="figy-dialog-body">
        {/*
          The two numbers somebody opened this for. The count is the
          one people expect; the tokens are the one that matters, and
          putting them side by side is most of what this screen says.
        */}
        <div className="figy-figures">
          <div className="figy-figure">
            <span className="figy-figure-value">{view.count}</span>
            <span className="figy-figure-label">on the table</span>
            {offered && (
              <span className="figy-figure-note">{offered.count} offered last turn</span>
            )}
          </div>
          <div className="figy-figure">
            <span className="figy-figure-value">{formatTokens(total)}</span>
            <span className="figy-figure-label">of definitions</span>
            <span className="figy-figure-note">in every request</span>
          </div>
          <div className="figy-figure">
            <span className="figy-figure-value">{formatTokens(view.average)}</span>
            <span className="figy-figure-label">a tool, on average</span>
            <span className="figy-figure-note">
              {view.classes.map((one) => `${one.n} ${one.cls}`).join(" · ")}
            </span>
          </div>
        </div>

        {/*
          To scale, by class.

          It makes the point the table takes eight rows to make: the
          read tools are most of the list and the ones that ask about
          themselves are a handful.
        */}
        {/*
          The bar takes the *pills'* colours, not the context screen's.

          Borrowing `user` and `assistant` was the first version and it
          was a colour meaning two different things in one window — over
          there they are sections of the request. Here the only thing
          worth encoding is the class, which is exactly what the pill on
          each row already says, so the bar and the rows agree and the
          legend is the table.
        */}
        <div className="figy-context-bar" role="img" aria-label="What the definitions weigh">
          {view.weights.map((one) => (
            <span
              key={one.cls}
              className={`figy-context-slice figy-tooldef-slice ${one.cls}`}
              style={{ flexGrow: one.share }}
              title={`${one.cls} — ${formatTokens(one.tokens)} tokens`}
            />
          ))}
        </div>

        <table className="figy-table figy-table-plain">
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td>
                  {/*
                    The description, behind a disclosure.

                    It is the text the *model* reads to decide whether
                    to reach for the tool, which makes it the most
                    useful thing on the row and far too long to show
                    twenty-four of.
                  */}
                  <button
                    type="button"
                    className={`figy-tooldef ${open === row.name ? "on" : ""}`}
                    onClick={() => setOpen((at) => (at === row.name ? null : row.name))}
                    aria-expanded={open === row.name}
                  >
                    <ChevronRight size={11} className="figy-tooldef-caret shrink-0" />
                    <span className="figy-tooldef-name">{row.name}</span>
                    <span className={`figy-tooldef-class ${row.cls}`}>{row.cls}</span>
                  </button>
                  {open === row.name && (
                    <div className="figy-tooldef-body">
                      <p>{row.description}</p>
                      <p className="figy-tooldef-note">{CLASS_NOTE[row.cls]}</p>
                    </div>
                  )}
                </td>
                <td className="num">{formatTokens(row.tokens)}</td>
                <td className="num figy-table-dim">
                  {row.of > 0 ? `${Math.round(row.of * 100)}%` : "—"}
                </td>
              </tr>
            ))}
            <tr className="figy-table-total">
              <td>Every turn, before anything is said</td>
              <td className="num">{formatTokens(total)}</td>
              <td />
            </tr>
          </tbody>
        </table>

        {/*
          The reason the set is frozen, said where somebody is looking
          at the set.
        */}
        <div className="figy-dialog-note muted">{view.note}</div>

        {offered && (
          <div className="figy-card figy-notice info">
            <div className="figy-notice-main">
              <div className="figy-notice-title">
                <span className="figy-notice-glyph">◔</span>
                {offered.count} of {view.count} offered on the last message
              </div>
              <div className="figy-notice-body">
                Narrowed by {offered.by} before the model was asked, so the definitions it did not
                need were never sent.
              </div>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
