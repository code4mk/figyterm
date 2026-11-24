/**
 * The card the run stops on.
 *
 * Four things ask: a file edit, a command, a question of the agent's own, and
 * the end of plan mode. They are drawn by one component because they are one
 * interaction — here is what is about to happen, here are the few ways to
 * answer, here is the keyboard — and the alternative was four cards that
 * drifted apart on padding and numbering within a month.
 *
 * The list is the same one `/model` and `/rewind` use, for the same reason.
 */

import type { Prompt, PromptOption } from "../../services/figycode-blocks";
import { Diff } from "./FigyBlocks";

/* ─── The numbered list ───────────────────────────────────────────────────── */

export function ChoiceList({
  options,
  selected,
  onSelect,
  onChoose,
  /** Numbering starts at 1 in a prompt and is absent in a settings panel. */
  numbered = true,
}: {
  options: PromptOption[];
  selected: number;
  onSelect: (index: number) => void;
  onChoose: (index: number) => void;
  numbered?: boolean;
}) {
  return (
    <ul className="figy-choices" role="listbox" aria-activedescendant={`figy-choice-${selected}`}>
      {options.map((option, i) => (
        <li key={option.label}>
          <button
            type="button"
            id={`figy-choice-${i}`}
            role="option"
            aria-selected={i === selected}
            className={`figy-choice ${i === selected ? "on" : ""}`}
            /* Hover moves the cursor, so the pointer and the arrow keys share
               one notion of "the current row" rather than lighting two. */
            onMouseEnter={() => onSelect(i)}
            onClick={() => onChoose(i)}
          >
            <span className="figy-choice-caret">{i === selected ? "›" : ""}</span>
            {numbered && <span className="figy-choice-no">{i + 1}.</span>}
            <span className="figy-choice-label">{option.label}</span>
            {option.hint && <span className="figy-choice-hint">{option.hint}</span>}
            {option.chord && <span className="figy-choice-chord">{option.chord}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ─── The card ────────────────────────────────────────────────────────────── */

const TITLE_GLYPH: Record<Prompt["variant"], string> = {
  edit: "◆",
  bash: "▲",
  question: "?",
  plan: "?",
};

export function PromptCard({
  prompt,
  selected,
  onSelect,
  onChoose,
}: {
  prompt: Prompt;
  selected: number;
  onSelect: (index: number) => void;
  onChoose: (index: number) => void;
}) {
  const hasProposal = !!(prompt.command || prompt.diff || prompt.facts || prompt.steps?.length);

  return (
    <>
      {hasProposal && (
        <div
          className={`figy-card figy-proposal ${prompt.variant}`}
          role="group"
          aria-label={prompt.title}
        >
          {/*
            Deliberately the transcript's own row, not a dialog heading:
            the same glyph and the same verb-bold-path-not weight the row
            will have when it has run, so what you approved and what
            happened are visibly the same object.
          */}
          <div className="figy-proposal-head">
            <span className={`figy-prompt-glyph ${prompt.variant}`}>
              {TITLE_GLYPH[prompt.variant]}
            </span>
            {prompt.variant === "edit" ? (
              <>
                <span className="figy-prompt-title">{prompt.title.split(" ")[0]}</span>
                <span className="figy-prompt-path">
                  {prompt.title.split(" ").slice(1).join(" ")}
                </span>
              </>
            ) : (
              <span className="figy-prompt-title">{prompt.title}</span>
            )}
            {prompt.subtitle && <span className="figy-prompt-sub">{prompt.subtitle}</span>}
          </div>

          {prompt.command && (
            <div className="figy-prompt-command">
              <span className="figy-dollar">$</span>
              <span>{prompt.command}</span>
            </div>
          )}
          {prompt.facts && <div className="figy-prompt-facts">{prompt.facts}</div>}

          {/*
            The plan, numbered.

            Numbered rather than bulleted because the order is the
            content: a plan is a sequence, and what gets checked before
            approving it is whether step three can happen after step
            two.
          */}
          {prompt.steps && prompt.steps.length > 0 && (
            <ol className="figy-prompt-steps">
              {prompt.steps.map((step, i) => (
                <li className="figy-prompt-step" key={`${i}-${step}`}>
                  <span className="figy-prompt-step-no">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          )}
          {prompt.diff && (
            <div className="figy-proposal-diff">
              <Diff lines={prompt.diff} />
            </div>
          )}
        </div>
      )}

      {/* The decision. Short, and the same shape whatever is above it. */}
      <div className="figy-card figy-ask" role="group" aria-label={prompt.question}>
        <div className="figy-ask-question">{prompt.question}</div>
        <ChoiceList
          options={prompt.options}
          selected={selected}
          onSelect={onSelect}
          onChoose={onChoose}
        />
        <div className="figy-prompt-footer">{prompt.footer}</div>
      </div>
    </>
  );
}
