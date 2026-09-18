/**
 * The conflict scanner, which has to be right about ranges it will *replace*.
 *
 * Every test asserts the extracted text rather than offsets. Offsets are what
 * the code computes, so asserting them would only restate the implementation;
 * what matters is that "accept current" ends up inserting the lines a person
 * would point at — and an off-by-one at a marker boundary is how an accept
 * silently eats the line above it or leaves a `=======` behind.
 */

import assert from "node:assert/strict";
import { Text } from "@codemirror/state";
import { findConflicts } from "./mergeConflictScan";

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

/** Builds a document, and reads a range back the way the accept actions do. */
function doc(...lines: string[]) {
  const text = Text.of(lines);
  return {
    text,
    slice: (from: number, to: number) => text.sliceString(from, to),
  };
}

console.log("mergeConflictScan");

test("the common shape: two halves and their labels", () => {
  const { text, slice } = doc(
    "before",
    "<<<<<<< HEAD",
    "mine one",
    "mine two",
    "=======",
    "theirs one",
    ">>>>>>> feature/thing",
    "after"
  );

  const [conflict] = findConflicts(text);
  assert.equal(conflict.oursLabel, "HEAD");
  assert.equal(conflict.theirsLabel, "feature/thing");
  assert.equal(slice(conflict.ours.from, conflict.ours.to), "mine one\nmine two");
  assert.equal(slice(conflict.theirs.from, conflict.theirs.to), "theirs one");
  // The block covers its own markers and nothing outside them.
  assert.equal(slice(conflict.from, conflict.from + 12), "<<<<<<< HEAD");
  assert.equal(slice(conflict.to - 21, conflict.to), ">>>>>>> feature/thing");
});

test("accepting a side replaces exactly the block", () => {
  const { text, slice } = doc(
    "keep me",
    "<<<<<<< HEAD",
    "mine",
    "=======",
    "theirs",
    ">>>>>>> other",
    "keep me too"
  );

  const [conflict] = findConflicts(text);
  const before = slice(0, conflict.from);
  const after = slice(conflict.to, text.length);
  assert.equal(before, "keep me\n");
  assert.equal(after, "\nkeep me too");
});

test("an empty half is empty, not the marker line", () => {
  // Git writes this whenever one side deleted everything.
  const { text, slice } = doc("<<<<<<< HEAD", "=======", "theirs", ">>>>>>> other");
  const [conflict] = findConflicts(text);
  assert.equal(slice(conflict.ours.from, conflict.ours.to), "");
  assert.equal(slice(conflict.theirs.from, conflict.theirs.to), "theirs");
});

test("diff3 keeps the base apart from both sides", () => {
  const { text, slice } = doc(
    "<<<<<<< HEAD",
    "mine",
    "||||||| merged common ancestors",
    "original",
    "=======",
    "theirs",
    ">>>>>>> other"
  );

  const [conflict] = findConflicts(text);
  assert.equal(slice(conflict.ours.from, conflict.ours.to), "mine");
  assert.ok(conflict.base);
  assert.equal(slice(conflict.base!.from, conflict.base!.to), "original");
  assert.equal(slice(conflict.theirs.from, conflict.theirs.to), "theirs");
});

test("several conflicts in one file are all found, in order", () => {
  const { text, slice } = doc(
    "<<<<<<< HEAD",
    "a-mine",
    "=======",
    "a-theirs",
    ">>>>>>> other",
    "middle",
    "<<<<<<< HEAD",
    "b-mine",
    "=======",
    "b-theirs",
    ">>>>>>> other"
  );

  const found = findConflicts(text);
  assert.equal(found.length, 2);
  assert.equal(slice(found[0].ours.from, found[0].ours.to), "a-mine");
  assert.equal(slice(found[1].ours.from, found[1].ours.to), "b-mine");
  assert.ok(found[0].to < found[1].from);
});

test("markers only count at the start of a line", () => {
  // The case that makes a regex over the whole text wrong: text *about*
  // conflicts, which this very repository contains.
  const text = Text.of([
    "const START = /^<{7}/;",
    "// git writes <<<<<<< HEAD into the file",
    "const line = '======= not a marker';",
  ]).toString();
  assert.equal(findConflicts(Text.of(text.split("\n"))).length, 0);
});

test("an unterminated block is not a conflict", () => {
  // Half a conflict has no side to accept, and offering one would delete the
  // rest of the file.
  const text = Text.of(["<<<<<<< HEAD", "mine", "=======", "theirs"]);
  assert.equal(findConflicts(text).length, 0);
});

test("a second start abandons the first, unterminated one", () => {
  const { text, slice } = doc(
    "<<<<<<< HEAD",
    "stray",
    "<<<<<<< HEAD",
    "mine",
    "=======",
    "theirs",
    ">>>>>>> other"
  );
  const found = findConflicts(text);
  assert.equal(found.length, 1);
  assert.equal(slice(found[0].ours.from, found[0].ours.to), "mine");
});

test("a marker with no label still parses", () => {
  const { text, slice } = doc("<<<<<<<", "mine", "=======", "theirs", ">>>>>>>");
  const [conflict] = findConflicts(text);
  assert.equal(conflict.oursLabel, "");
  assert.equal(slice(conflict.ours.from, conflict.ours.to), "mine");
  assert.equal(slice(conflict.theirs.from, conflict.theirs.to), "theirs");
});

test("eight angle brackets are not a marker", () => {
  const text = Text.of(["<<<<<<<< HEAD", "mine", "=======", "theirs", ">>>>>>> other"]);
  assert.equal(findConflicts(text).length, 0);
});

test("a clean file costs nothing and finds nothing", () => {
  assert.deepEqual(findConflicts(Text.of(["one", "two", "three"])), []);
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("  all passing");
