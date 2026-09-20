/**
 * The collection interchange format: its constants, its shapes, and how to tell
 * one kind of document from another.
 *
 * This is the format every API client on the market reads and writes, and being
 * exactly right about it is the point of the whole feature. A collection that
 * imports with one header missing is worse than one that refuses to import,
 * because nobody finds out until the request fails against production.
 *
 * Named `interchange/` rather than `format/` because `../format.ts` already
 * formats responses, and two things called format is one too many.
 *
 * Nothing here is read at runtime except by `import.ts` and `export.ts`; the
 * rest of the app never sees these shapes, only the app's own model.
 */

/**
 * The value `info.schema` must carry for a v2.1.0 document.
 *
 * It is a wire constant, not a link: other tools identify the format by
 * matching this string, and a document without it byte-for-byte is rejected on
 * import elsewhere. That is the entire reason it is written out verbatim, and
 * it is confined to this one line so nothing else in the codebase has to
 * mention it.
 */
export const SCHEMA_V2_1_0 =
  "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/** What a document turned out to be. */
export type DocumentKind = "collection" | "environment" | "dump" | "unknown";

/** The versions this reads. Anything else is attempted as v2.1.0. */
export type SchemaVersion = "2.1.0" | "2.0.0" | "unknown";

export interface RawObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): RawObject | null {
  return isObject(value) ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Which kind of file this is.
 *
 * Structural rather than by filename: everything involved is a `.json`, people
 * rename them, and a collection called `environment.json` should still import
 * as a collection.
 */
export function detectKind(document: unknown): DocumentKind {
  const root = asObject(document);
  if (!root) return "unknown";

  if (isObject(root.info) && Array.isArray(root.item)) return "collection";

  // An environment is a name and a list of values. The scope — environment or
  // globals — rides on a vendor-prefixed key, which is matched by its suffix so
  // that a file from any tool in this family is read the same way.
  if (Array.isArray(root.values) && typeof root.name === "string") return "environment";

  // A whole-account backup: several collections and environments in one file.
  if (Array.isArray(root.collections) || Array.isArray(root.environments)) return "dump";

  return "unknown";
}

/** The schema version a collection declares. */
export function schemaVersion(document: unknown): SchemaVersion {
  const info = asObject(asObject(document)?.info);
  const schema = asString(info?.schema);
  if (schema.includes("/v2.1.0/")) return "2.1.0";
  if (schema.includes("/v2.0.0/")) return "2.0.0";
  return "unknown";
}

/**
 * The value of the vendor-prefixed scope key on an environment document.
 *
 * Found by suffix rather than by an exact key, so whichever prefix a given
 * exporter uses, the answer — `environment` or `globals` — is read the same.
 */
export function variableScope(document: unknown): string | null {
  const root = asObject(document);
  if (!root) return null;
  const key = Object.keys(root).find((name) => name.endsWith("_variable_scope"));
  return key ? asString(root[key], null as unknown as string) || null : null;
}

/** The body modes the format defines. */
export type BodyMode = "raw" | "urlencoded" | "formdata" | "file" | "graphql";

/**
 * The body modes this reads and sends.
 *
 * All of them, as of the phase that added the body editors: a form stays a
 * form, a multipart upload keeps its parts, and a file body keeps its path.
 * The only thing that does not survive a move between machines is a *file* — a
 * path is a path on the machine that wrote it — and the import report says so
 * rather than leaving it to be discovered on the first send.
 */
export const BODY_MODES: BodyMode[] = ["raw", "urlencoded", "formdata", "file", "graphql"];

/** Kept as a set for the reader's "is this a mode I know" check. */
export const BODY_SUPPORT: Record<BodyMode, true> = {
  raw: true,
  urlencoded: true,
  graphql: true,
  formdata: true,
  file: true,
};

/** Content types the reader assigns when converting a body mode. */
export const URLENCODED_TYPE = "application/x-www-form-urlencoded";
export const JSON_TYPE = "application/json";

/** `raw.options.raw.language` to a content type, for bodies that declare one. */
export function contentTypeForLanguage(language: string): string {
  switch (language.toLowerCase()) {
    case "json":
      return JSON_TYPE;
    case "xml":
      return "application/xml";
    case "html":
      return "text/html";
    case "javascript":
      return "application/javascript";
    case "graphql":
      return JSON_TYPE;
    default:
      return "text/plain";
  }
}

/** The reverse, for writing a raw body back out with its language. */
export function languageForContentType(contentType: string): string {
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (type === JSON_TYPE || type.endsWith("+json")) return "json";
  if (type.endsWith("xml")) return "xml";
  if (type === "text/html") return "html";
  if (type === "application/javascript") return "javascript";
  return "text";
}
