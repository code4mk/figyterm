/**
 * Finding the variables in a piece of text, and saying what each one means.
 *
 * The ranges are the part worth pinning: three separate pieces of editor
 * machinery read them, and an off-by-one colours the wrong half of a URL or
 * replaces the wrong characters when a completion is accepted.
 */

import assert from "node:assert/strict";
import {
  completionRange,
  describe,
  meaningOf,
  namesInScope,
  scanTemplates,
} from "./highlight";
import { Scope } from "./template";

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

const scopes: Scope[] = [
  { label: "Users", variables: [{ key: "id", value: "42", enabled: true }] },
  {
    label: "Staging",
    variables: [
      { key: "base_url", value: "https://staging.example.com", enabled: true },
      { key: "id", value: "ignored", enabled: true },
      { key: "token", value: "", enabled: true },
      { key: "off", value: "nope", enabled: false },
    ],
  },
];

console.log("api/highlight");

test("a span covers the braces, not just the name", () => {
  const [span] = scanTemplates("{{base_url}}/users");
  assert.deepEqual(span, { from: 0, to: 12, name: "base_url" });
  assert.equal("{{base_url}}/users".slice(span!.from, span!.to), "{{base_url}}");
});

test("every mention is its own span, duplicates included", () => {
  const spans = scanTemplates("{{host}}:{{port}}/{{host}}");
  assert.deepEqual(
    spans.map((span) => span.name),
    ["host", "port", "host"]
  );
  assert.equal(spans[2]!.from, 18);
});

test("the name is trimmed but the span still covers the spaces", () => {
  const text = "{{  spaced  }}";
  const [span] = scanTemplates(text);
  assert.equal(span!.name, "spaced");
  assert.equal(text.slice(span!.from, span!.to), text);
});

test("text with no variables has no spans", () => {
  assert.deepEqual(scanTemplates("https://example.com/users"), []);
  assert.deepEqual(scanTemplates(""), []);
  assert.deepEqual(scanTemplates("{{}}"), [], "empty braces are not a variable");
});

/** Scanning twice must give the same answer: a shared global regex carries a
 * `lastIndex` and would skip half the matches on the second call. */
test("scanning the same text twice gives the same spans", () => {
  const text = "{{a}}/{{b}}";
  assert.deepEqual(scanTemplates(text), scanTemplates(text));
});

test("a name that is not Latin is found like any other", () => {
  const [span] = scanTemplates("{{ব্যবহারকারী}}/x");
  assert.equal(span!.name, "ব্যবহারকারী");
  assert.equal(span!.from, 0);
});

// ─── What a name means ───────────────────────────────────────────────────────

test("the innermost scope wins", () => {
  const meaning = meaningOf("id", scopes);
  assert.equal(meaning.state, "resolved");
  assert.equal(meaning.value, "42");
  assert.equal(meaning.from, "Users");
});

test("a name nothing defines is missing", () => {
  assert.equal(meaningOf("nope", scopes).state, "missing");
});

/** The most confusing state to be in, so it is not lumped in with resolved:
 * the request goes out with nothing where a token should be. */
test("defined as nothing is its own state, not resolved", () => {
  const meaning = meaningOf("token", scopes);
  assert.equal(meaning.state, "empty");
  assert.equal(meaning.from, "Staging");
});

test("a disabled variable does not answer", () => {
  assert.equal(meaningOf("off", scopes).state, "missing");
});

test("a generated value says so rather than looking unresolved", () => {
  assert.equal(meaningOf("$guid", scopes).state, "dynamic");
  assert.equal(meaningOf("$timestamp", []).state, "dynamic");
});

test("the description says which scope answered", () => {
  assert.ok(describe(meaningOf("id", scopes)).includes("Users"));
  assert.ok(describe(meaningOf("nope", scopes)).includes("not be sent"));
  assert.ok(describe(meaningOf("token", scopes)).includes("nothing"));
  assert.ok(describe(meaningOf("$guid", scopes)).includes("every send"));
});

// ─── Completing ──────────────────────────────────────────────────────────────

test("the caret inside open braces is a place to complete", () => {
  const range = completionRange("{{ba", 4);
  assert.deepEqual(range, { from: 2, to: 4, typed: "ba" });
});

test("ordinary text is not", () => {
  assert.equal(completionRange("https://example.com", 10), null);
  assert.equal(completionRange("", 0), null);
});

/** Past a closed template, the caret is not inside it. */
test("the caret after a finished variable is not a place to complete", () => {
  assert.equal(completionRange("{{base_url}}/users", 18), null);
});

/** Completing inside `{{ba|}}` must not leave `{{base_url}}}}`. */
test("the closing braces are replaced when they are already there", () => {
  const range = completionRange("{{ba}}", 4);
  assert.deepEqual(range, { from: 2, to: 6, typed: "ba" });
});

test("a brace inside the braces stops it, rather than completing nonsense", () => {
  assert.equal(completionRange("{{a{b", 5), null);
});

test("an empty pair offers everything", () => {
  assert.deepEqual(completionRange("{{", 2), { from: 2, to: 2, typed: "" });
});

// ─── What to offer ───────────────────────────────────────────────────────────

test("names are offered innermost first, with no duplicates", () => {
  const names = namesInScope(scopes);
  assert.deepEqual(
    names.map((entry) => entry.name),
    ["id", "base_url", "token"]
  );
  assert.equal(names[0]!.from, "Users", "the inner one is the one that would win");
});

test("a disabled variable is not offered", () => {
  assert.ok(!namesInScope(scopes).some((entry) => entry.name === "off"));
});

test("a blank row in a half-edited table is not offered", () => {
  const withBlank: Scope[] = [
    { label: "S", variables: [{ key: "", value: "", enabled: true }] },
  ];
  assert.deepEqual(namesInScope(withBlank), []);
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
