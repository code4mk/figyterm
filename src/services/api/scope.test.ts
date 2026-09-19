/**
 * A folder or collection row, read into a draft and folded back.
 *
 * The property worth testing is the round trip. A draft that does not fold back
 * into the row it came from makes the tab report itself dirty for ever — the
 * save button lights up on a tab nobody has touched, and after a while nobody
 * believes it.
 */

import assert from "node:assert/strict";
import { ApiItem } from "../../types/api";
import { emptyScope, scopeFrom, scopeTo } from "./scope";

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

function folder(partial: Partial<ApiItem> = {}): ApiItem {
  return {
    id: "f1",
    collectionId: "c1",
    parentId: null,
    kind: "folder",
    name: "Users",
    description: "",
    rank: "V",
    updatedAt: 0,
    method: null,
    url: null,
    auth: null,
    variables: null,
    conflictedAt: null,
    events: null,
    ...partial,
  };
}

console.log("api/scope");

test("a bare folder reads as a draft with nothing in it", () => {
  const draft = scopeFrom(folder());
  assert.equal(draft.name, "Users");
  assert.equal(draft.description, "");
  assert.equal(draft.auth.type, "inherit");
  assert.deepEqual(draft.variables, []);
  assert.deepEqual(draft.scripts, { prerequest: "", test: "" });
});

test("what is on the row is what is in the draft", () => {
  const draft = scopeFrom(
    folder({
      description: "Everything under /users.",
      auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
      variables: [{ key: "page_size", value: "25" }],
      events: [
        { listen: "test", script: { type: "text/javascript", exec: ["pm.test('x', () => {})"] } },
      ],
    })
  );

  assert.equal(draft.description, "Everything under /users.");
  assert.equal(draft.auth.type, "bearer");
  assert.equal(draft.auth.params.token, "{{token}}");
  assert.deepEqual(draft.variables, [{ key: "page_size", value: "25", enabled: true }]);
  assert.equal(draft.scripts.test, "pm.test('x', () => {})");
  assert.equal(draft.scripts.prerequest, "");
});

/** The one that matters: unchanged in, unchanged out. */
test("a draft folded back matches the row it came from", () => {
  const row = folder({
    description: "Everything under /users.",
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] },
    variables: [{ key: "page_size", value: "25" }],
    events: [
      { listen: "test", script: { type: "text/javascript", exec: ["pm.test('x', () => {})"] } },
    ],
  });

  const written = scopeTo(scopeFrom(row), row.events);
  assert.equal(written.name, "Users");
  assert.equal(written.description, "Everything under /users.");
  assert.deepEqual(written.auth, row.auth);
  assert.deepEqual(written.variables, [{ key: "page_size", value: "25" }]);
  assert.deepEqual(written.events, row.events);
});

/** For a folder, an absent block is what passes the question up the chain.
 * Writing `{"type":"inherit"}` would invent a block the format has no word
 * for, and every request below would stop inheriting. */
test("inherit is written as no block at all", () => {
  assert.equal(scopeTo(emptyScope(), null).auth, null);
});

test("no auth is a block, because it is an answer rather than a gap", () => {
  const draft = { ...emptyScope(), auth: { type: "noauth", params: {} } };
  assert.deepEqual(scopeTo(draft, null).auth, { type: "noauth" });
});

test("a listener this app does not know survives a save", () => {
  const existing = [
    { listen: "somethingelse", script: { exec: ["keep me"] } },
    { listen: "test", script: { exec: ["old"] } },
  ];
  const written = scopeTo({ ...emptyScope(), scripts: { prerequest: "", test: "new" } }, existing);

  assert.deepEqual(written.events, [
    { listen: "somethingelse", script: { exec: ["keep me"] } },
    { listen: "test", script: { type: "text/javascript", exec: ["new"] } },
  ]);
});

test("a name of spaces does not become a row nobody can find", () => {
  assert.equal(scopeTo({ ...emptyScope(), name: "   " }, null).name, "Untitled");
  assert.equal(scopeTo({ ...emptyScope(), name: "  Users  " }, null).name, "Users");
});

/** Non-Latin names are the ordinary case here, not an edge one. */
test("a name that is not Latin is kept as it was typed", () => {
  assert.equal(scopeTo({ ...emptyScope(), name: "ব্যবহারকারী" }, null).name, "ব্যবহারকারী");
});

test("a disabled variable stays disabled all the way round", () => {
  const row = folder({ variables: [{ key: "a", value: "1", disabled: true }] });
  const draft = scopeFrom(row);
  assert.equal(draft.variables[0]!.enabled, false);
  assert.deepEqual(scopeTo(draft, null).variables, [{ key: "a", value: "1", disabled: true }]);
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
