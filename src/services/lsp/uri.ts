/**
 * `file://` URIs, which the protocol speaks and the filesystem does not.
 *
 * Fiddly enough to be worth its own file, because both directions have a
 * Windows case that silently produces a path nothing can open: a drive letter
 * needs a third slash (`file:///C:/src`), backslashes are not URI separators,
 * and the colon after the drive letter must survive encoding while every other
 * reserved character must not.
 */

import { isWindows } from "../platform";

/**
 * Percent-encodes one path segment.
 *
 * `encodeURIComponent` is the right tool and slightly too eager: it escapes
 * characters that are legal, unreserved and extremely common in source trees.
 * Leaving them alone keeps the URI readable in logs, which is where anybody
 * debugging this will be looking.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%(2[46F]|3A|40|5B|5D)/gi, decodeURIComponent);
}

/** An absolute filesystem path as a `file://` URI. */
export function pathToUri(path: string): string {
  let normalized = path.replace(/\\/g, "/");

  /*
    A UNC path — `\\server\share\file` — is the one case with a real
    authority. The server name goes *before* the path, so `file://server/share`,
    with two slashes rather than three. Treating it like any other absolute path
    produced `file:////server/share`, which names a host of "" and a path
    beginning `//server` — not the same file, and not a file a server can open.
  */
  const unc = /^\/\/([^/]+)(\/.*)?$/.exec(normalized);
  if (unc) {
    const host = encodeSegment(unc[1]);
    const rest = (unc[2] ?? "/")
      .split("/")
      .map((segment) => encodeSegment(segment))
      .join("/");
    return `file://${host}${rest}`;
  }

  // A drive letter becomes an authority-less absolute path, hence three
  // slashes. Uppercased because servers compare URIs as strings, and a `c:`
  // from us against a `C:` from them is two different documents.
  const drive = /^([a-zA-Z]):/.exec(normalized);
  if (drive) {
    normalized = `/${drive[1].toUpperCase()}:${normalized.slice(2)}`;
  } else if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  const encoded = normalized
    .split("/")
    .map((segment) => (/^[a-zA-Z]:$/.test(segment) ? segment : encodeSegment(segment)))
    .join("/");

  return `file://${encoded}`;
}

/**
 * A `file://` URI back to a filesystem path.
 *
 * Anything that isn't a `file:` URI returns null rather than a guess — a server
 * may legitimately point at `untitled:` or its own scheme for a generated
 * document, and "go to definition" on one of those should do nothing rather
 * than open a file named after a URL.
 */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;

  const body = uri.slice("file://".length);

  /*
    An authority that isn't empty means UNC: `file://server/share` came from
    `\\server\share`, and has to go back as one. Everything else has an empty
    authority and a path starting at the third slash.
  */
  if (body && !body.startsWith("/")) {
    const decoded = decodeURIComponent(body);
    return isWindows ? `\\\\${decoded.replace(/\//g, "\\")}` : `//${decoded}`;
  }

  let path = decodeURIComponent(body);
  if (!path.startsWith("/")) path = `/${path}`;

  // `/C:/src` is a Windows path wearing a URI's leading slash.
  const drive = /^\/([a-zA-Z]):/.exec(path);
  if (drive) {
    const rest = path.slice(3);
    return isWindows ? `${drive[1].toUpperCase()}:${rest.replace(/\//g, "\\")}` : path;
  }

  return path;
}
