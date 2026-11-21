/**
 * The arithmetic behind "what should I be suggesting here".
 *
 * Every bug these cover was silent. Autocomplete that offers nothing looks
 * exactly like autocomplete that has nothing to offer, so the engine shipped
 * for months refusing to complete the second argument of every variadic command
 * — `git add one.txt <space>`, which is the whole reason `git add` takes a list
 * — and nothing anywhere said so.
 *
 * The engine itself reaches the filesystem and the spec store through Tauri and
 * cannot be imported here; this is the half that decides, and it is pure.
 */

import assert from "node:assert/strict";
import { argsToOffer, isFlagToken, tokenize } from "./figy-args";

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

console.log("figy-args");

/* ─── tokenize ─────────────────────────────────────────────────────────── */

test("a trailing space opens a new, empty token", () => {
  // This is the difference between "still typing `add`" and "ready for a file",
  // and every later decision reads it.
  assert.deepEqual(tokenize("git add"), ["git", "add"]);
  assert.deepEqual(tokenize("git add "), ["git", "add", ""]);
});

test("an escaped space stays inside its token", () => {
  assert.deepEqual(tokenize("cd My\\ Documents"), ["cd", "My Documents"]);
});

test("a quoted argument is one token, spaces and all", () => {
  assert.deepEqual(tokenize('git commit -m "two words"'), [
    "git",
    "commit",
    "-m",
    "two words",
  ]);
});

test("a space inside quotes does not open a new token", () => {
  // The trailing space is inside the quotes, so the argument is unfinished —
  // there is no new token to start.
  assert.deepEqual(tokenize('git commit -m "unfinished '), [
    "git",
    "commit",
    "-m",
    "unfinished ",
  ]);
});

/* ─── isFlagToken ──────────────────────────────────────────────────────── */

test("a flag is recognised without consulting the spec", () => {
  // The old test was `tok.startsWith("-") && currentSpec.options`, so a flag
  // typed at a subcommand that lists none was counted as a positional value.
  assert.equal(isFlagToken("-v"), true);
  assert.equal(isFlagToken("--force"), true);
  assert.equal(isFlagToken("--filter=web"), true);
});

test("a path or a plain word is not a flag", () => {
  assert.equal(isFlagToken("src/main.ts"), false);
  assert.equal(isFlagToken("add"), false);
  assert.equal(isFlagToken(""), false);
});

/* ─── argsToOffer ──────────────────────────────────────────────────────── */

const file = { name: "pathspec", template: "filepaths" as const };

test("a variadic argument is still offered after one value", () => {
  // The regression this file exists for: `git add one.txt ` offered nothing,
  // because a variadic argument was retired the moment it was used once.
  const args = [{ ...file, isVariadic: true }];
  assert.deepEqual(argsToOffer(args, 0), args);
  assert.deepEqual(argsToOffer(args, 1), args);
  assert.deepEqual(argsToOffer(args, 7), args);
});

test("a fixed argument retires once its position is filled", () => {
  const args = [{ name: "branch" }, { name: "start-point" }];
  assert.deepEqual(argsToOffer(args, 0), args);
  assert.deepEqual(argsToOffer(args, 1), [{ name: "start-point" }]);
  assert.deepEqual(argsToOffer(args, 2), []);
});

test("a variadic argument after a fixed one outlives it", () => {
  // `docker compose run <service> <command...>`: the service is supplied once,
  // the command keeps taking words.
  const args = [{ name: "service" }, { name: "command", isVariadic: true }];
  assert.deepEqual(argsToOffer(args, 1), [{ name: "command", isVariadic: true }]);
  assert.deepEqual(argsToOffer(args, 4), [{ name: "command", isVariadic: true }]);
});

test("no arguments is not an error", () => {
  assert.deepEqual(argsToOffer([], 0), []);
  assert.deepEqual(argsToOffer([], 3), []);
});

process.exit(failures === 0 ? 0 : 1);
