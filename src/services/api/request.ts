/**
 * What the request editor holds, reduced to what actually goes on the wire.
 *
 * Kept apart from `client.ts` so it imports nothing from Tauri and can be run
 * under Node: every decision here is one a request can be wrong because of —
 * a disabled row that was sent anyway, a `Content-Type` that overwrote the one
 * that was typed — and each is cheap to pin down with a test and expensive to
 * find by hand.
 */

import {
  BodyField,
  HeaderRow,
  RequestBody,
  SendBody,
  SendField,
  SendInput,
  SendOptions,
} from "../../types/api";

/** A blank header row. Ids key the React list; they never leave the webview. */
export function blankHeader(id: string): HeaderRow {
  return { id, name: "", value: "", enabled: true };
}

/**
 * Whether a row is worth sending.
 *
 * A row with a value and no name is not a header, it is a half-typed one — the
 * editor always keeps one empty row at the end for typing into, and that row
 * must never reach the wire.
 */
export function isSendable(header: HeaderRow): boolean {
  return header.enabled && header.name.trim() !== "";
}

export function hasHeader(headers: { name: string }[], name: string): boolean {
  const wanted = name.toLowerCase();
  return headers.some((header) => header.name.trim().toLowerCase() === wanted);
}

/** The fields worth sending: enabled, and named. */
function sendableFields(fields: BodyField[] | undefined): SendField[] {
  return (fields ?? [])
    .filter((field) => field.enabled && field.key.trim() !== "")
    .map((field) => {
      const sent: SendField = { key: field.key.trim(), value: field.value };
      if (field.kind === "file" && field.filePath) sent.filePath = field.filePath;
      if (field.contentType) sent.contentType = field.contentType;
      return sent;
    });
}

/**
 * What the editor holds, as the wire shape.
 *
 * A body that is empty in its own terms — no text, no enabled fields, no file —
 * becomes `none` rather than an empty one of its kind, so a half-configured
 * form does not send `Content-Length: 0` with a form content type on a GET.
 */
export function buildSendBody(body: RequestBody): SendBody {
  switch (body.mode) {
    case "raw":
      return body.text === "" ? { mode: "none" } : { mode: "raw", text: body.text };

    case "urlencoded": {
      const fields = sendableFields(body.fields);
      return fields.length === 0 ? { mode: "none" } : { mode: "urlencoded", fields };
    }

    case "formdata": {
      const fields = sendableFields(body.fields);
      return fields.length === 0 ? { mode: "none" } : { mode: "formdata", fields };
    }

    case "file":
      return body.filePath ? { mode: "file", path: body.filePath } : { mode: "none" };

    case "graphql":
      return body.text.trim() === ""
        ? { mode: "none" }
        : { mode: "graphql", query: body.text, variables: body.graphqlVariables ?? "" };

    default:
      return { mode: "none" };
  }
}

/** Whether this body's own shape decides its content type, whatever the
 * editor's field says. Rust sets these, so the header table must not. */
function impliesContentType(mode: RequestBody["mode"]): boolean {
  return mode === "urlencoded" || mode === "formdata" || mode === "graphql";
}

export function buildSendInput(params: {
  id: string;
  method: string;
  url: string;
  headers: HeaderRow[];
  body: RequestBody;
  options: SendOptions;
}): SendInput {
  const { id, method, url, headers, body, options } = params;

  const sent = headers
    .filter(isSendable)
    .map((header) => ({ name: header.name.trim(), value: header.value }));

  const wire = buildSendBody(body);

  // A raw body with no `Content-Type` is a request most servers reject for the
  // wrong reason, so the editor's content type fills the gap — but it never
  // overrides a header that was typed, which is the whole point of typing one,
  // and never for a body whose own shape decides the type.
  if (
    wire.mode !== "none" &&
    !impliesContentType(body.mode) &&
    body.contentType &&
    !hasHeader(sent, "content-type")
  ) {
    sent.push({ name: "Content-Type", value: body.contentType });
  }

  return { id, method, url, headers: sent, body: wire, options };
}

/** A blank field row, for the form and multipart tables. */
export function blankField(id: string): BodyField {
  return { id, key: "", value: "", enabled: true, kind: "text" };
}
