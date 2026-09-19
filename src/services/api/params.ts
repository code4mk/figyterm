/**
 * The query string, as a table.
 *
 * **The URL is the only source of truth.** The table reads it and writes it
 * back; it does not keep a second copy. That is the one design decision here
 * worth defending: a params table holding its own list *beside* a URL bar is
 * two places that say what will be sent, and the moment somebody edits the URL
 * directly they disagree — silently, and in favour of whichever one the send
 * path happens to read.
 *
 * The exception is an **unticked** row. It cannot live in the URL, because the
 * URL is what goes on the wire, so those are parked by the caller and merged
 * back in here. They are view state and nothing more: unticking a parameter is
 * a thing you do for a minute, and it is not saved into the collection.
 *
 * Template-tolerant throughout, because a query in a collection is rarely a
 * query — it is `?key={{api_key}}&page={{page}}` — and every split has to
 * ignore separators inside braces.
 */

import { splitOutsideTemplates } from "./url";

/** One row of the table. */
export interface QueryRow {
  id: string;
  key: string;
  /** The raw text between `=` and the next `&`, not decoded. */
  value: string;
  enabled: boolean;
  /** A bare `?flag` with no `=` at all, which is not the same as an empty
   * value — some servers care, and round-tripping it wrong changes the
   * request. */
  bare?: boolean;
}

/** Everything before the `?`, and the `#fragment` if there is one. */
function parts(url: string): { head: string; query: string; hash: string } {
  const hashAt = indexOutside(url, "#");
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);

  const queryAt = indexOutside(withoutHash, "?");
  return {
    head: queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt),
    query: queryAt === -1 ? "" : withoutHash.slice(queryAt + 1),
    hash,
  };
}

/** The first `character` outside `{{…}}`, or -1. A `?` inside a variable is
 * part of somebody's default value, not the start of the query. */
function indexOutside(text: string, character: string): number {
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

/** The parameters in a URL, in order. */
export function paramsOf(url: string, newId: () => string): QueryRow[] {
  const { query } = parts(url);
  if (query === "") return [];

  return splitOutsideTemplates(query, "&")
    // A trailing `&`, or `?&a=1`, produces an empty piece that is not a
    // parameter — dropping it keeps the table from growing a blank row that
    // writing back would then make permanent.
    .filter((pair) => pair !== "")
    .map((pair) => {
      const equals = indexOutside(pair, "=");
      return equals === -1
        ? { id: newId(), key: pair, value: "", enabled: true, bare: true }
        : {
            id: newId(),
            key: pair.slice(0, equals),
            value: pair.slice(equals + 1),
            enabled: true,
          };
    });
}

/** The query string a set of rows would produce. Unticked and unnamed rows are
 * left out: this is what goes on the wire. */
function queryOf(rows: QueryRow[]): string {
  return rows
    .filter((row) => row.enabled && row.key !== "")
    .map((row) => (row.bare && row.value === "" ? row.key : `${row.key}=${row.value}`))
    .join("&");
}

/**
 * The URL with its query replaced.
 *
 * The `?` goes when the last parameter does, rather than being left behind as
 * a trailing `?` — which is legal, sent, and looks to everybody like a bug.
 */
export function withParams(url: string, rows: QueryRow[]): string {
  const { head, hash } = parts(url);
  const query = queryOf(rows);
  return `${head}${query === "" ? "" : `?${query}`}${hash}`;
}

/**
 * The table for a URL, keeping the rows the table already had.
 *
 * Called on every keystroke in the URL bar, so it has to be stable: rebuilding
 * the rows from scratch each time would hand React a new `id` per row per
 * keystroke, and the cell being typed in would lose focus on every character.
 *
 * Unticked rows are not in the URL — that is what unticking means — so they are
 * kept from `existing` at the position they held, and the URL's parameters fill
 * in around them.
 */
export function syncParams(
  url: string,
  existing: QueryRow[],
  newId: () => string
): QueryRow[] {
  const fromUrl = paramsOf(url, newId);
  const parked = existing.filter((row) => !row.enabled);

  // Nothing unticked, and the same parameters as last time: keep the rows
  // exactly as they are, ids and all.
  const enabled = existing.filter((row) => row.enabled);
  const unchanged =
    enabled.length === fromUrl.length &&
    enabled.every(
      (row, index) =>
        row.key === fromUrl[index]!.key &&
        row.value === fromUrl[index]!.value &&
        (row.bare ?? false) === (fromUrl[index]!.bare ?? false)
    );
  if (unchanged && parked.length === 0) return existing;

  // Reuse the id of the row that was in this position, so a row being edited
  // keeps its identity and its focus.
  const reused = fromUrl.map((row, index) => {
    const previous = enabled[index];
    return previous ? { ...row, id: previous.id } : row;
  });

  if (parked.length === 0) return reused;

  // The unticked rows go back where they were. Their old index is against the
  // full list, which is the list this rebuilds, so it is walked in order.
  const merged: QueryRow[] = [];
  let next = 0;
  for (const row of existing) {
    if (row.enabled) continue;
    const at = existing.indexOf(row);
    while (next < reused.length && merged.length < at) merged.push(reused[next++]!);
    merged.push(row);
  }
  while (next < reused.length) merged.push(reused[next++]!);
  return merged;
}

/** How many will actually be sent — what the tab badge counts. */
export function activeCount(rows: QueryRow[]): number {
  return rows.filter((row) => row.enabled && row.key !== "").length;
}
