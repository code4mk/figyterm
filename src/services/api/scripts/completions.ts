/**
 * What `pm.` offers, for the script editor's completion list.
 *
 * Note what is *not* here: `pm.iterationData`. A run's data file drives the
 * iterations and fills `{{variables}}`, but it is not handed to scripts — the
 * worker is never given the row. Offering it would complete to `undefined`,
 * which is worse than not offering it.
 *
 * Written by hand against `pm.ts` rather than derived from it. Deriving would
 * need the object to exist, and it only exists inside a worker that is not
 * running while somebody is typing — and a list generated from a live object
 * could not carry the one-line explanations, which are most of the value.
 *
 * The cost is that this can drift from `pm.ts`. The test next door walks the
 * list and fails on a name the real surface does not have, which turns drift
 * into a failing test rather than a completion that inserts nothing.
 */

export interface ScriptCompletion {
  /** What gets inserted, `pm.` and all. */
  label: string;
  /** One line about it, shown beside the name. */
  detail: string;
  /** `function` puts a call's parentheses in; `property` does not. */
  kind: "function" | "property" | "namespace";
}

export const PM_COMPLETIONS: ScriptCompletion[] = [
  { label: "pm.test", detail: "Name an assertion and run it", kind: "function" },
  { label: "pm.expect", detail: "Assert about any value", kind: "function" },
  { label: "pm.response", detail: "What came back", kind: "namespace" },
  { label: "pm.response.code", detail: "The status number", kind: "property" },
  { label: "pm.response.status", detail: "The status text", kind: "property" },
  { label: "pm.response.responseTime", detail: "How long it took, in ms", kind: "property" },
  { label: "pm.response.json", detail: "The body, parsed", kind: "function" },
  { label: "pm.response.text", detail: "The body, as text", kind: "function" },
  { label: "pm.response.to.have.status", detail: "Assert the status", kind: "function" },
  { label: "pm.request", detail: "What is going out", kind: "namespace" },
  { label: "pm.request.url", detail: "The URL, after resolution", kind: "property" },
  { label: "pm.request.method", detail: "The method", kind: "property" },
  { label: "pm.request.headers.add", detail: "Add a header", kind: "function" },
  { label: "pm.request.headers.upsert", detail: "Set a header, replacing any", kind: "function" },
  { label: "pm.request.headers.remove", detail: "Remove a header", kind: "function" },
  { label: "pm.environment.get", detail: "Read from the environment", kind: "function" },
  { label: "pm.environment.set", detail: "Write to the environment", kind: "function" },
  { label: "pm.environment.unset", detail: "Remove from the environment", kind: "function" },
  { label: "pm.collectionVariables.get", detail: "Read a collection variable", kind: "function" },
  { label: "pm.collectionVariables.set", detail: "Write a collection variable", kind: "function" },
  { label: "pm.globals.get", detail: "Read a global", kind: "function" },
  { label: "pm.globals.set", detail: "Write a global", kind: "function" },
  { label: "pm.variables.get", detail: "Read from any scope, innermost first", kind: "function" },
  { label: "pm.variables.set", detail: "Write, which goes to the environment", kind: "function" },
  { label: "pm.variables.has", detail: "Whether anything defines it", kind: "function" },
  { label: "pm.info.requestName", detail: "The name of this request", kind: "property" },
  { label: "pm.info.iteration", detail: "Which run this is, from zero", kind: "property" },
  { label: "pm.info.eventName", detail: '"prerequest" or "test"', kind: "property" },
];

/** Snippets worth a keystroke: the shapes people write over and over. */
export const SCRIPT_SNIPPETS: { label: string; detail: string; body: string }[] = [
  {
    label: "test",
    detail: "A named assertion",
    body: 'pm.test("", () => {\n  \n});',
  },
  {
    label: "status",
    detail: "Assert the response code",
    body: 'pm.test("status is 200", () => {\n  pm.response.to.have.status(200);\n});',
  },
  {
    label: "savetoken",
    detail: "Keep a token from the response",
    body: 'pm.environment.set("token", pm.response.json().access_token);',
  },
];
