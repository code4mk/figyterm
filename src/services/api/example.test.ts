/**
 * Reading the request an example was captured from.
 *
 * Real documents write `originalRequest` in every shape the format allows, and
 * an example that cannot be read is still an example somebody kept — so
 * nothing here throws, and the absent case is told apart from the empty one.
 */

import assert from "node:assert/strict";
import { exampleContentType, exampleRequest } from "./example";

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

const ids = () => {
  let next = 0;
  return () => `h${next++}`;
};

console.log("api/example");

test("the method, URL, headers and body all come back", () => {
  const request = exampleRequest(
    {
      raw: {
        originalRequest: {
          method: "post",
          url: { raw: "{{base_url}}/users?page=1" },
          header: [{ key: "Accept", value: "application/json" }],
          body: { mode: "raw", raw: '{"name":"Ada"}' },
        },
      },
    },
    ids()
  );

  assert.ok(request);
  assert.equal(request!.method, "POST", "uppercased, whatever the document said");
  assert.equal(request!.url, "{{base_url}}/users?page=1");
  assert.deepEqual(
    request!.headers.map((header) => [header.name, header.value]),
    [["Accept", "application/json"]]
  );
  assert.equal(request!.body.mode, "raw");
  assert.equal(request!.body.text, '{"name":"Ada"}');
});

/** "Nothing was recorded" and "a GET to nowhere" are different answers, and
 * the pane says so rather than drawing an empty method as the truth. */
test("an example with no recorded request says so, rather than inventing one", () => {
  assert.equal(exampleRequest({ raw: null }, ids()), null);
  assert.equal(exampleRequest({ raw: {} }, ids()), null);
  assert.equal(exampleRequest({ raw: { originalRequest: "nonsense" } }, ids()), null);
});

test("a URL written as a structure is read like one", () => {
  const request = exampleRequest(
    {
      raw: {
        originalRequest: {
          method: "GET",
          url: { host: ["api", "example", "com"], path: ["v1", "users"], protocol: "https" },
        },
      },
    },
    ids()
  );
  assert.equal(request!.url, "https://api.example.com/v1/users");
});

test("a missing method is a GET, which is what the format means by absent", () => {
  const request = exampleRequest({ raw: { originalRequest: { url: "/x" } } }, ids());
  assert.equal(request!.method, "GET");
  assert.equal(request!.url, "/x");
});

test("a form body is read as a form, not as text", () => {
  const request = exampleRequest(
    {
      raw: {
        originalRequest: {
          method: "POST",
          url: "/token",
          body: {
            mode: "urlencoded",
            urlencoded: [{ key: "grant_type", value: "client_credentials" }],
          },
        },
      },
    },
    ids()
  );
  assert.equal(request!.body.mode, "urlencoded");
  assert.equal(request!.body.fields?.[0]?.key, "grant_type");
});

test("no headers at all is an empty list, not a crash", () => {
  const request = exampleRequest({ raw: { originalRequest: { method: "GET", url: "/x" } } }, ids());
  assert.ok(Array.isArray(request!.headers));
});

// ─── The response's own type ─────────────────────────────────────────────────

test("the content type is found however it is cased", () => {
  assert.equal(
    exampleContentType({ headers: [{ name: "content-type", value: "application/json" }] }),
    "application/json"
  );
  assert.equal(
    exampleContentType({ headers: [{ name: "Content-Type", value: "text/html" }] }),
    "text/html"
  );
});

test("no content type is undefined, which is common and not an error", () => {
  assert.equal(exampleContentType({ headers: null }), undefined);
  assert.equal(exampleContentType({ headers: [] }), undefined);
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
