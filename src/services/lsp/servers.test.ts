/**
 * Which servers claim which files.
 *
 * This table used to key on the editor's `languageId`, and that was wrong twice
 * over — both failures silent, which is why they are pinned here rather than
 * left to be noticed in use:
 *
 * 1. Those ids pick a *highlighting grammar* and are approximate. `.kt` is
 *    highlighted as `cpp` and `.svelte` as `html`, so a Kotlin server keyed on
 *    `cpp` would have started on C++ files.
 * 2. They are the wrong string to send a server. `didOpen` carries the
 *    protocol's vocabulary, and `typescript-language-server` wants
 *    `typescriptreact` for a `.tsx` file, not `tsx`.
 */

import assert from "node:assert/strict";
import { primaryServerForPath, serversForPath, SERVERS } from "./servers";

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

const idsFor = (path: string) => serversForPath(path).map((match) => match.def.id);
const primary = (path: string) => primaryServerForPath(path)?.def.id ?? null;
const languageFor = (path: string, id: string) =>
  serversForPath(path).find((match) => match.def.id === id)?.languageId ?? null;

console.log("lsp/servers");

test("a file with no server matches nothing", () => {
  assert.deepEqual(idsFor("/w/notes.txt"), []);
  assert.deepEqual(idsFor("/w/archive.tar.gz"), []);
});

test("the obvious languages resolve", () => {
  assert.equal(primary("/w/main.rs"), "rust");
  assert.equal(primary("/w/app.py"), "python");
  assert.equal(primary("/w/main.go"), "go");
  assert.equal(primary("/w/index.php"), "php");
  assert.equal(primary("/w/build.zig"), "zig");
  assert.equal(primary("/w/main.tf"), "terraform");
  assert.equal(primary("/w/app.rb"), "ruby");
  assert.equal(primary("/w/App.swift"), "swift");
  assert.equal(primary("/w/main.dart"), "dart");
  assert.equal(primary("/w/Program.cs"), "csharp");
});

test("C# does not collide with the C family", () => {
  // `.cs` is *highlighted* as cpp — another approximation in the grammar table
  // — so this is the same trap as Kotlin, and worth its own case.
  assert.equal(primary("/w/Program.cs"), "csharp");
  assert.equal(primary("/w/main.c"), "clangd");
  assert.equal(languageFor("/w/Program.cs", "csharp"), "csharp");
});

test("Kotlin does not resolve to the C++ server — the bug that keying on language ids caused", () => {
  assert.equal(primary("/w/Main.kt"), "kotlin");
  assert.equal(primary("/w/main.cpp"), "clangd");
});

test("Svelte does not resolve to the HTML server", () => {
  assert.equal(primary("/w/App.svelte"), "svelte");
  assert.equal(primary("/w/index.html"), "html");
});

test("tsx is announced to the server as typescriptreact", () => {
  // The protocol's vocabulary, not the editor's. tsserver does the wrong thing
  // with `tsx`.
  assert.equal(languageFor("/w/App.tsx", "typescript"), "typescriptreact");
  assert.equal(languageFor("/w/app.ts", "typescript"), "typescript");
  assert.equal(languageFor("/w/app.jsx", "typescript"), "javascriptreact");
  assert.equal(languageFor("/w/app.js", "typescript"), "javascript");
});

test("clangd distinguishes C, C++ and Objective-C", () => {
  assert.equal(languageFor("/w/a.c", "clangd"), "c");
  assert.equal(languageFor("/w/a.cpp", "clangd"), "cpp");
  assert.equal(languageFor("/w/a.mm", "clangd"), "objective-cpp");
});

test("files matched by name rather than extension", () => {
  assert.equal(primary("/w/Dockerfile"), "docker");
  assert.equal(primary("/w/Gemfile"), "ruby");
  assert.equal(primary("/w/go.mod"), "go");
});

test("matching ignores case", () => {
  assert.equal(primary("/w/MAIN.RS"), "rust");
  assert.equal(primary("/w/dockerfile"), "docker");
});

test("Tailwind rides alongside rather than replacing", () => {
  // The whole reason companions exist: every file Tailwind cares about already
  // has a server, and completing class names must not cost you the other one.
  const tsx = idsFor("/w/App.tsx");
  assert.deepEqual(tsx, ["typescript", "tailwind"]);
  assert.equal(primary("/w/App.tsx"), "typescript", "the primary must stay first");

  const css = idsFor("/w/site.css");
  assert.deepEqual(css, ["css", "tailwind"]);
  assert.equal(primary("/w/site.css"), "css");
});

test("a companion is never the primary, even alone", () => {
  // `.astro` has no primary server in the table; Tailwind still claims it, and
  // must not be promoted into answering go-to-definition.
  assert.deepEqual(idsFor("/w/page.astro"), ["tailwind"]);
  assert.equal(primary("/w/page.astro"), null);
});

test("every entry is well formed", () => {
  const ids = new Set<string>();
  for (const def of SERVERS) {
    assert.ok(def.id && !ids.has(def.id), `duplicate or missing id: ${def.id}`);
    ids.add(def.id);
    assert.ok(def.label, `${def.id} has no label`);
    assert.ok(def.program, `${def.id} has no program`);
    assert.ok(Array.isArray(def.args), `${def.id} args must be a list`);
    assert.ok(def.install, `${def.id} has no install line`);
    assert.ok(
      Object.keys(def.extensions).length || Object.keys(def.filenames ?? {}).length,
      `${def.id} claims no files`
    );
    for (const [ext, language] of Object.entries(def.extensions)) {
      assert.equal(ext, ext.toLowerCase(), `${def.id}: extension ${ext} must be lowercase`);
      assert.ok(!ext.startsWith("."), `${def.id}: extension ${ext} must not start with a dot`);
      assert.ok(language, `${def.id}: ${ext} has no language id`);
    }
  }
});

test("only one primary can claim a given extension", () => {
  // Two primaries on one extension would make the resolution order arbitrary.
  const claimed = new Map<string, string>();
  for (const def of SERVERS) {
    if (def.companion) continue;
    for (const ext of Object.keys(def.extensions)) {
      const already = claimed.get(ext);
      assert.ok(!already, `.${ext} is claimed by both ${already} and ${def.id}`);
      claimed.set(ext, def.id);
    }
  }
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("  all passing");
