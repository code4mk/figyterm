/**
 * Which scripts run, and in what order.
 *
 * Order is the whole of it: a collection-level script that sets an auth header
 * is useless if it runs after the request's own script has already read the
 * header, and a folder script that runs before its collection's would see a
 * variable that has not been set yet.
 */

import assert from "node:assert/strict";
import { ApiCollection, ApiItem } from "../../../types/api";
import { collectScripts, scriptFrom } from "./events";

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

function events(kind: string, lines: string[]) {
  return [{ listen: kind, script: { type: "text/javascript", exec: lines } }];
}

function item(partial: Partial<ApiItem> & { id: string }): ApiItem {
  return {
    collectionId: "c1",
    parentId: null,
    kind: "request",
    name: partial.id,
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

function collection(partial: Partial<ApiCollection> = {}): ApiCollection {
  return {
    id: "c1",
    workspaceId: "w",
    name: "API",
    description: "",
    rank: "V",
    updatedAt: 0,
    auth: null,
    variables: null,
    conflictedAt: null,
    events: null,
    ...partial,
  };
}

console.log("api/events");

test("a script is read out of the format's own shape", () => {
  const code = scriptFrom(events("test", ["const a = 1;", "const b = 2;"]), "test");
  assert.equal(code, "const a = 1;\nconst b = 2;");
});

test("the other kind of event is not this one", () => {
  const both = [
    ...events("prerequest", ["before();"]),
    ...events("test", ["after();"]),
  ];
  assert.equal(scriptFrom(both, "prerequest"), "before();");
  assert.equal(scriptFrom(both, "test"), "after();");
});

/** A block left behind after somebody deleted the body. */
test("an empty script is nothing to run", () => {
  assert.equal(scriptFrom(events("test", [""]), "test"), null);
  assert.equal(scriptFrom(events("test", ["  ", "\t"]), "test"), null);
  assert.equal(scriptFrom([], "test"), null);
  assert.equal(scriptFrom(null, "test"), null);
  assert.equal(scriptFrom("rubbish", "test"), null);
});

test("a script written as one string rather than lines still reads", () => {
  const written = [{ listen: "test", script: { exec: "one();\ntwo();" } }];
  assert.equal(scriptFrom(written, "test"), "one();\ntwo();");
});

/** The order everything else depends on. */
test("the outermost script runs first, and the request's own runs last", () => {
  const items = [
    item({
      id: "folder",
      kind: "folder",
      name: "Users",
      events: events("prerequest", ["folder();"]),
    }),
    item({
      id: "request",
      name: "List",
      parentId: "folder",
      events: events("prerequest", ["request();"]),
    }),
  ];

  const found = collectScripts({
    item: items[1]!,
    items,
    collections: [collection({ events: events("prerequest", ["collection();"]) })],
    kind: "prerequest",
  });

  assert.deepEqual(
    found.map((script) => [script.from, script.code]),
    [
      ["API", "collection();"],
      ["Users", "folder();"],
      ["List", "request();"],
    ]
  );
});

test("levels with no script of their own are simply absent", () => {
  const items = [
    item({ id: "folder", kind: "folder", name: "Users" }),
    item({ id: "request", name: "List", parentId: "folder", events: events("test", ["mine();"]) }),
  ];

  const found = collectScripts({
    item: items[1]!,
    items,
    collections: [collection()],
    kind: "test",
  });
  assert.deepEqual(
    found.map((script) => script.from),
    ["List"]
  );
});

test("a request that is not in a collection has only its own", () => {
  assert.deepEqual(
    collectScripts({ item: null, items: [], collections: [collection()], kind: "test" }),
    []
  );
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
