/**
 * The arithmetic the whole tree's order rests on.
 *
 * Two properties matter and neither is obvious from reading the code: a key is
 * always strictly between its neighbours, and the gap never runs out however
 * many times it is subdivided. Both are checked by brute force below, because
 * the failure mode — a rank equal to its neighbour — is silent until two rows
 * swap places on someone else's machine.
 */

import assert from "node:assert/strict";
import { between, byRank, rankAfter, rankAt } from "./rank";

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

console.log("api/rank");

test("the first key in an empty list is in the middle of the range", () => {
  const first = between(null, null);
  assert.ok(first > "0" && first < "z", first);
});

test("appending always sorts after", () => {
  let last = between(null, null);
  for (let i = 0; i < 200; i++) {
    const next = between(last, null);
    assert.ok(next > last, `${next} should be after ${last}`);
    last = next;
  }
});

test("prepending always sorts before", () => {
  let first = between(null, null);
  for (let i = 0; i < 200; i++) {
    const next = between(null, first);
    assert.ok(next < first, `${next} should be before ${first}`);
    first = next;
  }
});

test("a key lands strictly between its neighbours", () => {
  const a = between(null, null);
  const b = between(a, null);
  const mid = between(a, b);
  assert.ok(a < mid && mid < b, `${a} < ${mid} < ${b}`);
});

/**
 * The property that makes this worth having: subdividing the same gap over and
 * over must keep working. With integer positions this is the case that forces a
 * renumber; here it only makes the key longer.
 */
test("the same gap can be subdivided two hundred times", () => {
  let low = between(null, null);
  const high = between(low, null);
  for (let i = 0; i < 200; i++) {
    const mid = between(low, high);
    assert.ok(low < mid && mid < high, `round ${i}: ${low} < ${mid} < ${high}`);
    low = mid;
  }
});

test("adjacent leading digits still leave room", () => {
  // 'A' and 'B' are neighbours in the alphabet: the answer has to grow a digit.
  const mid = between("A", "B");
  assert.ok("A" < mid && mid < "B", `A < ${mid} < B`);
});

test("no key ends in the first digit, which would leave nothing below it", () => {
  const keys = [between(null, null)];
  for (let i = 0; i < 100; i++) keys.push(between(keys[keys.length - 1]!, null));
  for (let i = 0; i < 100; i++) keys.push(between(null, keys[0]!));
  let low = "A";
  for (let i = 0; i < 100; i++) {
    low = between(low, "B");
    keys.push(low);
  }
  for (const key of keys) {
    assert.ok(!key.endsWith("0"), `${key} ends in the smallest digit`);
    assert.notEqual(key, "", "a key is never empty");
  }
});

test("out-of-order neighbours are a caller bug, not a silent fudge", () => {
  assert.throws(() => between("B", "A"));
  assert.throws(() => between("A", "A"));
});

test("rankAfter puts a row at the end", () => {
  const siblings = [{ rank: "A" }, { rank: "B" }, { rank: "C" }];
  const rank = rankAfter(siblings);
  assert.ok(rank > "C");
  assert.equal(rankAfter([]) > "", true);
});

test("rankAt lands where the drop did", () => {
  const siblings = [{ rank: "A" }, { rank: "C" }, { rank: "E" }];
  assert.ok(rankAt(siblings, 0) < "A");
  const middle = rankAt(siblings, 1);
  assert.ok(middle > "A" && middle < "C", middle);
  assert.ok(rankAt(siblings, 3) > "E");
  // Past the end, and before the beginning, clamp rather than throw: a drop
  // handler should not have to bounds-check the index it computed.
  assert.ok(rankAt(siblings, 99) > "E");
  assert.ok(rankAt(siblings, -5) < "A");
});

test("byRank sorts by rank and falls back to the name", () => {
  const rows = [
    { rank: "B", name: "second" },
    { rank: "A", name: "first" },
    { rank: "A", name: "also first" },
  ];
  const sorted = [...rows].sort(byRank).map((row) => row.name);
  assert.deepEqual(sorted, ["also first", "first", "second"]);
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
