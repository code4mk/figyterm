/**
 * The `pm` object, exercised with the scripts people actually write.
 *
 * Every test below runs a real script string through `new Function`, which is
 * exactly what the sandbox does — so this file covers the whole surface without
 * a browser, a worker or a network. The sandbox itself adds only the lock-down
 * and the timeout; everything a script can *say* is checked here.
 */

import assert from "node:assert/strict";
import { createPm, ScriptContext, ScriptOutcome } from "./pm";

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

function context(partial: Partial<ScriptContext> = {}): ScriptContext {
  return {
    request: {
      method: "GET",
      url: "https://api.example.com/users",
      headers: [{ name: "Accept", value: "application/json" }],
      body: "",
    },
    scopes: { globals: {}, collection: {}, environment: {} },
    info: {
      requestName: "List users",
      iteration: 0,
      iterationCount: 1,
      eventName: "test",
    },
    now: () => 1_768_910_400_000,
    ...partial,
  };
}

/** Runs a script the way the sandbox does, and returns what it did. */
function run(code: string, ctx: ScriptContext = context()): ScriptOutcome {
  const { pm, console: shim, finish } = createPm(ctx);
  try {
    // eslint-disable-next-line no-new-func
    new Function("pm", "console", code)(pm, shim);
    return finish();
  } catch (error) {
    return finish(error);
  }
}

function jsonResponse(body: unknown, code = 200) {
  return {
    code,
    status: code === 200 ? "OK" : "Error",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: JSON.stringify(body),
    responseTime: 42,
    responseSize: JSON.stringify(body).length,
  };
}

console.log("api/pm");

test("the opening line of almost every real test script", () => {
  const outcome = run(
    `pm.test("status is 200", () => { pm.response.to.have.status(200); });`,
    context({ response: jsonResponse({ ok: true }) })
  );
  assert.deepEqual(outcome.tests, [{ name: "status is 200", passed: true }]);
});

test("a failing assertion is a failed test, not a broken script", () => {
  const outcome = run(
    `pm.test("status is 201", () => { pm.response.to.have.status(201); });`,
    context({ response: jsonResponse({}, 200) })
  );
  assert.equal(outcome.tests[0]!.passed, false);
  assert.ok(outcome.tests[0]!.error?.includes("200"), outcome.tests[0]!.error);
  assert.equal(outcome.error, undefined, "the script itself did not break");
});

test("a test that throws for another reason still reports, and names it", () => {
  const outcome = run(`pm.test("boom", () => { throw new TypeError("nope"); });`);
  assert.equal(outcome.tests[0]!.passed, false);
  assert.ok(outcome.tests[0]!.error?.includes("TypeError"));
});

test("a script that breaks outside a test is reported as a script error", () => {
  const outcome = run(`nonsense.that.does.not.exist();`);
  assert.ok(outcome.error?.includes("ReferenceError"), outcome.error);
  assert.deepEqual(outcome.tests, []);
});

test("the response body, as text and as JSON", () => {
  const outcome = run(
    `const body = pm.response.json();
     pm.test("has an id", () => { pm.expect(body.id).to.be.a("string"); });
     pm.test("raw text too", () => { pm.expect(pm.response.text()).to.include("abc"); });
     pm.test("timing", () => { pm.expect(pm.response.responseTime).to.be.below(1000); });`,
    context({ response: jsonResponse({ id: "abc" }) })
  );
  assert.deepEqual(
    outcome.tests.map((entry) => entry.passed),
    [true, true, true]
  );
});

test("a body that is not JSON fails the test rather than the run", () => {
  const outcome = run(`pm.test("json", () => { pm.response.json(); });`, {
    ...context(),
    response: { ...jsonResponse({}), body: "<html>nope</html>" },
  });
  assert.equal(outcome.tests[0]!.passed, false);
  assert.ok(outcome.tests[0]!.error?.includes("not JSON"));
});

test("response headers, by name, case-insensitively", () => {
  const outcome = run(
    `pm.test("type", () => {
       pm.response.to.have.header("content-type");
       pm.expect(pm.response.headers.get("Content-Type")).to.include("json");
     });`,
    context({ response: jsonResponse({}) })
  );
  assert.equal(outcome.tests[0]!.passed, true, outcome.tests[0]!.error);
});

test("the fluent response chain covers what scripts reach for", () => {
  const outcome = run(
    `pm.test("ok", () => { pm.response.to.be.ok; });
     pm.test("json", () => { pm.response.to.be.json; });
     pm.test("named status", () => { pm.response.to.have.status("OK"); });
     pm.test("body matches", () => { pm.response.to.have.jsonBody({ id: "abc" }); });`,
    context({ response: jsonResponse({ id: "abc" }) })
  );
  assert.deepEqual(
    outcome.tests.map((entry) => [entry.name, entry.passed]),
    [
      ["ok", true],
      ["json", true],
      ["named status", true],
      ["body matches", true],
    ]
  );
});

// ─── Variables ───────────────────────────────────────────────────────────────

test("a script sets a variable, and the change is reported rather than applied", () => {
  const ctx = context({
    scopes: { globals: {}, collection: {}, environment: { host: "example.com" } },
  });
  const outcome = run(`pm.environment.set("token", "abc123");`, ctx);

  assert.deepEqual(outcome.changes.environment, { token: "abc123" });
  // The context this ran against is untouched: the caller decides.
  assert.deepEqual(ctx.scopes.environment, { host: "example.com" });
});

test("unsetting is not the same as setting an empty string", () => {
  const outcome = run(
    `pm.environment.set("a", "");
     pm.environment.unset("b");`,
    context({
      scopes: { globals: {}, collection: {}, environment: { a: "1", b: "2" } },
    })
  );
  assert.deepEqual(outcome.changes.environment, { a: "", b: null });
});

test("the three scopes are kept apart", () => {
  const outcome = run(
    `pm.globals.set("g", "1");
     pm.collectionVariables.set("c", "2");
     pm.environment.set("e", "3");`
  );
  assert.deepEqual(outcome.changes.globals, { g: "1" });
  assert.deepEqual(outcome.changes.collection, { c: "2" });
  assert.deepEqual(outcome.changes.environment, { e: "3" });
});

test("pm.variables reads through the chain, innermost first", () => {
  const outcome = run(
    `pm.test("innermost wins", () => {
       pm.expect(pm.variables.get("host")).to.equal("environment");
       pm.expect(pm.variables.get("only_global")).to.equal("g");
       pm.expect(pm.variables.has("missing")).to.be.false;
     });`,
    context({
      scopes: {
        globals: { host: "globals", only_global: "g" },
        collection: { host: "collection" },
        environment: { host: "environment" },
      },
    })
  );
  assert.equal(outcome.tests[0]!.passed, true, outcome.tests[0]!.error);
});

test("a number set into a variable becomes its text, as it must on the wire", () => {
  const outcome = run(`pm.environment.set("count", 42);`);
  assert.deepEqual(outcome.changes.environment, { count: "42" });
});

// ─── The request ─────────────────────────────────────────────────────────────

test("a pre-request script rewrites the request, and the change is reported", () => {
  const outcome = run(
    `pm.request.headers.upsert({ key: "Authorization", value: "Bearer " + pm.environment.get("token") });
     pm.request.url = pm.request.url + "?page=2";`,
    context({
      scopes: { globals: {}, collection: {}, environment: { token: "abc" } },
      info: {
        requestName: "List users",
        iteration: 0,
        iterationCount: 1,
        eventName: "prerequest",
      },
    })
  );

  const changed = outcome.changes.request!;
  assert.equal(changed.url, "https://api.example.com/users?page=2");
  assert.equal(
    changed.headers.find((header) => header.name === "Authorization")?.value,
    "Bearer abc"
  );
});

test("a script that reads the request without changing it reports no change", () => {
  const outcome = run(`const method = pm.request.method;`);
  assert.equal(outcome.changes.request, undefined);
});

test("upsert replaces rather than repeating, and remove removes", () => {
  const outcome = run(
    `pm.request.headers.upsert({ key: "accept", value: "text/plain" });
     pm.request.headers.add({ key: "X-Trace", value: "1" });
     pm.request.headers.remove("X-Trace");`
  );
  const headers = outcome.changes.request!.headers;
  assert.deepEqual(headers, [{ name: "Accept", value: "text/plain" }]);
});

// ─── Everything else ─────────────────────────────────────────────────────────

test("console output is captured rather than lost", () => {
  const outcome = run(
    `console.log("hello", { a: 1 });
     console.warn("careful");
     console.error("bad");`
  );
  assert.deepEqual(
    outcome.logs.map((line) => line.level),
    ["log", "warn", "error"]
  );
  assert.ok(outcome.logs[0]!.text.includes("hello"));
  assert.ok(outcome.logs[0]!.text.includes('"a": 1'));
});

test("a script that logs a novel does not get to fill the panel", () => {
  const outcome = run(`console.log({ text: "x".repeat(10000) });`);
  assert.ok(outcome.logs[0]!.text.length < 2100, `${outcome.logs[0]!.text.length}`);
});

/** Silently doing nothing would be worse than saying so. */
test("sendRequest says it is not available rather than pretending", () => {
  const outcome = run(`pm.test("send", () => { pm.sendRequest(); });`);
  assert.equal(outcome.tests[0]!.passed, false);
  assert.ok(outcome.tests[0]!.error?.includes("not available"));
});

test("the run's own details are readable", () => {
  const outcome = run(
    `pm.test("info", () => {
       pm.expect(pm.info.requestName).to.equal("List users");
       pm.expect(pm.info.iteration).to.equal(0);
     });`
  );
  assert.equal(outcome.tests[0]!.passed, true, outcome.tests[0]!.error);
});

/*
  The environment's name, which a collection is entitled to read.

  Scripts in the wild pick a per-environment variable by slicing a prefix off
  it — `pm.environment.name.replace("Acme - ", "")` — and with no name at all
  that is a TypeError on the script's first line, before anything it was going
  to set. One missing property, and every script in the collection "did not
  finish".
*/
test("a script can read the environment's name", () => {
  const outcome = run(
    `pm.test("name", () => {
       pm.expect(pm.environment.name).to.equal("Northstar RESO Web API - staging");
     });`,
    context({
      scopes: {
        globals: {},
        collection: {},
        environment: {},
        environmentName: "Northstar RESO Web API - staging",
      },
    })
  );
  assert.equal(outcome.tests[0]!.passed, true, outcome.tests[0]!.error);
});

test("no environment selected leaves the name undefined rather than throwing", () => {
  const outcome = run(`pm.variables.set("seen", String(pm.environment.name));`);
  assert.equal(outcome.error, undefined, outcome.error);
  assert.equal(outcome.changes.environment.seen, "undefined");
});

test("only the environment carries a name, as in Postman", () => {
  const outcome = run(
    `pm.test("scopes", () => {
       pm.expect(pm.globals.name).to.be.undefined;
       pm.expect(pm.collectionVariables.name).to.be.undefined;
     });`,
    context({
      scopes: { globals: {}, collection: {}, environment: {}, environmentName: "staging" },
    })
  );
  assert.equal(outcome.tests[0]!.passed, true, outcome.tests[0]!.error);
});

/* The script from the bug report, start to finish. */
test("a per-environment token lookup runs end to end", () => {
  const outcome = run(
    `const environmentName = pm.environment.name;
     const onlyEnvironment = environmentName.replace("Northstar RESO Web API - ", "");
     const variableName = "authToken_" + onlyEnvironment;
     let authToken = pm.collectionVariables.get(variableName);
     if (!authToken) authToken = pm.environment.get(variableName);
     if (!authToken) authToken = pm.globals.get(variableName);
     if (authToken) pm.variables.set("authToken", authToken);
     console.log("Environment: " + environmentName);`,
    context({
      scopes: {
        globals: {},
        collection: { authToken_staging: "abc.def.ghi" },
        environment: {},
        environmentName: "Northstar RESO Web API - staging",
      },
    })
  );
  assert.equal(outcome.error, undefined, outcome.error);
  assert.equal(outcome.changes.environment.authToken, "abc.def.ghi");
  assert.ok(outcome.logs[0]!.text.includes("Northstar RESO Web API - staging"));
});

test("several tests in one script all report", () => {
  const outcome = run(
    `pm.test("one", () => pm.expect(1).to.equal(1));
     pm.test("two", () => pm.expect(1).to.equal(2));
     pm.test("three", () => pm.expect(3).to.equal(3));`
  );
  assert.deepEqual(
    outcome.tests.map((entry) => entry.passed),
    [true, false, true]
  );
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
