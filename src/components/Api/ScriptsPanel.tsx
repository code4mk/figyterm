/**
 * The scripts on this request, and the ones it inherits.
 *
 * Two of them, so two sub-tabs rather than two editors stacked in one pane.
 * Split, each got a third of the height and the one being written in was
 * always the smaller half; a script is code, and code wants the room.
 *
 * The inherited list is the part that is easy to leave out and shouldn't be:
 * when a request fails an assertion nobody wrote, the answer is that its
 * collection has a test script, and a panel showing only the request's own
 * would leave that unanswerable.
 *
 * A real editor, not a textarea. Scripts are JavaScript, and a textarea gives
 * no highlighting, no bracket matching, no indentation and no idea what `pm`
 * is. The completion list is written against `pm.ts` and tested against it, so
 * an API you are meeting for the first time is discoverable by typing `pm.`.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import {
  autocompletion,
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { CollectedScript } from "../../services/api/scripts/events";
import {
  PM_COMPLETIONS,
  SCRIPT_SNIPPETS,
} from "../../services/api/scripts/completions";
import { CodeArea } from "./CodeArea";

type Which = "prerequest" | "test";

/**
 * What `pm.` offers, and the shapes people write most.
 *
 * Its own source rather than a word list: the words already in the document
 * are no help for an API you are meeting for the first time, and the one-line
 * explanations are most of what makes the list worth opening.
 */
function scriptCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w.$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const options: Completion[] = [
    ...PM_COMPLETIONS.map((entry): Completion => {
      if (entry.kind !== "function") {
        return { label: entry.label, detail: entry.detail, type: "property" };
      }
      return {
        label: entry.label,
        detail: entry.detail,
        type: "function",
        // A call gets its parentheses, with the caret between them; a property
        // does not, because `pm.response.code()` is not a thing.
        apply: (view: EditorView, _completion: Completion, from: number, to: number) =>
          view.dispatch({
            changes: { from, to, insert: `${entry.label}()` },
            selection: { anchor: from + entry.label.length + 1 },
          }),
      };
    }),
    ...SCRIPT_SNIPPETS.map(
      (snippet): Completion => ({
        label: snippet.label,
        detail: snippet.detail,
        type: "keyword",
        apply: snippet.body,
      })
    ),
  ];

  return { from: word.from, options };
}

interface ScriptsPanelProps {
  scripts: { prerequest: string; test: string };
  onChange: (scripts: { prerequest: string; test: string }) => void;
  /** What runs before this request's own, outermost first. */
  inheritedBefore: CollectedScript[];
  inheritedAfter: CollectedScript[];
  /** False for a request that is not in a collection: there is nowhere to save
   * a script to, and an editor that silently discards is worse than none. */
  savable: boolean;
}

function Inherited({ title, scripts }: { title: string; scripts: CollectedScript[] }) {
  const [open, setOpen] = useState(false);
  if (scripts.length === 0) return null;

  return (
    <div className="border-b border-ft-border-subtle shrink-0">
      <button
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[10px] text-ft-text-muted hover:text-ft-text"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {title}: {scripts.map((script) => script.from).join(", ")}
      </button>
      {open &&
        scripts.map((script, index) => (
          <pre
            key={index}
            className="px-3 pb-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-ft-text-secondary"
          >
            {`// from ${script.from}\n${script.code}`}
          </pre>
        ))}
    </div>
  );
}

export function ScriptsPanel({
  scripts,
  onChange,
  inheritedBefore,
  inheritedAfter,
  savable,
}: ScriptsPanelProps) {
  const [which, setWhich] = useState<Which>("prerequest");
  const before = which === "prerequest";

  // Built once: the editor reads its extensions when it is created, and a new
  // array per render would be a new array it never looks at.
  const completion = useMemo(
    () => [
      autocompletion({
        override: [scriptCompletions],
        // The language's own word list stays on underneath, so a variable
        // declared three lines up still completes.
        defaultKeymap: true,
        // The same design as the variable list and the editor window's own.
        tooltipClass: () => "cm-api-completions cm-api-scripts",
      }),
    ],
    []
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 h-7 shrink-0 border-b border-ft-border-subtle">
        <button
          className={`api-tab ${before ? "selected" : ""}`}
          onClick={() => setWhich("prerequest")}
          title="Runs before the request goes out"
        >
          Pre-request
          {scripts.prerequest.trim() !== "" && <span className="api-tab-dot" />}
        </button>
        <button
          className={`api-tab ${!before ? "selected" : ""}`}
          onClick={() => setWhich("test")}
          title="Runs once the response has arrived"
        >
          Post-response
          {scripts.test.trim() !== "" && <span className="api-tab-dot" />}
        </button>

        <span className="ml-auto min-w-0 truncate text-[10px] text-ft-text-muted">
          {!savable
            ? "Save this request into a collection to keep a script with it"
            : before
              ? "pm.environment.set, pm.request.headers.upsert"
              : "pm.test, pm.expect, pm.response"}
        </span>
      </div>

      {/* What runs around this one, for whichever half is showing. */}
      <Inherited
        title="Runs before, from"
        scripts={before ? inheritedBefore : []}
      />
      <Inherited title="Runs after, from" scripts={before ? [] : inheritedAfter} />

      {/* Keyed by which half is showing, so switching tabs builds the other
          editor rather than re-pointing this one at a different document —
          which would carry the undo history of one script into the other. */}
      {before ? (
        <CodeArea
          key="prerequest"
          value={scripts.prerequest}
          onChange={(prerequest) => onChange({ ...scripts, prerequest })}
          placeholder={'pm.environment.set("now", String(Date.now()));'}
          extensions={completion}
          ariaLabel="Pre-request script"
        />
      ) : (
        <CodeArea
          key="test"
          value={scripts.test}
          onChange={(test) => onChange({ ...scripts, test })}
          placeholder={
            'pm.test("status is 200", () => {\n  pm.response.to.have.status(200);\n});'
          }
          extensions={completion}
          ariaLabel="Post-response script"
        />
      )}
    </div>
  );
}
