import { EditorState, Extension, StateField, Transaction } from "@codemirror/state";
import { Conflict, findConflicts } from "./mergeConflictScan";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";

/**
 * Merge conflicts, in the editor, the way every other editor does them.
 *
 * A conflicted file is text with markers in it and nothing else — git writes
 * `<<<<<<<`, `=======` and `>>>>>>>` into the working file and leaves. You can
 * always resolve one by deleting the lines you don't want by hand, and that
 * still works; this only means you rarely have to.
 *
 * Each block gets its two halves tinted apart — yours green, incoming blue, the
 * same way GitHub and VS Code colour them — and a row of actions above it that
 * replace the whole block with the half you chose. The marker lines themselves
 * are dimmed rather than hidden: they are real text, the file on disk has them,
 * and an editor that pretended otherwise would be lying about what is saved.
 *
 * **What this deliberately is not** is a three-pane merge tool. Those are for
 * the conflicts an accept button cannot settle, and they are a feature of their
 * own; the panel's "Keep mine" and "Take incoming" cover the whole-file case,
 * this covers the block-by-block one, and anything harder is a text editor with
 * the markers visible — which is what git gave you and what everybody
 * eventually falls back to.
 */

/**
 * Whether typed text could have *created* a marker.
 *
 * Only asked when the document is currently conflict-free, where the sole way
 * to grow one is to type or paste its characters. A deletion needs no thought
 * there: removing text from a file with no conflicts in it cannot produce one.
 * Once a file does hold a conflict, every change rescans.
 */
function couldStartMarker(tr: Transaction): boolean {
  let could = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (could) return;
    const text = inserted.toString();
    if (text.includes("<") || text.includes("=") || text.includes(">") || text.includes("|")) {
      could = true;
    }
  });
  return could;
}

/**
 * The conflicts in the current document.
 *
 * Rescanned on a change only when one could plausibly have moved: with no
 * conflicts in the file and no marker characters in what was typed, the answer
 * is the empty array it already was. That fast path is what keeps this off the
 * keystroke budget in the 99.9% of files that will never see a conflict.
 */
export type { Conflict };

export const conflictField = StateField.define<Conflict[]>({
  create: (state) => findConflicts(state.doc),
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (value.length === 0 && !couldStartMarker(tr)) return value;
    return findConflicts(tr.state.doc);
  },
});

/** Replaces a whole conflict with one of its halves. */
function resolve(view: EditorView, conflict: Conflict, which: "ours" | "theirs" | "both") {
  const doc = view.state.doc;
  const ours = doc.sliceString(conflict.ours.from, conflict.ours.to);
  const theirs = doc.sliceString(conflict.theirs.from, conflict.theirs.to);

  const insert =
    which === "ours"
      ? ours
      : which === "theirs"
        ? theirs
        : // Both, in the order they appear in the file: yours first, then what
          // arrived. An empty half contributes no blank line.
          [ours, theirs].filter((half) => half.length > 0).join("\n");

  view.dispatch({
    changes: { from: conflict.from, to: conflict.to, insert },
    // The cursor lands where the block was, so accepting several in a row
    // doesn't leave the selection somewhere the text no longer is.
    selection: { anchor: Math.min(conflict.from, view.state.doc.length) },
    userEvent: "input.resolveConflict",
  });
  view.focus();
}

/** The row of actions above a conflict. */
class ConflictActions extends WidgetType {
  constructor(private readonly conflict: Conflict) {
    super();
  }

  /** Two widgets are the same widget when they cover the same block. */
  eq(other: ConflictActions): boolean {
    return (
      other.conflict.from === this.conflict.from &&
      other.conflict.to === this.conflict.to &&
      other.conflict.oursLabel === this.conflict.oursLabel &&
      other.conflict.theirsLabel === this.conflict.theirsLabel
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-conflict-actions";

    const add = (label: string, title: string, kind: string, run: () => void) => {
      const button = document.createElement("button");
      button.className = `cm-conflict-action ${kind}`;
      button.textContent = label;
      button.title = title;
      button.onmousedown = (e) => e.preventDefault();
      button.onclick = run;
      bar.appendChild(button);
    };

    const mine = this.conflict.oursLabel || "current";
    const incoming = this.conflict.theirsLabel || "incoming";

    add("Accept current", `Keep your version (${mine})`, "ours", () =>
      resolve(view, this.conflict, "ours")
    );
    add("Accept incoming", `Take the version from ${incoming}`, "theirs", () =>
      resolve(view, this.conflict, "theirs")
    );
    add("Accept both", "Keep your version, then the incoming one", "both", () =>
      resolve(view, this.conflict, "both")
    );

    return bar;
  }

  /** The buttons handle their own clicks; the editor should not also see them. */
  ignoreEvent(): boolean {
    return true;
  }
}

const oursLine = Decoration.line({ class: "cm-conflict-ours" });
const theirsLine = Decoration.line({ class: "cm-conflict-theirs" });
const baseLine = Decoration.line({ class: "cm-conflict-base" });
const markerLine = Decoration.line({ class: "cm-conflict-marker" });

/** Line decorations for both halves, and the actions above the block. */
function decorate(state: EditorState): DecorationSet {
  const conflicts = state.field(conflictField);
  if (conflicts.length === 0) return Decoration.none;

  const doc = state.doc;
  const marks: { from: number; value: Decoration }[] = [];

  const overLines = (from: number, to: number, value: Decoration) => {
    // An empty half — one side deleted everything — has nothing to tint, and
    // its range sits at the start of the separator line below it. Tinting that
    // would colour a marker as if it were content.
    if (to <= from) return;
    let line = doc.lineAt(from);
    for (;;) {
      marks.push({ from: line.from, value });
      if (line.to >= to || line.number >= doc.lines) break;
      line = doc.line(line.number + 1);
    }
  };

  for (const conflict of conflicts) {
    // The actions sit on their own line, above the block they act on.
    marks.push({
      from: conflict.from,
      value: Decoration.widget({
        widget: new ConflictActions(conflict),
        side: -1,
        block: true,
      }),
    });

    overLines(conflict.ours.from, conflict.ours.to, oursLine);
    if (conflict.base) overLines(conflict.base.from, conflict.base.to, baseLine);
    overLines(conflict.theirs.from, conflict.theirs.to, theirsLine);

    /*
      The marker lines last, and each one named by the half that follows it:
      `theirs.from` is the start of the line *after* `=======`, so stepping
      back one character lands on the separator itself. They go after the
      halves because a line carrying both classes takes the last background
      declared — which for an empty half is the marker, correctly.
    */
    marks.push({ from: doc.lineAt(conflict.from).from, value: markerLine });
    if (conflict.base) {
      marks.push({ from: doc.lineAt(conflict.base.from - 1).from, value: markerLine });
    }
    marks.push({ from: doc.lineAt(conflict.theirs.from - 1).from, value: markerLine });
    marks.push({ from: doc.lineAt(conflict.to).from, value: markerLine });
  }

  // CodeMirror wants ranges in document order, and the block widget shares a
  // position with the marker line it sits above — hence the stable sort and
  // the `true` below, which says these may overlap at a point.
  marks.sort((a, b) => a.from - b.from);
  return Decoration.set(
    marks.map((mark) => mark.value.range(mark.from)),
    true
  );
}

/**
 * The whole feature: the field, the decorations and their styling.
 *
 * Styled through CodeMirror's own theme layer rather than `styles.css`: these
 * nodes belong to the editor, and `&dark` is how a base theme says "when the
 * editor is dark" without this file having to know which theme is on.
 */
export function mergeConflicts(): Extension {
  return [
    conflictField,
    EditorView.decorations.compute([conflictField], decorate),
    EditorView.baseTheme({
      ".cm-conflict-ours": { backgroundColor: "rgba(63, 185, 80, 0.13)" },
      ".cm-conflict-theirs": { backgroundColor: "rgba(99, 102, 241, 0.15)" },
      ".cm-conflict-base": { backgroundColor: "rgba(139, 148, 158, 0.1)" },
      ".cm-conflict-marker": { backgroundColor: "rgba(139, 148, 158, 0.16)" },

      "&light .cm-conflict-ours": { backgroundColor: "rgba(26, 127, 55, 0.1)" },
      "&light .cm-conflict-theirs": { backgroundColor: "rgba(79, 70, 229, 0.1)" },
      "&light .cm-conflict-base": { backgroundColor: "rgba(107, 114, 128, 0.08)" },
      "&light .cm-conflict-marker": { backgroundColor: "rgba(107, 114, 128, 0.12)" },

      ".cm-conflict-actions": {
        display: "flex",
        gap: "12px",
        padding: "1px 8px",
        fontSize: "11px",
        fontFamily: "system-ui, -apple-system, \"Segoe UI\", sans-serif",
        userSelect: "none",
      },
      ".cm-conflict-action": {
        background: "none",
        border: "none",
        padding: "0",
        cursor: "pointer",
        fontSize: "11px",
        fontWeight: "600",
      },
      ".cm-conflict-action:hover": { textDecoration: "underline" },
      ".cm-conflict-action.ours": { color: "#3fb950" },
      ".cm-conflict-action.theirs": { color: "#7aa2f7" },
      ".cm-conflict-action.both": { color: "#8b949e" },
      "&light .cm-conflict-action.ours": { color: "#1a7f37" },
      "&light .cm-conflict-action.theirs": { color: "#4f46e5" },
      "&light .cm-conflict-action.both": { color: "#6b7280" },
    }),
  ];
}
