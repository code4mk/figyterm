/**
 * Reading a data file.
 *
 * The quoting cases are the point. A column holding `{"a":1,"b":2}` has a comma
 * in it, and a reader that splits on commas turns one row into two and shifts
 * every column after it — a run that then passes against nonsense, which is the
 * worst way for this to be wrong.
 */

import assert from "node:assert/strict";
import { readCsv, readDataFile, readJsonData, splitCsvLine } from "./data";

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

console.log("api/data");

test("a plain line splits on commas", () => {
  assert.deepEqual(splitCsvLine("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(splitCsvLine("a,,c"), ["a", "", "c"]);
});

/** The case the whole reader exists for. */
test("a comma inside quotes is not a separator", () => {
  assert.deepEqual(splitCsvLine('a,"one, two",c'), ["a", "one, two", "c"]);
  assert.deepEqual(splitCsvLine('"{""a"": 1, ""b"": 2}",next'), ['{"a": 1, "b": 2}', "next"]);
});

test("a doubled quote is one quote", () => {
  assert.deepEqual(splitCsvLine('"she said ""hi"""'), ['she said "hi"']);
});

test("a header row names the columns", () => {
  const file = readCsv("name,email\nAda,ada@example.com\nGrace,grace@example.com");
  assert.deepEqual(file.columns, ["name", "email"]);
  assert.deepEqual(file.rows, [
    { name: "Ada", email: "ada@example.com" },
    { name: "Grace", email: "grace@example.com" },
  ]);
});

test("a row with fewer fields than columns is filled with blanks", () => {
  const file = readCsv("a,b,c\n1,2");
  assert.deepEqual(file.rows, [{ a: "1", b: "2", c: "" }]);
});

test("a newline inside a quoted field stays in the field", () => {
  const file = readCsv('note,id\n"line one\nline two",1');
  assert.equal(file.rows.length, 1);
  assert.equal(file.rows[0]!.note, "line one\nline two");
  assert.equal(file.rows[0]!.id, "1");
});

test("carriage returns from a Windows file do not become data", () => {
  const file = readCsv("a,b\r\n1,2\r\n");
  assert.deepEqual(file.rows, [{ a: "1", b: "2" }]);
});

test("an empty file is empty rather than an error", () => {
  const file = readCsv("");
  assert.deepEqual(file.rows, []);
  assert.equal(file.notes.length, 1);
});

// ─── JSON ────────────────────────────────────────────────────────────────────

test("a JSON list is one row per entry", () => {
  const file = readJsonData('[{"id":1,"name":"Ada"},{"id":2,"name":"Grace"}]');
  assert.deepEqual(file.columns, ["id", "name"]);
  assert.deepEqual(file.rows, [
    { id: "1", name: "Ada" },
    { id: "2", name: "Grace" },
  ]);
});

test("every value becomes text, because it is going into a template", () => {
  const file = readJsonData('[{"n":1,"ok":true,"nothing":null,"deep":{"a":1}}]');
  assert.deepEqual(file.rows[0], {
    n: "1",
    ok: "true",
    nothing: "",
    deep: '{"a":1}',
  });
});

test("JSON that is not a list says what a data file is", () => {
  const file = readJsonData('{"a":1}');
  assert.deepEqual(file.rows, []);
  assert.ok(file.notes[0]!.includes("list of objects"));
});

test("JSON that will not parse is reported rather than thrown", () => {
  const file = readJsonData("[{");
  assert.deepEqual(file.rows, []);
  assert.ok(file.notes[0]!.includes("not valid JSON"));
});

test("the kind is decided by the name, and by the contents when it has to be", () => {
  assert.equal(readDataFile('[{"a":1}]', "rows.json").rows.length, 1);
  assert.equal(readDataFile("a\n1", "rows.csv").rows.length, 1);
  // A JSON file named .txt is still JSON.
  assert.equal(readDataFile('[{"a":1}]', "rows.txt").rows[0]!.a, "1");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
