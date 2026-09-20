/**
 * Which requests a run covers, and in what order.
 *
 * The walk is the testable half of the runner — the other half is `execute`,
 * which needs a network. Order matters because a collection's requests are
 * written to run in order: sign in, then use the token the first one set.
 */

import assert from "node:assert/strict";
import { ApiItem } from "../../../types/api";
import { requestsUnder } from "./run";

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

function item(partial: Partial<ApiItem> & { id: string; name: string }): ApiItem {
  return {
    collectionId: "c1",
    parentId: null,
    kind: "request",
    description: "",
    rank: "V",
    updatedAt: 0,
    method: "GET",
    url: "",
    auth: null,
    variables: null,
    conflictedAt: null,
    events: null,
    ...partial,
  };
}

/**
 *   API
 *     Sign in           (request, rank A)
 *     Users             (folder,  rank B)
 *       List            (request, rank A)
 *       Nested          (folder,  rank B)
 *         Deep          (request, rank A)
 *     Health            (request, rank C)
 */
const items = [
  item({ id: "signin", name: "Sign in", rank: "A" }),
  item({ id: "users", name: "Users", kind: "folder", rank: "B" }),
  item({ id: "list", name: "List", parentId: "users", rank: "A" }),
  item({ id: "nested", name: "Nested", kind: "folder", parentId: "users", rank: "B" }),
  item({ id: "deep", name: "Deep", parentId: "nested", rank: "A" }),
  item({ id: "health", name: "Health", rank: "C" }),
];

const names = (found: ApiItem[]) => found.map((row) => row.name);

console.log("api/runner");

/** Depth first, in rank order — the order the rail shows, which is the order
 * the collection's author wrote them in. */
test("a collection runs everything in it, in the order it is shown", () => {
  assert.deepEqual(names(requestsUnder(items, { kind: "collection", id: "c1" })), [
    "Sign in",
    "List",
    "Deep",
    "Health",
  ]);
});

test("a folder runs only what is under it", () => {
  assert.deepEqual(names(requestsUnder(items, { kind: "folder", id: "users" })), [
    "List",
    "Deep",
  ]);
  assert.deepEqual(names(requestsUnder(items, { kind: "folder", id: "nested" })), ["Deep"]);
});

test("folders are not requests, however deep they are", () => {
  const found = requestsUnder(items, { kind: "collection", id: "c1" });
  assert.ok(found.every((row) => row.kind === "request"));
});

test("an empty folder runs nothing rather than everything", () => {
  const empty = [...items, item({ id: "spare", name: "Spare", kind: "folder", rank: "D" })];
  assert.deepEqual(requestsUnder(empty, { kind: "folder", id: "spare" }), []);
  assert.deepEqual(requestsUnder(items, { kind: "folder", id: "missing" }), []);
});

test("another collection's requests are not swept in", () => {
  const two = [
    ...items,
    item({ id: "other", name: "Other", collectionId: "c2" }),
  ];
  assert.deepEqual(names(requestsUnder(two, { kind: "collection", id: "c1" })), [
    "Sign in",
    "List",
    "Deep",
    "Health",
  ]);
  assert.deepEqual(names(requestsUnder(two, { kind: "collection", id: "c2" })), ["Other"]);
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
