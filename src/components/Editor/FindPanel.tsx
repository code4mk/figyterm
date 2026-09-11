import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ListFilter,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
} from "lucide-react";
import { EditorView } from "@codemirror/view";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { isMac } from "../../services/platform";

/**
 * Find and replace, as a React panel.
 *
 * CodeMirror's own panel is replaced rather than restyled. Recolouring it got
 * the shape of a 2011 browser find bar — a text box, four checkboxes with
 * labels, and no match count — and the count is the part people actually use:
 * without "3 of 17" there is no way to know whether Enter is about to wrap.
 *
 * It is still *CodeMirror's* panel in the sense that matters: `createPanel` in
 * `EditorSurface` hands this component the panel's DOM to render into, so the
 * search state, the highlighting of every match, the open/close lifecycle and
 * the `⌘F`-while-open behaviour are all the library's. What's reimplemented is
 * the markup.
 */

/** Where counting stops. Past this the answer is "refine the search". */
const MAX_COUNTED = 5_000;

interface FindPanelProps {
  view: EditorView;
  /** Opened by the replace chord, so the second row starts expanded. */
  withReplace: boolean;
  /**
   * Bumped on every document and selection change while the panel is open, so
   * the count and the current index stay honest as the user edits and steps.
   */
  tick: number;
}

export function FindPanel({ view, withReplace, tick }: FindPanelProps) {
  const initial = useMemo(() => getSearchQuery(view.state), [view]);

  const [search, setSearch] = useState(initial.search);
  const [replace, setReplace] = useState(initial.replace);
  const [caseSensitive, setCaseSensitive] = useState(initial.caseSensitive);
  const [wholeWord, setWholeWord] = useState(initial.wholeWord);
  const [regexp, setRegexp] = useState(initial.regexp);
  const [showReplace, setShowReplace] = useState(withReplace);

  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  /**
   * Where "the first match" is measured from.
   *
   * Typing must not walk the selection forward a match per keystroke — typing
   * `foo` would land on the third `f`. So each edit of the query re-searches
   * from where the caret was when the panel opened, and only Enter (or a
   * replace) moves that mark on.
   */
  const anchor = useRef(view.state.selection.main.from);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  /*
    The replace chord pressed while the panel is *already* open: CodeMirror's
    `openSearchPanel` only re-focuses the field in that case, so the row has to
    be expanded from the prop rather than from the initial state.
  */
  useEffect(() => {
    if (withReplace) setShowReplace(true);
  }, [withReplace]);

  const query = useMemo(
    () =>
      new SearchQuery({
        search,
        replace,
        caseSensitive,
        wholeWord,
        regexp,
      }),
    [search, replace, caseSensitive, wholeWord, regexp]
  );

  /**
   * Selects the first match at or after the anchor, wrapping once.
   *
   * `findNext` isn't used for this: it steps from the *selection*, which is the
   * match it last left behind, and it falls back to opening CodeMirror's own
   * panel when the query is empty.
   */
  const selectFromAnchor = useCallback(
    (next: SearchQuery) => {
      if (!next.valid) return;
      const { state } = view;
      const from = Math.min(anchor.current, state.doc.length);

      // Iterated through the standard protocol rather than the cursor's own
      // `done`/`value` fields: `getCursor` is typed as an `Iterator`, and the
      // two spellings are the same object either way.
      const forward = next.getCursor(state, from).next();
      let hit = forward.done ? null : forward.value;

      if (!hit) {
        const wrapped = next.getCursor(state, 0, from).next();
        hit = wrapped.done ? null : wrapped.value;
      }
      if (!hit) return;

      view.dispatch({
        selection: { anchor: hit.from, head: hit.to },
        effects: EditorView.scrollIntoView(hit.from, { y: "center" }),
        userEvent: "select.search",
      });
    },
    [view]
  );

  // The query lives in CodeMirror, not here: it drives the match highlighting
  // and every one of the library's search commands.
  useEffect(() => {
    view.dispatch({ effects: setSearchQuery.of(query) });
    selectFromAnchor(query);
    // `selectFromAnchor` is stable and re-running on it would re-jump for no
    // reason; the query is the only real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, view]);

  /**
   * How many matches there are, and which one is selected.
   *
   * Counted here rather than kept in the editor state: it depends on the
   * viewport-independent whole document, changes on every edit, and nothing
   * inside CodeMirror needs it.
   */
  const counts = useMemo(() => {
    if (!search) return { total: 0, index: 0, capped: false, invalid: false };
    if (!query.valid) return { total: 0, index: 0, capped: false, invalid: true };

    const { state } = view;
    const selection = state.selection.main;
    const cursor = query.getCursor(state);
    let total = 0;
    let index = 0;

    for (let step = cursor.next(); !step.done && total < MAX_COUNTED; step = cursor.next()) {
      total++;
      if (step.value.from === selection.from && step.value.to === selection.to) {
        index = total;
      }
    }

    return { total, index, capped: total >= MAX_COUNTED, invalid: false };
    // `tick` is the whole point: it is what makes this recompute after an edit
    // or a step through the matches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, search, view, tick]);

  const step = useCallback(
    (direction: "next" | "previous") => {
      if (!query.valid) return;
      (direction === "next" ? findNext : findPrevious)(view);
      anchor.current = view.state.selection.main.from;
    },
    [query, view]
  );

  const close = useCallback(() => {
    closeSearchPanel(view);
    view.focus();
  }, [view]);

  const readOnly = view.state.readOnly;

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    // Stopped here so the modal's own chords don't also fire: ⌘F inside this
    // field means "focus me", not "open me again", and Escape means "close the
    // panel", not "close the editor".
    e.stopPropagation();

    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? "previous" : "next");
      return;
    }
    if (e.altKey && (e.metaKey || e.ctrlKey || !isMac)) {
      // ⌥⌘C / ⌥⌘W / ⌥⌘R on macOS, Alt+C / Alt+W / Alt+R elsewhere — the
      // toggles VS Code uses, so the buttons are not the only way in.
      const key = e.key.toLowerCase();
      if (key === "c") {
        e.preventDefault();
        setCaseSensitive((on) => !on);
      } else if (key === "w") {
        e.preventDefault();
        setWholeWord((on) => !on);
      } else if (key === "r") {
        e.preventDefault();
        setRegexp((on) => !on);
      }
    }
  };

  const onReplaceKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) replaceAll(view);
      else replaceNext(view);
      anchor.current = view.state.selection.main.from;
    }
  };

  return (
    <div className="editor-find" onMouseDown={(e) => e.stopPropagation()}>
      <button
        className="editor-find-expand"
        onClick={() => {
          const next = !showReplace;
          setShowReplace(next);
          // Focused only when the user opens the row by hand. Opening it with
          // the chord leaves the caret in the find field, which is where the
          // query you are about to replace gets typed.
          if (next) requestAnimationFrame(() => replaceRef.current?.focus());
        }}
        title={showReplace ? "Hide replace" : "Show replace"}
        aria-expanded={showReplace}
        aria-label={showReplace ? "Hide replace" : "Show replace"}
      >
        {showReplace ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      <div className="editor-find-rows">
        <div className="editor-find-row">
          <div
            className={`editor-find-field ${counts.invalid ? "invalid" : ""}`}
          >
            <input
              ref={inputRef}
              /* CodeMirror looks for this attribute when ⌘F is pressed while
                 the panel is already open, to focus and select the query. */
              main-field="true"
              className="editor-find-input"
              placeholder="Find"
              spellCheck={false}
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={onSearchKeyDown}
              onKeyUp={(e) => e.stopPropagation()}
              aria-label="Find"
            />
            <Toggle
              active={caseSensitive}
              onClick={() => setCaseSensitive((on) => !on)}
              title={`Match case (${isMac ? "⌥⌘C" : "Alt+C"})`}
            >
              <CaseSensitive size={13} />
            </Toggle>
            <Toggle
              active={wholeWord}
              onClick={() => setWholeWord((on) => !on)}
              title={`Match whole word (${isMac ? "⌥⌘W" : "Alt+W"})`}
            >
              <WholeWord size={13} />
            </Toggle>
            <Toggle
              active={regexp}
              onClick={() => setRegexp((on) => !on)}
              title={`Use a regular expression (${isMac ? "⌥⌘R" : "Alt+R"})`}
            >
              <Regex size={13} />
            </Toggle>
          </div>

          <span
            className={`editor-find-count ${counts.invalid ? "invalid" : ""}`}
            aria-live="polite"
          >
            {countLabel(search, counts)}
          </span>

          <button
            className="editor-find-btn"
            onClick={() => step("previous")}
            disabled={counts.total === 0}
            title="Previous match (⇧↵)"
            aria-label="Previous match"
          >
            <ArrowUp size={13} />
          </button>
          <button
            className="editor-find-btn"
            onClick={() => step("next")}
            disabled={counts.total === 0}
            title="Next match (↵)"
            aria-label="Next match"
          >
            <ArrowDown size={13} />
          </button>
          <button
            className="editor-find-btn"
            onClick={() => {
              selectMatches(view);
              view.focus();
            }}
            disabled={counts.total === 0}
            title="Select all matches"
            aria-label="Select all matches"
          >
            <ListFilter size={13} />
          </button>
          <button
            className="editor-find-btn"
            onClick={close}
            title="Close (Esc)"
            aria-label="Close find"
          >
            <X size={13} />
          </button>
        </div>

        {showReplace && (
          <div className="editor-find-row">
            <div className="editor-find-field">
              <input
                ref={replaceRef}
                className="editor-find-input"
                placeholder={readOnly ? "Replace — this file is read-only" : "Replace"}
                spellCheck={false}
                autoComplete="off"
                disabled={readOnly}
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                onKeyDown={onReplaceKeyDown}
                onKeyUp={(e) => e.stopPropagation()}
                aria-label="Replace with"
              />
            </div>

            <button
              className="editor-find-btn"
              onClick={() => {
                replaceNext(view);
                anchor.current = view.state.selection.main.from;
              }}
              disabled={readOnly || counts.total === 0}
              title="Replace this match (↵)"
              aria-label="Replace"
            >
              <Replace size={13} />
            </button>
            <button
              className="editor-find-btn"
              onClick={() => replaceAll(view)}
              disabled={readOnly || counts.total === 0}
              title={`Replace all (${isMac ? "⌘↵" : "Ctrl+Enter"})`}
              aria-label="Replace all"
            >
              <ReplaceAll size={13} />
            </button>
            {regexp && (
              <span className="editor-find-hint" title="$1, $2 … insert capture groups">
                $1
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function countLabel(
  search: string,
  counts: { total: number; index: number; capped: boolean; invalid: boolean }
): string {
  if (!search) return "";
  if (counts.invalid) return "Bad pattern";
  if (counts.total === 0) return "No results";
  const total = counts.capped ? `${counts.total}+` : String(counts.total);
  // Index zero means the selection isn't sitting on a match — after an edit, or
  // before the first step — so the total is all there is to say.
  return counts.index ? `${counts.index} of ${total}` : `${total} matches`;
}

function Toggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`editor-find-toggle ${active ? "active" : ""}`}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      // Keeps the field's focus: a toggle is a modifier on the query being
      // typed, not somewhere the caret should end up.
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}
