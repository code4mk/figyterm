/**
 * Reading a pasted cURL command, and writing one back.
 *
 * The tokenizer is the part worth testing hardest. A JSON body is full of
 * quotes and braces, and a naive split on whitespace turns one body into six
 * arguments — which does not fail loudly, it just sends the wrong thing.
 */

import assert from "node:assert/strict";
import { looksLikeCurl, parseCurl, tokenize } from "./curl";
import { generate } from "./codegen";
import { RequestBody } from "../../../types/api";

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

console.log("api/curl");

test("a paste is recognised as a command, or not", () => {
  assert.equal(looksLikeCurl("curl https://example.com"), true);
  assert.equal(looksLikeCurl("  curl -X POST https://example.com"), true);
  assert.equal(looksLikeCurl("https://example.com"), false);
  assert.equal(looksLikeCurl("curling"), false);
});

test("quotes hold a JSON body together", () => {
  const tokens = tokenize(`curl -d '{"name": "Ada", "ok": true}' https://example.com`);
  assert.deepEqual(tokens, ["curl", "-d", '{"name": "Ada", "ok": true}', "https://example.com"]);
});

test("a line continuation is not an argument", () => {
  const tokens = tokenize("curl \\\n  -X POST \\\n  https://example.com");
  assert.deepEqual(tokens, ["curl", "-X", "POST", "https://example.com"]);
});

test("an escaped quote inside double quotes survives", () => {
  assert.deepEqual(tokenize(`curl -d "{\\"a\\":1}"`), ["curl", "-d", '{"a":1}']);
});

test("an empty argument is still an argument", () => {
  assert.deepEqual(tokenize(`curl -H '' https://example.com`), [
    "curl",
    "-H",
    "",
    "https://example.com",
  ]);
});

test("the shape of a browser's copy-as-cURL", () => {
  const parsed = parseCurl(`curl 'https://api.example.com/v1/users?page=2' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer abc123' \\
  --compressed`)!;

  assert.equal(parsed.method, "GET");
  assert.equal(parsed.url, "https://api.example.com/v1/users?page=2");
  assert.deepEqual(
    parsed.headers.map((header) => [header.name, header.value]),
    [
      ["accept", "application/json"],
      ["authorization", "Bearer abc123"],
    ]
  );
  assert.equal(parsed.body.mode, "none");
});

test("data with no method is a POST, as curl itself would send it", () => {
  const parsed = parseCurl(`curl https://example.com/session -d 'user=ada&pass=x'`)!;
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.body.mode, "raw");
  assert.equal(parsed.body.text, "user=ada&pass=x");
  // curl's own default content type when there is data and no header.
  assert.equal(parsed.body.contentType, "application/x-www-form-urlencoded");
});

test("an explicit content type wins over the default", () => {
  const parsed = parseCurl(
    `curl -X POST https://example.com -H 'Content-Type: application/json' -d '{"a":1}'`
  )!;
  assert.equal(parsed.body.contentType, "application/json");
  assert.equal(parsed.body.text, '{"a":1}');
});

test("several data flags join the way curl joins them", () => {
  const parsed = parseCurl(`curl https://example.com -d a=1 -d b=2`)!;
  assert.equal(parsed.body.text, "a=1&b=2");
});

test("-G moves the data into the query", () => {
  const parsed = parseCurl(`curl -G https://example.com/search -d q=cats -d page=2`)!;
  assert.equal(parsed.method, "GET");
  assert.equal(parsed.url, "https://example.com/search?q=cats&page=2");
  assert.equal(parsed.body.mode, "none");
});

test("credentials become an Authorization header", () => {
  const parsed = parseCurl(`curl -u ada:secret https://example.com`)!;
  const auth = parsed.headers.find((header) => header.name === "Authorization")!;
  assert.equal(auth.value, "Basic YWRhOnNlY3JldA==");
});

test("the flags that map to headers do", () => {
  const parsed = parseCurl(
    `curl https://example.com -A 'Mozilla/5.0' -e https://ref.example -b 'sid=1'`
  )!;
  const byName = Object.fromEntries(parsed.headers.map((h) => [h.name, h.value]));
  assert.equal(byName["User-Agent"], "Mozilla/5.0");
  assert.equal(byName["Referer"], "https://ref.example");
  assert.equal(byName["Cookie"], "sid=1");
});

test("a form upload becomes a multipart body, files and all", () => {
  const parsed = parseCurl(
    `curl https://example.com -F file=@/tmp/a.png;type=image/png -F caption=me`
  )!;

  assert.equal(parsed.method, "POST");
  assert.equal(parsed.body.mode, "formdata");
  const [file, caption] = parsed.body.fields!;
  assert.equal(file!.kind, "file");
  assert.deepEqual(file!.filePaths, ["/tmp/a.png"]);
  assert.equal(file!.contentType, "image/png");
  assert.equal(caption!.kind, "text");
  assert.equal(caption!.value, "me");
});

/** A generated multipart command has to read back as the same one. */
test("multipart survives a trip out through the generator and back", () => {
  const request = {
    method: "POST",
    url: "https://example.com/upload",
    headers: [],
    body: {
      mode: "formdata",
      text: "",
      contentType: "",
      fields: [
        { id: "1", key: "file", value: "", enabled: true, kind: "file" as const, filePaths: ["/tmp/a.png"] },
        { id: "2", key: "caption", value: "me", enabled: true, kind: "text" as const },
      ],
    } as RequestBody,
  };

  const parsed = parseCurl(generate("curl", request))!;
  assert.equal(parsed.body.mode, "formdata");
  assert.deepEqual(parsed.body.fields![0]!.filePaths, ["/tmp/a.png"]);
  assert.equal(parsed.body.fields![1]!.value, "me");
});

test("skipping certificate checks is reported rather than silently obeyed", () => {
  const parsed = parseCurl(`curl -k https://self-signed.example.com`)!;
  assert.ok(parsed.notes.some((note) => note.includes("certificate")));
});

test("templates survive the trip", () => {
  const parsed = parseCurl(`curl '{{base_url}}/users/{{id}}' -H 'X-Key: {{key}}'`)!;
  assert.equal(parsed.url, "{{base_url}}/users/{{id}}");
  assert.equal(parsed.headers[0]!.value, "{{key}}");
});

test("a command with no URL is not a request", () => {
  assert.equal(parseCurl("curl -X POST"), null);
  assert.equal(parseCurl(""), null);
});

test("an unknown flag is skipped, and the URL is still found", () => {
  const parsed = parseCurl(`curl --http2 https://example.com`)!;
  assert.equal(parsed.url, "https://example.com");
});

// ─── Writing it back out ─────────────────────────────────────────────────────

const REQUEST = {
  method: "POST",
  url: "https://api.example.com/users",
  headers: [
    { id: "1", name: "Accept", value: "application/json", enabled: true },
    { id: "2", name: "X-Off", value: "no", enabled: false },
  ],
  body: {
    mode: "raw",
    text: '{"name":"Ada"}',
    contentType: "application/json",
  } as RequestBody,
};


test("generated cURL round-trips back through the parser", () => {
  const command = generate("curl", REQUEST);
  const parsed = parseCurl(command)!;

  assert.equal(parsed.method, "POST");
  assert.equal(parsed.url, REQUEST.url);
  assert.equal(parsed.body.text, '{"name":"Ada"}');
  // The disabled header is not in the command, and the content type the editor
  // adds for the body is.
  const names = parsed.headers.map((header) => header.name);
  assert.ok(names.includes("Accept"));
  assert.ok(!names.includes("X-Off"));
  assert.ok(names.includes("Content-Type"));
});

test("a body with a quote in it survives the shell", () => {
  const request = {
    ...REQUEST,
    body: { mode: "raw", text: `{"quote":"it's here"}`, contentType: "application/json" } as RequestBody,
  };
  const parsed = parseCurl(generate("curl", request))!;
  assert.equal(parsed.body.text, `{"quote":"it's here"}`);
});

test("every target produces something that mentions the request", () => {
  for (const target of ["fetch", "axios", "python", "go", "php"] as const) {
    const code = generate(target, REQUEST);
    assert.ok(code.includes("api.example.com/users"), `${target} is missing the URL`);
    assert.ok(code.includes("Ada"), `${target} is missing the body`);
    assert.ok(code.includes("Accept"), `${target} is missing the headers`);
    assert.ok(!code.includes("X-Off"), `${target} sent a disabled header`);
    assert.ok(code.includes("Content-Type"), `${target} is missing the content type`);
  }
});

test("a form body is generated as a form in every language", () => {
  const request = {
    ...REQUEST,
    body: {
      mode: "urlencoded",
      text: "",
      contentType: "",
      fields: [
        { id: "1", key: "user name", value: "ada", enabled: true, kind: "text" as const },
      ],
    } as RequestBody,
  };

  const parsed = parseCurl(generate("curl", request))!;
  assert.equal(parsed.body.text, "user%20name=ada");
  assert.equal(parsed.body.contentType, "application/x-www-form-urlencoded");

  for (const target of ["fetch", "axios", "python", "go", "php"] as const) {
    assert.ok(generate(target, request).includes("user%20name=ada"), target);
  }
});

test("a multipart body is generated with its parts", () => {
  const request = {
    ...REQUEST,
    body: {
      mode: "formdata",
      text: "",
      contentType: "",
      fields: [
        { id: "1", key: "file", value: "", enabled: true, kind: "file" as const, filePaths: ["/tmp/a.png"] },
        { id: "2", key: "caption", value: "me", enabled: true, kind: "text" as const },
      ],
    } as RequestBody,
  };

  const command = generate("curl", request);
  assert.ok(command.includes("--form 'file=@/tmp/a.png'"), command);
  assert.ok(command.includes("--form 'caption=me'"), command);
  // The boundary belongs to whatever sends it, so nothing may set the header.
  assert.ok(!command.includes("Content-Type: multipart"), command);

  assert.ok(generate("fetch", request).includes("new FormData()"));
  assert.ok(generate("go", request).includes("multipart.NewWriter"));
  assert.ok(generate("php", request).includes("new CURLFile"));
  assert.ok(generate("python", request).includes("files = {"));
});

test("a file body reads the file in every language", () => {
  const request = {
    ...REQUEST,
    body: { mode: "file", text: "", contentType: "", filePath: "/tmp/a.bin" } as RequestBody,
  };
  assert.ok(generate("curl", request).includes("--data-binary '@/tmp/a.bin'"));
  assert.ok(generate("python", request).includes('open("/tmp/a.bin", "rb")'));
  assert.ok(generate("go", request).includes('os.Open("/tmp/a.bin")'));
  assert.ok(generate("php", request).includes("file_get_contents('/tmp/a.bin')"));
});

test("a graphql body is generated as the JSON it becomes", () => {
  const request = {
    ...REQUEST,
    body: {
      mode: "graphql",
      text: "{ me { id } }",
      contentType: "",
      graphqlVariables: '{"id":1}',
    } as RequestBody,
  };
  const command = generate("curl", request);
  assert.ok(command.includes("Content-Type: application/json"), command);
  assert.ok(command.includes("me { id }"), command);
});

test("a request with no body leaves the body out entirely", () => {
  const request = {
    ...REQUEST,
    method: "GET",
    body: { mode: "none", text: "", contentType: "application/json" } as RequestBody,
  };
  assert.ok(!generate("fetch", request).includes("body:"));
  assert.ok(!generate("python", request).includes("payload"));
  assert.ok(generate("go", request).includes("nil"));
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
