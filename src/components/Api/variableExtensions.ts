/**
 * What an editor needs to know about `{{variables}}`.
 *
 * The decorations, the hover and the completion list, as extensions any
 * CodeMirror in this window can take — the one-line URL field, a table cell,
 * and the raw body editor, which is many lines and a different component
 * entirely. They were inside `VariableInput`, which meant the body could not
 * have them: the single most common place to write `{{client_id}}` was the one
 * place that did not colour it.
 */

import { EditorState, Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  Tooltip,
  TooltipView,
  ViewPlugin,
  ViewUpdate,
  hoverTooltip,
  keymap,
  showTooltip,
} from "@codemirror/view";
import {
  completionRange,
  describe,
  meaningOf,
  namesInScope,
  scanTemplates,
  TemplateState,
} from "../../services/api/highlight";
import { DYNAMIC_VARIABLES, Scope, ScopeKind } from "../../services/api/template";

const setScopes = StateEffect.define<Scope[]>();
const scopeField = StateField.define<Scope[]>({
  create: () => [],
  update: (current, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setScopes)) return effect.value;
    }
    return current;
  },
});

const MARKS = {
  resolved: Decoration.mark({ class: "cm-api-var" }),
  empty: Decoration.mark({ class: "cm-api-var cm-api-var-empty" }),
  missing: Decoration.mark({ class: "cm-api-var cm-api-var-missing" }),
  dynamic: Decoration.mark({ class: "cm-api-var cm-api-var-dynamic" }),
};

function decorate(view: EditorView): DecorationSet {
  const scopes = view.state.field(scopeField);
  const text = view.state.doc.toString();
  return Decoration.set(
    scanTemplates(text).map((span) =>
      MARKS[meaningOf(span.name, scopes).state].range(span.from, span.to)
    ),
    true
  );
}

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }

    update(update: ViewUpdate) {
      // Also on any transaction carrying new scopes: switching environment
      // changes what resolves without changing a character of the text.
      if (
        update.docChanged ||
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(setScopes))
        )
      ) {
        this.decorations = decorate(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

/** The hover: the value, and which scope it came from. */
const explain = hoverTooltip((view, pos) => {
  const text = view.state.doc.toString();
  const span = scanTemplates(text).find((entry) => pos >= entry.from && pos <= entry.to);
  if (!span) return null;

  const meaning = meaningOf(span.name, view.state.field(scopeField));

  return {
    pos: span.from,
    end: span.to,
    above: true,
    create: () => {
      /*
        Built with `textContent` throughout, never HTML: every string here is
        either a variable's name or its value, and both come out of a document
        somebody else wrote and this app imported.
      */
      const dom = document.createElement("div");
      dom.className = `api-var-tip ${meaning.state}`;

      // A header line: the name, and what state it is in. The state is a word
      // rather than only a colour, for the same reason the chips are
      // underlined — colour is never the only signal.
      const head = document.createElement("div");
      head.className = "api-var-tip-head";

      const name = document.createElement("span");
      name.className = "api-var-tip-name";
      name.textContent = span.name;

      const badge = document.createElement("span");
      badge.className = "api-var-tip-badge";
      badge.textContent = LABELS[meaning.state];

      head.append(name, badge);

      // The value, big enough to read, wrapped, and capped — a variable
      // holding a JWT is three hundred characters and would otherwise be a
      // tooltip the height of the window.
      const value = document.createElement("div");
      value.className = "api-var-tip-value";
      value.textContent = valueText(meaning);

      dom.append(head, value);

      // Where it came from, on its own line. `describe` says it in a sentence
      // for the states that have no value to show.
      const from = document.createElement("div");
      from.className = "api-var-tip-from";
      from.textContent =
        meaning.state === "resolved" || meaning.state === "empty"
          ? `from ${meaning.from}`
          : describe(meaning);
      dom.append(from);

      return { dom };
    },
  };
});

/** The word beside the name. Short, because it sits next to it. */
const LABELS: Record<TemplateState, string> = {
  resolved: "resolved",
  empty: "empty",
  missing: "not set",
  dynamic: "generated",
};

/** What to put in the value line, for each state. */
function valueText(meaning: ReturnType<typeof meaningOf>): string {
  switch (meaning.state) {
    case "resolved":
      return meaning.value ?? "";
    case "empty":
      return "(nothing)";
    case "missing":
      return "—";
    default:
      return "a fresh value on every send";
  }
}


/* ───────────────────────────────────────────────────────────────────────────
   The suggestion popup.

   Not CodeMirror's. Its `autocompletion` draws a `<ul>` of one-line `<li>`s
   and offers CSS and a few cells to dress it in; five attempts at dressing it
   ended in the same list with different paint, and two of the things this
   popup needs are not reachable from there at all — a header that counts what
   is on screen right now, and a footer saying which keys do what.

   So the list is ours: a tooltip we build, with our own markup, our own
   keymap, and the same shape as the references popup in the editor window —
   title, live count, dismiss; rows of a name, where it comes from and a chip;
   the value underneath in mono; a key hint along the bottom.
   ─────────────────────────────────────────────────────────────────────────── */

/** One thing that could be inserted. */
interface Candidate {
  name: string;
  /** The value, or for a generated one, what it will produce. */
  value: string;
  /** The scope's own name, for the second half of the first line. */
  from: string;
  kind: ScopeKind | "dynamic";
}

/** A candidate that survived filtering, and where the typed text matched. */
interface Row extends Candidate {
  /** Index of the match inside the name, or -1 when nothing was typed. */
  at: number;
}

function candidates(scopes: Scope[]): Candidate[] {
  const list: Candidate[] = namesInScope(scopes).map((entry) => ({
    name: entry.name,
    value: entry.value,
    from: entry.from,
    kind: entry.kind,
  }));

  // Last, always: nothing defines these, so no scope could offer them, and
  // they are the ones people cannot look up anywhere.
  for (const entry of DYNAMIC_VARIABLES) {
    list.push({ name: entry.name, value: entry.hint, from: "Built in", kind: "dynamic" });
  }
  return list;
}

/**
 * The order the kinds come in: environment, then collection, and the generated
 * ones last.
 *
 * Grouped by kind rather than by which scope happens to sit closest, because
 * the chip is the only thing distinguishing two rows called `authToken` and a
 * list that interleaves them is a list you have to read a chip at a time.
 * Generated values go last wherever they are: nothing defines them, so they
 * are never what somebody came looking for.
 */
const KIND_RANK: Record<ScopeKind | "dynamic", number> = {
  environment: 0,
  collection: 1,
  folder: 2,
  request: 3,
  global: 4,
  dynamic: 5,
};

/**
 * Which candidates match what has been typed, in kind order.
 *
 * Within a kind a prefix match sorts above one that matched in the middle —
 * typing `base` offers `base_url` before `api_base` — and below that the
 * original order survives, which is scope order, which is the order resolution
 * would pick them in.
 */
function rank(list: Candidate[], typed: string): Row[] {
  const byKind = (a: Row, b: Row) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.at - b.at;

  if (typed === "") {
    return list.map((entry) => ({ ...entry, at: -1 })).sort(byKind);
  }

  const needle = typed.toLowerCase();
  const hits: Row[] = [];
  for (const entry of list) {
    const at = entry.name.toLowerCase().indexOf(needle);
    if (at !== -1) hits.push({ ...entry, at });
  }
  return hits.sort(byKind);
}

/** Everything drawn, plus where accepting a row would write. */
interface Popup {
  /** The range to replace: just inside the braces, closing ones included. */
  from: number;
  to: number;
  /** What has been typed inside the braces, for the bold run on each name. */
  typed: string;
  rows: Row[];
  index: number;
  /** Escape was pressed. Kept rather than dropped so typing re-opens it and
   * moving the caret does not. */
  dismissed: boolean;
  /**
   * The tooltip object, carried in the state on purpose.
   *
   * CodeMirror matches tooltips across updates by identity, so a fresh object
   * each keystroke would tear the popup down and build it again — losing the
   * scroll position mid-filter. Reusing it while the popup is for the same
   * `{{` gives a stable element that re-renders in place.
   */
  tooltip: Tooltip;
}

const movePopup = StateEffect.define<number>();
const selectPopup = StateEffect.define<number>();
const dismissPopup = StateEffect.define<null>();

function tooltipAt(from: number): Tooltip {
  return {
    // The `{{` itself, so the popup hangs off the start of the template
    // rather than following the caret across the name being typed.
    pos: from - 2,
    above: false,
    strictSide: false,
    arrow: false,
    create: (view) => new PopupView(view),
  };
}

function compute(state: EditorState, previous: Popup | null): Popup | null {
  const selection = state.selection.main;
  if (!selection.empty) return null;

  const range = completionRange(state.doc.toString(), selection.head);
  if (!range) return null;

  const rows = rank(candidates(state.field(scopeField)), range.typed);
  if (rows.length === 0) return null;

  return {
    from: range.from,
    to: range.to,
    typed: range.typed,
    rows,
    index: 0,
    dismissed: false,
    tooltip: previous && previous.from === range.from ? previous.tooltip : tooltipAt(range.from),
  };
}

const popupField = StateField.define<Popup | null>({
  create: () => null,
  update(previous, transaction) {
    for (const effect of transaction.effects) {
      // Deliberately ahead of the recompute below: accepting a row changes the
      // document, and that change must not re-open the list it just closed.
      if (effect.is(dismissPopup)) return previous ? { ...previous, dismissed: true } : null;
      if (effect.is(movePopup) && previous) {
        const count = previous.rows.length;
        return { ...previous, index: (((previous.index + effect.value) % count) + count) % count };
      }
      if (effect.is(selectPopup) && previous) return { ...previous, index: effect.value };
    }

    const scoped = transaction.effects.some((effect) => effect.is(setScopes));
    if (!transaction.docChanged && !transaction.selection && !scoped) return previous;
    return compute(transaction.state, previous);
  },
  provide: (field) =>
    showTooltip.from(field, (popup) => (popup && !popup.dismissed ? popup.tooltip : null)),
});

/** The popup as it is now, or null when there is nothing to steer. */
function shown(view: EditorView): Popup | null {
  const popup = view.state.field(popupField, false);
  return popup && !popup.dismissed && popup.rows.length > 0 ? popup : null;
}

function insert(view: EditorView, popup: Popup, row: Row): void {
  // The closing braces come with it, so accepting finishes the template
  // rather than leaving it hanging open.
  const text = `${row.name}}}`;
  view.dispatch({
    changes: { from: popup.from, to: popup.to, insert: text },
    selection: { anchor: popup.from + text.length },
    effects: dismissPopup.of(null),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
}

const step = (by: number) => (view: EditorView) => {
  if (!shown(view)) return false;
  view.dispatch({ effects: movePopup.of(by) });
  return true;
};

function accept(view: EditorView): boolean {
  const popup = shown(view);
  const row = popup?.rows[popup.index];
  if (!popup || !row) return false;
  insert(view, popup, row);
  return true;
}

function dismiss(view: EditorView): boolean {
  if (!shown(view)) return false;
  view.dispatch({ effects: dismissPopup.of(null) });
  return true;
}

/**
 * Highest precedence, and every binding returns false when the popup is not
 * open — so Enter still submits the URL bar, Escape still closes the dialog,
 * and the arrows still move the caret, exactly as before, whenever there is no
 * list on screen to steer.
 */
const steering = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: step(1) },
    { key: "ArrowUp", run: step(-1) },
    { key: "PageDown", run: step(6) },
    { key: "PageUp", run: step(-6) },
    { key: "Enter", run: accept },
    { key: "Tab", run: accept },
    { key: "Escape", run: dismiss },
  ])
);

/**
 * The letter on a row's chip.
 *
 * From the scope's *kind*, never its name: an environment called "Collection"
 * is an ordinary thing to name one, and a chip guessed from the label would
 * put a C on it.
 */
const SCOPE_LETTER: Record<ScopeKind | "dynamic", string> = {
  environment: "E",
  collection: "C",
  global: "G",
  folder: "F",
  request: "R",
  dynamic: "D",
};

/** The words beside the name: what sort of scope, then which one. */
function whereFrom(row: Row): string {
  const what: Record<ScopeKind | "dynamic", string> = {
    environment: "Environment",
    collection: "Collection",
    global: "Globals",
    folder: "Folder",
    request: "Request",
    dynamic: "Dynamic",
  };
  // Globals and the generated ones have one name each, and it is the word
  // itself — "Globals · Globals" reads as a mistake.
  return row.kind === "global" || row.kind === "dynamic"
    ? what[row.kind]
    : `${what[row.kind]} · ${row.from}`;
}

/**
 * How many are on screen — what survived filtering, not what exists.
 *
 * The bare number, because the popup is narrow enough that a sentence beside
 * the title would push the dismiss off the end of it.
 */
function countLine(rows: Row[]): string {
  return String(rows.length);
}

class PopupView implements TooltipView {
  dom: HTMLElement;
  private count: HTMLElement;
  private list: HTMLElement;

  constructor(private view: EditorView) {
    this.dom = element("div", "figy-vars");
    // Clicking anywhere in here must not take the caret out of the field, or
    // the range the click is about to write into stops existing.
    this.dom.addEventListener("mousedown", (event) => event.preventDefault());

    const head = element("div", "figy-vars-head");
    head.append(element("span", "figy-vars-title", "VARIABLES"));
    this.count = element("span", "figy-vars-count");
    head.append(this.count);

    const close = element("button", "figy-vars-close", "×");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => dismiss(this.view));
    head.append(close);

    this.list = element("div", "figy-vars-list");

    const foot = element(
      "div",
      "figy-vars-foot",
      "↑↓ to move · ↵ to insert · Esc to close"
    );

    this.dom.append(head, this.list, foot);
    this.render();
  }

  mount() {
    this.reveal();
  }

  update(update: ViewUpdate) {
    if (update.state.field(popupField, false) !== update.startState.field(popupField, false)) {
      this.render();
      this.reveal();
    }
  }

  private render() {
    const popup = this.view.state.field(popupField, false);
    if (!popup) return;

    this.count.textContent = countLine(popup.rows);
    this.list.textContent = "";

    popup.rows.forEach((row, index) => {
      const item = element("div", `figy-vars-row${index === popup.index ? " selected" : ""}`);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === popup.index ? "true" : "false");

      const line = element("div", "figy-vars-line");

      // Built with `textContent` throughout, never HTML: every string on this
      // row is a name or a value out of a document somebody else wrote.
      const name = element("span", "figy-vars-name");
      if (row.at >= 0 && popup.typed !== "") {
        const end = row.at + popup.typed.length;
        name.append(document.createTextNode(row.name.slice(0, row.at)));
        name.append(element("b", "figy-vars-hit", row.name.slice(row.at, end)));
        name.append(document.createTextNode(row.name.slice(end)));
      } else {
        name.textContent = row.name;
      }

      line.append(name);

      const chip = element("span", `figy-vars-chip ${row.kind}`, SCOPE_LETTER[row.kind] ?? "E");
      // Which scope, on the chip's own tooltip. The popup is half the width it
      // was and there is no room to spell it out on the row — and it is the
      // one thing here that can be asked for rather than read.
      chip.title = whereFrom(row);
      line.append(chip);

      const value = element(
        "div",
        `figy-vars-value${row.value === "" ? " empty" : ""}`,
        // A dash rather than a sentence: at this width a sentence is an
        // ellipsis, and the dash says the same thing in one character.
        row.value === "" ? "—" : row.value
      );
      // Long tokens are cut with an ellipsis, so the whole of one is on hover.
      if (row.value !== "") value.title = row.value;

      item.append(line, value);
      item.addEventListener("click", () => insert(this.view, popup, row));
      item.addEventListener("mouseenter", () => {
        if (index !== popup.index) this.view.dispatch({ effects: selectPopup.of(index) });
      });

      this.list.append(item);
    });
  }

  /** Keep the selected row on screen while the arrows walk past the edge. */
  private reveal() {
    const selected = this.list.querySelector(".figy-vars-row.selected");
    selected?.scrollIntoView({ block: "nearest" });
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Everything a field needs to understand variables, as one extension.
 *
 * The scopes travel in a `StateField` rather than a closure: a closure captures
 * them as they were when the editor was built and goes stale the moment
 * somebody switches environment — which is exactly when the colours matter.
 * `setScopes` is how they are kept current.
 */
export function variableExtensions(): Extension {
  return [scopeField, highlighter, explain, popupField, steering];
}

/** Tells an editor which scopes are in play now. */
export function scopesEffect(scopes: Scope[]) {
  return setScopes.of(scopes);
}
