/**
 * v2.0.0 to v2.1.0, in one place.
 *
 * Kept apart from the reader on purpose. The differences between the two
 * versions are few but fiddly, and scattering them through `import.ts` as
 * `if (version === …)` branches is how a reader becomes impossible to reason
 * about — every later change then has to be thought about twice.
 *
 * The substantive difference is **auth**. In v2.0.0 an auth block's parameters
 * are an object:
 *
 *     { "type": "basic", "basic": { "username": "u", "password": "p" } }
 *
 * and in v2.1.0 they are a list, which is what makes them able to carry a type
 * per parameter and to be ordered:
 *
 *     { "type": "basic", "basic": [ { "key": "username", "value": "u", "type": "string" }, … ] }
 *
 * Nothing here interprets auth — that is a later phase — but converting on the
 * way in means the later phase reads one shape rather than two, and that an
 * export of an imported v2.0.0 file is a valid v2.1.0 document.
 *
 * Everything else about the two versions is compatible enough to read directly,
 * and anything this does not touch is preserved unchanged.
 */

import { asArray, asObject, RawObject, SCHEMA_V2_1_0, schemaVersion } from "./schema";

/** The auth types whose parameters need converting, wherever they appear. */
const AUTH_TYPES = [
  "apikey",
  "awsv4",
  "basic",
  "bearer",
  "digest",
  "edgegrid",
  "hawk",
  "ntlm",
  "oauth1",
  "oauth2",
];

/** `{ username: "u" }` to `[{ key: "username", value: "u", type: "string" }]`. */
function parametersToList(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  const object = asObject(value);
  if (!object) return value;
  return Object.entries(object).map(([key, entry]) => ({
    key,
    value: entry,
    type: typeof entry === "string" ? "string" : "any",
  }));
}

function upgradeAuth(value: unknown): unknown {
  const auth = asObject(value);
  if (!auth) return value;

  const upgraded: RawObject = { ...auth };
  for (const type of AUTH_TYPES) {
    if (type in upgraded) upgraded[type] = parametersToList(upgraded[type]);
  }
  return upgraded;
}

/** Walks the tree, upgrading auth wherever one hangs. */
function upgradeItems(entries: unknown[]): unknown[] {
  return entries.map((entry) => {
    const node = asObject(entry);
    if (!node) return entry;

    const upgraded: RawObject = { ...node };
    if ("auth" in upgraded) upgraded.auth = upgradeAuth(upgraded.auth);

    if (Array.isArray(node.item)) {
      upgraded.item = upgradeItems(node.item);
    }

    const request = asObject(node.request);
    if (request && "auth" in request) {
      upgraded.request = { ...request, auth: upgradeAuth(request.auth) };
    }
    return upgraded;
  });
}

/**
 * The document as v2.1.0.
 *
 * A document that already says 2.1.0 is returned untouched, so importing the
 * current version costs nothing and cannot be changed by a bug in here.
 */
export function upgradeToLatest(document: RawObject): RawObject {
  if (schemaVersion(document) === "2.1.0") return document;

  const info = asObject(document.info) ?? {};
  const upgraded: RawObject = {
    ...document,
    info: { ...info, schema: SCHEMA_V2_1_0 },
    item: upgradeItems(asArray(document.item)),
  };
  // Assigned rather than spread, so a document with no auth does not gain an
  // `auth` key holding undefined — which `"auth" in document` would then
  // report as present, and `JSON.stringify` would quietly drop again.
  if ("auth" in document) upgraded.auth = upgradeAuth(document.auth);
  return upgraded;
}
