/**
 * Import, export, and the promise that nothing is lost in between.
 *
 * This is the most important test file in the feature. Everything else can be
 * fixed in a later version; a collection that comes back out of this app
 * missing its scripts cannot, because by then the file it came from has been
 * replaced by the one this app wrote.
 *
 * The fixture below is hand-built against the published v2.1.0 schema rather
 * than captured from a real export — this runs offline. It deliberately
 * includes the parts most likely to be dropped: a vendor-prefixed id, a
 * disabled header, a disabled query parameter, a path variable with a
 * description, pre-request and test scripts, an auth block, a saved example
 * response, a multipart body with a file part, and a `protocolProfileBehavior`
 * block nothing here reads. Running this against a genuine export from another
 * tool is the one check still outstanding.
 */

import assert from "node:assert/strict";
import { readDocument } from "./import";
import { writeCollection, writeCollectionFile, ExportBundle, ExportItem } from "./export";
import { detectKind, schemaVersion, SCHEMA_V2_1_0 } from "./schema";
import { writeEnvironment } from "./environment";

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

console.log("api/interchange");

const COLLECTION = {
  info: {
    _postman_id: "8f0c2b1a-0000-4000-8000-1234567890ab",
    name: "Example API",
    description: "Everything the service does.",
    schema: SCHEMA_V2_1_0,
    _exporter_id: "12345678",
  },
  item: [
    {
      name: "Users",
      item: [
        {
          name: "List users",
          event: [
            {
              listen: "prerequest",
              script: { type: "text/javascript", exec: ["console.log('before')"] },
            },
            {
              listen: "test",
              script: {
                type: "text/javascript",
                exec: ["pm.test('ok', () => pm.response.to.have.status(200));"],
              },
            },
          ],
          request: {
            method: "GET",
            header: [
              { key: "Accept", value: "application/json" },
              { key: "X-Debug", value: "1", disabled: true, description: "only in staging" },
            ],
            url: {
              raw: "{{base_url}}/users?page=1",
              host: ["{{base_url}}"],
              path: ["users"],
              query: [
                { key: "page", value: "1" },
                { key: "verbose", value: "true", disabled: true },
              ],
            },
          },
          response: [
            {
              name: "200 OK",
              originalRequest: { method: "GET", header: [], url: { raw: "{{base_url}}/users" } },
              status: "OK",
              code: 200,
              _postman_previewlanguage: "json",
              header: [{ key: "Content-Type", value: "application/json" }],
              body: '{"users":[]}',
            },
          ],
        },
        {
          name: "Get user",
          request: {
            auth: {
              type: "bearer",
              bearer: [{ key: "token", value: "{{token}}", type: "string" }],
            },
            method: "GET",
            header: [],
            url: {
              raw: "{{base_url}}/users/:id",
              host: ["{{base_url}}"],
              path: ["users", ":id"],
              variable: [{ key: "id", value: "1", description: "the user's id" }],
            },
          },
          response: [],
        },
      ],
    },
    {
      name: "Create user",
      request: {
        method: "POST",
        header: [{ key: "Content-Type", value: "application/json" }],
        body: {
          mode: "raw",
          raw: '{\n  "name": "Ada"\n}',
          options: { raw: { language: "json" } },
        },
        url: { raw: "{{base_url}}/users", host: ["{{base_url}}"], path: ["users"] },
      },
      response: [],
    },
    {
      name: "Sign in",
      request: {
        method: "POST",
        header: [],
        body: {
          mode: "urlencoded",
          urlencoded: [
            { key: "username", value: "ada" },
            { key: "password", value: "{{password}}" },
            { key: "remember", value: "1", disabled: true },
          ],
        },
        url: { raw: "{{base_url}}/session", host: ["{{base_url}}"], path: ["session"] },
      },
      response: [],
    },
    {
      name: "Upload avatar",
      request: {
        method: "POST",
        header: [],
        body: {
          mode: "formdata",
          formdata: [
            { key: "file", type: "file", src: "/home/ada/avatar.png" },
            { key: "caption", value: "me", type: "text" },
          ],
        },
        url: { raw: "{{base_url}}/avatar", host: ["{{base_url}}"], path: ["avatar"] },
      },
      response: [],
    },
  ],
  auth: { type: "apikey", apikey: [{ key: "key", value: "X-Api-Key", type: "string" }] },
  event: [{ listen: "prerequest", script: { type: "text/javascript", exec: [""] } }],
  variable: [{ key: "base_url", value: "https://api.example.com" }],
  protocolProfileBehavior: { disableBodyPruning: true },
};

/**
 * What the store would hand back, built from what the reader produced.
 *
 * Mirrors `import_collection` followed by `export_collection` in Rust: parent
 * indices become ids, and every row keeps the document it came from. Going
 * through this shape rather than comparing the reader to the writer directly is
 * what makes the test cover the path the app actually takes.
 */
function throughTheStore(text: string): ExportBundle {
  const outcome = readDocument(text, "fixture.json");
  const collection = outcome.collections[0]!;
  const ids = collection.items.map((_, index) => `i${index}`);

  const items: ExportItem[] = collection.items.map((item, index) => ({
    id: ids[index]!,
    parentId: item.parent === null ? null : ids[item.parent]!,
    kind: item.kind,
    name: item.name,
    // The two columns the store fills from the document, mirrored here exactly
    // as `export_collection` hands them over — a helper that left them out
    // would be testing a bundle the app never builds.
    description: item.description,
    variables: item.variables,
    rank: item.rank,
    auth: item.auth,
    events: item.events,
    raw: item.raw,
    request: item.request
      ? {
          method: item.request.method,
          url: item.request.url,
          headers: item.request.headers,
          body: item.request.body,
        }
      : null,
    examples: item.examples.map((example, at) => ({
      id: `e${index}-${at}`,
      name: example.name,
      status: example.status,
      statusText: example.statusText,
      headers: example.headers,
      body: example.body,
      raw: example.raw,
    })),
  }));

  return {
    name: collection.name,
    description: collection.description,
    auth: collection.auth,
    variables: collection.variables,
    events: collection.events,
    raw: collection.raw,
    items,
  };
}

const text = JSON.stringify(COLLECTION);

test("a collection is recognised, and its version read", () => {
  assert.equal(detectKind(COLLECTION), "collection");
  assert.equal(schemaVersion(COLLECTION), "2.1.0");
});

test("the tree comes across with its shape intact", () => {
  const outcome = readDocument(text, "fixture.json");
  const collection = outcome.collections[0]!;

  assert.equal(collection.name, "Example API");
  assert.equal(outcome.counts.folders, 1);
  assert.equal(outcome.counts.requests, 5);

  const names = collection.items.map((item) => item.name);
  assert.deepEqual(names, [
    "Users",
    "List users",
    "Get user",
    "Create user",
    "Sign in",
    "Upload avatar",
  ]);

  // The two under the folder point at it; the rest are at the top.
  assert.equal(collection.items[1]!.parent, 0);
  assert.equal(collection.items[2]!.parent, 0);
  assert.equal(collection.items[3]!.parent, null);
});

test("a disabled header arrives unticked rather than missing", () => {
  const request = readDocument(text, "f").collections[0]!.items[1]!.request!;
  assert.deepEqual(
    request.headers.map((header) => [header.name, header.enabled]),
    [
      ["Accept", true],
      ["X-Debug", false],
    ]
  );
});

test("the URL is the raw one the author typed, templates and all", () => {
  const collection = readDocument(text, "f").collections[0]!;
  assert.equal(collection.items[1]!.request!.url, "{{base_url}}/users?page=1");
  assert.equal(collection.items[2]!.request!.url, "{{base_url}}/users/:id");
});

test("scripts are carried even though nothing runs them yet", () => {
  const item = readDocument(text, "f").collections[0]!.items[1]!;
  const events = item.events as { listen: string }[];
  assert.equal(events.length, 2);
  assert.equal(events[0]!.listen, "prerequest");
});

test("a form body stays a form, disabled rows and all", () => {
  const signIn = readDocument(text, "f").collections[0]!.items[4]!.request!;
  assert.equal(signIn.body.mode, "urlencoded");
  assert.deepEqual(
    signIn.body.fields!.map((field) => [field.key, field.value, field.enabled]),
    [
      ["username", "ada", true],
      ["password", "{{password}}", true],
      ["remember", "1", false],
    ]
  );
});

test("a multipart body keeps its parts and the file each one points at", () => {
  const outcome = readDocument(text, "fixture.json");
  const upload = outcome.collections[0]!.items[5]!.request!;

  assert.equal(upload.body.mode, "formdata");
  const [file, caption] = upload.body.fields!;
  assert.equal(file!.kind, "file");
  assert.equal(file!.filePath, "/home/ada/avatar.png");
  assert.equal(caption!.kind, "text");
  assert.equal(caption!.value, "me");

  // A path is a path on the machine that wrote it, and that is worth saying
  // before somebody presses Send and gets a confusing failure.
  assert.ok(
    outcome.notes.every((note) => note.level !== "error"),
    "it is a warning at most, not a failure"
  );
});

test("a saved response comes across with its status and body", () => {
  const listUsers = readDocument(text, "f").collections[0]!.items[1]!;
  assert.equal(listUsers.examples.length, 1);

  const example = listUsers.examples[0]!;
  assert.equal(example.name, "200 OK");
  assert.equal(example.status, 200);
  assert.equal(example.statusText, "OK");
  assert.equal(example.body, '{"users":[]}');
  assert.deepEqual(example.headers, [
    { name: "Content-Type", value: "application/json" },
  ]);
});

test("renaming an example changes the name and nothing else", () => {
  const bundle = throughTheStore(text);
  const listUsers = bundle.items.find((item) => item.name === "List users")!;
  listUsers.examples[0]!.name = "Empty list";

  const written = writeCollection(bundle) as {
    item: { item: { response: { name: string; _postman_previewlanguage?: string }[] }[] }[];
  };
  const example = written.item[0]!.item[0]!.response[0]!;
  assert.equal(example.name, "Empty list");
  // The fields this model has no column for are still there.
  assert.equal(example._postman_previewlanguage, "json");
});

// ─── What a folder carries ───────────────────────────────────────────────────
//
// A folder in this format is a real thing: description, variables, auth and
// scripts, all inherited by everything under it. The description and the
// variables are the two that only became editable with the folder tab, so
// these check the whole way round rather than just the read.

/** A document with one folder that has something to say for itself. */
const WITH_FOLDER = {
  info: { name: "Service", schema: SCHEMA_V2_1_0 },
  item: [
    {
      name: "Users",
      description: "Everything under /users.",
      variable: [{ key: "page_size", value: "25" }],
      item: [{ name: "List", request: { method: "GET", url: { raw: "/users" } } }],
    },
  ],
};

/** The same, with the richer description shape the format also allows. */
const WITH_TYPED_FOLDER = {
  info: { name: "Service", schema: SCHEMA_V2_1_0 },
  item: [
    {
      name: "Users",
      description: { content: "Everything under **/users**.", type: "text/markdown" },
      item: [{ name: "List", request: { method: "GET", url: { raw: "/users" } } }],
    },
  ],
};

type WrittenFolder = {
  item: { name: string; description?: unknown; variable?: unknown[] }[];
};

test("a folder's description and variables are read out of the document", () => {
  const folder = readDocument(JSON.stringify(WITH_FOLDER), "f.json").collections[0]!.items[0]!;
  assert.equal(folder.kind, "folder");
  assert.equal(folder.description, "Everything under /users.");
  assert.deepEqual(folder.variables, [{ key: "page_size", value: "25" }]);
});

/** A request's stays in `raw`: nothing edits one, and a column nothing writes
 * back is a second place for the same string to disagree. */
test("a request's description is left where it was", () => {
  const request = readDocument(JSON.stringify(WITH_FOLDER), "f.json").collections[0]!.items[1]!;
  assert.equal(request.kind, "request");
  assert.equal(request.description, "");
});

test("an untouched folder goes back out unchanged", () => {
  const written = writeCollection(throughTheStore(JSON.stringify(WITH_FOLDER))) as WrittenFolder;
  assert.equal(written.item[0]!.description, "Everything under /users.");
  assert.deepEqual(written.item[0]!.variable, [{ key: "page_size", value: "25" }]);
});

test("an edited folder description is what goes out", () => {
  const bundle = throughTheStore(JSON.stringify(WITH_FOLDER));
  bundle.items.find((item) => item.name === "Users")!.description = "Now with pagination.";

  const written = writeCollection(bundle) as WrittenFolder;
  assert.equal(written.item[0]!.description, "Now with pagination.");
});

test("emptying a folder description removes the key rather than writing nothing", () => {
  const bundle = throughTheStore(JSON.stringify(WITH_FOLDER));
  bundle.items.find((item) => item.name === "Users")!.description = "";

  const written = writeCollection(bundle) as WrittenFolder;
  assert.ok(!("description" in written.item[0]!));
});

/** Unchanged means the original shape goes back — a typed description must not
 * flatten to a string just because an export ran. */
test("a typed folder description survives an export that did not touch it", () => {
  const written = writeCollection(
    throughTheStore(JSON.stringify(WITH_TYPED_FOLDER))
  ) as WrittenFolder;
  assert.deepEqual(written.item[0]!.description, {
    content: "Everything under **/users**.",
    type: "text/markdown",
  });
});

test("editing a typed folder description writes the new text", () => {
  const bundle = throughTheStore(JSON.stringify(WITH_TYPED_FOLDER));
  bundle.items.find((item) => item.name === "Users")!.description = "Plain now.";

  const written = writeCollection(bundle) as WrittenFolder;
  assert.equal(written.item[0]!.description, "Plain now.");
});

test("deleting a folder's last variable removes the key", () => {
  const bundle = throughTheStore(JSON.stringify(WITH_FOLDER));
  bundle.items.find((item) => item.name === "Users")!.variables = [];

  const written = writeCollection(bundle) as WrittenFolder;
  assert.ok(!("variable" in written.item[0]!));
});

/** A collection imported before the variables column existed has them only in
 * `raw`, and an export must not take that as "there are none". */
test("a null variables column leaves whatever the original had", () => {
  const bundle = throughTheStore(JSON.stringify(WITH_FOLDER));
  bundle.items.find((item) => item.name === "Users")!.variables = null;

  const written = writeCollection(bundle) as WrittenFolder;
  assert.deepEqual(written.item[0]!.variable, [{ key: "page_size", value: "25" }]);
});

test("an edited form is written back as a form", () => {
  const bundle = throughTheStore(text);
  const signIn = bundle.items.find((item) => item.name === "Sign in")!;
  signIn.request!.body = {
    ...signIn.request!.body,
    fields: [
      { id: "1", key: "username", value: "grace", enabled: true, kind: "text" },
    ],
  };

  const written = writeCollection(bundle) as { item: { request: { body: unknown } }[] };
  assert.deepEqual(written.item[2]!.request.body, {
    mode: "urlencoded",
    urlencoded: [{ key: "username", value: "grace" }],
  });
});

/** The promise the whole feature rests on. */
test("import then export gives back the same document", () => {
  const written = writeCollection(throughTheStore(text));
  assert.deepEqual(written, COLLECTION);
});

test("exporting twice is byte identical", () => {
  const bundle = throughTheStore(text);
  assert.equal(writeCollectionFile(bundle), writeCollectionFile(bundle));
});

test("an edit is the only difference an edit makes", () => {
  const bundle = throughTheStore(text);
  const created = bundle.items.find((item) => item.name === "Create user")!;
  created.request!.url = "{{base_url}}/people";

  const written = writeCollection(bundle) as typeof COLLECTION;
  const entry = written.item[1] as { request: { url: { raw: string; path: string[] } } };

  assert.equal(entry.request.url.raw, "{{base_url}}/people");
  assert.deepEqual(entry.request.url.path, ["people"]);
  // And nothing else moved: the untouched request still has its example
  // response, its scripts and its disabled header.
  assert.deepEqual(written.item[0], COLLECTION.item[0]);
  assert.deepEqual(written.protocolProfileBehavior, { disableBodyPruning: true });
});

test("an edited body is written as what it now is", () => {
  const bundle = throughTheStore(text);
  const created = bundle.items.find((item) => item.name === "Create user")!;
  created.request!.body = {
    mode: "raw",
    text: '{"name":"Grace"}',
    contentType: "application/json",
  };

  const written = writeCollection(bundle) as { item: { request: { body: unknown } }[] };
  assert.deepEqual(written.item[1]!.request.body, {
    mode: "raw",
    raw: '{"name":"Grace"}',
    options: { raw: { language: "json" } },
  });
});

// ─── v2.0.0 ──────────────────────────────────────────────────────────────────

const V2_0_0 = {
  info: {
    name: "Older",
    schema: "https://schema.example.com/json/collection/v2.0.0/collection.json",
  },
  item: [
    {
      name: "Sign in",
      request: {
        auth: { type: "basic", basic: { username: "ada", password: "secret" } },
        method: "POST",
        header: "Accept: application/json\r\nX-Trace: 1",
        url: "https://api.example.com/session",
      },
    },
  ],
};

test("a v2.0.0 collection is read, and says so", () => {
  const outcome = readDocument(JSON.stringify(V2_0_0), "old.json");
  assert.equal(outcome.kind, "collection");
  assert.ok(outcome.notes.some((note) => note.message.includes("v2.0.0")));

  const item = outcome.collections[0]!.items[0]!;
  assert.equal(item.request!.method, "POST");
  assert.equal(item.request!.url, "https://api.example.com/session");
  // A header block written as one string is still two headers.
  assert.deepEqual(
    item.request!.headers.map((header) => header.name),
    ["Accept", "X-Trace"]
  );
});

test("v2.0.0 auth parameters become the list v2.1.0 wants", () => {
  const outcome = readDocument(JSON.stringify(V2_0_0), "old.json");
  const auth = outcome.collections[0]!.items[0]!.auth as {
    type: string;
    basic: { key: string; value: string }[];
  };
  assert.equal(auth.type, "basic");
  assert.ok(Array.isArray(auth.basic));
  assert.deepEqual(auth.basic, [
    { key: "username", value: "ada", type: "string" },
    { key: "password", value: "secret", type: "string" },
  ]);
});

test("exporting an upgraded collection declares the current schema", () => {
  const outcome = readDocument(JSON.stringify(V2_0_0), "old.json");
  const collection = outcome.collections[0]!;
  const written = writeCollection({
    name: collection.name,
    description: collection.description,
    auth: collection.auth,
    variables: collection.variables,
    events: collection.events,
    raw: collection.raw,
    items: collection.items.map((item, index) => ({
      id: `i${index}`,
      parentId: null,
      kind: item.kind,
      name: item.name,
      description: item.description,
      variables: item.variables,
      rank: item.rank,
      auth: item.auth,
      events: item.events,
      raw: item.raw,
      request: item.request ?? null,
      examples: [],
    })),
  }) as { info: { schema: string } };

  assert.equal(written.info.schema, SCHEMA_V2_1_0);
});

// ─── Environments ────────────────────────────────────────────────────────────

const ENVIRONMENT = {
  id: "aaaaaaaa-0000-4000-8000-bbbbbbbbbbbb",
  name: "Staging",
  values: [
    { key: "base_url", value: "https://staging.example.com", type: "default", enabled: true },
    { key: "token", value: "shhh", type: "secret", enabled: false },
  ],
  _postman_variable_scope: "environment",
  _postman_exported_at: "2026-01-01T00:00:00.000Z",
};

test("an environment is recognised and read", () => {
  const outcome = readDocument(JSON.stringify(ENVIRONMENT), "staging.json");
  assert.equal(outcome.kind, "environment");

  const environment = outcome.environments[0]!;
  assert.equal(environment.name, "Staging");
  assert.equal(environment.isGlobal, false);
  assert.deepEqual(environment.variables, [
    { key: "base_url", value: "https://staging.example.com", enabled: true, secret: false },
    { key: "token", value: "shhh", enabled: false, secret: true },
  ]);
});

test("globals are told apart from an environment by their scope", () => {
  const globals = { ...ENVIRONMENT, name: "Globals", _postman_variable_scope: "globals" };
  const outcome = readDocument(JSON.stringify(globals), "globals.json");
  assert.equal(outcome.environments[0]!.isGlobal, true);
});

test("an environment goes back out as it came in", () => {
  const outcome = readDocument(JSON.stringify(ENVIRONMENT), "staging.json");
  const written = writeEnvironment(outcome.environments[0]!);
  assert.deepEqual(written, ENVIRONMENT);
});

/**
 * The promise the whole initial/current split rests on.
 *
 * An export writes the *initial* value. If it ever wrote the current one, a
 * collection shared with a colleague would carry the real token of whoever
 * exported it — which is the exact accident the pair exists to prevent.
 */
test("an export writes the shared value, never this machine's own", () => {
  const written = writeEnvironment({
    name: "Staging",
    isGlobal: false,
    raw: null,
    variables: [
      { key: "token", value: "put-yours-here", enabled: true, secret: true },
    ],
  }) as { values: { key: string; value: string }[] };

  assert.equal(written.values[0]!.value, "put-yours-here");
  assert.ok(
    !JSON.stringify(written).includes("currentValue"),
    "the current value has no place in the document at all"
  );
});

// ─── Everything else ─────────────────────────────────────────────────────────

test("a backup holding several documents is unpacked", () => {
  const dump = { collections: [COLLECTION], environments: [ENVIRONMENT] };
  const outcome = readDocument(JSON.stringify(dump), "backup.json");
  assert.equal(outcome.kind, "dump");
  assert.equal(outcome.collections.length, 1);
  assert.equal(outcome.environments.length, 1);
});

test("a file that is not JSON is reported, not thrown", () => {
  const outcome = readDocument("not json at all", "notes.txt");
  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.collections.length, 0);
  assert.equal(outcome.notes[0]!.level, "error");
});

test("a JSON file that is not a collection is reported", () => {
  const outcome = readDocument('{"hello":"world"}', "thing.json");
  assert.equal(outcome.kind, "unknown");
  assert.ok(outcome.notes.some((note) => note.level === "error"));
});

test("a collection with no schema line is read anyway, with a warning", () => {
  const unlabelled = { info: { name: "Nameless" }, item: [] };
  const outcome = readDocument(JSON.stringify(unlabelled), "x.json");
  assert.equal(outcome.collections.length, 1);
  assert.ok(outcome.notes.some((note) => note.level === "warning"));
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
