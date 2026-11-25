/**
 * The diff the transcript shows for an edit.
 *
 * Worth testing because the failure is quiet: a diff that marks the wrong
 * lines still looks like a diff, and the reader believes it. Every case
 * here is one where the crude answer — everything removed, everything
 * added — would also have rendered, and would also have been wrong.
 */

import assert from "node:assert/strict";
import { addedLines, lineDiff } from "./figycode-diff";

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

console.log("figycode-diff");

/** `"34 - let a = 1;"` per row, for readable assertions. */
function shown(rows: ReturnType<typeof lineDiff>): string[] {
  return rows.map((row) => `${row.no ?? ""}${row.sign === " " ? " " : row.sign}${row.text}`);
}

test("one changed line in a block is one removal and one addition", () => {
  // The whole point. The crude version renders six rows for this.
  const rows = lineDiff(
    "fn main() {\n    let a = 1;\n}\n",
    "fn main() {\n    let a = 2;\n}\n",
    10
  );
  assert.deepEqual(shown(rows), [
    "10 fn main() {",
    "11-    let a = 1;",
    "11+    let a = 2;",
    "12 }",
  ]);
});

test("removals come before the additions that replace them", () => {
  const rows = lineDiff("a\nb\n", "x\ny\n", 1);
  assert.deepEqual(
    rows.map((r) => r.sign),
    ["-", "-", "+", "+"]
  );
});

test("line numbers follow the file as it now stands", () => {
  // Except removals, which carry the number they had — there is one
  // column, and "where is this now" is what a transcript is read for.
  const rows = lineDiff("keep\ngone\nkeep2\n", "keep\nkeep2\n", 100);
  assert.deepEqual(shown(rows), ["100 keep", "101-gone", "101 keep2"]);
});

test("an insertion is additions alone", () => {
  const rows = lineDiff("a\nc\n", "a\nb\nc\n", 1);
  assert.deepEqual(shown(rows), ["1 a", "2+b", "3 c"]);
});

test("a deletion is removals alone", () => {
  const rows = lineDiff("a\nb\nc\n", "a\nc\n", 1);
  assert.deepEqual(shown(rows), ["1 a", "2-b", "2 c"]);
});

test("long runs of unchanged lines are elided", () => {
  const before = ["x", ...Array.from({ length: 30 }, (_, i) => `line ${i}`), "y"].join("\n");
  const after = ["X", ...Array.from({ length: 30 }, (_, i) => `line ${i}`), "Y"].join("\n");
  const rows = lineDiff(before, after, 1);

  // Two changes, two lines of context each side, one gap between them.
  assert.equal(rows.filter((r) => r.sign === "…").length, 1);
  assert.ok(rows.length < 14, `expected a short diff, got ${rows.length} rows`);
  assert.ok(shown(rows).some((line) => line.includes("-x")));
  assert.ok(shown(rows).some((line) => line.includes("+Y")));
});

test("a change with no unchanged lines around it has no gap", () => {
  const rows = lineDiff("a\n", "b\n", 1);
  assert.ok(!rows.some((r) => r.sign === "…"));
});

test("an enormous replacement falls back rather than freezing", () => {
  // 5,000 lines either side is twenty-five million table cells.
  const before = Array.from({ length: 900 }, (_, i) => `a${i}`).join("\n");
  const after = Array.from({ length: 900 }, (_, i) => `b${i}`).join("\n");
  const started = Date.now();
  const rows = lineDiff(before, after, 1);
  assert.ok(Date.now() - started < 1000, "it should give up, not grind");
  assert.equal(rows.length, 1800);
});

test("a trailing newline is not a blank last line", () => {
  assert.equal(lineDiff("", "a\n", 1).length, 1);
  assert.deepEqual(addedLines("one\ntwo\n", 1).map((r) => r.text), ["one", "two"]);
});

test("empty either side still produces the other", () => {
  assert.deepEqual(shown(lineDiff("", "new\n", 5)), ["5+new"]);
  assert.deepEqual(shown(lineDiff("old\n", "", 5)), ["5-old"]);
  assert.deepEqual(lineDiff("", "", 1), []);
});

test("a new file is all additions, numbered from one", () => {
  assert.deepEqual(shown(addedLines("a\nb\n")), ["1+a", "2+b"]);
});

process.exit(failures ? 1 : 0);
