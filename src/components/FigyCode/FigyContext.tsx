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

/** The parts of the window, in the order they go on the wire. */
const PARTS = [
  {
    key: "tools",
    label: "Tool definitions",
    note: "Sent before anything else, on every turn, for the whole session",
  },
  { key: "system", label: "System prompt", note: "Frozen at the start, including FIGY.md" },
  { key: "user", label: "What you asked", note: "Every message you have sent" },
  { key: "assistant", label: "What it said", note: "Answers, and the arguments of its tool calls" },
  {
    key: "toolResults",
    label: "Tool results",
    note: "Each one re-sent on every later turn — usually the largest part",
  },
] as const;

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
          <div className="figy-empty">
            Nothing has been asked in this folder yet. The window fills from the first
            message — and the tool definitions are in it before that.
          </div>
        </div>
      </Dialog>
    );
  }

  const parts = PARTS.map((part) => ({ ...part, tokens: context[part.key] }));
  const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
  const window = context.window ?? 0;
  /* Against the window where there is one, against itself where there
     is not: a bar with no scale is a bar that says nothing. */
  const scale = window > 0 ? window : Math.max(estimated, 1);
  const free = Math.max(0, window - estimated);
  const percent = window > 0 ? Math.min(100, Math.round((estimated / window) * 100)) : null;

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
                style={{ flexGrow: part.tokens / scale }}
                title={`${part.label}: ${formatTokens(part.tokens)} tokens`}
              />
            ))}
          {free > 0 && <span className="figy-context-slice free" style={{ flexGrow: free / scale }} />}
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
            <div className="figy-dialog-note">
              Each of these is re-sent with every later message. A 3k result on turn
              three of a thirty-turn session is about 80k input tokens.
            </div>
            {context.heaviest.map((one, i) => (
              <div className="figy-context-row" key={`${i}-${one.name}`}>
                <span className="figy-context-key toolResults" />
                <span className="figy-context-label">{one.name}</span>
                <span className="figy-context-tokens">{formatTokens(one.tokens)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="figy-context-foot">
          <span>
            {context.messages} message{context.messages === 1 ? "" : "s"} · {context.turns} from
            you · {context.model || "no model"}
          </span>
          {/*
            Said whenever a router has narrowed the set, because a
            session that cannot do something it could do yesterday
            should be able to find out why here.
          */}
          <span>
            {context.toolsOffered} of {context.toolsTotal} tools offered
            {/*
              What the picker did, said here and nowhere else.

              A router that cannot be reached offers everything and
              says nothing during the turn, which is the right
              behaviour and makes "narrowed", "switched off" and "not
              running" identical from the transcript. This line is the
              difference.
            */}
            {context.picker ? ` · picker: ${context.picker}` : " · no tool picker"}
          </span>
          <span>
            {/*
              Said rather than hidden. The parts are an estimate at
              four characters a token; the provider's own count for
              the last request is the real number, and they will not
              agree.
            */}
            {context.measured > 0
              ? `The last request measured ${formatTokens(context.measured)}. The breakdown above is an estimate.`
              : "An estimate at four characters a token, until the first turn is measured."}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
