/**
 * The query string as a table, and back.
 *
 * Two properties carry the whole design. **Round trip**: a URL read into rows
 * and written back is the URL it started as, or the table silently edits every
 * request it is merely looked at. **Stability**: syncing on a keystroke keeps
 * the row ids, or the cell being typed in loses focus on every character.
 */

import assert from "node:assert/strict";
import { activeCount, paramsOf, QueryRow, syncParams, withParams } from "./params";
import { resolveText, Scope } from "./template";

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

/** Predictable ids, so a test can say which row it means. */
function ids() {
  let next = 0;
  return () => `p${next++}`;
}

const read = (url: string) => paramsOf(url, ids());
const pairs = (rows: QueryRow[]) => rows.map((row) => [row.key, row.value, row.enabled]);

console.log("api/params");

test("a query becomes rows, in order", () => {
  assert.deepEqual(pairs(read("https://x.com/a?page=1&size=20")), [
    ["page", "1", true],
    ["size", "20", true],
  ]);
});

test("a URL with no query has no rows", () => {
  assert.deepEqual(read("https://x.com/a"), []);
  assert.deepEqual(read(""), []);
  assert.deepEqual(read("https://x.com/a?"), []);
});

/** A bare `?flag` is not the same as `?flag=` — some servers care, and
 * round-tripping it wrong changes the request. */
test("a flag with no equals keeps that shape", () => {
  const [row] = read("https://x.com?verbose");
  assert.equal(row!.key, "verbose");
  assert.equal(row!.value, "");
  assert.equal(row!.bare, true);
  assert.equal(withParams("https://x.com?verbose", read("https://x.com?verbose")), "https://x.com?verbose");
});

test("an empty value is kept as an empty value", () => {
  assert.equal(withParams("https://x.com?q=", read("https://x.com?q=")), "https://x.com?q=");
});

test("a value containing an equals is not split twice", () => {
  const [row] = read("https://x.com?filter=a=b");
  assert.equal(row!.key, "filter");
  assert.equal(row!.value, "a=b");
});

/** The whole reason the splits are template-aware. */
test("an ampersand inside a variable does not start a new parameter", () => {
  const rows = read("https://x.com?q={{a&b}}&page=1");
  assert.deepEqual(pairs(rows), [
    ["q", "{{a&b}}", true],
    ["page", "1", true],
  ]);
});

test("a question mark inside a variable is not the start of the query", () => {
  assert.deepEqual(read("{{base_url}}/users"), []);
  assert.deepEqual(pairs(read("{{base_url}}/users?page=1")), [["page", "1", true]]);
});

// ─── Writing back ────────────────────────────────────────────────────────────

test("a URL read and written back is unchanged", () => {
  for (const url of [
    "https://x.com/a?page=1&size=20",
    "https://x.com/a",
    "{{base_url}}/users?key={{api_key}}",
    "https://x.com/a?q=a=b&verbose",
    "https://x.com/a?page=1#section",
  ]) {
    assert.equal(withParams(url, read(url)), url, url);
  }
});

test("the question mark goes when the last parameter does", () => {
  assert.equal(withParams("https://x.com/a?page=1", []), "https://x.com/a");
});

test("a fragment survives having the query rewritten", () => {
  const url = "https://x.com/a?page=1#top";
  const rows = read(url);
  rows[0]!.value = "2";
  assert.equal(withParams(url, rows), "https://x.com/a?page=2#top");
});

test("an unticked row is not sent, and a nameless one is not either", () => {
  const rows: QueryRow[] = [
    { id: "a", key: "page", value: "1", enabled: true },
    { id: "b", key: "debug", value: "1", enabled: false },
    { id: "c", key: "", value: "typing", enabled: true },
  ];
  assert.equal(withParams("https://x.com", rows), "https://x.com?page=1");
  assert.equal(activeCount(rows), 1);
});

// ─── Syncing while typing ────────────────────────────────────────────────────

/** Rebuilding the rows on every keystroke would hand React a new id per row
 * per character, and the cell being typed in would lose focus. */
test("an unchanged URL gives back the very same rows", () => {
  const rows = read("https://x.com?page=1&size=20");
  assert.equal(syncParams("https://x.com?page=1&size=20", rows, ids()), rows);
});

test("editing a value in the URL keeps the row's id", () => {
  const rows = read("https://x.com?page=1");
  const next = syncParams("https://x.com?page=12", rows, ids());
  assert.equal(next[0]!.id, rows[0]!.id, "same row, new value");
  assert.equal(next[0]!.value, "12");
});

test("a parameter added in the URL bar appears in the table", () => {
  const rows = read("https://x.com?page=1");
  const next = syncParams("https://x.com?page=1&size=20", rows, ids());
  assert.deepEqual(pairs(next), [
    ["page", "1", true],
    ["size", "20", true],
  ]);
});

test("a parameter removed from the URL bar leaves the table", () => {
  const rows = read("https://x.com?page=1&size=20");
  assert.deepEqual(pairs(syncParams("https://x.com?size=20", rows, ids())), [["size", "20", true]]);
});

/** Unticked rows are not in the URL — that is what unticking means — so a sync
 * has to put them back rather than read them as deletions. */
test("an unticked row survives a URL the table cannot see it in", () => {
  const rows: QueryRow[] = [
    { id: "a", key: "page", value: "1", enabled: true },
    { id: "b", key: "debug", value: "1", enabled: false },
  ];
  const next = syncParams("https://x.com?page=2", rows, ids());
  assert.deepEqual(pairs(next), [
    ["page", "2", true],
    ["debug", "1", false],
  ]);
});

test("an unticked row keeps its place in the middle of the list", () => {
  const rows: QueryRow[] = [
    { id: "a", key: "one", value: "1", enabled: true },
    { id: "b", key: "off", value: "x", enabled: false },
    { id: "c", key: "two", value: "2", enabled: true },
  ];
  const next = syncParams("https://x.com?one=1&two=2", rows, ids());
  assert.deepEqual(
    next.map((row) => row.key),
    ["one", "off", "two"]
  );
});

test("clearing the URL's query leaves only what was unticked", () => {
  const rows: QueryRow[] = [
    { id: "a", key: "page", value: "1", enabled: true },
    { id: "b", key: "debug", value: "1", enabled: false },
  ];
  assert.deepEqual(pairs(syncParams("https://x.com", rows, ids())), [["debug", "1", false]]);
});

test("a name that is not Latin survives both directions", () => {
  const url = "https://x.com?নাম=মান";
  assert.deepEqual(pairs(read(url)), [["নাম", "মান", true]]);
  assert.equal(withParams(url, read(url)), url);
});

// ─── Variables ───────────────────────────────────────────────────────────────
//
// A parameter's value needs no resolution of its own: the table writes into the
// URL, and the URL is resolved. That is a consequence of keeping one copy of
// the query rather than two, and it is worth pinning — if the table ever grows
// its own list of values, these fail, which is exactly the warning wanted.

const KEYED: Scope[] = [
  { label: "Env", variables: [{ key: "api_key", value: "K-99", enabled: true }] },
];

test("a templated value goes into the URL, where resolution finds it", () => {
  const rows = read("https://x.com/v1?page=1");
  rows.push({ id: "k", key: "key", value: "{{api_key}}", enabled: true });

  const url = withParams("https://x.com/v1?page=1", rows);
  assert.equal(url, "https://x.com/v1?page=1&key={{api_key}}");
  assert.equal(resolveText(url, KEYED).text, "https://x.com/v1?page=1&key=K-99");
});

/** Without this the braces would reach the server, which is what happened to
 * form bodies before `resolveBody` existed. */
test("a value nothing defines stops the send rather than being sent", () => {
  const url = withParams("https://x.com", [
    { id: "k", key: "key", value: "{{nope}}", enabled: true },
  ]);
  assert.deepEqual(resolveText(url, KEYED).unresolved, ["nope"]);
});

test("a templated key resolves too", () => {
  const url = withParams("https://x.com", [
    { id: "k", key: "{{api_key}}", value: "1", enabled: true },
  ]);
  assert.equal(resolveText(url, KEYED).text, "https://x.com?K-99=1");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
