/**
 * Reading a saved split back.
 *
 * The failure this guards against is not hypothetical in shape: a layout with
 * a zero in it renders a pane with no height, and a pane with no height has no
 * divider to grab, so the window is stuck that way until somebody deletes the
 * session. Every branch below is a way that could happen.
 */

import assert from "node:assert/strict";
import { DEFAULT_SPLIT, readLayout, readSplit } from "./layout";

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

console.log("api/layout");

test("a good layout comes back as it went in", () => {
  assert.deepEqual(readLayout({ request: 30, response: 70 }, DEFAULT_SPLIT.bottom), {
    request: 30,
    response: 70,
  });
});

test("nothing saved is the default", () => {
  assert.deepEqual(readLayout(undefined, DEFAULT_SPLIT.bottom), DEFAULT_SPLIT.bottom);
  assert.deepEqual(readLayout(null, DEFAULT_SPLIT.bottom), DEFAULT_SPLIT.bottom);
  assert.deepEqual(readLayout("46%", DEFAULT_SPLIT.right), DEFAULT_SPLIT.right);
  assert.deepEqual(readLayout([44, 56], DEFAULT_SPLIT.bottom), DEFAULT_SPLIT.bottom);
});

/** The one that would leave a pane nobody can drag back. */
test("a zero or a negative is refused rather than applied", () => {
  assert.deepEqual(readLayout({ request: 0, response: 100 }, DEFAULT_SPLIT.bottom), DEFAULT_SPLIT.bottom);
  assert.deepEqual(readLayout({ request: -10, response: 110 }, DEFAULT_SPLIT.bottom), DEFAULT_SPLIT.bottom);
});

test("a NaN or an infinity is refused", () => {
  assert.deepEqual(readLayout({ request: NaN, response: 56 }, DEFAULT_SPLIT.bottom), DEFAULT_SPLIT.bottom);
  assert.deepEqual(
    readLayout({ request: Infinity, response: 56 }, DEFAULT_SPLIT.bottom),
    DEFAULT_SPLIT.bottom
  );
});

test("a value that is not a number at all is refused", () => {
  assert.deepEqual(
    readLayout({ request: "44", response: 56 }, DEFAULT_SPLIT.bottom),
    DEFAULT_SPLIT.bottom
  );
});

/** All or nothing: half a saved layout is a shape neither side chose. */
test("a missing panel discards the whole layout, not just its own key", () => {
  assert.deepEqual(readLayout({ request: 30 }, DEFAULT_SPLIT.bottom), DEFAULT_SPLIT.bottom);
});

test("a panel this build does not have is dropped", () => {
  assert.deepEqual(
    readLayout({ request: 30, response: 70, console: 20 }, DEFAULT_SPLIT.bottom),
    { request: 30, response: 70 }
  );
});

test("the layout name is validated, not cast", () => {
  assert.equal(readSplit("right"), "right");
  assert.equal(readSplit("bottom"), "bottom");
  assert.equal(readSplit(undefined), "bottom");
  assert.equal(readSplit("sideways"), "bottom");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
