/**
 * `{{variables}}`, and where their values come from.
 *
 * The rule is the one every client in this family uses: **the innermost scope
 * wins.** A variable set on the request beats one on its folder, which beats
 * the collection's, which beats the active environment's, which beats the
 * globals. Nothing merges; the first scope that has a value for a name is the
 * answer, and the rest are not consulted.
 *
 * Two decisions worth writing down:
 *
 * - **An unresolved variable is never silently emptied.** A request with
 *   `{{token}}` and no token must not go out with an empty `Authorization`
 *   header — that is a 401 nobody can explain. Resolution reports what it could
 *   not find and leaves the text alone, and the window refuses to send until
 *   somebody decides.
 * - **A value may itself contain variables**, because `{{base_url}}` is very
 *   often `{{protocol}}://{{host}}`. Resolution repeats until nothing changes,
 *   with a depth limit so a variable that refers to itself is a stopped loop
 *   rather than a hung window.
 *
 * Pure, and tested under Node: the dynamic values that would otherwise make
 * that impossible — a UUID, the clock, a random number — are injected.
 */

import { RequestBody } from "../../types/api";

/** One variable, as any scope holds it. */
export interface Variable {
  key: string;
  value: string;
  enabled: boolean;
}

/** A level of the chain. `label` is what the UI says a value came from. */
/**
 * Which level of the chain a scope is.
 *
 * The label alone cannot say: an environment called "Collection" is a
 * perfectly ordinary thing to name one, and a suggestion list that guessed the
 * kind from the name would put the wrong letter on it. Resolution does not use
 * this — the order is what decides a winner — it is for saying *where* a value
 * came from.
 */
export type ScopeKind = "request" | "folder" | "collection" | "environment" | "global";

export interface Scope {
  label: string;
  variables: Variable[];
  kind?: ScopeKind;
}

/** Where a resolved value came from, for the hover peek. */
export interface Found {
  value: string;
  from: string;
}

export interface Resolution {
  text: string;
  /** Names with no value anywhere, in the order they were met. */
  unresolved: string[];
}

/** The unpredictable parts, injected so the rest can be tested. */
export interface Dynamics {
  uuid: () => string;
  now: () => Date;
  randomInt: (max: number) => number;
}

export const REAL_DYNAMICS: Dynamics = {
  uuid: () => crypto.randomUUID(),
  now: () => new Date(),
  randomInt: (max) => Math.floor(Math.random() * max),
};

/** How many times a value containing variables is re-resolved. */
const MAX_DEPTH = 10;

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Every variable name mentioned in the text, in order, without duplicates. */
export function findTemplates(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TEMPLATE)) {
    const name = match[1]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * The generated values, by name.
 *
 * A deliberately small set: the ones people actually reach for when writing a
 * request by hand. The long tail of fake names and addresses belongs to a
 * fixture library, not to a URL bar.
 */
export function dynamicValue(name: string, dynamics: Dynamics): string | null {
  switch (name) {
    case "$guid":
    case "$randomUUID":
      return dynamics.uuid();
    case "$timestamp":
      return String(Math.floor(dynamics.now().getTime() / 1000));
    case "$isoTimestamp":
      return dynamics.now().toISOString();
    case "$epoch":
      return String(dynamics.now().getTime());
    case "$randomInt":
      return String(dynamics.randomInt(1000));
    case "$randomAlphaNumeric":
      return ALPHANUMERIC[dynamics.randomInt(ALPHANUMERIC.length)]!;
    default:
      return null;
  }
}

/**
 * The generated values, for the suggestion list.
 *
 * Beside the list rather than inside `dynamicValue` because a switch cannot be
 * enumerated, and the completion list has to be able to offer these — they are
 * the ones nobody can look up, since they are in no environment. The test next
 * door resolves every name here, so a rename in the switch fails the build
 * rather than leaving a suggestion that inserts something unresolvable.
 */
export const DYNAMIC_VARIABLES: { name: string; hint: string }[] = [
  { name: "$guid", hint: "A fresh UUID" },
  { name: "$randomUUID", hint: "A fresh UUID" },
  { name: "$timestamp", hint: "Seconds since the epoch" },
  { name: "$isoTimestamp", hint: "The time now, ISO 8601" },
  { name: "$epoch", hint: "Milliseconds since the epoch" },
  { name: "$randomInt", hint: "A number from 0 to 999" },
  { name: "$randomAlphaNumeric", hint: "One random letter or digit" },
];

/** Whether a name is one of the generated values. */
export function isDynamic(name: string): boolean {
  return name.startsWith("$");
}

/**
 * The value for a name, and which scope it came from.
 *
 * Disabled variables are skipped rather than treated as empty: unticking one is
 * how you fall back to the scope underneath, and treating it as an empty string
 * would shadow that scope with nothing.
 */
export function lookup(name: string, scopes: Scope[]): Found | null {
  for (const scope of scopes) {
    const variable = scope.variables.find(
      (candidate) => candidate.enabled && candidate.key === name
    );
    if (variable) return { value: variable.value, from: scope.label };
  }
  return null;
}

/**
 * Substitutes every variable in the text.
 *
 * Unknown names are left exactly as they were written, so what the window shows
 * as unresolved is the same text that is in the field.
 */
export function resolveText(
  text: string,
  scopes: Scope[],
  dynamics: Dynamics = REAL_DYNAMICS
): Resolution {
  const unresolved: string[] = [];
  if (!text.includes("{{")) return { text, unresolved };

  let current = text;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let changed = false;

    const next = current.replace(TEMPLATE, (whole, rawName: string) => {
      const name = rawName.trim();

      if (isDynamic(name)) {
        const generated = dynamicValue(name, dynamics);
        if (generated === null) {
          if (!unresolved.includes(name)) unresolved.push(name);
          return whole;
        }
        changed = true;
        return generated;
      }

      const found = lookup(name, scopes);
      if (!found) {
        if (!unresolved.includes(name)) unresolved.push(name);
        return whole;
      }
      changed = true;
      return found.value;
    });

    current = next;
    if (!changed) break;
  }

  return { text: current, unresolved };
}

/** What a request looks like before and after resolution. */
/**
 * Every part of a body that can hold a variable, resolved.
 *
 * **All of it, not just the raw text.** Only `raw` used to be resolved, so a
 * form field holding `{{client_id}}` was sent with the braces in it — and
 * because nothing scanned those fields, the unresolved check did not stop the
 * send either. The request went out looking correct and the server replied
 * about an application called `{{client_id}}`.
 *
 * A file's *path* is resolved too. `{{fixtures}}/avatar.png` is a reasonable
 * thing to write, and a path is no less a string than a value is.
 */
export function resolveBody(
  body: RequestBody,
  scopes: Scope[],
  dynamics: Dynamics = REAL_DYNAMICS
): { body: RequestBody; unresolved: string[] } {
  const unresolved: string[] = [];
  const take = (text: string) => {
    const resolution = resolveText(text, scopes, dynamics);
    for (const name of resolution.unresolved) {
      if (!unresolved.includes(name)) unresolved.push(name);
    }
    return resolution.text;
  };

  const resolved: RequestBody = {
    ...body,
    // `text` is the raw body and the GraphQL query; one field, two meanings,
    // and both are resolved the same way.
    text: take(body.text),
    graphqlVariables:
      body.graphqlVariables === undefined ? undefined : take(body.graphqlVariables),
    filePath: body.filePath === undefined ? undefined : take(body.filePath),
    fields: body.fields?.map((field) => ({
      ...field,
      // The key as well as the value: a form with a `{{field_name}}` in it is
      // rarer than one with a templated value, but it is not a mistake.
      key: take(field.key),
      value: take(field.value),
      // Each path on its own: a `{{fixtures}}` in one attachment is as likely
      // as in the next, and resolving the list as a whole is not a thing you
      // can do to an array.
      filePaths:
        field.filePaths === undefined ? undefined : field.filePaths.map((path) => take(path)),
    })),
  };

  return { body: resolved, unresolved };
}

export interface ResolvableRequest {
  url: string;
  headers: { name: string; value: string; enabled: boolean }[];
  body: string;
}

export interface ResolvedRequest extends ResolvableRequest {
  unresolved: string[];
}

/**
 * Resolves everything that goes on the wire.
 *
 * Header *names* are resolved too, not just values: a name is as likely to be
 * `{{auth_header}}` as a value is, and a request that sends a header literally
 * called `{{auth_header}}` is a bug report nobody enjoys writing.
 */
export function resolveRequest(
  request: ResolvableRequest,
  scopes: Scope[],
  dynamics: Dynamics = REAL_DYNAMICS
): ResolvedRequest {
  const unresolved: string[] = [];
  const take = (resolution: Resolution) => {
    for (const name of resolution.unresolved) {
      if (!unresolved.includes(name)) unresolved.push(name);
    }
    return resolution.text;
  };

  const url = take(resolveText(request.url, scopes, dynamics));
  const headers = request.headers.map((header) => ({
    ...header,
    name: take(resolveText(header.name, scopes, dynamics)),
    value: take(resolveText(header.value, scopes, dynamics)),
  }));
  const body = take(resolveText(request.body, scopes, dynamics));

  return { url, headers, body, unresolved };
}
