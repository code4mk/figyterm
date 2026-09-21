/**
 * What the editor sends, versus what it is holding.
 *
 * Both mistakes here are silent at the moment they are made: a disabled header
 * that goes out anyway is a request you did not write, and a `Content-Type`
 * quietly replaced is a request the server rejects for a reason that has
 * nothing to do with what you were testing.
 */

import assert from "node:assert/strict";
import {
  blankField,
  buildSendBody,
  buildSendInput,
  hasHeader,
  isBlankField,
  isSendable,
} from "./request";
import { BodyField, DEFAULT_SEND_OPTIONS, HeaderRow, RequestBody } from "../../types/api";

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

function header(name: string, value: string, enabled = true): HeaderRow {
  return { id: `${name}:${value}`, name, value, enabled };
}

function body(partial: Partial<RequestBody> = {}): RequestBody {
  return { mode: "none", text: "", contentType: "application/json", ...partial };
}

function build(headers: HeaderRow[], bodyValue: RequestBody) {
  return buildSendInput({
    id: "1",
    method: "POST",
    url: "https://example.com",
    headers,
    body: bodyValue,
    options: DEFAULT_SEND_OPTIONS,
  });
}

console.log("api/request");

test("disabled and unnamed rows never reach the wire", () => {
  assert.equal(isSendable(header("Accept", "*/*")), true);
  assert.equal(isSendable(header("Accept", "*/*", false)), false);
  assert.equal(isSendable(header("", "orphaned value")), false);
  assert.equal(isSendable(header("   ", "whitespace")), false);
});

test("only enabled, named rows are sent, trimmed", () => {
  const input = build(
    [
      header("  Accept  ", "*/*"),
      header("X-Off", "no", false),
      header("", "no name"),
    ],
    body()
  );
  assert.deepEqual(input.headers, [{ name: "Accept", value: "*/*" }]);
});

test("a raw body gets the editor's content type", () => {
  const input = build([], body({ mode: "raw", text: '{"a":1}' }));
  assert.deepEqual(input.body, { mode: "raw", text: '{"a":1}' });
  assert.deepEqual(input.headers, [
    { name: "Content-Type", value: "application/json" },
  ]);
});

test("a typed Content-Type wins, whatever its case", () => {
  const input = build(
    [header("content-type", "application/xml")],
    body({ mode: "raw", text: "<a/>" })
  );
  assert.deepEqual(input.headers, [{ name: "content-type", value: "application/xml" }]);
});

test("an empty raw body sends nothing, and no content type with it", () => {
  const input = build([], body({ mode: "raw", text: "" }));
  assert.deepEqual(input.body, { mode: "none" });
  assert.deepEqual(input.headers, []);
});

test("switching the body off keeps the text but does not send it", () => {
  const kept = body({ mode: "none", text: '{"a":1}' });
  const input = build([], kept);
  assert.deepEqual(input.body, { mode: "none" });
  assert.equal(kept.text, '{"a":1}');
});

// ─── Bodies ──────────────────────────────────────────────────────────────────

function field(partial: Partial<BodyField> & { key: string }): BodyField {
  return { ...blankField(partial.key), ...partial };
}

test("a form sends its enabled, named fields", () => {
  const wire = buildSendBody({
    mode: "urlencoded",
    text: "",
    contentType: "",
    fields: [
      field({ key: "user", value: "ada" }),
      field({ key: "off", value: "no", enabled: false }),
      field({ key: "  ", value: "unnamed" }),
    ],
  });
  assert.deepEqual(wire, {
    mode: "urlencoded",
    fields: [{ key: "user", value: "ada" }],
  });
});

test("a multipart field carries its file path", () => {
  const wire = buildSendBody({
    mode: "formdata",
    text: "",
    contentType: "",
    fields: [
      field({ key: "file", kind: "file", filePaths: ["/tmp/a.png"] }),
      field({ key: "caption", value: "me" }),
    ],
  });
  assert.deepEqual(wire, {
    mode: "formdata",
    fields: [
      { key: "file", value: "", filePaths: ["/tmp/a.png"] },
      { key: "caption", value: "me" },
    ],
  });
});

/*
  The rule the body editor keeps one trailing blank row by, and throws away
  abandoned rows by.

  The bug it is here to stop: marking the trailing row as a file part left it
  with no key, no value and no path yet, so it counted as blank, was dropped in
  the same breath, and a fresh Text row appeared in its place. The type selector
  snapped straight back to Text and the file picker was unreachable — which made
  multipart uploads look broken rather than fiddly. Choosing File is a decision,
  and a row carrying a decision is not an empty one.
*/
test("a row marked as a file part is not blank, even with nothing else in it", () => {
  assert.equal(isBlankField(blankField("a")), true, "a fresh row is blank");
  assert.equal(
    isBlankField({ ...blankField("a"), kind: "file" }),
    false,
    "choosing File is something said, so the row survives to be filled in"
  );
});

test("anything typed or chosen keeps a row", () => {
  assert.equal(isBlankField({ ...blankField("a"), key: "upload" }), false);
  assert.equal(isBlankField({ ...blankField("a"), value: "x" }), false);
  assert.equal(isBlankField({ ...blankField("a"), filePaths: ["/tmp/a.png"] }), false);
});

/* A file part still needs a name to be sent: multipart has nowhere to put an
   unnamed one. The editor warns about it; this is the half that drops it. */
test("a file part with no name is not sent", () => {
  const wire = buildSendBody({
    mode: "formdata",
    text: "",
    contentType: "",
    fields: [
      field({ key: "", kind: "file", filePaths: ["/tmp/a.png"] }),
      field({ key: "named", kind: "file", filePaths: ["/tmp/b.png"] }),
    ],
  });
  assert.deepEqual(wire, {
    mode: "formdata",
    fields: [{ key: "named", value: "", filePaths: ["/tmp/b.png"] }],
  });
});

test("a body that is empty in its own terms sends nothing at all", () => {
  const empty = { text: "", contentType: "" };
  assert.deepEqual(buildSendBody({ ...empty, mode: "urlencoded", fields: [] }), {
    mode: "none",
  });
  assert.deepEqual(buildSendBody({ ...empty, mode: "formdata", fields: [] }), {
    mode: "none",
  });
  assert.deepEqual(buildSendBody({ ...empty, mode: "file" }), { mode: "none" });
  assert.deepEqual(buildSendBody({ ...empty, mode: "graphql" }), { mode: "none" });
  assert.deepEqual(buildSendBody({ ...empty, mode: "raw" }), { mode: "none" });
});

test("a file body is its path", () => {
  assert.deepEqual(
    buildSendBody({ mode: "file", text: "", contentType: "", filePath: "/tmp/a.bin" }),
    { mode: "file", path: "/tmp/a.bin" }
  );
});

test("graphql keeps the query and the variables apart", () => {
  assert.deepEqual(
    buildSendBody({
      mode: "graphql",
      text: "{ me { id } }",
      contentType: "",
      graphqlVariables: '{"id":1}',
    }),
    { mode: "graphql", query: "{ me { id } }", variables: '{"id":1}' }
  );
});

/** The shape decides the type, so the editor must not also set the header. */
test("a form does not get a Content-Type header from the editor", () => {
  const input = build(
    [],
    {
      mode: "urlencoded",
      text: "",
      contentType: "application/json",
      fields: [field({ key: "a", value: "1" })],
    }
  );
  assert.deepEqual(input.headers, []);
});

test("hasHeader ignores case and surrounding space", () => {
  assert.equal(hasHeader([{ name: " Content-Type " }], "content-type"), true);
  assert.equal(hasHeader([{ name: "Accept" }], "content-type"), false);
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
