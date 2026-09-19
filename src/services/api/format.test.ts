/**
 * Reading a response.
 *
 * The content-type cases are the ones worth having: `application/vnd.api+json`
 * is JSON, `application/json` over an HTML error page is not, and a body that
 * claims nothing at all still has to render as something.
 */

import assert from "node:assert/strict";
import {
  contentKind,
  formatBytes,
  formatDuration,
  headerValue,
  prettyJson,
  statusTone,
  timeAgo,
} from "./format";

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

console.log("api/format");

test("header lookup ignores case", () => {
  const headers = [
    { name: "Content-Type", value: "application/json" },
    { name: "x-request-id", value: "abc" },
  ];
  assert.equal(headerValue(headers, "content-type"), "application/json");
  assert.equal(headerValue(headers, "X-Request-Id"), "abc");
  assert.equal(headerValue(headers, "etag"), undefined);
});

test("sizes read the way every other client reports them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1000), "1.0 kB");
  assert.equal(formatBytes(1400), "1.4 kB");
  assert.equal(formatBytes(15_000), "15 kB");
  assert.equal(formatBytes(2_500_000), "2.5 MB");
  assert.equal(formatBytes(-1), "—");
});

test("durations change unit where reading them changes", () => {
  assert.equal(formatDuration(0), "0 ms");
  assert.equal(formatDuration(243.4), "243 ms");
  assert.equal(formatDuration(1240), "1.24 s");
  assert.equal(formatDuration(125_000), "2 m 05 s");
});

test("a vendor JSON type is still JSON", () => {
  assert.equal(contentKind("application/json"), "json");
  assert.equal(contentKind("application/json; charset=utf-8"), "json");
  assert.equal(contentKind("application/vnd.api+json"), "json");
  assert.equal(contentKind("APPLICATION/JSON"), "json");
});

test("the other kinds land where they should", () => {
  assert.equal(contentKind("text/html; charset=utf-8"), "html");
  assert.equal(contentKind("application/xml"), "xml");
  assert.equal(contentKind("image/png"), "image");
  assert.equal(contentKind("text/plain"), "text");
  assert.equal(contentKind("application/octet-stream"), "binary");
  assert.equal(contentKind("application/pdf"), "binary");
  assert.equal(contentKind(undefined), "text");
  assert.equal(contentKind(""), "text");
});

test("pretty-printing answers for the body, not the header", () => {
  assert.equal(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyJson("  [1,2]  "), "[\n  1,\n  2\n]");
  // Served as JSON, but it is an error page — the toggle must stay disabled.
  assert.equal(prettyJson("<html>oops</html>"), null);
  assert.equal(prettyJson(""), null);
  assert.equal(prettyJson("   "), null);
});

test("a body too large to reformat declines rather than blocking", () => {
  const huge = `{"a":"${"x".repeat(3 * 1024 * 1024)}"}`;
  assert.equal(prettyJson(huge), null);
});

test("history times read as ages until they are old enough to be dates", () => {
  const now = Date.UTC(2026, 0, 20, 12, 0, 0);
  assert.equal(timeAgo(now, now), "just now");
  assert.equal(timeAgo(now - 30_000, now), "just now");
  assert.equal(timeAgo(now - 4 * 60_000, now), "4m");
  assert.equal(timeAgo(now - 2 * 3_600_000, now), "2h");
  assert.equal(timeAgo(now - 3 * 86_400_000, now), "3d");
  // Older than a week: a date, because "9d" tells you nothing useful.
  assert.ok(!timeAgo(now - 30 * 86_400_000, now).endsWith("d"));
  // A clock that went backwards must not produce a negative age.
  assert.equal(timeAgo(now + 5000, now), "just now");
});

test("status tones", () => {
  assert.equal(statusTone(100), "info");
  assert.equal(statusTone(200), "success");
  assert.equal(statusTone(204), "success");
  assert.equal(statusTone(301), "redirect");
  assert.equal(statusTone(404), "client-error");
  assert.equal(statusTone(500), "server-error");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
