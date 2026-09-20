/**
 * The console's buffer and its filter.
 *
 * Two things can go wrong here and both are quiet. A buffer that grows without
 * bound is a leak that takes a day of a window being open to show up. A filter
 * that hides everything looks exactly like a console that stopped working.
 */

import assert from "node:assert/strict";
import {
  append,
  clockOf,
  CONSOLE_LIMIT,
  ConsoleEntry,
  formatAll,
  formatLine,
  matches,
  summarise,
} from "./console";

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

/** Builds a log of `count` lines through the same path the store uses. */
function log(count: number, limit = CONSOLE_LIMIT): ConsoleEntry[] {
  let entries: ConsoleEntry[] = [];
  for (let index = 0; index < count; index++) {
    entries = append(
      entries,
      { level: "info", source: "request", text: `line ${index}` },
      index,
      1000 + index,
      limit
    );
  }
  return entries;
}

console.log("api/console");

test("a line goes on the end, with the id and time it was given", () => {
  const entries = append([], { level: "warn", source: "sync", text: "hello" }, 7, 1234);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: 7,
    at: 1234,
    level: "warn",
    source: "sync",
    text: "hello",
  });
});

test("the oldest line goes when the buffer is full", () => {
  const entries = log(5, 3);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ["line 2", "line 3", "line 4"]
  );
});

/** The leak this exists to prevent. */
test("a long session never exceeds the limit", () => {
  const entries = log(5000, 500);
  assert.equal(entries.length, 500);
  assert.equal(entries[entries.length - 1]!.text, "line 4999");
});

test("a limit of zero keeps nothing rather than keeping one", () => {
  assert.deepEqual(log(10, 0), []);
});

test("appending does not mutate what it was given", () => {
  const before = log(2);
  const after = append(before, { level: "info", source: "script", text: "new" }, 99, 1);
  assert.equal(before.length, 2);
  assert.equal(after.length, 3);
});

// ─── The filter ──────────────────────────────────────────────────────────────

const entry: ConsoleEntry = {
  id: 1,
  at: 0,
  level: "error",
  source: "script",
  text: "The test failed",
  detail: "expected 200, got 404",
};

test("no levels chosen shows everything, rather than nothing", () => {
  assert.equal(matches(entry, { levels: new Set(), query: "" }), true);
});

test("a chosen level hides the others", () => {
  assert.equal(matches(entry, { levels: new Set(["error"] as const), query: "" }), true);
  assert.equal(matches(entry, { levels: new Set(["info"] as const), query: "" }), false);
});

test("the query reads the detail and the source too, not only the text", () => {
  const all = { levels: new Set<never>(), query: "" };
  assert.equal(matches(entry, { ...all, query: "failed" }), true);
  assert.equal(matches(entry, { ...all, query: "404" }), true, "the detail counts");
  assert.equal(matches(entry, { ...all, query: "script" }), true, "the source counts");
  assert.equal(matches(entry, { ...all, query: "nowhere" }), false);
});

test("the query ignores case and surrounding space", () => {
  assert.equal(matches(entry, { levels: new Set(), query: "  FAILED " }), true);
});

test("a line with no detail is not matched by a query that only the detail would answer", () => {
  const bare = { ...entry, detail: undefined };
  assert.equal(matches(bare, { levels: new Set(), query: "404" }), false);
});

// ─── What the collapsed bar says ─────────────────────────────────────────────

test("the summary counts what needs attention and nothing else", () => {
  const entries: ConsoleEntry[] = [
    { id: 1, at: 0, level: "info", source: "request", text: "a" },
    { id: 2, at: 0, level: "warn", source: "request", text: "b" },
    { id: 3, at: 0, level: "error", source: "script", text: "c" },
    { id: 4, at: 0, level: "error", source: "sync", text: "d" },
  ];
  assert.deepEqual(summarise(entries), { errors: 2, warnings: 1 });
  assert.deepEqual(summarise([]), { errors: 0, warnings: 0 });
});

// ─── Copying ─────────────────────────────────────────────────────────────────

test("the clock is padded, so the column does not jitter", () => {
  // Built from local parts, because the formatter reads local time and the
  // machine running this is not necessarily on UTC.
  const at = new Date(2026, 0, 2, 9, 5, 3).getTime();
  assert.equal(clockOf(at), "09:05:03");
});

/** A copied line that spans two is one that gets quoted as one and pasted as
 * two. The detail stays on the same line. */
test("a copied line is one line", () => {
  assert.ok(!formatLine(entry).includes("\n"));
  assert.ok(formatLine(entry).includes("The test failed"));
  assert.ok(formatLine(entry).includes("expected 200, got 404"));
});

test("copying the log gives one line per entry", () => {
  assert.equal(formatAll(log(3)).split("\n").length, 3);
  assert.equal(formatAll([]), "");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
