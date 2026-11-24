/**
 * The small pure things the Figy Code window is built from.
 *
 * Mostly this file is here for `typedNumber`, which looks like it does
 * not need a test and is the reason every price in the settings dialog
 * was impossible to enter: a field that parses what you typed on every
 * keystroke eats the decimal point, and nothing about reading the code
 * says so. Typing `0.10` one character at a time is the test.
 */

import assert from "node:assert/strict";
import {
  formatCost,
  formatTokens,
  mentionAt,
  toLatinDigits,
  todosFromText,
  typedNumber,
} from "./figycode-blocks";

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

console.log("figycode-blocks");

/* ─── Typing a number ──────────────────────────────────────────────────────── */

/** Types a string one character at a time, as a person does. */
function type(characters: string): { text: string; value: number | undefined } {
  let text = "";
  let value: number | undefined;
  for (const character of characters) {
    const next = typedNumber(text + character);
    if (!next) continue; // refused: the box does not change
    text = next.text;
    value = next.value;
  }
  return { text, value };
}

test("a fractional price can be typed one character at a time", () => {
  // The bug: `0.` parsed to `0`, re-rendered as "0", and ate the point.
  // Every price anybody would actually enter is a fraction.
  assert.deepEqual(type("0.10"), { text: "0.10", value: 0.1 });
  assert.deepEqual(type("3"), { text: "3", value: 3 });
  assert.deepEqual(type("0.075"), { text: "0.075", value: 0.075 });
  assert.deepEqual(type("15.5"), { text: "15.5", value: 15.5 });
});

test("a number half typed keeps its text, whatever it parses to", () => {
  // `0.` really is zero for one keystroke, and that was never the bug.
  // The bug was the box being redrawn from the number instead of from
  // what was typed, which is what lost the point.
  assert.deepEqual(typedNumber("0."), { text: "0.", value: 0 });
  assert.deepEqual(typedNumber("."), { text: ".", value: undefined });
  assert.deepEqual(typedNumber(""), { text: "", value: undefined });
});

test("clearing the box means unset rather than zero", () => {
  // A context window of 0 and a context window nobody has set are
  // different things: one divides by zero, the other says so.
  assert.equal(typedNumber("").value, undefined);
  assert.equal(typedNumber("0").value, 0);
});

test("a keystroke that cannot be part of a number is refused", () => {
  // Rather than `Number("3x") || 0`, which turned a typo into a price
  // of nothing and said so nowhere.
  assert.equal(typedNumber("3x"), null);
  assert.equal(typedNumber("-1"), null);
  assert.equal(typedNumber("1.2.3"), null);
  assert.deepEqual(type("3x5"), { text: "35", value: 35 }, "the letter changes nothing");
});

test("a comma is a decimal point, because half the world types one", () => {
  assert.deepEqual(typedNumber("0,6"), { text: "0,6", value: 0.6 });
});

test("Bengali digits are numbers", () => {
  // The number row of a Bangla InScript layout produces these, and
  // `Number("০.৬")` is NaN — so the price would silently unset itself.
  assert.equal(toLatinDigits("০.৬"), "0.6");
  assert.deepEqual(typedNumber("০.৬"), { text: "0.6", value: 0.6 });
  assert.equal(typedNumber("২০০০০০").value, 200000);
});

/* ─── Formatting ───────────────────────────────────────────────────────────── */

test("a cost under a cent keeps the digits that say something", () => {
  // Early in a session the interesting number is tenths of a cent, and
  // `$0.00` says nothing at all.
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.0042), "$0.0042");
  assert.equal(formatCost(1.374), "$1.37");
});

test("tokens read as tokens", () => {
  assert.equal(formatTokens(940), "940");
  assert.equal(formatTokens(2100), "2.1k");
  assert.equal(formatTokens(31000), "31k");
});

/* ─── Mentions ─────────────────────────────────────────────────────────────── */

test("an @ only opens a mention at the start of a word", () => {
  assert.deepEqual(mentionAt("look at @src/ma", 15), { query: "src/ma", start: 8 });
  assert.equal(mentionAt("mail@example.com", 16), null);
  assert.equal(mentionAt("@file and then", 14), null, "a mention ends at whitespace");
});

/* ─── The plan, read back out of its own text ──────────────────────────────── */

test("a todo list survives the round trip through the model's copy", () => {
  // `detail` is not stored, so a resumed conversation recovers the plan
  // from the text the model reads. The glyphs are the contract.
  assert.deepEqual(todosFromText("1 of 2 done\n✓ find it\n▸ fix it"), [
    { text: "find it", status: "done" },
    { text: "fix it", status: "running" },
  ]);
  assert.deepEqual(todosFromText("nothing here"), []);
});

process.exit(failures ? 1 : 0);
