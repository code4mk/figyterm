/**
 * Variable resolution, and what happens when a value is missing.
 *
 * The case that matters most is the last one: a request with an unresolved
 * variable must come back saying so, with the text untouched. The alternative —
 * substituting an empty string — sends `Authorization: Bearer ` to production
 * and produces a 401 that looks like a server problem.
 */

import assert from "node:assert/strict";
import { RequestBody } from "../../types/api";
import {
  DYNAMIC_VARIABLES,
  Dynamics,
  dynamicValue,
  findTemplates,
  isDynamic,
  lookup,
  resolveBody,
  resolveRequest,
  resolveText,
  Scope,
} from "./template";

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

/** Fixed values, so a test of the substitution is not a test of the clock. */
const FIXED: Dynamics = {
  uuid: () => "00000000-0000-4000-8000-000000000000",
  now: () => new Date("2026-01-20T12:00:00.000Z"),
  randomInt: () => 7,
};

function scope(label: string, variables: Record<string, string>, enabled = true): Scope {
  return {
    label,
    variables: Object.entries(variables).map(([key, value]) => ({ key, value, enabled })),
  };
}

console.log("api/template");

test("templates are found, in order, without repeats", () => {
  assert.deepEqual(findTemplates("{{a}}/{{b}}?x={{a}}"), ["a", "b"]);
  assert.deepEqual(findTemplates("nothing here"), []);
  // Whitespace inside the braces is tolerated; people type it.
  assert.deepEqual(findTemplates("{{ spaced }}"), ["spaced"]);
});

test("the innermost scope wins", () => {
  const scopes = [
    scope("Collection", { host: "collection.example.com" }),
    scope("Staging", { host: "staging.example.com", token: "abc" }),
    scope("Globals", { host: "globals.example.com", token: "zzz" }),
  ];
  assert.equal(resolveText("{{host}}", scopes).text, "collection.example.com");
  assert.equal(resolveText("{{token}}", scopes).text, "abc");
});

test("a disabled variable falls through rather than shadowing with nothing", () => {
  const scopes = [
    scope("Staging", { token: "disabled-value" }, false),
    scope("Globals", { token: "fallback" }),
  ];
  assert.equal(resolveText("{{token}}", scopes).text, "fallback");
});

test("lookup says where a value came from", () => {
  const scopes = [scope("Collection", { a: "1" }), scope("Globals", { b: "2" })];
  assert.deepEqual(lookup("a", scopes), { value: "1", from: "Collection" });
  assert.deepEqual(lookup("b", scopes), { value: "2", from: "Globals" });
  assert.equal(lookup("c", scopes), null);
});

test("a value that contains variables is resolved too", () => {
  const scopes = [
    scope("Env", {
      base_url: "{{protocol}}://{{host}}",
      protocol: "https",
      host: "api.example.com",
    }),
  ];
  assert.equal(resolveText("{{base_url}}/users", scopes).text, "https://api.example.com/users");
});

/** A variable that refers to itself must stop, not hang the window. */
test("a cycle stops rather than running forever", () => {
  const scopes = [scope("Env", { a: "{{b}}", b: "{{a}}" })];
  const resolution = resolveText("{{a}}", scopes);
  assert.ok(resolution.text.includes("{{"), "it gives up with the text still templated");
});

test("an unknown variable is reported and left exactly as written", () => {
  const resolution = resolveText("Bearer {{token}}", [scope("Env", {})]);
  assert.equal(resolution.text, "Bearer {{token}}");
  assert.deepEqual(resolution.unresolved, ["token"]);
});

test("text with no variables comes back untouched", () => {
  const resolution = resolveText("https://example.com", [scope("Env", { a: "1" })]);
  assert.equal(resolution.text, "https://example.com");
  assert.deepEqual(resolution.unresolved, []);
});

test("generated values are generated", () => {
  assert.equal(isDynamic("$guid"), true);
  assert.equal(isDynamic("token"), false);

  assert.equal(resolveText("{{$guid}}", [], FIXED).text, "00000000-0000-4000-8000-000000000000");
  assert.equal(resolveText("{{$timestamp}}", [], FIXED).text, "1768910400");
  assert.equal(resolveText("{{$isoTimestamp}}", [], FIXED).text, "2026-01-20T12:00:00.000Z");
  assert.equal(resolveText("{{$randomInt}}", [], FIXED).text, "7");
});

test("an unknown generated value is reported, not invented", () => {
  const resolution = resolveText("{{$randomMoonPhase}}", [], FIXED);
  assert.deepEqual(resolution.unresolved, ["$randomMoonPhase"]);
  assert.equal(resolution.text, "{{$randomMoonPhase}}");
});

test("a variable can be set to a value that is itself dynamic", () => {
  const scopes = [scope("Env", { trace: "{{$guid}}" })];
  assert.equal(
    resolveText("{{trace}}", scopes, FIXED).text,
    "00000000-0000-4000-8000-000000000000"
  );
});

test("a whole request resolves, header names included", () => {
  const scopes = [
    scope("Env", {
      base_url: "https://api.example.com",
      auth_header: "X-Api-Key",
      key: "abc123",
      id: "42",
    }),
  ];

  const resolved = resolveRequest(
    {
      url: "{{base_url}}/users/{{id}}",
      headers: [
        { name: "{{auth_header}}", value: "{{key}}", enabled: true },
        { name: "Accept", value: "application/json", enabled: true },
      ],
      body: '{"id":"{{id}}"}',
    },
    scopes,
    FIXED
  );

  assert.equal(resolved.url, "https://api.example.com/users/42");
  assert.equal(resolved.headers[0]!.name, "X-Api-Key");
  assert.equal(resolved.headers[0]!.value, "abc123");
  assert.equal(resolved.body, '{"id":"42"}');
  assert.deepEqual(resolved.unresolved, []);
});

test("everything missing across a request is collected once each", () => {
  const resolved = resolveRequest(
    {
      url: "{{base_url}}/users/{{id}}",
      headers: [{ name: "Authorization", value: "Bearer {{token}}", enabled: true }],
      body: "{{id}}",
    },
    [],
    FIXED
  );

  assert.deepEqual(resolved.unresolved, ["base_url", "id", "token"]);
  // And nothing was emptied on the way.
  assert.equal(resolved.url, "{{base_url}}/users/{{id}}");
  assert.equal(resolved.headers[0]!.value, "Bearer {{token}}");
});

// ─── The body, every mode of it ──────────────────────────────────────────────
//
// Only `raw` used to be resolved. A form field holding `{{client_id}}` was sent
// with the braces still in it, and because nothing scanned those fields the
// unresolved check did not stop the send either — so the request looked correct
// and the server replied about an application literally called
// "{{client_id}}". These are the modes that were silently untouched.

const CREDS: Scope[] = [
  {
    label: "Env",
    variables: [
      { key: "client_id", value: "abc-123", enabled: true },
      { key: "secret", value: "s3cret", enabled: true },
      { key: "fixtures", value: "/home/ada/fixtures", enabled: true },
    ],
  },
];

const body = (partial: Partial<RequestBody>): RequestBody => ({
  mode: "none",
  text: "",
  contentType: "application/json",
  ...partial,
});

test("a raw body still resolves", () => {
  const { body: out, unresolved } = resolveBody(
    body({ mode: "raw", text: '{"id":"{{client_id}}"}' }),
    CREDS,
    FIXED
  );
  assert.equal(out.text, '{"id":"abc-123"}');
  assert.deepEqual(unresolved, []);
});

/** The one that was actually broken, and the shape of an OAuth token request. */
test("a form field's value resolves", () => {
  const { body: out } = resolveBody(
    body({
      mode: "urlencoded",
      fields: [
        { id: "1", key: "grant_type", value: "client_credentials", enabled: true, kind: "text" },
        { id: "2", key: "client_id", value: "{{client_id}}", enabled: true, kind: "text" },
        { id: "3", key: "client_secret", value: "{{secret}}", enabled: true, kind: "text" },
      ],
    }),
    CREDS,
    FIXED
  );
  assert.deepEqual(
    out.fields!.map((field) => field.value),
    ["client_credentials", "abc-123", "s3cret"]
  );
});

test("a multipart field's value resolves too", () => {
  const { body: out } = resolveBody(
    body({
      mode: "formdata",
      fields: [{ id: "1", key: "who", value: "{{client_id}}", enabled: true, kind: "text" }],
    }),
    CREDS,
    FIXED
  );
  assert.equal(out.fields![0]!.value, "abc-123");
});

test("a field name resolves, which is rarer but not a mistake", () => {
  const { body: out } = resolveBody(
    body({
      mode: "urlencoded",
      fields: [{ id: "1", key: "{{client_id}}", value: "x", enabled: true, kind: "text" }],
    }),
    CREDS,
    FIXED
  );
  assert.equal(out.fields![0]!.key, "abc-123");
});

test("a GraphQL query and its variables both resolve", () => {
  const { body: out } = resolveBody(
    body({
      mode: "graphql",
      text: "query { user(id: \"{{client_id}}\") { name } }",
      graphqlVariables: '{"id":"{{client_id}}"}',
    }),
    CREDS,
    FIXED
  );
  assert.ok(out.text.includes("abc-123"));
  assert.equal(out.graphqlVariables, '{"id":"abc-123"}');
});

test("a file path resolves, because a path is a string like any other", () => {
  const { body: out } = resolveBody(
    body({ mode: "file", filePath: "{{fixtures}}/avatar.png" }),
    CREDS,
    FIXED
  );
  assert.equal(out.filePath, "/home/ada/fixtures/avatar.png");

  const part = resolveBody(
    body({
      mode: "formdata",
      fields: [
        { id: "1", key: "f", value: "", enabled: true, kind: "file", filePath: "{{fixtures}}/a.png" },
      ],
    }),
    CREDS,
    FIXED
  );
  assert.equal(part.body.fields![0]!.filePath, "/home/ada/fixtures/a.png");
});

/** Without this the send is not blocked, which is how the braces reached the
 * server in the first place. */
test("a name nothing defines is reported, so the send can be stopped", () => {
  const { unresolved } = resolveBody(
    body({
      mode: "urlencoded",
      fields: [{ id: "1", key: "client_id", value: "{{nope}}", enabled: true, kind: "text" }],
    }),
    CREDS,
    FIXED
  );
  assert.deepEqual(unresolved, ["nope"]);
});

test("each missing name is reported once, however many times it appears", () => {
  const { unresolved } = resolveBody(
    body({
      mode: "urlencoded",
      fields: [
        { id: "1", key: "a", value: "{{nope}}", enabled: true, kind: "text" },
        { id: "2", key: "b", value: "{{nope}}", enabled: true, kind: "text" },
      ],
    }),
    CREDS,
    FIXED
  );
  assert.deepEqual(unresolved, ["nope"]);
});

test("a body with nothing in it comes back with nothing in it", () => {
  const { body: out, unresolved } = resolveBody(body({ mode: "none" }), CREDS, FIXED);
  assert.equal(out.mode, "none");
  assert.equal(out.fields, undefined);
  assert.deepEqual(unresolved, []);
});

test("an unticked field is resolved too, so unticking it back on is not a surprise", () => {
  const { body: out } = resolveBody(
    body({
      mode: "urlencoded",
      fields: [{ id: "1", key: "k", value: "{{client_id}}", enabled: false, kind: "text" }],
    }),
    CREDS,
    FIXED
  );
  assert.equal(out.fields![0]!.value, "abc-123");
});

/** The suggestion list is written beside the switch that resolves these, so it
 * can drift from it. A name here that resolves to nothing would be a
 * suggestion that inserts something the send then refuses. */
test("every generated value offered is one that really resolves", () => {
  for (const entry of DYNAMIC_VARIABLES) {
    assert.notEqual(
      dynamicValue(entry.name, FIXED),
      null,
      `${entry.name} is offered but does not resolve`
    );
    assert.ok(entry.hint.length > 0, `${entry.name} says what it is`);
    assert.ok(isDynamic(entry.name), `${entry.name} is recognised as generated`);
  }
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
