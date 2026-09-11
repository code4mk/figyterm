import { indentUnit as indentUnitFacet } from "@codemirror/language";
import { EditorState, Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/**
 * Indentation guides — the faint vertical lines down each level of indent, with
 * the one belonging to the block the cursor is in drawn brighter.
 *
 * Written here rather than taken from `@replit/codemirror-indentation-markers`,
 * which is the usual answer. Partly one fewer dependency in what is already the
 * largest chunk of the bundle, but mostly because the whole of it is the two
 * rules below and both are judgement calls that every implementation makes
 * differently. Being able to read them is worth more than not writing them.
 *
 * ## Which guides a line gets
 *
 * One at every multiple of the indent unit, up to its own indent. Column zero
 * is the margin rather than a level, so a line indented once has one guide.
 *
 * A **blank** line has no indent of its own and would punch a hole through
 * every guide passing it, so it borrows: the *smaller* of the indents of the
 * nearest non-blank line above and below. Smaller, not larger, because a blank
 * line between a nested block and the statement after it belongs to whichever
 * is shallower — the deeper one would run a guide past the end of the block it
 * was describing. At the top or bottom of a file there is no neighbour and no
 * block, so a trailing blank line gets nothing.
 *
 * ## Which guide is active
 *
 * The innermost block containing the cursor, highlighted along that block's
 * whole extent rather than only on the cursor's line — the point of it is to
 * show where the block *ends*.
 *
 * With one wrinkle that matters: a line which *opens* a block belongs to the
 * block it opens. Resting on `function outer() {` lights the guide running down
 * its body, not the one around the function itself, because the body is what
 * you are about to be looking at. That is the difference between this being
 * useful and it merely being decorative.
 *
 * ## What this deliberately does not do
 *
 * It does not consult the syntax tree. Guides are a visual summary of the
 * whitespace, and a reader comparing them with the text expects them to agree
 * with what is in the file — including where the file's indentation is
 * inconsistent, which is exactly when they are most useful. A tree-driven
 * version would draw the indentation the parser thinks ought to be there.
 *
 * Only the visible lines are decorated, so the cost is the height of the window
 * rather than the length of the file.
 */

/** Above this, a line's indent is treated as noise and gets no guides. */
const MAX_LEVELS = 24;

/** How far a blank line will look for a neighbour to borrow from. */
const LOOKAROUND = 200;

/**
 * How far the active block's extent is traced in each direction.
 *
 * The walk below runs while the indent holds, which in a file that is one
 * enormous indented block is the whole file — on every cursor move. Bounded,
 * because the only thing past the bound is a guide the reader would have to
 * scroll five thousand lines to notice was missing.
 */
const MAX_BLOCK_SCAN = 5_000;

/**
 * How wide one level is, in columns, from the configured indent unit.
 *
 * `indentUnit` is a *string* — two spaces, four spaces, or a tab — because that
 * is what gets inserted. Its length is the column width for every case except a
 * tab, which occupies `tabSize` columns.
 */
function levelWidth(state: EditorState): number {
  const unit = state.facet(indentUnitFacet);
  if (unit.includes("\t")) return state.tabSize;
  return Math.max(1, unit.length);
}

/**
 * A line's own indent in columns, or null if it is blank.
 *
 * Blank means "nothing but whitespace": a line of four spaces is as blank as an
 * empty one, and treating it as indented would draw a guide on trailing
 * whitespace nobody can see.
 */
function ownColumns(text: string, tabSize: number): number | null {
  let columns = 0;
  for (const char of text) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += tabSize - (columns % tabSize);
    else return columns;
  }
  return null;
}

function neighbourColumns(
  state: EditorState,
  from: number,
  step: -1 | 1,
  tabSize: number
): number {
  const lines = state.doc.lines;
  for (let i = 1; i <= LOOKAROUND; i++) {
    const number = from + step * i;
    if (number < 1 || number > lines) break;
    const columns = ownColumns(state.doc.line(number).text, tabSize);
    if (columns !== null) return columns;
  }
  // Nothing either side: the edge of the file, where a guide would be
  // describing a block that isn't there.
  return 0;
}

/**
 * The indent a line is *treated* as having — its own, or borrowed if blank.
 *
 * The one function both rules go through, deliberately. When the drawn guides
 * and the active highlight worked the indent out separately they disagreed
 * around blank lines, and a highlight landing one level off the guide it is
 * supposed to be brightening looks like a rendering bug rather than a different
 * answer to a hard question.
 */
function effectiveColumns(state: EditorState, number: number, tabSize: number): number {
  const own = ownColumns(state.doc.line(number).text, tabSize);
  if (own !== null) return own;
  return Math.min(
    neighbourColumns(state, number, -1, tabSize),
    neighbourColumns(state, number, 1, tabSize)
  );
}

function depthOf(columns: number, width: number): number {
  return Math.min(Math.floor(columns / width), MAX_LEVELS);
}

/**
 * The block the cursor is in, as a depth and the lines it covers.
 *
 * Null when the cursor is at the top level, which has no guide to brighten, or
 * when a selection spans lines — "the block" of a selection crossing three of
 * them would be picking one arbitrarily.
 */
function activeBlock(
  state: EditorState,
  width: number,
  tabSize: number
): { depth: number; from: number; to: number } | null {
  const selection = state.selection.main;
  const cursorLine = state.doc.lineAt(selection.head);
  if (!selection.empty && state.doc.lineAt(selection.anchor).number !== cursorLine.number) {
    return null;
  }

  const lines = state.doc.lines;
  const own = depthOf(effectiveColumns(state, cursorLine.number, tabSize), width);

  // A line that opens a block belongs to the block it opens, so the search
  // starts inside it rather than on the opener.
  let depth = own;
  let start = cursorLine.number;
  if (cursorLine.number < lines) {
    const below = depthOf(effectiveColumns(state, cursorLine.number + 1, tabSize), width);
    if (below > own) {
      depth = below;
      start = cursorLine.number + 1;
    }
  }

  if (depth <= 0) return null;

  let from = start;
  const floor = Math.max(1, start - MAX_BLOCK_SCAN);
  while (from > floor && depthOf(effectiveColumns(state, from - 1, tabSize), width) >= depth) {
    from--;
  }

  let to = start;
  const ceiling = Math.min(lines, start + MAX_BLOCK_SCAN);
  while (to < ceiling && depthOf(effectiveColumns(state, to + 1, tabSize), width) >= depth) {
    to++;
  }

  return { depth, from, to };
}

/**
 * Cached line decorations, keyed by everything that goes into one.
 *
 * `Decoration.line` compares by identity, so building a fresh one per line
 * would make every visible line's decoration distinct and defeat CodeMirror's
 * diffing — every line torn down and rebuilt on every keystroke.
 *
 * All three numbers live in one decoration rather than two layered ones,
 * because two `Decoration.line`s on the same line would both want to set
 * `style` and only one of them can.
 */
const cache = new Map<string, Decoration>();

function lineDecoration(depth: number, width: number, active: number): Decoration {
  const key = `${depth}:${width}:${active}`;
  const existing = cache.get(key);
  if (existing) return existing;

  // `active` is the 1-based level to brighten; the stylesheet wants the column
  // it sits at, which is one level to its left.
  const style =
    `--cm-indent-depth:${depth};--cm-indent-width:${width}ch` +
    (active > 0 ? `;--cm-indent-active:${active - 1}` : "");

  const created = Decoration.line({
    class: active > 0 ? "cm-indent-guides cm-indent-active" : "cm-indent-guides",
    attributes: { style },
  });
  cache.set(key, created);
  return created;
}

function buildGuides(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const width = levelWidth(state);
  const tabSize = state.tabSize;
  const lines = state.doc.lines;
  const block = activeBlock(state, width, tabSize);

  for (const { from, to } of view.visibleRanges) {
    let line = state.doc.lineAt(from);

    while (line.from <= to) {
      const depth = depthOf(effectiveColumns(state, line.number, tabSize), width);

      if (depth > 0) {
        // Only inside the active block, and only on a line deep enough to have
        // that guide in the first place.
        const active =
          block &&
          line.number >= block.from &&
          line.number <= block.to &&
          depth >= block.depth
            ? block.depth
            : 0;
        builder.add(line.from, line.from, lineDecoration(depth, width, active));
      }

      if (line.number >= lines) break;
      line = state.doc.line(line.number + 1);
    }
  }

  return builder.finish();
}

export function indentGuides(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildGuides(view);
      }

      update(update: ViewUpdate) {
        /*
          `selectionSet` as well as the rest, because moving the cursor moves
          which guide is active — that is the whole feature. It costs a rebuild
          over the visible lines per cursor move, which is the same order of
          work as the active-line highlight drawn beside it.
        */
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.startState.facet(indentUnitFacet) !== update.state.facet(indentUnitFacet)
        ) {
          this.decorations = buildGuides(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );
}
