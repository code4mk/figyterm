/**
 * The header names worth suggesting, and the values worth suggesting for them.
 *
 * Not a complete registry — that is several hundred names, most of which are
 * response headers or belong to a protocol nobody is hand-writing a request
 * for. This is the set somebody actually types into a request, which is short
 * enough to read and therefore short enough to be useful.
 *
 * Canonical casing throughout. HTTP header names are case-insensitive and the
 * server will not care, but `Content-Type` beside `content-type` beside
 * `Content-type` in one table looks like three different headers.
 */

export interface HeaderSuggestion {
  name: string;
  /** What it is for, one line, shown beside the name. */
  hint: string;
}

export const HEADER_SUGGESTIONS: HeaderSuggestion[] = [
  { name: "Accept", hint: "What the client will take back" },
  { name: "Accept-Encoding", hint: "Compression the client understands" },
  { name: "Accept-Language", hint: "Preferred languages" },
  { name: "Authorization", hint: "Credentials — usually set by the Auth tab instead" },
  { name: "Cache-Control", hint: "What may be cached, and for how long" },
  { name: "Content-Type", hint: "What the body is — set by the Body tab unless given here" },
  { name: "Content-Length", hint: "Set by the client; a value here is ignored" },
  { name: "Cookie", hint: "Cookies to send" },
  { name: "Host", hint: "Overrides the host the URL implies" },
  { name: "If-Match", hint: "Only if the resource still has this ETag" },
  { name: "If-None-Match", hint: "Only if the resource has changed" },
  { name: "Idempotency-Key", hint: "Makes a retried write safe" },
  { name: "Origin", hint: "Where the request claims to come from" },
  { name: "Prefer", hint: "A hint the server may honour" },
  { name: "Range", hint: "Part of the resource, not all of it" },
  { name: "Referer", hint: "The page this came from" },
  { name: "User-Agent", hint: "What is making the request" },
  { name: "X-Api-Key", hint: "An API key, where the service wants its own header" },
  { name: "X-Correlation-Id", hint: "Ties this request to a trace" },
  { name: "X-Request-Id", hint: "Identifies this one request" },
];

/**
 * The names matching what has been typed, best first.
 *
 * A prefix match sorts above a match in the middle, because somebody typing
 * `id` means `Idempotency-Key`, not `X-Request-Id` — and an alphabetical list
 * would put the wrong one on top.
 */
export function suggestHeaders(typed: string): HeaderSuggestion[] {
  const needle = typed.trim().toLowerCase();
  if (needle === "") return HEADER_SUGGESTIONS;

  const starts: HeaderSuggestion[] = [];
  const contains: HeaderSuggestion[] = [];
  for (const entry of HEADER_SUGGESTIONS) {
    const name = entry.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(entry);
    else if (name.includes(needle)) contains.push(entry);
  }
  return [...starts, ...contains];
}
