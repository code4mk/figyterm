/**
 * Reading a collection, an environment, or a whole backup.
 *
 * The rule the whole reader is built around: **nothing is discarded.** Every
 * entry keeps the document it came from, so that whatever this model does not
 * understand — a script, an auth block, a disabled parameter, a key from a tool
 * nobody here has heard of — comes back out intact on export. A round trip
 * through this app must not be a data-loss event for the person who sent the
 * file.
 *
 * The second rule: **say what happened.** A multipart body cannot be sent yet.
 * Rather than importing a request that silently sends nothing, the body is left
 * empty, the original is kept, and the import report names the request. A known
 * gap somebody can see is worth ten silent ones.
 */

import { BodyField, HeaderRow, HttpMethod, RequestBody } from "../../../types/api";
import { between } from "../rank";
import {
  asArray,
  asObject,
  asString,
  BODY_SUPPORT,
  BodyMode,
  contentTypeForLanguage,
  detectKind,
  DocumentKind,
  JSON_TYPE,
  RawObject,
  schemaVersion,
  URLENCODED_TYPE,
  variableScope,
} from "./schema";
import { upgradeToLatest } from "./upgrade";
import { serializeUrl, UrlParts } from "../url";

export interface ImportedRequest {
  method: string;
  url: string;
  headers: HeaderRow[];
  body: RequestBody;
}

/** A saved response, as the document holds it. */
export interface ImportedExample {
  name: string;
  status: number | null;
  statusText: string | null;
  headers: { name: string; value: string }[] | null;
  body: string | null;
  raw: unknown;
}

export interface ImportedItem {
  kind: "folder" | "request";
  name: string;
  /**
   * A folder's own description, flattened to markdown.
   *
   * Folders only. A request's description is left inside `raw` where it has
   * always been: nothing edits one, and reading it into a column that nothing
   * writes back would be two places for the same string to disagree.
   */
  description: string;
  rank: string;
  /** Index into the same list; null at the top of the collection. */
  parent: number | null;
  auth: unknown;
  events: unknown;
  /** A folder's or request's own variables — an inner link of the scope
   * chain, and the reason they are read out of the document rather than left
   * in `raw`. */
  variables: unknown;
  raw: unknown;
  request?: ImportedRequest;
  /** The document's `response[]`: the answers somebody kept. */
  examples: ImportedExample[];
}

export interface ImportedCollection {
  name: string;
  description: string;
  rank: string;
  auth: unknown;
  variables: unknown;
  events: unknown;
  raw: unknown;
  items: ImportedItem[];
}

export interface ImportedVariable {
  key: string;
  value: string;
  enabled: boolean;
  secret: boolean;
}

export interface ImportedEnvironment {
  name: string;
  isGlobal: boolean;
  variables: ImportedVariable[];
  raw: unknown;
}

/** Something the person importing should know, good or bad. */
export interface ImportNote {
  level: "info" | "warning" | "error";
  message: string;
}

export interface ImportOutcome {
  kind: DocumentKind;
  collections: ImportedCollection[];
  environments: ImportedEnvironment[];
  notes: ImportNote[];
  counts: { folders: number; requests: number; variables: number };
}

/** Ids for header rows. Sequential rather than random so a round-trip test
 * compares equal twice running. */
function idSource(): () => string {
  let next = 0;
  return () => `h${++next}`;
}

/** `description` is a string in some documents and `{content, type}` in others. */
function description(value: unknown): string {
  if (typeof value === "string") return value;
  const object = asObject(value);
  return object ? asString(object.content) : "";
}

/**
 * Headers, from either shape the format allows: a list of pairs, or one raw
 * header block as a single string.
 *
 * A disabled header is kept and unticked rather than dropped — the tick is the
 * whole reason the format has a `disabled` flag, and losing it changes what the
 * next person sends.
 */
export function headersFromDocument(value: unknown, id: () => string): HeaderRow[] {
  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const colon = line.indexOf(":");
        return colon === -1
          ? { id: id(), name: line, value: "", enabled: true }
          : {
              id: id(),
              name: line.slice(0, colon).trim(),
              value: line.slice(colon + 1).trim(),
              enabled: true,
            };
      });
  }

  return asArray(value).flatMap((entry) => {
    const header = asObject(entry);
    if (!header) return [];
    return [
      {
        id: id(),
        name: asString(header.key),
        value: asString(header.value),
        enabled: header.disabled !== true,
      },
    ];
  });
}

/**
 * A body, as this app holds it.
 *
 * Every mode the format defines now has one here, so nothing is converted and
 * nothing is lost: a form stays a form, a multipart upload keeps its parts and
 * their file paths, and a GraphQL request keeps its query and variables apart
 * rather than being flattened into the JSON they become on the wire.
 *
 * Deterministic, and exported, because `export.ts` runs it over the stored
 * original to decide whether the body in the database is still the imported
 * one. If it is, the original document goes back out untouched.
 */
export function bodyFromDocument(
  value: unknown,
  contentTypeHeader: string | undefined,
  id: () => string = idSource()
): { body: RequestBody; note?: string } {
  const object = asObject(value);
  const empty: RequestBody = { mode: "none", text: "", contentType: JSON_TYPE };
  if (!object) return { body: empty };

  const mode = asString(object.mode) as BodyMode;
  if (!mode || !(mode in BODY_SUPPORT)) return { body: empty };

  if (mode === "raw") {
    const options = asObject(asObject(object.options)?.raw);
    const language = asString(options?.language);
    const contentType =
      contentTypeHeader ?? (language ? contentTypeForLanguage(language) : "text/plain");
    return { body: { mode: "raw", text: asString(object.raw), contentType } };
  }

  if (mode === "urlencoded" || mode === "formdata") {
    const fields: BodyField[] = asArray(object[mode]).flatMap((entry) => {
      const pair = asObject(entry);
      if (!pair) return [];
      const isFile = asString(pair.type) === "file" || pair.src !== undefined;
      // `src` is a list when several files were attached to one field, and all
      // of them are taken — the part is repeated once per file on the wire, so
      // the list is the field. It used to keep the first and leave the rest in
      // the preserved document, which meant a form that uploaded three files
      // came back uploading one.
      const sources = (Array.isArray(pair.src) ? pair.src : [pair.src])
        .map((entry) => asString(entry))
        .filter((path) => path !== "");
      return [
        {
          id: id(),
          key: asString(pair.key),
          value: asString(pair.value),
          enabled: pair.disabled !== true,
          kind: isFile ? ("file" as const) : ("text" as const),
          ...(isFile && sources.length > 0 ? { filePaths: sources } : {}),
          ...(asString(pair.contentType) !== ""
            ? { contentType: asString(pair.contentType) }
            : {}),
        },
      ];
    });

    const missing = fields.filter(
      (field) => field.kind === "file" && (field.filePaths ?? []).length === 0
    );
    return {
      body: {
        mode,
        text: "",
        contentType: contentTypeHeader ?? (mode === "urlencoded" ? URLENCODED_TYPE : ""),
        fields,
      },
      note:
        missing.length > 0
          ? "a file field with no path — the file it points at is on the machine it was exported from"
          : undefined,
    };
  }

  if (mode === "file") {
    const src = asString(asObject(object.file)?.src);
    return {
      body: {
        mode: "file",
        text: "",
        contentType: contentTypeHeader ?? "",
        ...(src !== "" ? { filePath: src } : {}),
      },
      note:
        src === ""
          ? "a file body with no path"
          : "a file body — the path points at the machine it was exported from",
    };
  }

  // GraphQL: the query and the variables stay apart, and are combined into the
  // JSON the wire expects only at send time.
  const graphql = asObject(object.graphql) ?? {};
  return {
    body: {
      mode: "graphql",
      text: asString(graphql.query),
      contentType: contentTypeHeader ?? JSON_TYPE,
      graphqlVariables: asString(graphql.variables),
    },
  };
}

/** The URL of a request entry, from `raw` where there is one and from the
 * parts where there is not. `raw` wins because it is what the author typed. */
export function urlFromDocument(value: unknown): string {
  if (typeof value === "string") return value;
  const object = asObject(value);
  if (!object) return "";

  const raw = asString(object.raw);
  if (raw !== "") return raw;

  const parts: UrlParts = {
    raw: "",
    protocol: asString(object.protocol) || undefined,
    host: hostOf(object.host),
    port: asString(object.port) || undefined,
    path: pathOf(object.path),
    query: asArray(object.query).flatMap((entry) => {
      const param = asObject(entry);
      if (!param) return [];
      return [
        {
          key: asString(param.key),
          value: param.value === null ? null : asString(param.value),
          disabled: param.disabled === true,
        },
      ];
    }),
    hash: asString(object.hash) || undefined,
  };
  return serializeUrl(parts);
}

/** `host` is a list of labels, but some documents write it as one string. */
function hostOf(value: unknown): string[] | undefined {
  if (typeof value === "string") return value === "" ? undefined : value.split(".");
  const list = asArray(value).map((part) => asString(part));
  return list.length > 0 ? list : undefined;
}

/** `path` is a list of segments, each sometimes an object carrying a variable. */
function pathOf(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.replace(/^\//, "");
    return trimmed === "" ? undefined : trimmed.split("/");
  }
  const list = asArray(value).map((segment) => {
    if (typeof segment === "string") return segment;
    const object = asObject(segment);
    return object ? asString(object.value) : "";
  });
  return list.length > 0 ? list : undefined;
}

/**
 * The saved responses on a request.
 *
 * Read into rows of their own rather than left in the preserved document,
 * because they are shown, renamed and deleted — and because an example is the
 * part of a collection that turns it from a list of URLs into documentation.
 */
function examplesFromDocument(value: unknown): ImportedExample[] {
  return asArray(value).flatMap((entry) => {
    const response = asObject(entry);
    if (!response) return [];

    const headers = asArray(response.header).flatMap((item) => {
      const header = asObject(item);
      return header ? [{ name: asString(header.key), value: asString(header.value) }] : [];
    });

    return [
      {
        name: asString(response.name, "Example"),
        status: typeof response.code === "number" ? response.code : null,
        statusText: asString(response.status) || null,
        headers: headers.length > 0 ? headers : null,
        body: typeof response.body === "string" ? response.body : null,
        raw: response,
      },
    ];
  });
}

/**
 * Walks the tree, flattening it into rows with parent indices.
 *
 * Depth first, so a parent is always earlier in the list than its children —
 * which is what the store's importer relies on to resolve them.
 */
function walk(
  entries: unknown[],
  parent: number | null,
  items: ImportedItem[],
  notes: ImportNote[],
  id: () => string,
  counts: { folders: number; requests: number; variables: number }
): void {
  let rank: string | null = null;

  for (const entry of entries) {
    const node = asObject(entry);
    if (!node) continue;

    rank = between(rank, null);
    const name = asString(node.name, "Untitled");
    const children = node.item;

    if (Array.isArray(children)) {
      counts.folders++;
      const index = items.length;
      items.push({
        kind: "folder",
        name,
        description: description(node.description),
        rank,
        parent,
        auth: node.auth ?? null,
        events: node.event ?? null,
        variables: node.variable ?? null,
        raw: node,
        examples: [],
      });
      walk(children, index, items, notes, id, counts);
      continue;
    }

    counts.requests++;
    const request = node.request;
    // The format allows `request` to be a bare URL string, which means a GET.
    const details = asObject(request);
    const headers = headersFromDocument(details?.header, id);
    const contentType = headers.find(
      (header) => header.name.toLowerCase() === "content-type" && header.enabled
    )?.value;
    const { body, note } = bodyFromDocument(details?.body, contentType, id);

    if (note) {
      notes.push({ level: "warning", message: `"${name}" has ${note}.` });
    }

    items.push({
      kind: "request",
      name,
      description: "",
      rank,
      parent,
      auth: details?.auth ?? null,
      events: node.event ?? null,
      variables: node.variable ?? null,
      raw: node,
      examples: examplesFromDocument(node.response),
      request: {
        method: (asString(details?.method, "GET").toUpperCase() || "GET") as HttpMethod,
        url: urlFromDocument(typeof request === "string" ? request : details?.url),
        headers,
        body,
      },
    });
  }
}

function readCollection(document: RawObject, rank: string, notes: ImportNote[], counts: ImportOutcome["counts"]): ImportedCollection {
  const info = asObject(document.info) ?? {};
  const items: ImportedItem[] = [];
  walk(asArray(document.item), null, items, notes, idSource(), counts);

  return {
    name: asString(info.name, "Imported collection"),
    description: description(info.description),
    rank,
    auth: document.auth ?? null,
    variables: document.variable ?? null,
    events: document.event ?? null,
    raw: document,
    items,
  };
}

function readEnvironment(document: RawObject, counts: ImportOutcome["counts"]): ImportedEnvironment {
  const scope = variableScope(document);
  const variables = asArray(document.values).flatMap((entry) => {
    const value = asObject(entry);
    if (!value) return [];
    counts.variables++;
    return [
      {
        key: asString(value.key),
        value: asString(value.value),
        enabled: value.enabled !== false,
        // The format marks a secret by its `type`, which is the only signal
        // there is that a value should not be written into a shared row.
        secret: asString(value.type) === "secret",
      },
    ];
  });

  return {
    name: asString(document.name, "Imported environment"),
    isGlobal: scope === "globals",
    variables,
    raw: document,
  };
}

/**
 * Reads one file.
 *
 * `source` is the filename, used only in the report — a person importing six
 * files at once needs to know which one had the problem.
 */
export function readDocument(text: string, source: string): ImportOutcome {
  const notes: ImportNote[] = [];
  const counts = { folders: 0, requests: 0, variables: 0 };
  const outcome: ImportOutcome = {
    kind: "unknown",
    collections: [],
    environments: [],
    notes,
    counts,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    notes.push({ level: "error", message: `${source} is not valid JSON: ${error}` });
    return outcome;
  }

  const kind = detectKind(parsed);
  outcome.kind = kind;

  if (kind === "collection") {
    const version = schemaVersion(parsed);
    if (version === "2.0.0") {
      notes.push({
        level: "info",
        message: `${source} is a v2.0.0 collection, read as v2.1.0.`,
      });
    } else if (version === "unknown") {
      notes.push({
        level: "warning",
        message: `${source} does not say which schema version it is; read as v2.1.0.`,
      });
    }
    const document = upgradeToLatest(parsed as RawObject);
    outcome.collections.push(readCollection(document, between(null, null), notes, counts));
    return outcome;
  }

  if (kind === "environment") {
    outcome.environments.push(readEnvironment(parsed as RawObject, counts));
    return outcome;
  }

  if (kind === "dump") {
    // A whole-account backup: collections and environments in one file.
    const root = asObject(parsed)!;
    let rank: string | null = null;
    for (const entry of asArray(root.collections)) {
      const document = asObject(entry);
      if (!document) continue;
      rank = between(rank, null);
      outcome.collections.push(
        readCollection(upgradeToLatest(document), rank, notes, counts)
      );
    }
    for (const entry of asArray(root.environments)) {
      const document = asObject(entry);
      if (document) outcome.environments.push(readEnvironment(document, counts));
    }
    if (outcome.collections.length === 0 && outcome.environments.length === 0) {
      notes.push({ level: "warning", message: `${source} held nothing importable.` });
    }
    return outcome;
  }

  notes.push({
    level: "error",
    message: `${source} is not a collection or an environment this can read.`,
  });
  return outcome;
}
