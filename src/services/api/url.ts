/**
 * What a half-typed URL means.
 *
 * Nobody types `https://`. They type `api.example.com/v1/users`, or
 * `localhost:3000/health`, and expect the client to work out the rest — which
 * is guesswork, and guesswork is exactly the kind of thing that should be a
 * pure function with the cases written down.
 *
 * The one rule worth defending: **an unqualified host gets `https://`, but a
 * local one gets `http://`.** Defaulting everything to `https` sends people's
 * first request at their dev server to a port that is not listening for TLS;
 * defaulting everything to `http` sends their credentials to a public host in
 * the clear. Neither default is right for both, so neither is used for both.
 */

/** `scheme://` at the front, which means the user has already decided. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A scheme-relative URL — `//example.com/x`, which HTML allows. */
const SCHEME_RELATIVE = /^\/\//;

/** Hosts that are this machine, however they are spelled. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
  "host.docker.internal",
]);

/** The host part of an unqualified URL: everything before the first `/`, `?`
 * or `#`, minus any `user:pass@` and any `:port`. */
function hostOf(raw: string): string {
  const authority = raw.split(/[/?#]/, 1)[0] ?? "";
  const afterCredentials = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;

  // An IPv6 literal keeps its brackets; anything else loses its port.
  if (afterCredentials.startsWith("[")) {
    const close = afterCredentials.indexOf("]");
    return close === -1 ? afterCredentials : afterCredentials.slice(0, close + 1);
  }
  const colon = afterCredentials.indexOf(":");
  return colon === -1 ? afterCredentials : afterCredentials.slice(0, colon);
}

export function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (LOCAL_HOSTS.has(lower)) return true;
  // `.localhost` is reserved for exactly this, and `mysite.test` is the
  // convention every local proxy has settled on.
  return lower.endsWith(".localhost") || lower.endsWith(".test");
}

/**
 * The URL to actually send, given what is in the bar.
 *
 * Returns the input untouched when it already carries a scheme, and `""` for
 * nothing at all — the caller decides what to do about an empty bar; guessing
 * a URL for it would be worse than refusing.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (HAS_SCHEME.test(trimmed)) return trimmed;

  if (SCHEME_RELATIVE.test(trimmed)) {
    const host = hostOf(trimmed.slice(2));
    return `${isLocalHost(host) ? "http" : "https"}://${trimmed.slice(2)}`;
  }

  // A bare port — `:3000/health` — is this machine by every convention there
  // is, and is the shape a copied log line usually has.
  if (trimmed.startsWith(":")) return `http://localhost${trimmed}`;

  return `${isLocalHost(hostOf(trimmed)) ? "http" : "https"}://${trimmed}`;
}

/**
 * Whether this is worth pressing Send on.
 *
 * Deliberately permissive: it rejects an empty bar and a URL with no host, and
 * leaves every other judgement to the server. A client that refuses to send
 * what its user typed, because it disagrees about what a valid URL is, is worse
 * than one that shows the error the server gave.
 */
export function isSendableUrl(raw: string): boolean {
  const normalized = normalizeUrl(raw);
  if (normalized === "") return false;
  const rest = normalized.slice(normalized.indexOf("://") + 3);
  return hostOf(rest) !== "";
}

/** `api.example.com/v1/users` — what the tab strip and history show, once
 * there is more than one request to tell apart. */
export function shortUrl(raw: string): string {
  const normalized = normalizeUrl(raw);
  if (normalized === "") return "";
  return normalized.replace(HAS_SCHEME, "").replace(/\/$/, "");
}

// ─── Parsing, for the interchange format ─────────────────────────────────────
//
// The collection format stores a URL twice: as `raw` text, and as a structure
// of protocol, host, path and query. Both have to be written on export, and
// either may be the only one present on import.
//
// Everything below is template-tolerant, which is the whole difficulty. A URL
// in a collection is rarely a URL — it is `{{base_url}}/users/{{id}}?k={{key}}`,
// and a parser that reaches for `new URL()` throws on the first one it sees.

/** One query parameter as the format stores it. */
export interface QueryParam {
  key: string;
  /** Null for a bare `?flag` with no `=`, which is not the same as empty. */
  value: string | null;
  disabled?: boolean;
}

/** A path variable — the `:id` in `/users/:id`. */
export interface PathVariable {
  key: string;
  value?: string;
}

export interface UrlParts {
  raw: string;
  protocol?: string;
  host?: string[];
  port?: string;
  path?: string[];
  query?: QueryParam[];
  hash?: string;
  variable?: PathVariable[];
}

/**
 * Splits on a separator, ignoring any that fall inside `{{…}}`.
 *
 * The reason this exists: `{{host}}.example.com` must not lose its braces to a
 * split on `.`, and `?q={{a&b}}` is one parameter, not two. Every split in this
 * file goes through here.
 */
export function splitOutsideTemplates(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (let index = 0; index < text.length; index++) {
    if (text.startsWith("{{", index)) {
      depth++;
      current += "{{";
      index++;
      continue;
    }
    if (text.startsWith("}}", index) && depth > 0) {
      depth--;
      current += "}}";
      index++;
      continue;
    }
    if (depth === 0 && text.startsWith(separator, index)) {
      parts.push(current);
      current = "";
      index += separator.length - 1;
      continue;
    }
    current += text[index];
  }
  parts.push(current);
  return parts;
}

/** The index of the first `character` outside a template, or -1. */
function indexOutsideTemplates(text: string, character: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith("{{", index)) {
      depth++;
      index++;
      continue;
    }
    if (text.startsWith("}}", index) && depth > 0) {
      depth--;
      index++;
      continue;
    }
    if (depth === 0 && text[index] === character) return index;
  }
  return -1;
}

/** Whether the text is entirely one template, like `{{base_url}}`. */
function isTemplate(text: string): boolean {
  return /^\{\{[^}]*\}\}$/.test(text);
}

/**
 * The structure behind a URL string.
 *
 * `raw` always comes back exactly as it went in; everything else is a reading
 * of it. Nothing here throws — a URL nobody can parse is still a URL somebody
 * typed, and it goes out with just its raw form rather than being refused.
 */
export function parseUrl(raw: string): UrlParts {
  const parts: UrlParts = { raw };
  let rest = raw.trim();
  if (rest === "") return parts;

  const hashAt = indexOutsideTemplates(rest, "#");
  if (hashAt !== -1) {
    parts.hash = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }

  const queryAt = indexOutsideTemplates(rest, "?");
  if (queryAt !== -1) {
    const queryText = rest.slice(queryAt + 1);
    rest = rest.slice(0, queryAt);
    if (queryText !== "") {
      parts.query = splitOutsideTemplates(queryText, "&").map((pair) => {
        const equals = indexOutsideTemplates(pair, "=");
        return equals === -1
          ? { key: pair, value: null }
          : { key: pair.slice(0, equals), value: pair.slice(equals + 1) };
      });
    }
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    parts.protocol = scheme[1]!.toLowerCase();
    rest = rest.slice(scheme[0].length);
  }

  const slashAt = indexOutsideTemplates(rest, "/");
  let authority = slashAt === -1 ? rest : rest.slice(0, slashAt);
  const pathText = slashAt === -1 ? "" : rest.slice(slashAt + 1);

  // Credentials belong to the authority but not to the host, and treating
  // `user:pass@host` as a host would put the password in the host array.
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);

  if (authority !== "") {
    if (authority.startsWith("[")) {
      // An IPv6 literal keeps its brackets and is one host element.
      const close = authority.indexOf("]");
      const literal = close === -1 ? authority : authority.slice(0, close + 1);
      const after = close === -1 ? "" : authority.slice(close + 1);
      parts.host = [literal];
      if (after.startsWith(":")) parts.port = after.slice(1);
    } else {
      const colon = indexOutsideTemplates(authority, ":");
      const host = colon === -1 ? authority : authority.slice(0, colon);
      if (colon !== -1) parts.port = authority.slice(colon + 1);
      parts.host = isTemplate(host) ? [host] : splitOutsideTemplates(host, ".");
    }
  }

  if (pathText !== "") {
    parts.path = splitOutsideTemplates(pathText, "/");
    const variables = parts.path
      .filter((segment) => segment.startsWith(":") && segment.length > 1)
      .map((segment) => ({ key: segment.slice(1) }));
    if (variables.length > 0) parts.variable = variables;
  }

  return parts;
}

/**
 * The URL string for a structure, used when a document gives the parts but no
 * `raw` — which real files do.
 *
 * Disabled parameters are left out, because this is the URL that would be
 * *sent*. They survive in the stored document and come back on export.
 */
export function serializeUrl(parts: UrlParts): string {
  let text = "";
  if (parts.protocol) text += `${parts.protocol}://`;
  if (parts.host?.length) text += parts.host.join(".");
  if (parts.port) text += `:${parts.port}`;
  if (parts.path?.length) text += `/${parts.path.join("/")}`;

  const enabled = (parts.query ?? []).filter((param) => !param.disabled);
  if (enabled.length > 0) {
    text += `?${enabled
      .map((param) => (param.value === null ? param.key : `${param.key}=${param.value}`))
      .join("&")}`;
  }
  if (parts.hash) text += `#${parts.hash}`;
  return text;
}
