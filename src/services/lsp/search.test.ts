/**
 * Searching the language-server table.
 *
 * The list is twenty-four rows, which is past the point where scanning beats
 * searching. The rule that matters is that a query matches **the files a server
 * claims**, not just its name: the thing people arrive knowing is usually the
 * file — "what handles `.tsx`" — and searching for that by server name requires
 * already knowing the answer.
 *
 * The matcher lives in `EditorSettingsModal.tsx` because it is presentation.
 * The copy here is deliberate and small; what is tested is that the *table*
 * supports these queries — that the extensions and filenames a user would type
 * are actually in the data.
 */

import assert from "node:assert/strict";
import { SERVERS, type LspServerDef } from "./servers";

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

/** Mirrors `matchesQuery` in the settings panel. */
function matches(def: LspServerDef, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [
    def.label,
    def.program,
    def.id,
    ...Object.keys(def.extensions),
    ...Object.keys(def.filenames ?? {}),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term.replace(/^\./, "")));
}

const search = (query: string) =>
  SERVERS.filter((def) => matches(def, query)).map((def) => def.id);

console.log("lsp/search");

test("an empty query keeps everything", () => {
  assert.equal(search("").length, SERVERS.length);
  assert.equal(search("   ").length, SERVERS.length);
});

test("searching by language name", () => {
  assert.ok(search("rust").includes("rust"));
  assert.ok(search("python").includes("python"));
  assert.ok(search("kotlin").includes("kotlin"));
});

test("searching by extension, the way people actually think", () => {
  assert.ok(search("tsx").includes("typescript"));
  assert.ok(search("rs").includes("rust"));
  assert.ok(search("cs").includes("csharp"));
  assert.ok(search("zig").includes("zig"));
});

test("a leading dot is ignored, so .py works like py", () => {
  assert.deepEqual(search(".py"), search("py"));
  assert.ok(search(".tf").includes("terraform"));
});

test("searching by the program you installed", () => {
  assert.ok(search("gopls").includes("go"));
  assert.ok(search("marksman").includes("markdown"));
  assert.ok(search("intelephense").includes("php"));
});

test("searching by a whole filename", () => {
  assert.ok(search("dockerfile").includes("docker"));
  assert.ok(search("gemfile").includes("ruby"));
});

test("matching is case-insensitive", () => {
  assert.ok(search("RUST").includes("rust"));
  assert.ok(search("TailWind").includes("tailwind"));
});

test("several terms narrow rather than widen", () => {
  // What a space means everywhere else. `language server` must not return
  // everything just because both words appear somewhere in the table.
  const both = search("tailwind css");
  assert.deepEqual(both, ["tailwind"]);
  assert.ok(search("tailwind").length >= both.length);
});

test("a query nothing matches returns nothing", () => {
  assert.deepEqual(search("cobol"), []);
});

test("every server is reachable by its own label", () => {
  // Guards against an entry that can be seen but never found.
  for (const def of SERVERS) {
    const found = search(def.label.split(" ")[0]);
    assert.ok(found.includes(def.id), `${def.id} is not findable by its label`);
  }
});

test("every server is reachable by one of its extensions", () => {
  for (const def of SERVERS) {
    const first = Object.keys(def.extensions)[0] ?? Object.keys(def.filenames ?? {})[0];
    assert.ok(first, `${def.id} claims nothing`);
    assert.ok(
      search(first).includes(def.id),
      `${def.id} is not findable by .${first}`
    );
  }
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("  all passing");
