/**
 * The prefix arithmetic a rename depends on.
 *
 * Both of the ways this can be wrong are silent. Too eager, and renaming `src`
 * rewrites the path of a tab open in `srcery`, which then saves to a file that
 * doesn't exist. Too shy, and the tab keeps the old name and the old path, and
 * the next save writes back to somewhere the file no longer is.
 *
 * Case sensitivity is passed explicitly in every assertion rather than left to
 * the platform default, so the Windows and macOS behaviour is covered by a test
 * run on Linux.
 */

import assert from "node:assert/strict";
import {
  canMoveInto,
  cleanName,
  isUnder,
  newEntryParent,
  remapPath,
  samePath,
  TreeRow,
} from "./explorer-paths";

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

console.log("explorer-paths");

test("a folder does not contain itself", () => {
  assert.equal(isUnder("/a/src", "/a/src", true), false);
});

test("a sibling with a longer name is not inside", () => {
  assert.equal(isUnder("/a/srcery/x.ts", "/a/src", true), false);
  assert.equal(isUnder("/a/src-old", "/a/src", true), false);
});

test("a child at any depth is inside", () => {
  assert.equal(isUnder("/a/src/x.ts", "/a/src", true), true);
  assert.equal(isUnder("/a/src/deep/x.ts", "/a/src", true), true);
});

test("a root that already ends in a separator still works", () => {
  assert.equal(isUnder("/x.ts", "/", true), true);
  assert.equal(isUnder("C:\\x.ts", "C:\\", true), true);
});

test("Windows separators count as separators", () => {
  assert.equal(isUnder("C:\\a\\src\\x.ts", "C:\\a\\src", true), true);
  assert.equal(isUnder("C:\\a\\srcery\\x.ts", "C:\\a\\src", true), false);
});

test("case only matters where the filesystem says it does", () => {
  assert.equal(samePath("/a/Src", "/a/src", true), false);
  assert.equal(samePath("/a/Src", "/a/src", false), true);
  assert.equal(isUnder("/a/SRC/x.ts", "/a/src", false), true);
  assert.equal(isUnder("/a/SRC/x.ts", "/a/src", true), false);
});

test("renaming a folder rewrites what is under it and nothing else", () => {
  assert.equal(remapPath("/a/src/x.ts", "/a/src", "/a/source", true), "/a/source/x.ts");
  assert.equal(remapPath("/a/src", "/a/src", "/a/source", true), "/a/source");
  assert.equal(remapPath("/a/srcery/x.ts", "/a/src", "/a/source", true), null);
  assert.equal(remapPath("/b/x.ts", "/a/src", "/a/source", true), null);
});

test("a move keeps the tail's own separators", () => {
  assert.equal(remapPath("C:\\a\\src\\x.ts", "C:\\a\\src", "D:\\keep", true), "D:\\keep\\x.ts");
});

test("a rename that only changes case still lands", () => {
  // The interesting one on macOS: `readme.md` to `README.md` is a real rename,
  // and the tab has to follow it even though the two paths compare equal.
  assert.equal(remapPath("/a/readme.md", "/a/readme.md", "/a/README.md", false), "/a/README.md");
});

test("a folder cannot be moved into itself or its own child", () => {
  assert.equal(canMoveInto("/a/src", "/a/src", "/a", true), false);
  assert.equal(canMoveInto("/a/src", "/a/src/lib", "/a", true), false);
  assert.equal(canMoveInto("/a/src", "/a/other", "/a", true), true);
});

test("dropping something back where it already is does nothing", () => {
  assert.equal(canMoveInto("/a/src/x.ts", "/a/src", "/a/src", true), false);
  assert.equal(canMoveInto("/a/src/x.ts", "/a", "/a/src", true), true);
});

test("control characters never survive a name field", () => {
  // The bug this exists for: four of these, pasted in ahead of the name, drew
  // as boxes with an X and would have made a file nobody could type.
  assert.equal(cleanName("\u0001\u0001\u0001\u0001explore.md"), "explore.md");
  assert.equal(cleanName("a\u001Bb\u007Fc\u0085d"), "abcd");
});

test("a separator can't smuggle a move into a rename", () => {
  assert.equal(cleanName("../etc/passwd"), "..etcpasswd");
});

test("a name in any script is left exactly as it is", () => {
  // The user typing these has a Bengali layout; stripping "unusual" characters
  // would break every name they write.
  assert.equal(cleanName("পরীক্ষা.md"), "পরীক্ষা.md");
  assert.equal(cleanName("notes 📌 v2.md"), "notes 📌 v2.md");
  assert.equal(cleanName("Component.test.tsx"), "Component.test.tsx");
});

/** The tree as drawn: order is what this function reads. */
function rows(...entries: [string, boolean, boolean][]): TreeRow[] {
  return entries.map(([path, isDir, expanded]) => ({ path, isDir, expanded }));
}

test("a new entry goes in the last open folder on screen", () => {
  const tree = rows(
    ["/a/src", true, true],
    ["/a/src/components", true, true],
    ["/a/src/components/Button.tsx", false, false],
    ["/a/lib", true, true],
    ["/a/lib/fuzzy.ts", false, false]
  );
  assert.equal(newEntryParent(tree, "/a"), "/a/lib");
});

test("a collapsed folder is never the target", () => {
  const tree = rows(
    ["/a/src", true, true],
    ["/a/src/components", true, false],
    ["/a/lib", true, false]
  );
  assert.equal(newEntryParent(tree, "/a"), "/a/src");
});

test("with everything collapsed it falls back to the root", () => {
  const tree = rows(["/a/src", true, false], ["/a/README.md", false, false]);
  assert.equal(newEntryParent(tree, "/a"), "/a");
  assert.equal(newEntryParent([], "/a"), "/a");
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("  all passing");
