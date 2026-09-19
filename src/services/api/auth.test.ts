/**
 * Auth, and the distinction the whole thing turns on: a request with no auth
 * block inherits, and a request with a `noauth` block does not.
 *
 * Getting that backwards breaks every request in a folder at the same moment,
 * and the symptom — a 401 from an endpoint that worked yesterday — points at
 * the server rather than at the client.
 */

import assert from "node:assert/strict";
import { applyAuth, effectiveAuth, NO_AUTH, readAuth, writeAuth } from "./auth";

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

const target = () => ({
  url: "https://api.example.com/users",
  headers: [{ name: "Accept", value: "application/json", enabled: true }],
});

console.log("api/auth");

test("a block is read out of the format's own shape", () => {
  const parsed = readAuth({
    type: "bearer",
    bearer: [{ key: "token", value: "abc", type: "string" }],
  });
  assert.deepEqual(parsed, { type: "bearer", params: { token: "abc" } });
});

test("the older object shape is read too", () => {
  const parsed = readAuth({ type: "basic", basic: { username: "ada", password: "x" } });
  assert.deepEqual(parsed, { type: "basic", params: { username: "ada", password: "x" } });
});

test("nothing at all is nothing, which is what makes inheritance work", () => {
  assert.equal(readAuth(null), null);
  assert.equal(readAuth(undefined), null);
  assert.equal(readAuth({}), null);
  assert.equal(readAuth("bearer"), null);
});

test("a block round-trips through the writer", () => {
  const block = writeAuth({ type: "apikey", params: { key: "X-Api-Key", value: "abc", in: "header" } });
  assert.deepEqual(readAuth(block), {
    type: "apikey",
    params: { key: "X-Api-Key", value: "abc", in: "header" },
  });
});

test("inherit is stored as nothing; no auth is stored as something", () => {
  assert.equal(writeAuth({ type: "inherit", params: {} }), null);
  assert.deepEqual(writeAuth({ type: "noauth", params: {} }), { type: "noauth" });
});

// ─── Inheritance ─────────────────────────────────────────────────────────────

test("an absent block inherits from the folder, then the collection", () => {
  const collection = { type: "bearer", bearer: [{ key: "token", value: "collection" }] };
  const folder = { type: "bearer", bearer: [{ key: "token", value: "folder" }] };

  assert.equal(effectiveAuth([null, null, collection]).params.token, "collection");
  assert.equal(effectiveAuth([null, folder, collection]).params.token, "folder");
});

/** The distinction this file exists for. */
test("an explicit no-auth stops the search rather than continuing it", () => {
  const collection = { type: "bearer", bearer: [{ key: "token", value: "collection" }] };
  assert.deepEqual(effectiveAuth([{ type: "noauth" }, null, collection]), NO_AUTH);
});

test("nothing anywhere is no auth", () => {
  assert.deepEqual(effectiveAuth([null, null, null]), NO_AUTH);
  assert.deepEqual(effectiveAuth([]), NO_AUTH);
});

// ─── Applying ────────────────────────────────────────────────────────────────

test("basic auth encodes the pair", () => {
  const applied = applyAuth({ type: "basic", params: { username: "ada", password: "secret" } }, target());
  const header = applied.headers.find((entry) => entry.name === "Authorization")!;
  assert.equal(header.value, "Basic YWRhOnNlY3JldA==");
});

test("a password outside Latin-1 does not throw", () => {
  const applied = applyAuth({ type: "basic", params: { username: "ada", password: "pässwörd" } }, target());
  assert.ok(applied.headers.some((entry) => entry.name === "Authorization"));
});

test("bearer is the token with a word in front", () => {
  const applied = applyAuth({ type: "bearer", params: { token: "abc123" } }, target());
  assert.equal(
    applied.headers.find((entry) => entry.name === "Authorization")!.value,
    "Bearer abc123"
  );
});

test("an API key goes in a header, or in the query when asked", () => {
  const inHeader = applyAuth(
    { type: "apikey", params: { key: "X-Api-Key", value: "abc" } },
    target()
  );
  assert.equal(inHeader.headers.find((entry) => entry.name === "X-Api-Key")!.value, "abc");
  assert.equal(inHeader.url, "https://api.example.com/users");

  const inQuery = applyAuth(
    { type: "apikey", params: { key: "api_key", value: "a b", in: "query" } },
    target()
  );
  assert.equal(inQuery.url, "https://api.example.com/users?api_key=a%20b");
});

test("an API key joins a query that already has parameters", () => {
  const applied = applyAuth(
    { type: "apikey", params: { key: "k", value: "1", in: "query" } },
    { url: "https://example.com?a=1", headers: [] }
  );
  assert.equal(applied.url, "https://example.com?a=1&k=1");
});

/** Two Authorization headers is a request most servers reject outright. */
test("auth replaces an Authorization header rather than adding a second", () => {
  const applied = applyAuth(
    { type: "bearer", params: { token: "new" } },
    {
      url: "https://example.com",
      headers: [{ name: "authorization", value: "Bearer old", enabled: true }],
    }
  );
  const authorizations = applied.headers.filter(
    (entry) => entry.name.toLowerCase() === "authorization"
  );
  assert.equal(authorizations.length, 1);
  assert.equal(authorizations[0]!.value, "Bearer new");
});

test("no auth changes nothing", () => {
  const original = target();
  assert.deepEqual(applyAuth(NO_AUTH, original), original);
});

test("a type this cannot apply says so instead of sending nothing quietly", () => {
  const applied = applyAuth({ type: "oauth2", params: { accessToken: "x" } }, target());
  assert.ok(applied.note?.includes("oauth2"));
  assert.equal(applied.headers.length, 1, "and it adds no credentials it cannot compute");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
