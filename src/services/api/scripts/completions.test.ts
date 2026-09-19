/**
 * That the completion list describes the `pm` that actually exists.
 *
 * The list is written by hand — it has to be, because the real object only
 * exists inside a worker and could not carry the explanations anyway. The risk
 * of writing it by hand is drift: a rename in `pm.ts` leaves a completion that
 * inserts a call to nothing, and the script fails at run time with
 * "undefined is not a function".
 *
 * So the list is walked against a real `pm`, built here the same way the worker
 * builds it. A name that is no longer there fails the build rather than the
 * script.
 */

import assert from "node:assert/strict";
import { createPm } from "./pm";
import { PM_COMPLETIONS, SCRIPT_SNIPPETS } from "./completions";

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

/** A `pm` with everything present: a response, so the response half exists. */
function surface(): Record<string, unknown> {
  const { pm } = createPm({
    request: {
      method: "GET",
      url: "https://example.com",
      headers: [{ name: "Accept", value: "*/*" }],
      body: "",
    },
    response: {
      code: 200,
      status: "OK",
      headers: [],
      body: "{}",
      responseTime: 12,
      responseSize: 2,
    },
    scopes: { globals: {}, collection: {}, environment: {} },
    info: { requestName: "R", iteration: 0, iterationCount: 1, eventName: "test" },
  });
  return pm as unknown as Record<string, unknown>;
}

/** Walks `pm.a.b.c` and returns what is there, or `undefined`. */
function reach(root: Record<string, unknown>, path: string): unknown {
  // The leading `pm.` names the root itself.
  const parts = path.split(".").slice(1);
  let at: unknown = root;
  for (const part of parts) {
    if (at === null || at === undefined) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

console.log("api/completions");

test("every completion names something that is really there", () => {
  const pm = surface();
  for (const entry of PM_COMPLETIONS) {
    assert.notEqual(
      reach(pm, entry.label),
      undefined,
      `${entry.label} does not exist on pm — the list has drifted from pm.ts`
    );
  }
});

test("everything called a function is one", () => {
  const pm = surface();
  for (const entry of PM_COMPLETIONS) {
    if (entry.kind !== "function") continue;
    assert.equal(
      typeof reach(pm, entry.label),
      "function",
      `${entry.label} is offered as a call but is not callable`
    );
  }
});

test("every entry says what it is for", () => {
  for (const entry of PM_COMPLETIONS) {
    assert.ok(entry.detail.length > 0, `${entry.label} has no explanation`);
    assert.ok(entry.label.startsWith("pm."), `${entry.label} is not on pm`);
  }
});

test("no completion is listed twice", () => {
  const seen = new Set(PM_COMPLETIONS.map((entry) => entry.label));
  assert.equal(seen.size, PM_COMPLETIONS.length);
});

test("the snippets are the shapes people actually write", () => {
  for (const snippet of SCRIPT_SNIPPETS) {
    assert.ok(snippet.body.includes("pm."), `${snippet.label} uses the pm surface`);
    assert.ok(snippet.detail.length > 0);
  }
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
