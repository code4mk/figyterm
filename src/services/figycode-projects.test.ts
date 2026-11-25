/**
 * The folder list behind the Figy Code window.
 *
 * This is the part of that window that is not a fiction, so it is the part
 * where a bug costs something: a project that silently fails to stick, a
 * duplicate row for the same checkout under two spellings, or an extra
 * folder granted twice. All four functions are pure and take the list they
 * operate on, which is why they can be tested at all — the storage around
 * them is six lines of try/catch and has nothing to get wrong.
 */

import assert from "node:assert/strict";
import {
  addExtraDir,
  removeExtraDir,
  filterRows,
  forgetProject,
  pickerRows,
  projectLabel,
  rememberProject,
  type FigyProject,
} from "./figycode-projects";

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

console.log("figycode-projects");

const fig: FigyProject = { root: "/Users/me/code/fig", extraDirs: [], lastUsedAt: 100 };
const api: FigyProject = { root: "/Users/me/work/api", extraDirs: [], lastUsedAt: 200 };

/* ─── Names ────────────────────────────────────────────────────────────────── */

test("a project is called whatever its folder is called", () => {
  assert.equal(projectLabel("/Users/me/code/fig-alternative"), "fig-alternative");
  assert.equal(projectLabel("C:\\Users\\me\\api"), "api");
});

test("a root folder survives as itself rather than as nothing", () => {
  assert.equal(projectLabel("/"), "/");
});

/* ─── Remembering ──────────────────────────────────────────────────────────── */

test("a new folder goes to the front", () => {
  const next = rememberProject([fig], "/Users/me/work/api", 300);
  assert.deepEqual(
    next.map((p) => p.root),
    ["/Users/me/work/api", "/Users/me/code/fig"]
  );
});

test("reopening one moves it without duplicating it", () => {
  const next = rememberProject([fig, api], "/Users/me/work/api", 300);
  assert.equal(next.length, 2);
  assert.equal(next[0].root, "/Users/me/work/api");
  assert.equal(next[0].lastUsedAt, 300);
});

test("a trailing separator is the same folder, not a second one", () => {
  // Two rows for one checkout is the bug this normalisation exists to stop.
  const next = rememberProject([fig], "/Users/me/code/fig/", 300);
  assert.equal(next.length, 1);
});

test("reopening keeps the folders the project was already granted", () => {
  const granted: FigyProject = { ...fig, extraDirs: ["/Users/me/shared"] };
  const next = rememberProject([granted], granted.root, 400);
  assert.deepEqual(next[0].extraDirs, ["/Users/me/shared"]);
});

test("an empty path is not a project", () => {
  assert.deepEqual(rememberProject([fig], "   "), [fig]);
});

test("forgetting removes exactly one", () => {
  assert.deepEqual(
    forgetProject([fig, api], "/Users/me/code/fig").map((p) => p.root),
    ["/Users/me/work/api"]
  );
});

/* ─── Extra folders ────────────────────────────────────────────────────────── */

test("an extra folder is added once", () => {
  let list = addExtraDir([fig], fig.root, "/Users/me/shared");
  list = addExtraDir(list, fig.root, "/Users/me/shared");
  assert.deepEqual(list[0].extraDirs, ["/Users/me/shared"]);
});

test("the root is never also an extra", () => {
  // A row saying the agent may reach the folder it runs in explains nothing.
  const list = addExtraDir([fig], fig.root, "/Users/me/code/fig");
  assert.deepEqual(list[0].extraDirs, []);
});

test("an extra folder can be taken back", () => {
  // The mistake this undoes is granting an agent a folder you did not
  // mean to, which is not a mistake to leave standing.
  let list = addExtraDir([fig], fig.root, "/Users/me/shared");
  list = addExtraDir(list, fig.root, "/Users/me/notes");
  list = removeExtraDir(list, fig.root, "/Users/me/shared");
  assert.deepEqual(list[0].extraDirs, ["/Users/me/notes"]);
});

test("removing a folder that was never granted changes nothing", () => {
  const list = removeExtraDir([fig], fig.root, "/Users/me/elsewhere");
  assert.deepEqual(list[0].extraDirs, fig.extraDirs);
});

test("granting one project a folder leaves the others alone", () => {
  const list = addExtraDir([fig, api], fig.root, "/Users/me/shared");
  assert.deepEqual(list[1].extraDirs, []);
});

/* ─── What the picker shows ────────────────────────────────────────────────── */

test("projects come first, then folders the terminal has been in", () => {
  const rows = pickerRows([fig], ["/Users/me/downloads"], "/Users/me/work/api");
  assert.deepEqual(rows, [
    { root: "/Users/me/code/fig", known: true },
    { root: "/Users/me/work/api", known: false },
    { root: "/Users/me/downloads", known: false },
  ]);
});

test("a folder that is already a project is not offered twice", () => {
  const rows = pickerRows([fig], ["/Users/me/code/fig"], "/Users/me/code/fig");
  assert.deepEqual(rows, [{ root: "/Users/me/code/fig", known: true }]);
});

test("filtering matches the whole path, not just the name", () => {
  const rows = pickerRows([fig, api], [], undefined);
  assert.deepEqual(filterRows(rows, "work").map((r) => r.root), ["/Users/me/work/api"]);
  assert.equal(filterRows(rows, "").length, 2);
  assert.equal(filterRows(rows, "ZZZ").length, 0);
});

process.exit(failures ? 1 : 0);
