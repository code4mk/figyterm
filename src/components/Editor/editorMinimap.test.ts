/**
 * The arithmetic the minimap draws by.
 *
 * At two pixels a line none of this is visible as a picture — a run merged
 * across a space, a tab counted as one column, a run lost at the clip all
 * produce a map that looks plausible and is subtly wrong about the shape of
 * the file, which is the only thing a minimap is for.
 *
 * The drawing itself is a canvas and is not tested here; this is the half that
 * decides what to draw, which is why it was separated from the half that draws.
 */

import assert from "node:assert/strict";
import { lineSegments, scrollTopFor, type ColorSpan } from "./editorMinimap";

let failures = 0;
function test(name: string, run: () => void) {
  try {
    run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(error as Error).message.split("\n").join("\n        ")}`);
  }
}

console.log("editorMinimap");

/* ─── lineSegments ─────────────────────────────────────────────────────────
   What the canvas is asked to draw for one line, and in what colour. The
   picture itself is real text rasterised by the browser; this is the part with
   the decisions in it, and the part where a line can silently come out shifted,
   clipped wrong, or painted in the colour of the token next to it.
   ──────────────────────────────────────────────────────────────────────────── */

/** The drawn text of a line, ignoring where the colours fall. */
const drawn = (segments: { text: string }[]) => segments.map((s) => s.text).join("");

test("a word is one segment at its own column", () => {
  const out = lineSegments("const", 0, [], 90);
  assert.deepEqual(out, [{ column: 0, text: "const", color: null }]);
});

test("a space ends a run and leaves a gap", () => {
  const out = lineSegments("a b", 0, [], 90);
  assert.deepEqual(out, [
    { column: 0, text: "a", color: null },
    { column: 2, text: "b", color: null },
  ]);
});

test("indentation becomes columns, not drawn text", () => {
  const out = lineSegments("    return", 0, [], 90);
  assert.equal(out.length, 1);
  assert.equal(out[0].column, 4);
  assert.equal(out[0].text, "return");
});

test("a tab goes to the next tab stop, not a fixed width", () => {
  // Mid-line this is the difference between columns lining up and everything
  // after the tab sitting one place out.
  assert.equal(lineSegments("a\tb", 0, [], 90, 2)[1].column, 2);
  assert.equal(lineSegments("ab\tc", 0, [], 90, 2)[1].column, 4);
});

test("trailing whitespace draws nothing", () => {
  assert.equal(drawn(lineSegments("end   ", 0, [], 90)), "end");
  assert.deepEqual(lineSegments("     ", 0, [], 90), []);
  assert.deepEqual(lineSegments("", 0, [], 90), []);
});

test("a long line is clipped to the columns that fit", () => {
  assert.equal(drawn(lineSegments("x".repeat(200), 0, [], 74)).length, 74);
});

test("a carriage return is not a glyph", () => {
  // Files with CRLF endings arrive here with the \r still attached. Spaces are
  // gaps rather than drawn text, so what comes back is the ink alone.
  const out = lineSegments("let a = 1;\r", 0, [], 90);
  assert.equal(drawn(out), "leta=1;");
  assert.ok(!drawn(out).includes("\r"));
});

/* ─── colour ─────────────────────────────────────────────────────────────── */

test("a span colours exactly the characters it covers", () => {
  // `const` keyword, `x` plain: the boundary is the thing to get right.
  const spans: ColorSpan[] = [{ from: 0, to: 5, color: "#f00" }];
  const out = lineSegments("const x", 0, spans, 90);
  assert.deepEqual(out, [
    { column: 0, text: "const", color: "#f00" },
    { column: 6, text: "x", color: null },
  ]);
});

test("spans are read against the document, not the line", () => {
  // A line 400 characters into the file gets spans at 400-odd; using them as
  // if they were line offsets would colour the wrong words.
  const spans: ColorSpan[] = [{ from: 403, to: 406, color: "#0f0" }];
  const out = lineSegments("ab cde", 400, spans, 90);
  assert.deepEqual(out, [
    { column: 0, text: "ab", color: null },
    { column: 3, text: "cde", color: "#0f0" },
  ]);
});

test("two colours in one word are two segments", () => {
  const spans: ColorSpan[] = [
    { from: 0, to: 2, color: "#f00" },
    { from: 2, to: 4, color: "#00f" },
  ];
  const out = lineSegments("abcd", 0, spans, 90);
  assert.deepEqual(out, [
    { column: 0, text: "ab", color: "#f00" },
    { column: 2, text: "cd", color: "#00f" },
  ]);
});

test("an uncoloured gap between two spans stays uncoloured", () => {
  const spans: ColorSpan[] = [
    { from: 0, to: 1, color: "#f00" },
    { from: 3, to: 4, color: "#00f" },
  ];
  assert.deepEqual(lineSegments("abcd", 0, spans, 90), [
    { column: 0, text: "a", color: "#f00" },
    { column: 1, text: "bc", color: null },
    { column: 3, text: "d", color: "#00f" },
  ]);
});

test("a span reaching past the clip colours only what is drawn", () => {
  const spans: ColorSpan[] = [{ from: 0, to: 100, color: "#f00" }];
  const out = lineSegments("x".repeat(50), 0, spans, 10);
  assert.equal(drawn(out).length, 10);
  assert.equal(out[0].color, "#f00");
});

test("no spans at all is a plain line, not a crash", () => {
  // The parser not having reached this line yet is the normal case on a big
  // file, and it has to draw.
  assert.equal(drawn(lineSegments("plain text", 0, [], 90)), "plaintext");
});

/* ─── scrollTopFor ─────────────────────────────────────────────────────────
   Where a press on the rail puts the view. A document 4000 tall in an 800-tall
   viewport: 3200 of travel, and a quarter of it visible at a time.
   ──────────────────────────────────────────────────────────────────────────── */

const DOC = 4000;
const VIEW = 800;

test("a press with no grab centres the view on it", () => {
  // Half way down the file, with the viewport's middle at the pointer: the top
  // sits an eighth of the document above it.
  const top = scrollTopFor(0.5, DOC, VIEW, null);
  assert.equal(Math.round(top + VIEW / 2), DOC / 2);
});

test("a press at the very top and the very bottom clamp", () => {
  assert.equal(scrollTopFor(0, DOC, VIEW, null), 0);
  assert.equal(scrollTopFor(1, DOC, VIEW, null), DOC - VIEW);
  // Past either end, from a drag that left the window.
  assert.equal(scrollTopFor(-0.4, DOC, VIEW, null), 0);
  assert.equal(scrollTopFor(1.8, DOC, VIEW, null), DOC - VIEW);
});

test("a grab holds the indicator where it was taken", () => {
  // Grabbed at its own top edge, the thumb's top follows the pointer exactly —
  // rescaled, because the top can only travel the track minus the thumb. With
  // a fifth of the document visible, that travel is four fifths of the track.
  const travel = 1 - VIEW / DOC;
  assert.equal(
    Math.round(scrollTopFor(0.25, DOC, VIEW, 0)),
    Math.round((0.25 / travel) * (DOC - VIEW))
  );
});

test("a grab survives the round trip to the top edge and back", () => {
  // The property that makes a drag feel attached: scroll somewhere, work out
  // where the thumb's top now is, press there, and nothing moves.
  const travel = 1 - VIEW / DOC;
  const before = 1800;
  const thumbTopFraction = (before / (DOC - VIEW)) * travel;
  assert.equal(Math.round(scrollTopFor(thumbTopFraction, DOC, VIEW, 0)), before);
});

test("grabbing the middle of the thumb is the same as no grab", () => {
  // Half the visible fraction is the thumb's own midpoint, which is where a
  // centring press puts it — so the two agree, and a press never lurches.
  const visible = VIEW / DOC;
  assert.equal(
    scrollTopFor(0.5, DOC, VIEW, visible / 2),
    scrollTopFor(0.5, DOC, VIEW, null)
  );
});

test("a document that fits has nowhere to scroll", () => {
  assert.equal(scrollTopFor(0.5, 600, 800, null), 0);
  assert.equal(scrollTopFor(1, 800, 800, null), 0);
});

process.exit(failures === 0 ? 0 : 1);
