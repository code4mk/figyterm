/**
 * A cURL command, turned into a request.
 *
 * This is how most API calls are actually shared: pasted out of a terminal, a
 * browser's network tab, or a page of documentation. Reading it is the single
 * cheapest thing this app can do to be useful on the first day someone opens
 * it, and it costs no file format at all.
 *
 * The parser is deliberately forgiving. A command it does not fully understand
 * still produces a request with whatever it did understand, and says what it
 * skipped; refusing the whole paste because of one unknown flag would be the
 * wrong trade every time.
 */

import { BodyField, HeaderRow, HttpMethod, RequestBody } from "../../../types/api";
import { JSON_TYPE, URLENCODED_TYPE } from "./schema";

export interface ParsedCurl {
  method: HttpMethod;
  url: string;
  headers: HeaderRow[];
  body: RequestBody;
  /** Flags that were recognised but cannot be honoured yet. */
  notes: string[];
}

/** Whether a paste is worth trying to read as a command. */
export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(\s|$)/.test(text);
}

/**
 * Splits a command line into arguments the way a shell would.
 *
 * Single quotes are literal, double quotes allow `\"`, a backslash before a
 * newline continues the line, and `$'…'` is read as an ordinary quoted string.
 * Getting this wrong mangles JSON bodies, which are full of quotes, so it is
 * done properly rather than with a split on whitespace.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;

    if (quote === null && character === "\\" && command[index + 1] === "\n") {
      index++;
      continue;
    }
    if (quote === null && character === "\\" && command[index + 1] === "\r") {
      index += command[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    if (quote === "\"" && character === "\\" && index + 1 < command.length) {
      current += command[index + 1];
      index++;
      started = true;
      continue;
    }
    // Outside quotes a backslash escapes the next character, which is how a
    // single quote gets into a single-quoted string at all: the shell idiom is
    // to close, escape, and reopen — `'it'\''s here'`. Without this, a body
    // containing an apostrophe is cut in three, and the generated command this
    // app writes cannot be read back by it.
    if (quote === null && character === "\\" && index + 1 < command.length) {
      current += command[index + 1];
      index++;
      started = true;
      continue;
    }
    if (quote === null && (character === '"' || character === "'")) {
      // `$'…'` is bash's escaped-string form; the dollar is not part of it.
      if (current.endsWith("$")) current = current.slice(0, -1);
      quote = character;
      started = true;
      continue;
    }
    if (quote !== null && character === quote) {
      quote = null;
      continue;
    }
    if (quote === null && /\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

/** Flags that take no value and change nothing this app does. */
const IGNORED = new Set([
  "-L",
  "--location",
  "--compressed",
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-v",
  "--verbose",
  "-f",
  "--fail",
  "--no-buffer",
  "-#",
  "--progress-bar",
]);

/** Flags that take a value which changes nothing this app does. */
const IGNORED_WITH_VALUE = new Set([
  "-o",
  "--output",
  "-w",
  "--write-out",
  "--max-time",
  "--connect-timeout",
  "--retry",
]);

function header(id: number, name: string, value: string): HeaderRow {
  return { id: `c${id}`, name, value, enabled: true };
}

/**
 * Reads the command.
 *
 * Returns `null` only when there is no URL in it at all, since a request
 * without one is not a request.
 */
export function parseCurl(command: string): ParsedCurl | null {
  const tokens = tokenize(command.trim());
  if (tokens.length === 0) return null;
  if (tokens[0] === "curl") tokens.shift();

  const headers: HeaderRow[] = [];
  const notes: string[] = [];
  const data: string[] = [];
  const form: BodyField[] = [];
  let method: string | null = null;
  let url = "";
  let asQuery = false;
  let nextId = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const value = () => tokens[++index] ?? "";

    if (IGNORED.has(token)) continue;
    if (IGNORED_WITH_VALUE.has(token)) {
      index++;
      continue;
    }

    switch (token) {
      case "-X":
      case "--request":
        method = value().toUpperCase();
        break;

      case "-H":
      case "--header": {
        const text = value();
        const colon = text.indexOf(":");
        if (colon === -1) {
          // `-H "X-Thing;"` is curl's way of sending an empty header.
          headers.push(header(nextId++, text.replace(/;$/, ""), ""));
        } else {
          headers.push(
            header(nextId++, text.slice(0, colon).trim(), text.slice(colon + 1).trim())
          );
        }
        break;
      }

      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        data.push(value());
        break;

      case "--data-urlencode": {
        const pair = value();
        const equals = pair.indexOf("=");
        data.push(
          equals === -1
            ? encodeURIComponent(pair)
            : `${pair.slice(0, equals)}=${encodeURIComponent(pair.slice(equals + 1))}`
        );
        break;
      }

      case "-G":
      case "--get":
        asQuery = true;
        break;

      case "-I":
      case "--head":
        method = "HEAD";
        break;

      case "-u":
      case "--user": {
        const credentials = value();
        headers.push(header(nextId++, "Authorization", `Basic ${base64(credentials)}`));
        break;
      }

      case "-b":
      case "--cookie":
        headers.push(header(nextId++, "Cookie", value()));
        break;

      case "-A":
      case "--user-agent":
        headers.push(header(nextId++, "User-Agent", value()));
        break;

      case "-e":
      case "--referer":
        headers.push(header(nextId++, "Referer", value()));
        break;

      case "-k":
      case "--insecure":
        notes.push(
          "The command skips certificate checks. This request will verify them; the response pane offers to stop if one fails."
        );
        break;

      case "-F":
      case "--form": {
        // `key=value`, or `key=@path` for a file, with an optional
        // `;type=image/png` after it.
        const text = value();
        const equals = text.indexOf("=");
        if (equals === -1) {
          notes.push(`Skipped the form field ${text}, which has no value.`);
          break;
        }

        const key = text.slice(0, equals);
        let rest = text.slice(equals + 1);
        let contentType: string | undefined;
        const typeAt = rest.indexOf(";type=");
        if (typeAt !== -1) {
          contentType = rest.slice(typeAt + 6);
          rest = rest.slice(0, typeAt);
        }

        const isFile = rest.startsWith("@") || rest.startsWith("<");
        form.push({
          id: `f${form.length}`,
          key,
          value: isFile ? "" : rest,
          enabled: true,
          kind: isFile ? "file" : "text",
          ...(isFile ? { filePath: rest.slice(1) } : {}),
          ...(contentType ? { contentType } : {}),
        });
        break;
      }

      case "--url":
        url = value();
        break;

      default:
        if (token.startsWith("-")) {
          notes.push(`Skipped ${token}, which this does not understand.`);
          // A flag with an attached value (`--foo=bar`) has already consumed
          // it; one with a separate value would leave that value to be read as
          // the URL, so it is stepped over unless it looks like one.
          const next = tokens[index + 1];
          if (next && !next.startsWith("-") && !looksLikeUrl(next)) index++;
        } else if (url === "") {
          url = token;
        }
    }
  }

  if (url === "") return null;

  let text = data.join("&");
  if (asQuery && text !== "") {
    url += (url.includes("?") ? "&" : "?") + text;
    text = "";
  }

  const contentType = headers.find(
    (entry) => entry.name.toLowerCase() === "content-type"
  )?.value;

  // curl's own default when there is data and no type: form encoding. Matching
  // it matters, because a command that worked in a terminal has to work here.
  const body: RequestBody =
    form.length > 0
      ? { mode: "formdata", text: "", contentType: "", fields: form }
      : text === ""
        ? { mode: "none", text: "", contentType: JSON_TYPE }
        : {
            mode: "raw",
            text,
            contentType: contentType ?? URLENCODED_TYPE,
          };

  const sendsSomething = text !== "" || form.length > 0;

  return {
    method: (method ?? (sendsSomething ? "POST" : "GET")) as HttpMethod,
    url,
    headers,
    body,
    notes,
  };
}

function looksLikeUrl(token: string): boolean {
  return /^(https?:\/\/|\{\{)/i.test(token) || /^[\w.-]+\.[a-z]{2,}/i.test(token);
}

/**
 * Base64 for the basic-auth header.
 *
 * `btoa` handles Latin-1 only, so anything outside it is UTF-8 encoded by hand
 * first — a password with an accent in it would otherwise throw.
 */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
