/**
 * The assertion dialect collection scripts are written in.
 *
 * The case worth being careful about is negation: `expect(1).to.not.equal(2)`
 * must pass and `expect(1).to.not.equal(1)` must fail, and an implementation
 * that gets one of those backwards turns a suite green that should be red —
 * which is the worst possible failure for a testing feature.
 */

import assert from "node:assert/strict";
import { AssertionError, deepEqual, expect, show, typeOf } from "./assert";

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

/** Asserts that an expectation fails, and gives back its message. */
function fails(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AssertionError) return error.message;
    throw error;
  }
  throw new Error("that should have failed");
}

console.log("api/assert");

test("the connecting words all lead back to the same expectation", () => {
  expect(1).to.be.a("number");
  expect("x").to.be.that.is.a("string");
  expect([1]).to.have.length(1).and.to.be.an("array");
});

test("equal is strict, eql is deep", () => {
  expect(1).to.equal(1);
  expect({ a: 1 }).to.eql({ a: 1 });
  expect({ a: 1 }).to.deep.equal({ a: 1 });
  fails(() => expect({ a: 1 }).to.equal({ a: 1 }));
  fails(() => expect({ a: 1 }).to.eql({ a: 2 }));
});

/** The one that must not be backwards. */
test("negation inverts exactly once", () => {
  expect(1).to.not.equal(2);
  expect("x").to.not.be.a("number");
  expect([1, 2]).to.not.include(3);

  const message = fails(() => expect(1).to.not.equal(1));
  assert.ok(message.includes("not to equal"), message);
});

test("types include the two JavaScript lies", () => {
  assert.equal(typeOf(null), "null");
  assert.equal(typeOf([]), "array");
  assert.equal(typeOf("x"), "string");
  expect(null).to.be.a("null");
  expect([]).to.be.an("array");
});

test("the boolean words", () => {
  expect(true).to.be.true;
  expect(false).to.be.false;
  expect(null).to.be.null;
  expect(undefined).to.be.undefined;
  expect(1).to.be.ok;
  expect([]).to.be.empty;
  expect("").to.be.empty;
  expect({}).to.be.empty;
  fails(() => expect(0).to.be.ok);
  fails(() => expect([1]).to.be.empty);
});

test("property checks the name, then the value, then keeps going", () => {
  const body = { id: "abc", nested: { deep: 1 } };
  expect(body).to.have.property("id");
  expect(body).to.have.property("id", "abc");
  expect(body).to.have.property("id").that.is.a("string");
  expect(body).to.have.deep.property("nested", { deep: 1 });

  const message = fails(() => expect(body).to.have.property("id", "xyz"));
  assert.ok(message.includes("abc"), "the message says what was actually there");
  fails(() => expect(body).to.have.property("missing"));
});

test("length, include and match", () => {
  expect([1, 2, 3]).to.have.length(3);
  expect([1, 2, 3]).to.have.lengthOf(3);
  expect("hello").to.include("ell");
  expect([{ a: 1 }]).to.include({ a: 1 });
  expect("2026-01-20").to.match(/^\d{4}-\d{2}-\d{2}$/);
  fails(() => expect([1]).to.have.length(2));
});

test("the numeric comparisons", () => {
  expect(5).to.be.above(4);
  expect(5).to.be.below(6);
  expect(5).to.be.least(5);
  expect(5).to.be.most(5);
  expect(200).to.be.oneOf([200, 201]);
  fails(() => expect(5).to.be.above(5));
  fails(() => expect(404).to.be.oneOf([200, 201]));
});

test("a failure says what was expected and what was there", () => {
  const message = fails(() => expect("actual").to.equal("wanted"));
  assert.ok(message.includes('"actual"'), message);
  assert.ok(message.includes('"wanted"'), message);
});

test("a long value is cut short rather than filling the panel", () => {
  const long = show({ text: "x".repeat(500) });
  assert.ok(long.length < 130, `${long.length} characters`);
  assert.ok(long.endsWith("…"));
});

/*
  `lengthOf` used to be a plain method, which made the commonest length idiom
  in the wild a TypeError rather than an assertion: `.lengthOf` was a function,
  a function has no `.at`, and `.least` on undefined threw. It took the whole
  script down with it, so a collection's first failing token check reported as
  "the script did not finish" rather than as a red test.
*/
test("lengthOf works as a call and as a chain", () => {
  expect([1, 2, 3]).to.have.lengthOf(3);
  expect("abc").to.have.lengthOf.at.least(1);
  expect("abc").to.have.lengthOf.at.most(5);
  expect([1, 2]).to.have.lengthOf.above(1);
  expect([1, 2]).to.have.lengthOf.below(3);
  expect("abcd").to.have.length.of.at.least(4);
  expect([1, 2, 3]).to.have.lengthOf.within(2, 4);
});

test("a chained length assertion is about the length, not the value", () => {
  // The distinction the proxy exists for: `Number("abc")` is NaN, so a matcher
  // reading the value rather than its length would fail this silently.
  expect("abc").to.have.lengthOf.at.least(1);
  const message = fails(() => expect("ab").to.have.lengthOf.at.least(5));
  assert.ok(message.includes("length"), message);
  assert.ok(message.includes("2"), message);
});

test("the token check from a real collection passes", () => {
  expect("eyJhbGciOiJIUzI1NiJ9.e30.sig").to.be.a("string").and.to.have.lengthOf.at.least(1);
  fails(() => expect("").to.be.a("string").and.to.have.lengthOf.at.least(1));
});

test("negation carries onto the length", () => {
  expect([1, 2]).to.not.have.lengthOf(3);
  fails(() => expect([1, 2]).to.not.have.lengthOf(2));
});

test("deep equality across the shapes that matter", () => {
  assert.equal(deepEqual([1, [2, 3]], [1, [2, 3]]), true);
  assert.equal(deepEqual({ a: { b: 1 } }, { a: { b: 1 } }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual(null, undefined), false);
  assert.equal(deepEqual(NaN, NaN), true, "Object.is, so a NaN matches itself");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
