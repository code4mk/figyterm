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

import type { Prompt, PromptOption } from "../../services/figycode-demo";
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
  return (
    <div className={`figy-card figy-prompt ${prompt.variant}`} role="group" aria-label={prompt.title}>
      <div className="figy-prompt-head">
        <span className={`figy-prompt-glyph ${prompt.variant}`}>{TITLE_GLYPH[prompt.variant]}</span>
        {/* The path is the subject of an edit prompt, so the verb is bold and
            the path is not — the same weight split the transcript's tool rows
            use, so the two read as the same object in two states. */}
        {prompt.variant === "edit" ? (
          <>
            <span className="figy-prompt-title">{prompt.title.split(" ")[0]}</span>
            <span className="figy-prompt-path">{prompt.title.split(" ").slice(1).join(" ")}</span>
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
      {prompt.diff && (
        <div className="figy-prompt-diff">
          <Diff lines={prompt.diff} />
        </div>
      )}

      <ChoiceList
        options={prompt.options}
        selected={selected}
        onSelect={onSelect}
        onChoose={onChoose}
      />

      <div className="figy-prompt-footer">{prompt.footer}</div>
    </div>
  );
}
