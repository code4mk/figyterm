/**
 * The editor's own path arithmetic — the half of `editor-fs` that touches no
 * filesystem and so can be checked here.
 *
 * `relativeTo` is the one worth pinning down. It feeds the breadcrumb, quick
 * open's labels, the search results' headings and "Copy Relative Path", and the
 * way it used to be wrong was quiet: a bare `startsWith` reported a sibling
 * folder with a shared prefix as being inside the root and handed back a
 * fragment of a name, which reads as a plausible path and is a path to nothing.
 *
 * Running under Node means the platform is taken to be Linux, so these are the
 * case-sensitive answers; the case-folding they share with the tree is covered
 * by `explorer-paths.test.ts`.
 */

import assert from "node:assert/strict";
import { basename, dirname, joinPath, relativeTo, segmentsOf } from "./editor-fs";

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

console.log("editor-fs/paths");

test("the root itself is the empty string, not its own name", () => {
  assert.equal(relativeTo("/work/api", "/work/api"), "");
  // A trailing separator on either side names the same folder.
  assert.equal(relativeTo("/work/api/", "/work/api"), "");
});

test("a file under the root loses the root and the separator", () => {
  assert.equal(relativeTo("/work/api", "/work/api/src/main.rs"), "src/main.rs");
  assert.equal(relativeTo("/work/api/", "/work/api/src/main.rs"), "src/main.rs");
});

test("a sibling sharing a prefix is left alone", () => {
  // The bug: `startsWith` says this is inside `/work/api` and returns
  // `-old/src/main.rs`.
  assert.equal(
    relativeTo("/work/api", "/work/api-old/src/main.rs"),
    "/work/api-old/src/main.rs"
  );
  assert.equal(relativeTo("/work/api", "/work/apiary.md"), "/work/apiary.md");
});

test("a path somewhere else entirely comes back whole", () => {
  assert.equal(relativeTo("/work/api", "/etc/hosts"), "/etc/hosts");
});

test("the filesystem root is a root like any other", () => {
  assert.equal(relativeTo("/", "/etc/hosts"), "etc/hosts");
});

test("Windows separators are separators", () => {
  assert.equal(relativeTo("C:\\work\\api", "C:\\work\\api\\src\\main.rs"), "src\\main.rs");
  assert.equal(
    relativeTo("C:\\work\\api", "C:\\work\\api-old\\src\\main.rs"),
    "C:\\work\\api-old\\src\\main.rs"
  );
});

test("the result feeds back through joinPath to where it came from", () => {
  const root = "/work/api";
  const path = "/work/api/src/main.rs";
  assert.equal(joinPath(root, ...segmentsOf(relativeTo(root, path))), path);
});

test("basename and dirname keep the root's separator", () => {
  assert.equal(basename("/work/api/src/main.rs"), "main.rs");
  assert.equal(basename("/work/api/src/"), "src");
  assert.equal(dirname("/a"), "/");
  assert.equal(dirname("/work/api/src/main.rs"), "/work/api/src");
});

process.exit(failures === 0 ? 0 : 1);
