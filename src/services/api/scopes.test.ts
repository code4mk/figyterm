/**
 * Which value a request actually gets, and which auth block answers for it.
 *
 * Both walks go the same way and both are easy to get subtly wrong. The order
 * is the test: a staging environment must not beat a variable set on the
 * request itself, and a folder without an auth block must pass the question up
 * rather than answer it with nothing.
 */

import assert from "node:assert/strict";
import { ApiCollection, ApiEnvironment, ApiItem } from "../../types/api";
import { ancestry, authChain, buildScopes, variablesFrom, variablesTo } from "./scopes";
import { effectiveAuth } from "./auth";
import { resolveText } from "./template";

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

function item(partial: Partial<ApiItem> & { id: string }): ApiItem {
  return {
    collectionId: "c1",
    parentId: null,
    kind: "request",
    name: partial.id,
    rank: "V",
    updatedAt: 0,
    method: "GET",
    url: "",
    auth: null,
    variables: null,
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
    ...partial,
  };
}

function environment(
  id: string,
  name: string,
  isGlobal: boolean,
  values: Record<string, string>
): ApiEnvironment {
  return {
    id,
    name,
    isGlobal,
    updatedAt: 0,
    raw: null,
    variables: Object.entries(values).map(([key, value], index) => ({
      id: `${id}-${index}`,
      key,
      value,
      currentValue: null,
      enabled: true,
      secret: false,
    })),
    conflictedAt: null,
  };
}

console.log("api/scopes");

test("the format's variable list is read, disabled flag and all", () => {
  const variables = variablesFrom([
    { key: "a", value: "1" },
    { key: "b", value: 2 },
    { key: "c", value: "3", disabled: true },
    { value: "no key" },
    "rubbish",
  ]);
  assert.deepEqual(variables, [
    { key: "a", value: "1", enabled: true },
    { key: "b", value: "2", enabled: true },
    { key: "c", value: "3", enabled: false },
  ]);
  assert.deepEqual(variablesFrom(null), []);
});

test("and written back in the same shape", () => {
  assert.deepEqual(
    variablesTo([
      { key: "a", value: "1", enabled: true },
      { key: "b", value: "2", enabled: false },
    ]),
    [
      { key: "a", value: "1" },
      { key: "b", value: "2", disabled: true },
    ]
  );
});

test("ancestry runs from the request up to the top", () => {
  const items = [
    item({ id: "folder", kind: "folder" }),
    item({ id: "inner", kind: "folder", parentId: "folder" }),
    item({ id: "request", parentId: "inner" }),
  ];
  assert.deepEqual(
    ancestry(items[2]!, items).map((row) => row.id),
    ["request", "inner", "folder"]
  );
  assert.deepEqual(ancestry(null, items), []);
});

test("a broken parent chain does not loop forever", () => {
  const items = [item({ id: "a", parentId: "b" }), item({ id: "b", parentId: "a" })];
  assert.equal(ancestry(items[0]!, items).length, 2);
});

/** The order everything else depends on. */
test("the innermost scope comes first", () => {
  const items = [
    item({ id: "folder", kind: "folder", variables: [{ key: "host", value: "folder" }] }),
    item({
      id: "request",
      parentId: "folder",
      variables: [{ key: "host", value: "request" }],
    }),
  ];

  const scopes = buildScopes({
    item: items[1]!,
    items,
    collections: [collection({ variables: [{ key: "host", value: "collection" }] })],
    environments: [
      environment("e1", "Staging", false, { host: "environment" }),
      environment("g1", "Globals", true, { host: "globals" }),
    ],
    activeEnvironmentId: "e1",
  });

  assert.deepEqual(
    scopes.map((scope) => scope.label),
    ["request", "folder", "API", "Staging", "Globals"]
  );
  assert.equal(resolveText("{{host}}", scopes).text, "request");
});

test("with no environment selected, the collection and globals still apply", () => {
  const scopes = buildScopes({
    item: item({ id: "r" }),
    items: [item({ id: "r" })],
    collections: [collection({ variables: [{ key: "host", value: "collection" }] })],
    environments: [
      environment("e1", "Staging", false, { host: "environment" }),
      environment("g1", "Globals", true, { token: "globals" }),
    ],
    activeEnvironmentId: null,
  });

  assert.equal(resolveText("{{host}}", scopes).text, "collection");
  assert.equal(resolveText("{{token}}", scopes).text, "globals");
});

test("a scratch request with no collection still gets the environment", () => {
  const scopes = buildScopes({
    item: null,
    items: [],
    collections: [collection({ variables: [{ key: "host", value: "collection" }] })],
    environments: [environment("e1", "Staging", false, { host: "environment" })],
    activeEnvironmentId: "e1",
  });

  assert.deepEqual(
    scopes.map((scope) => scope.label),
    ["Staging"]
  );
  assert.equal(resolveText("{{host}}", scopes).text, "environment");
});

test("an environment that is not the active one is not consulted", () => {
  const scopes = buildScopes({
    item: null,
    items: [],
    collections: [],
    environments: [
      environment("e1", "Staging", false, { host: "staging" }),
      environment("e2", "Production", false, { host: "production" }),
    ],
    activeEnvironmentId: "e1",
  });
  assert.equal(resolveText("{{host}}", scopes).text, "staging");
});

// ─── Auth ────────────────────────────────────────────────────────────────────

test("a folder with no block passes the question up, and the collection answers", () => {
  const items = [
    item({ id: "folder", kind: "folder" }),
    item({ id: "request", parentId: "folder" }),
  ];
  const chain = authChain({
    item: items[1]!,
    items,
    collections: [collection({ auth: { type: "bearer", bearer: [{ key: "token", value: "c" }] } })],
    environments: [],
    activeEnvironmentId: null,
  });

  // Every link is present, gaps included — that is what lets the walk work.
  assert.deepEqual(chain.slice(0, 2), [null, null]);
  assert.equal(effectiveAuth(chain).params.token, "c");
});

test("a folder's block beats the collection's", () => {
  const items = [
    item({ id: "folder", kind: "folder", auth: { type: "bearer", bearer: [{ key: "token", value: "f" }] } }),
    item({ id: "request", parentId: "folder" }),
  ];
  const chain = authChain({
    item: items[1]!,
    items,
    collections: [collection({ auth: { type: "bearer", bearer: [{ key: "token", value: "c" }] } })],
    environments: [],
    activeEnvironmentId: null,
  });
  assert.equal(effectiveAuth(chain).params.token, "f");
});

test("a request's own no-auth stops the walk at the request", () => {
  const items = [
    item({ id: "folder", kind: "folder", auth: { type: "bearer", bearer: [{ key: "token", value: "f" }] } }),
    item({ id: "request", parentId: "folder", auth: { type: "noauth" } }),
  ];
  const chain = authChain({
    item: items[1]!,
    items,
    collections: [collection()],
    environments: [],
    activeEnvironmentId: null,
  });
  assert.equal(effectiveAuth(chain).type, "noauth");
});

// ─── The initial value and the current one ───────────────────────────────────
//
// The initial value is what a colleague gets; the current one is this
// machine's. Resolution has to take the current one, or the whole pair is
// decoration — and it has to keep taking the initial one when there is no
// current, or every environment breaks the day the column was added.

test("a current value is what resolves, not the shared one", () => {
  const staging = environment("e1", "Staging", false, { token: "put-yours-here" });
  staging.variables[0]!.currentValue = "the-real-one";

  const scopes = buildScopes({
    item: null,
    items: [],
    collections: [],
    environments: [staging],
    activeEnvironmentId: "e1",
  });
  assert.equal(resolveText("{{token}}", scopes).text, "the-real-one");
});

test("with no current value the shared one still resolves", () => {
  const scopes = buildScopes({
    item: null,
    items: [],
    collections: [],
    environments: [environment("e1", "Staging", false, { token: "shared" })],
    activeEnvironmentId: "e1",
  });
  assert.equal(resolveText("{{token}}", scopes).text, "shared");
});

/** Null and empty are different: an empty current value is somebody choosing
 * to send nothing, and falling back to the shared one would ignore them. */
test("a current value of nothing is an answer, not a gap", () => {
  const staging = environment("e1", "Staging", false, { token: "shared" });
  staging.variables[0]!.currentValue = "";

  const scopes = buildScopes({
    item: null,
    items: [],
    collections: [],
    environments: [staging],
    activeEnvironmentId: "e1",
  });
  assert.equal(resolveText("{{token}}", scopes).text, "");
});

test("globals follow the same rule", () => {
  const globals = environment("g", "Globals", true, { host: "shared.example.com" });
  globals.variables[0]!.currentValue = "localhost:3000";

  const scopes = buildScopes({
    item: null,
    items: [],
    collections: [],
    environments: [globals],
    activeEnvironmentId: null,
  });
  assert.equal(resolveText("{{host}}", scopes).text, "localhost:3000");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
