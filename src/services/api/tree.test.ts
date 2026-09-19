/**
 * What the rail draws.
 *
 * The cases worth pinning down are the ones where a row goes missing: a match
 * inside a collapsed folder, a folder dropped into its own child, and an empty
 * collection — each of which looks like the rail is broken rather than like a
 * rule being applied.
 */

import assert from "node:assert/strict";
import { ApiCollection, ApiItem } from "../../types/api";
import { buildTree, crumbsOf, isWithin, siblingsOf } from "./tree";

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

function collection(id: string, name: string, rank = "V"): ApiCollection {
  return {
    id,
    workspaceId: "w",
    name,
    description: "",
    rank,
    updatedAt: 0,
    auth: null,
    variables: null,
    conflictedAt: null,
    events: null,
  };
}

function folder(id: string, name: string, parentId: string | null, rank = "V"): ApiItem {
  return {
    id,
    collectionId: "c1",
    parentId,
    kind: "folder",
    name,
    description: "",
    rank,
    updatedAt: 0,
    method: null,
    url: null,
    auth: null,
    variables: null,
    conflictedAt: null,
    events: null,
  };
}

function request(
  id: string,
  name: string,
  parentId: string | null,
  url = "https://example.com",
  method = "GET",
  rank = "V"
): ApiItem {
  return {
    id,
    collectionId: "c1",
    parentId,
    kind: "request",
    name,
    description: "",
    rank,
    updatedAt: 0,
    method,
    url,
    auth: null,
    variables: null,
    conflictedAt: null,
    events: null,
  };
}

const collections = [collection("c1", "API")];
const items = [
  folder("f1", "Users", null, "A"),
  request("r1", "List users", "f1", "https://example.com/users", "GET", "A"),
  request("r2", "Create user", "f1", "https://example.com/users", "POST", "B"),
  request("r3", "Health", null, "https://example.com/health", "GET", "B"),
];

const names = (rows: { name: string }[]) => rows.map((row) => row.name);

console.log("api/tree");

test("a conflicted copy is marked so the rail can badge it", () => {
  const conflicted = { ...request("r9", "Copy", null), conflictedAt: 1 };
  const rows = buildTree(collections, [conflicted], {
    expanded: new Set(["c1"]),
    query: "",
  });
  assert.equal(rows.find((row) => row.name === "Copy")?.conflicted, true);
  assert.equal(rows.find((row) => row.name === "API")?.conflicted, false);
});

test("a collapsed collection shows only itself", () => {
  const rows = buildTree(collections, items, { expanded: new Set(), query: "" });
  assert.deepEqual(names(rows), ["API"]);
  assert.equal(rows[0]!.hasChildren, true);
  assert.equal(rows[0]!.expanded, false);
});

test("expanding shows children in rank order, folders and requests alike", () => {
  const rows = buildTree(collections, items, { expanded: new Set(["c1"]), query: "" });
  assert.deepEqual(names(rows), ["API", "Users", "Health"]);
});

test("expanding a folder shows what is inside it", () => {
  const rows = buildTree(collections, items, {
    expanded: new Set(["c1", "f1"]),
    query: "",
  });
  assert.deepEqual(names(rows), ["API", "Users", "List users", "Create user", "Health"]);
  assert.equal(rows[2]!.depth, 2);
});

test("an empty collection still gets a row", () => {
  const rows = buildTree([collection("c2", "Empty")], [], {
    expanded: new Set(),
    query: "",
  });
  assert.deepEqual(names(rows), ["Empty"]);
  assert.equal(rows[0]!.hasChildren, false);
});

/** The case that decides whether search is usable at all. */
test("a match inside a collapsed folder reveals itself and its ancestors", () => {
  const rows = buildTree(collections, items, {
    expanded: new Set(),
    query: "create",
  });
  assert.deepEqual(names(rows), ["API", "Users", "Create user"]);
});

test("searching matches the URL and the method, not just the name", () => {
  const byUrl = buildTree(collections, items, { expanded: new Set(), query: "health" });
  assert.deepEqual(names(byUrl), ["API", "Health"]);

  const byMethod = buildTree(collections, items, { expanded: new Set(), query: "post" });
  assert.deepEqual(names(byMethod), ["API", "Users", "Create user"]);
});

test("a query nothing matches shows nothing", () => {
  const rows = buildTree(collections, items, { expanded: new Set(), query: "zzz" });
  assert.deepEqual(names(rows), []);
});

test("matching a collection by name keeps it visible", () => {
  const rows = buildTree(collections, items, { expanded: new Set(), query: "api" });
  assert.equal(rows[0]!.name, "API");
});

test("siblings are the rows a drop has to fit between", () => {
  assert.deepEqual(names(siblingsOf(items, "c1", "f1")), ["List users", "Create user"]);
  assert.deepEqual(names(siblingsOf(items, "c1", null)), ["Users", "Health"]);
  assert.deepEqual(siblingsOf(items, "nope", null), []);
});

test("a folder is within itself, and within nothing else", () => {
  const nested = [...items, folder("f2", "Nested", "f1")];
  assert.equal(isWithin(nested, "f1", "f1"), true);
  assert.equal(isWithin(nested, "f1", "f2"), true, "f2 is inside f1");
  assert.equal(isWithin(nested, "f2", "f1"), false, "f1 is not inside f2");
});

// ─── Kept responses ──────────────────────────────────────────────────────────
//
// An example is stored against a request and exports with it, so the tree is
// where it belongs. The cases below are the ones that would make it look
// broken: a request that gains a twisty it should not have, and a search that
// buries its own matches under every request's history.

const examples = [
  { id: "x1", itemId: "r1", name: "200 OK", status: 200, rank: "A" },
  { id: "x2", itemId: "r1", name: "422 invalid", status: 422, rank: "B" },
];

test("a request with kept responses gets a twisty", () => {
  const rows = buildTree(collections, items, {
    expanded: new Set(["c1", "f1"]),
    query: "",
    examples,
  });
  assert.equal(rows.find((row) => row.name === "List users")?.hasChildren, true);
  assert.equal(
    rows.find((row) => row.name === "Create user")?.hasChildren,
    false,
    "a request with none does not"
  );
});

test("expanding a request lists its examples in rank order, under it", () => {
  const rows = buildTree(collections, items, {
    expanded: new Set(["c1", "f1", "r1"]),
    query: "",
    examples,
  });
  assert.deepEqual(names(rows), [
    "API",
    "Users",
    "List users",
    "200 OK",
    "422 invalid",
    "Create user",
    "Health",
  ]);
});

test("an example row carries its status and the request it belongs to", () => {
  const rows = buildTree(collections, items, {
    expanded: new Set(["c1", "f1", "r1"]),
    query: "",
    examples,
  });
  const kept = rows.find((row) => row.name === "422 invalid")!;
  assert.equal(kept.kind, "example");
  assert.equal(kept.status, 422);
  assert.equal(kept.parentId, "r1");
  assert.equal(kept.depth, rows.find((row) => row.name === "List users")!.depth + 1);
});

/** Searching reveals the path to a hit. Examples are not searched, so opening
 * every matching request would bury the matches in their own history. */
test("a search does not open every request's examples", () => {
  const rows = buildTree(collections, items, {
    expanded: new Set(),
    query: "users",
    examples,
  });
  assert.ok(names(rows).includes("List users"));
  assert.ok(!names(rows).includes("200 OK"));
});

test("with no examples passed, the tree is the one it always was", () => {
  const withOut = buildTree(collections, items, { expanded: new Set(["c1", "f1"]), query: "" });
  assert.ok(withOut.every((row) => row.kind !== "example"));
  assert.equal(withOut.find((row) => row.name === "List users")?.hasChildren, false);
});

test("a broken parent chain does not hang the walk", () => {
  const orphan = folder("f9", "Orphan", "missing");
  assert.equal(isWithin([orphan], "f1", "f9"), false);
  const rows = buildTree(collections, [orphan], { expanded: new Set(["c1"]), query: "" });
  // It has a parent that does not exist, so it is not drawn under anything —
  // but the rail still renders, which is the point.
  assert.deepEqual(names(rows), ["API"]);
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}

// ─── The trail to an item ────────────────────────────────────────────────────

console.log("api/tree — crumbs");

const crumbCollections = [{ id: "c1", name: "Reso API" }] as never;

function crumbItem(id: string, name: string, parentId: string | null, kind: string) {
  return {
    id,
    collectionId: "c1",
    parentId,
    kind,
    name,
    description: "",
    rank: "a",
    updatedAt: 0,
    method: kind === "request" ? "GET" : null,
    url: null,
    auth: null,
    variables: null,
  } as never;
}

test("the trail runs collection, folders, then the item itself", () => {
  const items = [
    crumbItem("f1", "Auth", null, "folder"),
    crumbItem("f2", "Tokens", "f1", "folder"),
    crumbItem("r1", "token", "f2", "request"),
  ];
  assert.deepEqual(
    crumbsOf(items, crumbCollections, "r1").map((crumb) => [crumb.kind, crumb.name]),
    [
      ["collection", "Reso API"],
      ["folder", "Auth"],
      ["folder", "Tokens"],
      ["request", "token"],
    ]
  );
});

test("an item at the top of a collection is collection then item", () => {
  const items = [crumbItem("r1", "health", null, "request")];
  assert.deepEqual(
    crumbsOf(items, crumbCollections, "r1").map((crumb) => crumb.name),
    ["Reso API", "health"]
  );
});

/** A tab open on a request that has since been deleted, which is ordinary. */
test("an item that is not there has no trail, rather than a broken one", () => {
  assert.deepEqual(crumbsOf([], crumbCollections, "gone"), []);
  assert.deepEqual(crumbsOf([], crumbCollections, null), []);
});

/** Half a sync, or a folder deleted while a tab was open on its child. */
test("a missing parent ends the walk instead of throwing", () => {
  const items = [crumbItem("r1", "token", "vanished", "request")];
  assert.deepEqual(
    crumbsOf(items, crumbCollections, "r1").map((crumb) => crumb.name),
    ["Reso API", "token"]
  );
});

test("a collection nobody can find is left off rather than drawn as empty", () => {
  const items = [crumbItem("r1", "token", null, "request")];
  assert.deepEqual(
    crumbsOf(items, [] as never, "r1").map((crumb) => crumb.name),
    ["token"]
  );
});

/** Nothing should ever write a cycle; a window that hangs because something
 * did would be a worse answer than a short trail. */
test("a cycle stops rather than spinning", () => {
  const items = [crumbItem("a", "A", "b", "folder"), crumbItem("b", "B", "a", "folder")];
  assert.ok(crumbsOf(items, crumbCollections, "a").length <= 3);
});
