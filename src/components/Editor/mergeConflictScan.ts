import { Text } from "@codemirror/state";

/**
 * Finding merge conflicts in a document, and nothing else.
 *
 * Apart from `mergeConflicts.ts` because this half is pure — text in, ranges
 * out — which is what lets `npm test` run it in Node. The decorations, the
 * widgets and the accept actions all need CodeMirror's view layer, and the
 * view layer needs a DOM.
 */

/** Both halves of one conflict, and where its markers are. */
export interface Conflict {
  /** Start of the `<<<<<<<` line. */
  from: number;
  /** End of the `>>>>>>>` line, newline excluded. */
  to: number;
  /** What follows `<<<<<<<` — usually `HEAD`. */
  oursLabel: string;
  /** What follows `>>>>>>>` — the branch or commit being merged. */
  theirsLabel: string;
  /** The text between `<<<<<<<` and `=======`, markers excluded. */
  ours: { from: number; to: number };
  /** The text between `=======` and `>>>>>>>`. */
  theirs: { from: number; to: number };
  /** The common ancestor's version, when `merge.conflictStyle` is `diff3`. */
  base: { from: number; to: number } | null;
}

/**
 * Above this many lines the scan is skipped.
 *
 * The scan walks the whole document, and while the rope walk is fast, a file
 * this size is generated — a lock file, a bundle, a data dump — and conflicts
 * in it are resolved by regenerating the file, not by reading it.
 */
const MAX_SCAN_LINES = 100_000;

const START = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const MIDDLE = /^={7}\s*$/;
const END = /^>{7}(?: |$)/;

/**
 * Finds every conflict in the document.
 *
 * A single pass with a small state machine rather than a regular expression
 * over the whole text: the blocks are line-oriented, can't nest, and a file
 * that contains something that merely *looks* like a marker mid-line — a
 * heredoc, a base64 blob, this very comment — must not be read as one.
 */
export function findConflicts(doc: Text): Conflict[] {
  if (doc.lines > MAX_SCAN_LINES) return [];

  const found: Conflict[] = [];
  let open: {
    from: number;
    oursLabel: string;
    oursFrom: number;
    oursTo: number;
    baseFrom: number | null;
    baseTo: number | null;
    theirsFrom: number | null;
  } | null = null;

  let pos = 0;
  for (const line of doc.iterLines()) {
    const lineEnd = pos + line.length;

    if (START.test(line)) {
      // A second `<<<<<<<` before the first block closed means the first was
      // never a conflict — some file that happens to contain the marker. The
      // newer one wins, which is the reading that recovers.
      open = {
        from: pos,
        oursLabel: line.slice(7).trim(),
        oursFrom: lineEnd + 1,
        oursTo: lineEnd + 1,
        baseFrom: null,
        baseTo: null,
        theirsFrom: null,
      };
    } else if (open && BASE.test(line)) {
      open.oursTo = pos > open.oursFrom ? pos - 1 : open.oursFrom;
      open.baseFrom = lineEnd + 1;
    } else if (open && MIDDLE.test(line)) {
      if (open.baseFrom !== null) {
        open.baseTo = pos > open.baseFrom ? pos - 1 : open.baseFrom;
      } else {
        open.oursTo = pos > open.oursFrom ? pos - 1 : open.oursFrom;
      }
      open.theirsFrom = lineEnd + 1;
    } else if (open && open.theirsFrom !== null && END.test(line)) {
      found.push({
        from: open.from,
        to: lineEnd,
        oursLabel: open.oursLabel,
        theirsLabel: line.slice(7).trim(),
        ours: { from: open.oursFrom, to: open.oursTo },
        theirs: {
          from: open.theirsFrom,
          to: pos > open.theirsFrom ? pos - 1 : open.theirsFrom,
        },
        base:
          open.baseFrom !== null && open.baseTo !== null
            ? { from: open.baseFrom, to: open.baseTo }
            : null,
      });
      open = null;
    }

    pos = lineEnd + 1;
  }

  return found;
}
