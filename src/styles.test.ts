/**
 * Every class the Figy Code window uses has a rule behind it.
 *
 * This exists because of an afternoon it would have saved. A block
 * replacement in `styles.css`, meant to swap one list for a table,
 * matched two section markers with rather more between them than
 * intended — and took the model picker, the permission rows, the
 * footer's Settings button and the whole to-do renderer with it.
 *
 * Nothing complained. CSS has no compiler, a missing rule is not an
 * error, and the components went on rendering: a dropdown became a
 * column of run-together text that was still, technically, working.
 * It was found by reading a screenshot.
 *
 * So: a test. It is not a design review and it cannot tell whether a
 * rule is any good — it answers one question, which is whether the
 * rule is there at all, and that is the question that was open.
 *
 * It reads the two files rather than a DOM, because there is no DOM
 * in this runner and none is needed: both halves are text.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

console.log("styles");

/** Every `.tsx` under a directory, depth first. */
function components(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return components(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * The `figy-` names out of every `className`.
 *
 * Both spellings: a plain string, and a template literal whose
 * expressions are dropped — `figy-todo ${item.status}` contributes
 * `figy-todo`, and the status it appends is a modifier the rule for
 * `figy-todo` carries.
 */
function classesUsed(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const text = match[1] ?? match[2] ?? "";
    for (const word of text.split(/[\s{}$?:()[\].]+/)) {
      if (word.startsWith("figy-")) found.add(word);
    }
  }
  return found;
}

test("every figy- class the window uses has a rule in styles.css", () => {
  const css = readFileSync("src/styles.css", "utf8");
  const defined = new Set(
    [...css.matchAll(/\.(figy-[a-zA-Z0-9_-]+)/g)].map((match) => match[1])
  );

  const orphans: string[] = [];
  for (const file of components("src/components/FigyCode")) {
    for (const name of classesUsed(readFileSync(file, "utf8"))) {
      if (!defined.has(name)) orphans.push(`${name} (${file})`);
    }
  }

  assert.deepEqual(
    orphans,
    [],
    `classes with no rule — a deleted block, or a typo:\n  ${orphans.join("\n  ")}`
  );
});

/**
 * And the other direction, as a warning rather than a failure.
 *
 * A rule nobody matches is the first thing to rot, but it is also how
 * a style that is about to be used looks on the way in — so this
 * counts them and says so, and fails only if the number runs away.
 */
test("styles.css is not mostly rules for things that no longer exist", () => {
  const css = readFileSync("src/styles.css", "utf8");
  const defined = new Set(
    [...css.matchAll(/\.(figy-[a-zA-Z0-9_-]+)/g)].map((match) => match[1])
  );
  const used = new Set<string>();
  for (const file of components("src/components/FigyCode")) {
    for (const name of classesUsed(readFileSync(file, "utf8"))) used.add(name);
  }

  // Modifiers (`figy-todo.done`) and classes set outside a
  // `className` attribute are counted as unused here, so the bar is
  // generous. It is a smoke alarm, not an inventory.
  const unused = [...defined].filter((name) => !used.has(name));
  assert.ok(
    unused.length < 90,
    `${unused.length} rules match nothing in FigyCode:\n  ${unused.sort().join("\n  ")}`
  );
});

process.exit(failures ? 1 : 0);
