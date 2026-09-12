/**
 * The encoding trap, pinned down.
 *
 * `docs/LSP.md` asks for exactly this before any feature is built on top of the
 * conversion: a line containing `é`, `👋` and a tab, checked against every
 * encoding a server may negotiate. Everything the client renders — a squiggle,
 * a tooltip, the range a rename replaces — is placed by these two functions, and
 * when they are off by one the symptom is "hover is wrong sometimes" rather
 * than anything that points here.
 *
 * Run with `npm test`. There is no test framework in this project; see
 * `scripts/run-ts-tests.mjs` for how these run without one.
 */

import assert from "node:assert/strict";
import { offsetToPosition, positionToOffset, rangeToOffsets, __test } from "./position";
import type { PositionEncoding } from "./protocol";

const { measure, unmeasure } = __test;

/**
 * A stand-in for CodeMirror's `Text`.
 *
 * `position.ts` only ever asks a document four things, and building the real
 * thing here would mean bundling `@codemirror/state` into a test of arithmetic.
 * The shape is the contract.
 */
function doc(...lines: string[]) {
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1; // + the newline
  }
  const length = at - 1;

  const lineAt = (offset: number) => {
    let number = 1;
    for (let i = 0; i < lines.length; i++) if (starts[i] <= offset) number = i + 1;
    return line(number);
  };
  const line = (number: number) => ({
    number,
    from: starts[number - 1],
    to: starts[number - 1] + lines[number - 1].length,
    text: lines[number - 1],
  });

  return { length, lines: lines.length, lineAt, line } as never;
}

const ENCODINGS: PositionEncoding[] = ["utf-8", "utf-16", "utf-32"];

/** The line `LSP.md` names: an accented character, an astral one, and a tab. */
const TRICKY = "const é = '👋';\tok";

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

console.log("lsp/position");

test("a plain ASCII line is the same in every encoding", () => {
  const text = "const x = 1;";
  for (const encoding of ENCODINGS) {
    assert.equal(measure(text, text.length, encoding), text.length);
    assert.equal(unmeasure(text, text.length, encoding), text.length);
  }
});

test("é is one code unit, two UTF-8 bytes, one codepoint", () => {
  assert.equal(measure("é", 1, "utf-16"), 1);
  assert.equal(measure("é", 1, "utf-8"), 2);
  assert.equal(measure("é", 1, "utf-32"), 1);
});

test("👋 is two code units, four UTF-8 bytes, one codepoint", () => {
  // The astral case, and the reason `Array.from(line).length` is the wrong tool
  // for UTF-16 and the right one for UTF-32.
  assert.equal("👋".length, 2);
  assert.equal(measure("👋", 2, "utf-16"), 2);
  assert.equal(measure("👋", 2, "utf-8"), 4);
  assert.equal(measure("👋", 2, "utf-32"), 1);
});

test("a tab is one unit everywhere", () => {
  for (const encoding of ENCODINGS) assert.equal(measure("\t", 1, encoding), 1);
});

test("measuring the tricky line agrees with the platform's own encoders", () => {
  assert.equal(measure(TRICKY, TRICKY.length, "utf-16"), TRICKY.length);
  assert.equal(
    measure(TRICKY, TRICKY.length, "utf-8"),
    new TextEncoder().encode(TRICKY).length
  );
  assert.equal(measure(TRICKY, TRICKY.length, "utf-32"), Array.from(TRICKY).length);
});

test("measure and unmeasure are inverses at every code-unit boundary", () => {
  for (const encoding of ENCODINGS) {
    for (let index = 0; index <= TRICKY.length; index++) {
      // Inside a surrogate pair there is no position to round-trip to: the
      // conversion lands on the start of the character, which is correct and
      // is what every client does.
      const insideAPair =
        index > 0 && index < TRICKY.length && TRICKY.codePointAt(index - 1)! > 0xffff;
      if (insideAPair) continue;
      const units = measure(TRICKY, index, encoding);
      assert.equal(
        unmeasure(TRICKY, units, encoding),
        index,
        `${encoding} lost index ${index}`
      );
    }
  }
});

test("a position inside a surrogate pair snaps to the character, not into it", () => {
  const wave = "a👋b";
  // Three UTF-8 bytes in is the middle of the emoji. Splitting there would
  // produce a JavaScript offset between two surrogates, which is an invalid
  // string index and corrupts every edit built on it.
  const offset = unmeasure(wave, 3, "utf-8");
  assert.equal(offset, 1, "must not land between the surrogates");
});

test("offsets round-trip through positions in a multi-line document", () => {
  const document = doc("first", TRICKY, "", "last é");
  for (const encoding of ENCODINGS) {
    for (let offset = 0; offset <= (document as never as { length: number }).length; offset++) {
      const position = offsetToPosition(document, offset, encoding);
      const back = positionToOffset(document, position, encoding);
      const text = (document as never as { lineAt: (o: number) => { text: string; from: number } })
        .lineAt(offset);
      const insideAPair = text.text.codePointAt(offset - text.from - 1)! > 0xffff;
      if (insideAPair) continue;
      assert.equal(back, offset, `${encoding} lost offset ${offset}`);
    }
  }
});

test("line numbers are zero-based going out and one-based coming back", () => {
  const document = doc("one", "two");
  assert.deepEqual(offsetToPosition(document, 0, "utf-16"), { line: 0, character: 0 });
  assert.deepEqual(offsetToPosition(document, 4, "utf-16"), { line: 1, character: 0 });
  assert.equal(positionToOffset(document, { line: 1, character: 2 }, "utf-16"), 6);
});

test("a position past the end of the document is clamped, not thrown", () => {
  const document = doc("one", "two");
  // A server's copy of a document lags the editor's by an edit or two as a
  // matter of course; this is the normal case, not the exceptional one.
  assert.equal(positionToOffset(document, { line: 99, character: 99 }, "utf-16"), 7);
  assert.equal(positionToOffset(document, { line: 0, character: 99 }, "utf-16"), 3);
  assert.equal(positionToOffset(document, { line: -5, character: -5 }, "utf-16"), 0);
});

test("an offset past the end of the document is clamped", () => {
  const document = doc("one");
  assert.deepEqual(offsetToPosition(document, 999, "utf-16"), { line: 0, character: 3 });
  assert.deepEqual(offsetToPosition(document, -10, "utf-16"), { line: 0, character: 0 });
});

test("an inverted range comes back the right way round", () => {
  const document = doc("hello world");
  const range = { start: { line: 0, character: 8 }, end: { line: 0, character: 2 } };
  assert.deepEqual(rangeToOffsets(document, range, "utf-16"), { from: 2, to: 8 });
});

test("a UTF-8 server places a range correctly on the tricky line", () => {
  const document = doc(TRICKY);
  // `ok` at the end, in UTF-8 byte positions — what rust-analyzer would send.
  const bytes = new TextEncoder().encode(TRICKY).length;
  const range = {
    start: { line: 0, character: bytes - 2 },
    end: { line: 0, character: bytes },
  };
  const { from, to } = rangeToOffsets(document, range, "utf-8");
  assert.equal(TRICKY.slice(from, to), "ok");
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("  all passing");
