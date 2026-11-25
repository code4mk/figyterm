/**
 * `/context` — where the window is going.
 *
 * The status bar has said `ctx 34%` for a while, which answers how full
 * and not *what with*, and those have completely different consequences.
 * A session at 34% because the tool definitions are large is a session
 * that will be at 34% for ever. One at 34% because a single `read`
 * returned eight thousand tokens is one where deleting that habit buys
 * the whole window back — and `TOOLS.md`'s rule says why: a tool result
 * is a permanent subscription, re-sent on every later turn until the
 * session ends.
 *
 * So the dialog is built around the thing you can act on. A bar for the
 * shape of it, a row per part, and then the five heaviest tool results
 * by name, which is the list that actually changes what somebody does
 * next.
 *
 * ## Two kinds of number, said plainly
 *
 * `measured` is the provider's own count for the last turn and is
 * exact. Every other figure is characters over four. They will not add
 * up. Scaling the parts until they did would make the sum honest and
 * every part a lie, so the dialog shows both and says which is which.
 */

import { formatTokens } from "../../services/figycode-blocks";
import type { ContextBreakdown } from "../../services/figycode-agent";
import { Dialog } from "./FigyDialog";
import { CONTEXT_EMPTY, contextView } from "../../services/figycode-views";

export function ContextDialog({
  context,
  onClose,
}: {
  context: ContextBreakdown | null;
  onClose: () => void;
}) {
  if (!context) {
    return (
      <Dialog title="Context" onClose={onClose}>
        <div className="figy-dialog-body">
          <div className="figy-empty">{CONTEXT_EMPTY}</div>
        </div>
      </Dialog>
    );
  }

  /*
    Every label, order, number and footnote on this screen comes out of
    `contextView`, which the editor panel's version renders too. They
    used to compute their own and disagree — this one led with the
    estimate and that one with the provider's measured count, about the
    same conversation.
  */
  const view = contextView(context);
  const { estimated, free, percent, parts } = view;
  const window = view.window;

  return (
    <Dialog title="Context" onClose={onClose}>
      <div className="figy-dialog-body">
        <div className="figy-context-head">
          <span className="figy-context-total">
            {formatTokens(estimated)}
            {window > 0 && <span className="figy-context-of"> of {formatTokens(window)}</span>}
          </span>
          {percent != null && <span className="figy-context-percent">{percent}% full</span>}
        </div>

        {/*
          One bar, in wire order. Not a pie: these are parts of a
          sequence — tools, then the prompt, then the conversation —
          and the order is the thing that decides what a cache keeps.
        */}
        <div className="figy-context-bar" role="img" aria-label={`${percent ?? 0}% of the window`}>
          {parts
            .filter((part) => part.tokens > 0)
            .map((part) => (
              <span
                key={part.key}
                className={`figy-context-slice ${part.key}`}
                style={{ flexGrow: part.share }}
                title={`${part.label}: ${formatTokens(part.tokens)} tokens`}
              />
            ))}
          {free > 0 && (
            <span
              className="figy-context-slice free"
              style={{ flexGrow: view.freeShare }}
            />
          )}
        </div>

        <div className="figy-context-parts">
          {parts.map((part) => (
            <div className="figy-context-row" key={part.key}>
              <span className={`figy-context-key ${part.key}`} />
              <span className="figy-context-label">
                {part.label}
                <span className="figy-context-note">{part.note}</span>
              </span>
              <span className="figy-context-tokens">{formatTokens(part.tokens)}</span>
            </div>
          ))}
          {window > 0 && (
            <div className="figy-context-row">
              <span className="figy-context-key free" />
              <span className="figy-context-label">Free</span>
              <span className="figy-context-tokens">{formatTokens(free)}</span>
            </div>
          )}
        </div>

        {/*
          The actionable half. A result that was expensive once is
          expensive on every turn after it, so the name beside the
          number is what changes what somebody does next.
        */}
        {context.heaviest.length > 0 && (
          <div className="figy-dialog-section">
            <div className="figy-dialog-section-head">Heaviest results</div>
            <div className="figy-dialog-note">{view.heaviestNote}</div>
            {view.heaviest.map((one, i) => (
              <div className="figy-context-row" key={`${i}-${one.name}`}>
                <span className="figy-context-key toolResults" />
                <span className="figy-context-label">{one.name}</span>
                <span className="figy-context-tokens">{formatTokens(one.tokens)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="figy-context-foot">
          {view.facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
