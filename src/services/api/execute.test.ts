/**
 * The two pure pieces of the send pipeline: what a script is given to read, and
 * what the phase after it is given.
 *
 * `executeRequest` itself goes to the network, so it is not what this file
 * tests. These two are where the variables a script sees come from, and both
 * had a bug that made a script's own writes invisible — which is the kind of
 * thing that reads as "the environment is not updating" rather than as an
 * error, and so never shows up in a log.
 */

import assert from "node:assert/strict";
import { ApiEnvironment, ApiVariable } from "../../types/api";
import { ExecuteContext, scriptScopes, withScriptChanges } from "./execute";

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

function variable(partial: Partial<ApiVariable> & { key: string }): ApiVariable {
  return {
    id: partial.key,
    value: "",
    currentValue: null,
    enabled: true,
    secret: false,
    ...partial,
  };
}

function environment(partial: Partial<ApiEnvironment> & { id: string }): ApiEnvironment {
  return {
    name: partial.id,
    isGlobal: false,
    variables: [],
    ...partial,
  } as ApiEnvironment;
}

function context(partial: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    item: null,
    items: [],
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    draft: {
      method: "GET",
      url: "https://api.example.com",
      headers: [],
      body: { mode: "none", text: "", contentType: "application/json" },
      auth: { type: "noauth", params: {} },
      settings: {},
      scripts: { prerequest: "", test: "" },
    },
    name: "A request",
    ...partial,
  } as ExecuteContext;
}

console.log("api/execute");

/*
  The bug this file was written for.

  A script's writes are stored as the *current* value — on purpose, so a token
  fetched at runtime is never exported with the collection. The script scope
  then read the *initial* value, so `pm.environment.set` wrote to one field and
  `pm.environment.get` read another. The variable looked frozen, while
  `{{token}}` in the URL resolved to the new value perfectly, because the
  template resolver had always read the current one.
*/
test("a script reads the current value, not the initial one", () => {
  const scopes = scriptScopes(
    context({
      activeEnvironmentId: "staging",
      environments: [
        environment({
          id: "staging",
          name: "Northstar RESO Web API - staging",
          variables: [
            variable({ key: "authToken", value: "placeholder", currentValue: "the-real-one" }),
          ],
        }),
      ],
    })
  );

  assert.equal(scopes.environment.authToken, "the-real-one");
});

test("no current value falls back to the initial one", () => {
  const scopes = scriptScopes(
    context({
      activeEnvironmentId: "staging",
      environments: [
        environment({
          id: "staging",
          variables: [variable({ key: "base_url", value: "https://staging.example.com" })],
        }),
      ],
    })
  );

  assert.equal(scopes.environment.base_url, "https://staging.example.com");
});

test("an empty current value is a deliberate blank, not a fallback", () => {
  const scopes = scriptScopes(
    context({
      activeEnvironmentId: "staging",
      environments: [
        environment({
          id: "staging",
          variables: [variable({ key: "prefix", value: "v1", currentValue: "" })],
        }),
      ],
    })
  );

  assert.equal(scopes.environment.prefix, "");
});

test("a disabled variable is not in scope at all", () => {
  const scopes = scriptScopes(
    context({
      activeEnvironmentId: "staging",
      environments: [
        environment({
          id: "staging",
          variables: [variable({ key: "old", value: "x", enabled: false })],
        }),
      ],
    })
  );

  assert.equal("old" in scopes.environment, false);
});

test("globals read the current value too", () => {
  const scopes = scriptScopes(
    context({
      environments: [
        environment({
          id: "globals",
          isGlobal: true,
          variables: [variable({ key: "host", value: "example.com", currentValue: "localhost" })],
        }),
      ],
    })
  );

  assert.equal(scopes.globals.host, "localhost");
});

test("the environment's name rides along, and is absent when none is active", () => {
  const active = scriptScopes(
    context({
      activeEnvironmentId: "staging",
      environments: [environment({ id: "staging", name: "Northstar RESO Web API - staging" })],
    })
  );
  assert.equal(active.environmentName, "Northstar RESO Web API - staging");

  assert.equal(scriptScopes(context()).environmentName, undefined);
});

test("a data row overrides the environment for the run", () => {
  const scopes = scriptScopes(
    context({
      activeEnvironmentId: "staging",
      environments: [
        environment({ id: "staging", variables: [variable({ key: "city", value: "Dhaka" })] }),
      ],
      data: { city: "Chattogram" },
    })
  );

  assert.equal(scopes.environment.city, "Chattogram");
});

/*
  The other half: a test script reads what the pre-request script set, in the
  same send, before any of it has been written to disk.
*/
test("the test phase sees what the pre-request phase set", () => {
  const merged = withScriptChanges(
    { globals: {}, collection: {}, environment: { old: "1" }, environmentName: "staging" },
    { globals: {}, collection: {}, environment: { authToken: "fresh" } }
  );

  assert.equal(merged.environment.authToken, "fresh");
  assert.equal(merged.environment.old, "1", "what was already there survives");
  assert.equal(merged.environmentName, "staging", "no script renames its environment");
});

test("an unset removes the name rather than storing the word null", () => {
  const merged = withScriptChanges(
    { globals: { a: "1" }, collection: {}, environment: { b: "2" } },
    { globals: { a: null }, collection: {}, environment: { b: null } }
  );

  assert.equal("a" in merged.globals, false);
  assert.equal("b" in merged.environment, false);
});

test("merging does not write through to the scopes it was given", () => {
  const before = { globals: {}, collection: {}, environment: { token: "old" } };
  withScriptChanges(before, { globals: {}, collection: {}, environment: { token: "new" } });
  assert.equal(before.environment.token, "old");
});

test("every scope carries its changes, not just the environment", () => {
  const merged = withScriptChanges(
    { globals: {}, collection: {}, environment: {} },
    {
      globals: { g: "1" },
      collection: { c: "2" },
      environment: { e: "3" },
    }
  );

  assert.deepEqual(
    [merged.globals.g, merged.collection.c, merged.environment.e],
    ["1", "2", "3"]
  );
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
