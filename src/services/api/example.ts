/**
 * The request an example was captured from.
 *
 * An example is a response somebody kept, and the format keeps the request
 * beside it — `originalRequest` on the stored entry. Without it an example is
 * a body with no explanation: you can read the 422 but not what was sent to
 * earn it, which is most of what makes a kept response documentation.
 *
 * It is read out of `raw` rather than stored in columns of its own. The
 * original entry is already kept verbatim so export can put back what this
 * model does not understand, and a second copy in columns would be a second
 * thing to keep in step with it.
 *
 * Pure, so the reading is testable: real documents put the URL in three
 * different shapes and the body in six, and this has to survive all of them
 * without throwing — an example that cannot be read is still an example
 * somebody kept.
 */

import { ApiExample, HeaderRow, HttpMethod, RequestBody } from "../../types/api";
import { bodyFromDocument, headersFromDocument, urlFromDocument } from "./interchange/import";

export interface ExampleRequest {
  method: HttpMethod;
  url: string;
  headers: HeaderRow[];
  body: RequestBody;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * What was sent to produce this example, or `null` when the document did not
 * say.
 *
 * `null` rather than an empty request: "there is no record of what was sent"
 * and "a GET to nowhere was sent" are different answers, and the pane says so
 * rather than drawing an empty method and URL as though they were the truth.
 */
export function exampleRequest(
  example: Pick<ApiExample, "raw">,
  newId: () => string
): ExampleRequest | null {
  const raw = asObject(example.raw);
  const original = asObject(raw?.originalRequest);
  if (!original) return null;

  const headers = headersFromDocument(original.header, newId);
  const contentType = headers.find(
    (header) => header.name.toLowerCase() === "content-type" && header.enabled
  )?.value;

  return {
    method: (String(original.method ?? "GET").toUpperCase() || "GET") as HttpMethod,
    // The format allows `url` to be a bare string or a structure; the reader
    // the importer uses handles both, and templates in either.
    url: urlFromDocument(original.url),
    headers,
    body: bodyFromDocument(original.body, contentType, newId).body,
  };
}

/** The content type an example's *response* declared, for choosing how to
 * draw the body. Absent is common and not an error. */
export function exampleContentType(example: Pick<ApiExample, "headers">): string | undefined {
  return (
    example.headers?.find((header) => header.name.toLowerCase() === "content-type")?.value ??
    undefined
  );
}
