/**
 * Paths in, URIs out — and the Windows shapes, which are where this goes wrong.
 *
 * `pathToUri` runs on every `didOpen`, so a wrong answer here is not a subtle
 * degradation: the server opens a different file, or none, and every feature
 * reports nothing for reasons that look like ours.
 */

import assert from "node:assert/strict";
import { pathToUri, uriToPath } from "./uri";

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

console.log("lsp/uri");

test("a POSIX path round-trips", () => {
  assert.equal(pathToUri("/Users/me/a.ts"), "file:///Users/me/a.ts");
  assert.equal(uriToPath("file:///Users/me/a.ts"), "/Users/me/a.ts");
});

test("a Windows drive letter gets three slashes", () => {
  // Two would make the drive an authority — a host called "C:".
  assert.equal(pathToUri("C:\\src\\a.ts"), "file:///C:/src/a.ts");
});

test("the drive letter is uppercased", () => {
  // Servers compare URIs as strings, so `c:` from us against `C:` from them is
  // two different documents.
  assert.equal(pathToUri("c:/src/a.ts"), "file:///C:/src/a.ts");
  assert.equal(pathToUri("c:\\src\\a.ts"), pathToUri("C:/src/a.ts"));
});

test("spaces and other reserved characters encode", () => {
  assert.equal(pathToUri("C:\\My Code\\a.ts"), "file:///C:/My%20Code/a.ts");
  assert.equal(pathToUri("/tmp/a b#c.ts"), "file:///tmp/a%20b%23c.ts");
});

test("characters that are legal are left readable", () => {
  // `encodeURIComponent` escapes these, and a URI full of %40 in a log is
  // harder to read for no benefit.
  assert.equal(pathToUri("/src/@scope/a.ts"), "file:///src/@scope/a.ts");
});

test("a UNC path keeps the server as the authority — two slashes, not four", () => {
  /*
    The bug this pins. `\\server\share\a.ts` was becoming
    `file:////server/share/a.ts`, which names an empty host and a path starting
    `//server` — a different file, and one nothing can open.
  */
  assert.equal(pathToUri("\\\\srv\\share\\a.ts"), "file://srv/share/a.ts");
  assert.equal(pathToUri("//srv/share/a.ts"), "file://srv/share/a.ts");
});

test("a UNC round-trip survives on POSIX", () => {
  // Off Windows the separator stays `/`, but the shape is preserved.
  assert.equal(uriToPath("file://srv/share/a.ts"), "//srv/share/a.ts");
});

test("a drive-letter URI comes back as a path", () => {
  // Off Windows `isWindows` is false, so the POSIX form is returned — the test
  // asserts what this platform does rather than pretending to be another.
  assert.equal(uriToPath("file:///C:/src/a.ts"), "/C:/src/a.ts");
});

test("a non-file scheme is refused rather than guessed at", () => {
  // Servers legitimately point at their own schemes for generated documents.
  assert.equal(uriToPath("untitled:Untitled-1"), null);
  assert.equal(uriToPath("jdt://contents/rt.jar"), null);
  assert.equal(uriToPath("https://example.com/a.ts"), null);
});

test("encoded characters decode on the way back", () => {
  assert.equal(uriToPath("file:///tmp/My%20Code/a.ts"), "/tmp/My Code/a.ts");
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("  all passing");
