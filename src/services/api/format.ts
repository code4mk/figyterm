/**
 * Reading a response: sizes, durations, content types, and whether a body can
 * be pretty-printed.
 *
 * All pure, all run under Node by `format.test.ts`. The response pane has
 * enough to do without also being the place where "is this JSON" is decided.
 */

import { HeaderPair } from "../../types/api";

/**
 * Above this, `prettyJson` declines rather than reformatting.
 *
 * `JSON.parse` followed by `JSON.stringify` on a 20 MB body blocks the main
 * thread for seconds, and the webview cannot paint that much text usefully
 * anyway. The raw view is always available, so declining costs nothing.
 */
const PRETTY_LIMIT = 2 * 1024 * 1024;

/** Case-insensitive header lookup; HTTP header names are not case-sensitive
 * and a response pane that pretends otherwise misses `content-type`. */
export function headerValue(headers: HeaderPair[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === wanted)?.value;
}

/** `1.4 kB`. Decimal units, because that is what every other tool in this
 * space reports and a size that disagrees with `curl` invites a bug report. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `243 ms`, `1.24 s`, `2 m 05 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${String(seconds).padStart(2, "0")} s`;
}

export type ContentKind = "json" | "html" | "xml" | "text" | "image" | "binary";

/**
 * What kind of thing the body is, from its content type.
 *
 * Suffix-aware, because half the JSON on the internet is served as something
 * like `application/vnd.api+json` — matching on the exact type would render it
 * as plain text and lose the formatting for precisely the APIs most likely to
 * need it.
 */
export function contentKind(contentType: string | undefined): ContentKind {
  if (!contentType) return "text";
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "") return "text";

  if (type === "application/json" || type.endsWith("+json") || type === "text/json") {
    return "json";
  }
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "text/xml" || type === "application/xml" || type.endsWith("+xml")) {
    return "xml";
  }
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/")) return "text";
  if (type === "application/javascript" || type === "application/x-ndjson") return "text";
  if (type === "application/x-www-form-urlencoded") return "text";
  return "binary";
}

/**
 * The body, reformatted — or `null` when it is not JSON after all.
 *
 * `null` rather than a throw or the original string, so the caller can tell
 * "there is nothing to pretty-print" from "here is the pretty-printed version",
 * and disable the toggle rather than offering a view that does nothing. A
 * content type claiming JSON over a body that is an HTML error page is common
 * enough that the text, not the header, has the final say.
 */
export function prettyJson(text: string): string | null {
  if (text.length > PRETTY_LIMIT) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/**
 * `just now`, `4m`, `2h`, `3d`, then a date.
 *
 * `now` is a parameter rather than `Date.now()` so this can be tested, and so a
 * list of fifty history rows all agree about what "now" is instead of each
 * asking the clock.
 */
export function timeAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export type StatusTone = "info" | "success" | "redirect" | "client-error" | "server-error";

export function statusTone(status: number): StatusTone {
  if (status >= 500) return "server-error";
  if (status >= 400) return "client-error";
  if (status >= 300) return "redirect";
  if (status >= 200) return "success";
  return "info";
}

/** The class that colours a status, a method chip or an error line. Kept here
 * rather than inline so the response pane and the history list cannot drift. */
export function toneClass(tone: StatusTone): string {
  switch (tone) {
    case "success":
      return "text-ft-success";
    case "redirect":
      return "text-ft-accent";
    case "client-error":
      return "text-ft-warning";
    case "server-error":
      return "text-ft-error";
    case "info":
      return "text-ft-text-secondary";
  }
}
