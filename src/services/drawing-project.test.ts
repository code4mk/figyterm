/**
 * The list arithmetic is the part that is wrong silently when it is wrong: a
 * bad `nextUntitledName` doesn't throw, it gives two projects the same label; a
 * bad `pickAppState` doesn't throw, it quietly persists the theme and repaints
 * someone's drawing in the wrong one a day later.
 */

import assert from "node:assert/strict";
import {
  DrawingProject,
  UNTITLED,
  duplicateName,
  insertProject,
  nextUntitledName,
  normalizeName,
  pickAppState,
  searchProjects,
  sortProjects,
  visibleElementCount,
  PERSISTED_APP_STATE_KEYS,
} from "./drawing-project";

function project(overrides: Partial<DrawingProject> = {}): DrawingProject {
  return {
    id: "p1",
    name: "Sketch",
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    elementCount: 0,
    ...overrides,
  };
}

// ─── Names ──────────────────────────────────────────────────────────────────

assert.equal(normalizeName("  Architecture  "), "Architecture", "names are trimmed");
assert.equal(normalizeName(""), null, "an empty name is not a name");
assert.equal(normalizeName("   "), null, "nor is whitespace");
assert.equal(normalizeName("\t\n"), null, "nor any other blank");

assert.equal(nextUntitledName([]), UNTITLED, "the first one is unnumbered");
assert.equal(nextUntitledName(["Sketch"]), UNTITLED, "unrelated names do not push it along");
assert.equal(nextUntitledName([UNTITLED]), `${UNTITLED} 2`, "numbering starts at 2, not 1");
assert.equal(
  nextUntitledName([UNTITLED, `${UNTITLED} 2`]),
  `${UNTITLED} 3`
);
assert.equal(
  nextUntitledName([UNTITLED, `${UNTITLED} 3`]),
  `${UNTITLED} 2`,
  "a gap is reused rather than stepped over"
);
assert.equal(
  nextUntitledName([`  ${UNTITLED}  `]),
  `${UNTITLED} 2`,
  "an untrimmed stored name still counts as taken"
);

assert.equal(duplicateName("Flow", []), "Flow copy");
assert.equal(duplicateName("Flow", ["Flow copy"]), "Flow copy 2");
assert.equal(duplicateName("Flow", ["Flow copy", "Flow copy 2"]), "Flow copy 3");
assert.equal(
  duplicateName("Flow copy", ["Flow copy"]),
  "Flow copy 2",
  "duplicating a copy does not give 'copy copy'"
);
assert.equal(
  duplicateName("Flow copy 2", ["Flow copy", "Flow copy 2"]),
  "Flow copy 3",
  "nor does duplicating a numbered copy"
);

// ─── Order ──────────────────────────────────────────────────────────────────

{
  const a = project({ id: "a", updatedAt: 100 });
  const b = project({ id: "b", updatedAt: 300 });
  const c = project({ id: "c", updatedAt: 200, favorite: true });
  const d = project({ id: "d", updatedAt: 50, favorite: true });

  assert.deepEqual(
    sortProjects([a, b, c, d]).map((p) => p.id),
    ["c", "d", "b", "a"],
    "favourites first, each group by most recently touched"
  );

  const input = [a, b, c, d];
  sortProjects(input);
  assert.deepEqual(input.map((p) => p.id), ["a", "b", "c", "d"], "the input is not sorted in place");
}

{
  // Equal keys keep their input order, so an unfavourited project drops back
  // into place rather than jumping.
  const x = project({ id: "x", updatedAt: 10 });
  const y = project({ id: "y", updatedAt: 10 });
  assert.deepEqual(sortProjects([x, y]).map((p) => p.id), ["x", "y"], "stable");
}

// ─── Inserting ──────────────────────────────────────────────────────────────

{
  const fav = project({ id: "fav", favorite: true, updatedAt: 1 });
  const a = project({ id: "a", updatedAt: 500 });
  const b = project({ id: "b", updatedAt: 9 });
  const fresh = project({ id: "new" });

  assert.deepEqual(
    insertProject([fav, a, b], fresh).map((p) => p.id),
    ["fav", "new", "a", "b"],
    "a new drawing goes above the ordinary ones and below the favourites"
  );
  assert.deepEqual(
    insertProject([a, b], fresh).map((p) => p.id),
    ["new", "a", "b"],
    "with no favourites it simply goes first"
  );
  assert.deepEqual(
    insertProject([fav], fresh).map((p) => p.id),
    ["fav", "new"],
    "with only favourites it goes last, which is still the top of its group"
  );
  assert.deepEqual(insertProject([], fresh).map((p) => p.id), ["new"]);

  // The point of the whole exercise: `a` and `b` are out of `updatedAt` order
  // and must stay that way, or the rail jumps when you press New.
  assert.deepEqual(
    insertProject([a, b], fresh).slice(1).map((p) => p.id),
    ["a", "b"],
    "the existing order is preserved, not re-sorted"
  );
}

// ─── Search ─────────────────────────────────────────────────────────────────

{
  const arch = project({ id: "arch", name: "Architecture", updatedAt: 1 });
  const flow = project({ id: "flow", name: "Auth flow", updatedAt: 3 });
  const star = project({ id: "star", name: "Starred idea", updatedAt: 2, favorite: true });
  const all = [arch, flow, star];

  // The store owns the order. Re-sorting here would fight it: `updatedAt` is
  // the sort key and autosave bumps it, so the open drawing would climb to the
  // top of the rail every few seconds while being drawn on.
  assert.deepEqual(
    searchProjects(all, "").map((p) => p.id),
    ["arch", "flow", "star"],
    "an empty query neither filters nor reorders — the given order survives"
  );
  assert.deepEqual(
    searchProjects(all, "   ").map((p) => p.id),
    ["arch", "flow", "star"],
    "and neither does a blank one"
  );
  assert.notEqual(
    searchProjects(all, ""),
    all,
    "but it is a copy, so the caller cannot mutate the store's array"
  );

  const hits = searchProjects(all, "arch");
  assert.equal(hits[0]?.id, "arch", "the best match leads, star or no star");
  assert.ok(
    !hits.some((p) => p.id === "star"),
    "a project that does not match is not in the results"
  );

  assert.equal(searchProjects(all, "zzzz").length, 0, "no matches is empty, not everything");
}

// ─── Elements ───────────────────────────────────────────────────────────────

assert.equal(visibleElementCount([]), 0);
assert.equal(
  visibleElementCount([{}, { isDeleted: false }, { isDeleted: true }]),
  2,
  "tombstones are kept for undo but not counted"
);

// ─── appState ───────────────────────────────────────────────────────────────

assert.ok(
  !PERSISTED_APP_STATE_KEYS.includes("theme" as never),
  "the theme belongs to the app, never to the drawing"
);

{
  const picked = pickAppState({
    viewBackgroundColor: "#fff",
    scrollX: 12,
    zoom: { value: 2 },
    // None of the following may survive:
    theme: "dark",
    selectedElementIds: { a: true },
    collaborators: new Map(),
    cursorButton: "down",
  });

  assert.deepEqual(
    Object.keys(picked).sort(),
    ["scrollX", "viewBackgroundColor", "zoom"],
    "only whitelisted keys survive"
  );
  assert.equal(picked.theme, undefined, "the theme is dropped");
  assert.equal(picked.collaborators, undefined, "and so is anything unserialisable");
}

assert.deepEqual(pickAppState(null), {}, "no appState is an empty object, not a throw");
assert.deepEqual(pickAppState(undefined), {});
assert.deepEqual(
  pickAppState({ scrollX: undefined }),
  {},
  "an undefined value is absent, not stored as undefined"
);

console.log("drawing-project: ok");
