/**
 * Converting between CodeMirror offsets and LSP positions.
 *
 * This is the smallest file in the client and the one most able to make
 * everything else subtly wrong, so it is worth stating exactly what the units
 * are.
 *
 * A CodeMirror offset is an index into a JavaScript string, and a JavaScript
 * string is **UTF-16 code units**. An LSP `Position.character` is in whatever
 * `positionEncoding` was negotiated, which since 3.17 can be `utf-8`,
 * `utf-16` or `utf-32`. With UTF-16 the conversion is line arithmetic and
 * nothing else — that is the gift, and it is why the client asks for it first.
 *
 * Two ways to lose the gift, both handled here:
 *
 * - **Some servers insist on UTF-8.** `rust-analyzer` is the one everybody
 *   meets. Then `character` is a *byte* count into the line and every
 *   conversion needs a walk.
 * - **Astral-plane characters are two code units.** A line containing `👋`
 *   makes codepoint counting and code-unit counting disagree, which is what
 *   `utf-32` asks for. `Array.from(line).length` is the right tool there and
 *   the wrong one everywhere else.
 *
 * Get this wrong and everything is off by one on any line containing an emoji
 * or an accented character — the kind of bug that gets reported as "hover is
 * wrong sometimes".
 */

import type { Text } from "@codemirror/state";
import type { Position, PositionEncoding, Range } from "./protocol";

const UTF8 = new TextEncoder();

/**
 * How many units of `encoding` the first `length` code units of `text` occupy.
 *
 * `length` is a JavaScript index, so the UTF-16 answer is itself.
 */
function measure(text: string, length: number, encoding: PositionEncoding): number {
  if (encoding === "utf-16") return length;

  const slice = text.slice(0, length);
  if (encoding === "utf-32") {
    // Codepoints. `Array.from` iterates by codepoint, which is exactly the
    // definition — and the one case where it is correct to use here.
    return Array.from(slice).length;
  }

  // UTF-8 bytes. `TextEncoder` is in every webview this runs in and is far
  // faster than counting by hand for anything but the shortest strings.
  return UTF8.encode(slice).length;
}

/**
 * The inverse: how many JavaScript code units `units` of `encoding` cover.
 *
 * Clamped to the string's length, because a server is entitled to name a
 * position past the end of a line it has a slightly stale copy of, and the
 * answer to that must be "the end of the line" rather than `NaN`.
 */
function unmeasure(text: string, units: number, encoding: PositionEncoding): number {
  if (units <= 0) return 0;
  if (encoding === "utf-16") return Math.min(units, text.length);

  if (encoding === "utf-32") {
    let index = 0;
    let seen = 0;
    while (index < text.length && seen < units) {
      // A surrogate pair is one codepoint and two code units.
      index += text.codePointAt(index)! > 0xffff ? 2 : 1;
      seen++;
    }
    return Math.min(index, text.length);
  }

  // UTF-8: walk codepoints, adding each one's byte length, and stop at the
  // first position that would overshoot. Landing *inside* a character is not
  // an option — the offset would split a surrogate pair.
  let index = 0;
  let bytes = 0;
  while (index < text.length && bytes < units) {
    const code = text.codePointAt(index)!;
    const width = code > 0xffff ? 2 : 1;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > units) break;
    bytes += size;
    index += width;
  }
  return Math.min(index, text.length);
}

/** A CodeMirror offset as an LSP position. */
export function offsetToPosition(
  doc: Text,
  offset: number,
  encoding: PositionEncoding
): Position {
  const clamped = Math.max(0, Math.min(offset, doc.length));
  const line = doc.lineAt(clamped);
  return {
    line: line.number - 1,
    character: measure(line.text, clamped - line.from, encoding),
  };
}

/**
 * An LSP position as a CodeMirror offset.
 *
 * Every part is clamped. A server's copy of a document can lag the editor's by
 * an edit or two — that is normal, not exceptional — and a position it names
 * from that copy must resolve to somewhere real rather than throwing inside a
 * tooltip.
 */
export function positionToOffset(
  doc: Text,
  position: Position,
  encoding: PositionEncoding
): number {
  const number = Math.max(1, Math.min(position.line + 1, doc.lines));
  const line = doc.line(number);
  return line.from + unmeasure(line.text, position.character, encoding);
}

/** An LSP range as a CodeMirror `{ from, to }`, never inverted. */
export function rangeToOffsets(
  doc: Text,
  range: Range,
  encoding: PositionEncoding
): { from: number; to: number } {
  const from = positionToOffset(doc, range.start, encoding);
  const to = positionToOffset(doc, range.end, encoding);
  // A server that sends `end` before `start` would otherwise produce a
  // CodeMirror change that throws.
  return from <= to ? { from, to } : { from: to, to: from };
}

/** A CodeMirror `{ from, to }` as an LSP range. */
export function offsetsToRange(
  doc: Text,
  from: number,
  to: number,
  encoding: PositionEncoding
): Range {
  return {
    start: offsetToPosition(doc, from, encoding),
    end: offsetToPosition(doc, to, encoding),
  };
}

/** Exported for the unit tests, which are the only reason these aren't inlined. */
export const __test = { measure, unmeasure };
