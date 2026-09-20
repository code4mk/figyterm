/**
 * Writing a collection back out as v2.1.0.
 *
 * One rule decides almost every line here:
 *
 * > **If this app has not changed something, the original goes back out
 * > untouched. If it has, the change wins.**
 *
 * That is what makes a round trip lossless *and* byte-stable. Import a file,
 * export it, and the result is the file — including the scripts, the auth
 * blocks, the descriptions, the disabled parameters and the vendor-prefixed
 * keys this app has never heard of. Edit one URL and export, and the result is
 * the file with one URL changed, not a document rebuilt from a smaller model
 * and quietly shorn of everything that model has no column for.
 *
 * "Has it changed?" is answered by running the reader over the stored original
 * and comparing what it produces to what is in the database — which is why
 * `bodyFromDocument` and `urlFromDocument` are exported from `import.ts`.
 *
 * Only v2.1.0 is written. One version emitted exactly beats three emitted
 * approximately.
 */

import { HeaderRow, RequestBody } from "../../../types/api";
import { parseUrl } from "../url";
import { bodyFromDocument, urlFromDocument } from "./import";
import {
  asArray,
  asObject,
  asString,
  languageForContentType,
  RawObject,
  SCHEMA_V2_1_0,
} from "./schema";

/** One row as the store hands it over. Mirrors `ExportItem` in Rust. */
/** A saved response, as the store hands it over. */
export interface ExportExample {
  id: string;
  name: string;
  status: number | null;
  statusText: string | null;
  headers: { name: string; value: string }[] | null;
  body: string | null;
  raw: unknown;
}

export interface ExportItem {
  id: string;
  parentId: string | null;
  kind: "folder" | "request";
  name: string;
  /** A folder's; empty on a request, whose description stays in `raw`. */
  description: string;
  rank: string;
  auth: unknown;
  events: unknown;
  /** A folder's own variables — an inner link of the scope chain. */
  variables: unknown;
  raw: unknown;
  request: {
    method: string;
    url: string;
    headers: HeaderRow[];
    body: RequestBody;
  } | null;
  examples: ExportExample[];
}

export interface ExportBundle {
  name: string;
  description: string;
  auth: unknown;
  variables: unknown;
  events: unknown;
  raw: unknown;
  items: ExportItem[];
}

/** Adds a key only when there is something to add, so an exported document has
 * no empty `event: []` or `auth: null` that the original did not have. */
function put(target: RawObject, key: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value) && value.length === 0) return;
  target[key] = value;
}

/**
 * The header list, keeping every field of the original that this app has no
 * column for — a description, a type, a vendor key.
 *
 * Matched by name, first unused occurrence wins, so a repeated `Accept` keeps
 * both of its descriptions rather than both taking the first.
 */
function writeHeaders(headers: HeaderRow[], original: unknown): unknown[] {
  const previous = asArray(original)
    .map((entry) => asObject(entry))
    .filter((entry): entry is RawObject => entry !== null);
  const used = new Set<number>();

  return headers.map((header) => {
    const index = previous.findIndex(
      (candidate, at) =>
        !used.has(at) && asString(candidate.key).toLowerCase() === header.name.toLowerCase()
    );
    const base: RawObject = index === -1 ? {} : { ...previous[index]! };
    if (index !== -1) used.add(index);

    base.key = header.name;
    base.value = header.value;
    if (header.enabled) delete base.disabled;
    else base.disabled = true;
    return base;
  });
}

/**
 * The URL, as both the text and the structure the format wants.
 *
 * When the stored URL is the one that was imported, the original object goes
 * back verbatim — it carries path-variable descriptions and disabled query
 * parameters that this model has nowhere to keep yet.
 */
function writeUrl(url: string, original: unknown): unknown {
  if (original !== undefined && urlFromDocument(original) === url) return original;

  const parts = parseUrl(url);
  const written: RawObject = { raw: url };
  put(written, "protocol", parts.protocol);
  put(written, "host", parts.host);
  put(written, "port", parts.port);
  put(written, "path", parts.path);
  put(
    written,
    "query",
    (parts.query ?? []).map((param) => {
      const entry: RawObject = { key: param.key, value: param.value };
      if (param.disabled) entry.disabled = true;
      return entry;
    })
  );
  put(written, "hash", parts.hash);
  put(
    written,
    "variable",
    (parts.variable ?? []).map((variable) => ({ key: variable.key }))
  );
  return written;
}

/**
 * The body.
 *
 * When the stored body is still what the import produced, the original goes
 * back out untouched — which keeps every field this model has no column for: a
 * part's description, a second file in a multi-file field, a vendor key. When
 * it has been edited, it is written from the model, in its own mode.
 */
function writeBody(body: RequestBody, original: unknown, contentType: string | undefined): unknown {
  if (original !== undefined) {
    const imported = bodyFromDocument(original, contentType).body;
    if (sameBody(imported, body)) return original;
  }

  switch (body.mode) {
    case "none":
      return undefined;

    case "raw":
      return body.text === ""
        ? undefined
        : {
            mode: "raw",
            raw: body.text,
            options: { raw: { language: languageForContentType(body.contentType) } },
          };

    case "urlencoded":
    case "formdata": {
      const fields = (body.fields ?? []).filter((field) => field.key.trim() !== "");
      if (fields.length === 0) return undefined;
      return {
        mode: body.mode,
        [body.mode]: fields.map((field) => {
          const entry: Record<string, unknown> = { key: field.key };
          if (field.kind === "file") {
            entry.type = "file";
            if (field.filePath) entry.src = field.filePath;
          } else {
            entry.value = field.value;
            // Only a multipart part carries a type of its own; a form field is
            // always text and saying so would be noise in the document.
            if (body.mode === "formdata") entry.type = "text";
          }
          if (field.contentType) entry.contentType = field.contentType;
          if (!field.enabled) entry.disabled = true;
          return entry;
        }),
      };
    }

    case "file":
      return body.filePath ? { mode: "file", file: { src: body.filePath } } : undefined;

    case "graphql":
      return body.text.trim() === ""
        ? undefined
        : {
            mode: "graphql",
            graphql: { query: body.text, variables: body.graphqlVariables ?? "" },
          };
  }
}

/**
 * Whether two bodies are the same request.
 *
 * Compared field by field rather than with `JSON.stringify`, because the ids on
 * the field rows are generated per read and never the same twice — comparing
 * them would mean the original never matched, and every export would rewrite
 * every body it had not needed to touch.
 */
function sameBody(a: RequestBody, b: RequestBody): boolean {
  if (a.mode !== b.mode) return false;
  if (a.text !== b.text) return false;
  if ((a.filePath ?? "") !== (b.filePath ?? "")) return false;
  if ((a.graphqlVariables ?? "") !== (b.graphqlVariables ?? "")) return false;

  const left = a.fields ?? [];
  const right = b.fields ?? [];
  if (left.length !== right.length) return false;
  return left.every((field, index) => {
    const other = right[index]!;
    return (
      field.key === other.key &&
      field.value === other.value &&
      field.enabled === other.enabled &&
      field.kind === other.kind &&
      (field.filePath ?? "") === (other.filePath ?? "") &&
      (field.contentType ?? "") === (other.contentType ?? "")
    );
  });
}

/**
 * The saved responses, merged over what each was imported from.
 *
 * An imported example keeps every field this model has no column for — the
 * original request it was captured from, the preview language, cookies — while
 * a name change or a new example still shows up.
 */
function writeExamples(examples: ExportExample[]): unknown[] {
  return examples.map((example) => {
    const written: RawObject = { ...(asObject(example.raw) ?? {}) };
    written.name = example.name;
    if (example.status !== null) written.code = example.status;
    if (example.statusText !== null) written.status = example.statusText;
    if (example.headers) {
      written.header = example.headers.map((header) => ({
        key: header.name,
        value: header.value,
      }));
    }
    if (example.body !== null) written.body = example.body;
    return written;
  });
}

/** One request entry. */
function writeRequest(item: ExportItem): RawObject {
  const original = asObject(item.raw) ?? {};
  const originalRequest = asObject(original.request) ?? undefined;
  const request = item.request!;

  const contentType = request.headers.find(
    (header) => header.name.toLowerCase() === "content-type" && header.enabled
  )?.value;

  const written: RawObject = { ...(originalRequest ?? {}) };
  written.method = request.method;
  written.header = writeHeaders(request.headers, originalRequest?.header);
  written.url = writeUrl(request.url, originalRequest?.url);

  const body = writeBody(request.body, originalRequest?.body, contentType);
  if (body === undefined) delete written.body;
  else written.body = body;

  // An auth block edited elsewhere would win here; until then it is whatever
  // was imported, and the column and the original agree.
  if (item.auth !== null && item.auth !== undefined) written.auth = item.auth;

  const entry: RawObject = { ...original };
  entry.name = item.name;
  entry.request = written;
  if (item.events !== null && item.events !== undefined) entry.event = item.events;

  // `response` is always written, even empty: the format expects the key on a
  // request, and a collection that loses its examples on a round trip has lost
  // the part that documented it.
  entry.response = writeExamples(item.examples);

  // A folder key on a request entry would make it a folder on the way back in.
  delete entry.item;
  return entry;
}

/**
 * Writes a description back in the shape it arrived in.
 *
 * The format allows a plain string or a `{content, type}` object, and the rule
 * everywhere else applies here: **unchanged means the original goes back**. A
 * document whose folder carried a typed description must not have it flattened
 * to a string by an export that did not touch it.
 */
function putDescription(target: RawObject, original: unknown, value: string): void {
  const flattened =
    typeof original === "string" ? original : asString(asObject(original)?.content);

  if (original !== undefined && value === flattened) target.description = original;
  else if (value !== "") target.description = value;
  else delete target.description;
}

function writeFolder(item: ExportItem, children: unknown[]): RawObject {
  const original = asObject(item.raw) ?? {};
  const entry: RawObject = { ...original };
  entry.name = item.name;
  entry.item = children;
  putDescription(entry, original.description, item.description);
  if (item.auth !== null && item.auth !== undefined) entry.auth = item.auth;
  if (item.events !== null && item.events !== undefined) entry.event = item.events;
  // A folder's own variables. An empty list means somebody deleted the last
  // one, so the key goes; null means the column has never held them — which is
  // true of a collection imported before the column existed — and there the
  // original in `raw` is the only copy and must be left alone.
  if (Array.isArray(item.variables)) {
    if (item.variables.length > 0) entry.variable = item.variables;
    else delete entry.variable;
  }
  delete entry.request;
  return entry;
}

/**
 * The whole document.
 *
 * Children are grouped by parent and ordered by rank, which is the order the
 * rail shows and therefore the order the file should have. Exporting the same
 * collection twice gives byte-identical output, so an export committed to a
 * repository is a diff of what changed rather than of how it was serialised.
 */
export function writeCollection(bundle: ExportBundle): RawObject {
  const childrenOf = new Map<string, ExportItem[]>();
  for (const item of bundle.items) {
    const key = item.parentId ?? "";
    const list = childrenOf.get(key);
    if (list) list.push(item);
    else childrenOf.set(key, [item]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.rank === b.rank ? a.name.localeCompare(b.name) : a.rank < b.rank ? -1 : 1));
  }

  const build = (parentId: string): unknown[] =>
    (childrenOf.get(parentId) ?? []).map((item) =>
      item.kind === "folder" ? writeFolder(item, build(item.id)) : writeRequest(item)
    );

  const original = asObject(bundle.raw) ?? {};
  const originalInfo = asObject(original.info) ?? {};

  const info: RawObject = { ...originalInfo };
  info.name = bundle.name;

  putDescription(info, originalInfo.description, bundle.description);
  // The one field that must be exactly right, or no other tool will recognise
  // the file. See `SCHEMA_V2_1_0`.
  info.schema = SCHEMA_V2_1_0;

  const document: RawObject = { ...original };
  document.info = info;
  document.item = build("");
  put(document, "auth", bundle.auth);
  put(document, "event", bundle.events);
  put(document, "variable", bundle.variables);
  return document;
}

/** The document as a file, with the two-space indent every exporter uses. */
export function writeCollectionFile(bundle: ExportBundle): string {
  return `${JSON.stringify(writeCollection(bundle), null, 2)}\n`;
}
