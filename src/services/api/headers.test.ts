/**
 * Which header names get suggested, and in what order.
 *
 * The ordering is the part that matters. Somebody typing `con` means
 * `Content-Type`; an alphabetical list puts `X-Correlation-Id` above it, and a
 * suggestion list whose first entry is never the right one is one people stop
 * reading.
 */

import assert from "node:assert/strict";
import { HEADER_SUGGESTIONS, suggestHeaders } from "./headers";

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

const names = (typed: string) => suggestHeaders(typed).map((entry) => entry.name);

console.log("api/headers");

test("nothing typed offers everything", () => {
  assert.equal(suggestHeaders("").length, HEADER_SUGGESTIONS.length);
  assert.equal(suggestHeaders("   ").length, HEADER_SUGGESTIONS.length);
});

/** The case the ordering exists for: somebody typing `id` means
 * `Idempotency-Key`, and an alphabetical list would put `X-Request-Id` on
 * top — a first suggestion that is never the right one is one people stop
 * reading. */
test("a prefix match comes before a match in the middle", () => {
  const found = names("id");
  assert.equal(found[0], "Idempotency-Key", "not one of the X-…-Id headers");
  assert.ok(found.includes("X-Request-Id"), "which is still offered");
  assert.ok(found.indexOf("Idempotency-Key") < found.indexOf("X-Request-Id"));
});

test("a prefix narrows to the family it names", () => {
  assert.deepEqual(names("content-"), ["Content-Type", "Content-Length"]);
});

test("matching ignores case, because header names do", () => {
  assert.deepEqual(names("CONTENT-T"), names("content-t"));
  assert.ok(names("AUTHOR").includes("Authorization"));
});

test("a name nothing matches offers nothing, rather than everything", () => {
  assert.deepEqual(names("zzzz"), []);
});

test("every entry is canonically cased and explained", () => {
  for (const entry of HEADER_SUGGESTIONS) {
    assert.ok(entry.hint.length > 0, `${entry.name} says what it is for`);
    assert.equal(
      entry.name,
      entry.name
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("-"),
      `${entry.name} is canonically cased`
    );
  }
});

test("no name is listed twice", () => {
  const seen = new Set(HEADER_SUGGESTIONS.map((entry) => entry.name.toLowerCase()));
  assert.equal(seen.size, HEADER_SUGGESTIONS.length);
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
