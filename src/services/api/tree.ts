/**
 * The rail's rows: a flat list of what is currently visible.
 *
 * Flat rather than nested, because the rail renders a list and a nested render
 * would need a recursive component to answer "which row is above this one" for
 * keyboard navigation and drag targets. Depth is a number on the row.
 *
 * Searching does not filter the list, it *reveals* — a match drags its
 * ancestors into view with it and ignores whether they were collapsed, which is
 * the behaviour every file tree has and the only one that makes a hit findable.
 * Without the ancestors, a matching request appears at the top level with no
 * indication of which collection it belongs to.
 */

import { ApiCollection, ApiExampleSummary, ApiItem } from "../../types/api";
import { byRank } from "./rank";

export type RowKind = "collection" | "folder" | "request" | "example";

export interface TreeRow {
  id: string;
  kind: RowKind;
  name: string;
  /** 0 for a collection, 1 for its children, and so on. */
  depth: number;
  collectionId: string;
  /** Null for a collection and for an item at the top of one. On an example,
   * the request it was kept against. */
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
  /** Request rows only. */
  method: string | null;
  url: string | null;
  /** Example rows only: the status that was kept. */
  status: number | null;
  /** A copy a sync kept when both sides had changed the row. */
  conflicted: boolean;
}

/** Whether a row matches the query — name, method or URL. */
function matches(
  query: string,
  name: string,
  method: string | null,
  url: string | null
): boolean {
  const needle = query.toLowerCase();
  return (
    name.toLowerCase().includes(needle) ||
    (method?.toLowerCase().includes(needle) ?? false) ||
    (url?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * Every id that matches, plus every ancestor of a match.
 *
 * Returned as a set rather than a filtered tree so the walk below stays one
 * pass: a row is drawn if it is in here, and expanded if it is in here and has
 * a child in here.
 */
function revealed(
  collections: ApiCollection[],
  items: ApiItem[],
  query: string
): Set<string> {
  const keep = new Set<string>();
  const byId = new Map(items.map((item) => [item.id, item]));

  const keepAncestors = (item: ApiItem) => {
    keep.add(item.collectionId);
    let parent = item.parentId ? byId.get(item.parentId) : undefined;
    // A cycle cannot happen through the UI, but a corrupt parent chain should
    // not hang the rail.
    const seen = new Set<string>();
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      keep.add(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
  };

  for (const collection of collections) {
    if (matches(query, collection.name, null, null)) keep.add(collection.id);
  }
  for (const item of items) {
    if (matches(query, item.name, item.method, item.url)) {
      keep.add(item.id);
      keepAncestors(item);
    }
  }
  return keep;
}

export interface TreeOptions {
  /** Ids of collections, folders and requests the user has opened. */
  expanded: Set<string>;
  /** Empty means "show the tree as it is expanded". */
  query: string;
  /**
   * Kept responses, to hang under the requests they belong to.
   *
   * Optional so a caller that has none — a test, or a rail drawn before the
   * first snapshot has arrived — gets the tree it already had.
   */
  examples?: ApiExampleSummary[];
}

/**
 * The visible rows, in order.
 *
 * A collection with no children still gets a row: an empty collection you
 * cannot see is one you cannot add anything to.
 */
export function buildTree(
  collections: ApiCollection[],
  items: ApiItem[],
  options: TreeOptions
): TreeRow[] {
  const query = options.query.trim();
  const searching = query !== "";
  const keep = searching ? revealed(collections, items, query) : null;

  const childrenOf = new Map<string, ApiItem[]>();
  for (const item of items) {
    const key = item.parentId ?? `collection:${item.collectionId}`;
    const list = childrenOf.get(key);
    if (list) list.push(item);
    else childrenOf.set(key, [item]);
  }
  for (const list of childrenOf.values()) list.sort(byRank);

  const examplesOf = new Map<string, ApiExampleSummary[]>();
  for (const example of options.examples ?? []) {
    const list = examplesOf.get(example.itemId);
    if (list) list.push(example);
    else examplesOf.set(example.itemId, [example]);
  }
  for (const list of examplesOf.values()) list.sort(byRank);

  const rows: TreeRow[] = [];

  const walk = (parentKey: string, collectionId: string, depth: number) => {
    for (const item of childrenOf.get(parentKey) ?? []) {
      if (keep && !keep.has(item.id)) continue;

      const children = childrenOf.get(item.id) ?? [];
      const kept = item.kind === "request" ? (examplesOf.get(item.id) ?? []) : [];
      // A request with kept responses opens too — its children are the
      // examples rather than more requests.
      const hasChildren =
        item.kind === "folder" ? children.length > 0 : kept.length > 0;
      // While searching, anything on the path to a hit is open — a collapsed
      // folder holding the only match is a search that appears to find nothing.
      // Examples are the exception: they are not searched, so opening every
      // request that matched would bury the matches in their own history.
      const expanded =
        item.kind === "folder" ? searching || options.expanded.has(item.id) : options.expanded.has(item.id);

      rows.push({
        id: item.id,
        kind: item.kind,
        name: item.name,
        depth,
        collectionId,
        parentId: item.parentId,
        hasChildren,
        expanded: hasChildren && expanded,
        method: item.method,
        url: item.url,
        status: null,
        conflicted: item.conflictedAt != null,
      });

      if (!hasChildren || !expanded) continue;

      if (item.kind === "folder") {
        walk(item.id, collectionId, depth + 1);
        continue;
      }

      for (const example of kept) {
        rows.push({
          id: example.id,
          kind: "example",
          name: example.name,
          depth: depth + 1,
          collectionId,
          parentId: item.id,
          hasChildren: false,
          expanded: false,
          method: null,
          url: null,
          status: example.status,
          conflicted: false,
        });
      }
    }
  };

  for (const collection of [...collections].sort(byRank)) {
    if (keep && !keep.has(collection.id)) continue;

    const children = childrenOf.get(`collection:${collection.id}`) ?? [];
    const expanded = searching ? true : options.expanded.has(collection.id);

    rows.push({
      id: collection.id,
      kind: "collection",
      name: collection.name,
      depth: 0,
      collectionId: collection.id,
      parentId: null,
      hasChildren: children.length > 0,
      expanded: children.length > 0 && expanded,
      method: null,
      url: null,
      status: null,
      conflicted: collection.conflictedAt != null,
    });

    if (expanded) walk(`collection:${collection.id}`, collection.id, 1);
  }

  return rows;
}

/** The items directly under a folder, or at the top of a collection, in order.
 * What a drop target needs in order to work out a rank. */
export function siblingsOf(
  items: ApiItem[],
  collectionId: string,
  parentId: string | null
): ApiItem[] {
  return items
    .filter(
      (item) =>
        item.collectionId === collectionId && (item.parentId ?? null) === parentId
    )
    .sort(byRank);
}

/**
 * Whether `folderId` is `itemId` or sits inside it.
 *
 * The check that stops a folder being dropped into its own child, which would
 * detach the whole subtree from the tree and leave it addressable by nothing.
 */
export function isWithin(items: ApiItem[], itemId: string, folderId: string): boolean {
  if (itemId === folderId) return true;
  const byId = new Map(items.map((item) => [item.id, item]));
  let current = byId.get(folderId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === itemId) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

/** One step on the way to a request: where it is, and what to open. */
export interface Crumb {
  id: string;
  name: string;
  kind: "collection" | "folder" | "request";
}

/**
 * The trail from a collection down to one item.
 *
 * A request called `token` is meaningless on its own — three collections have
 * one — and the tab strip has room for the name and nothing else. The trail is
 * what says *which* `token`, and each step is somewhere to go back to.
 *
 * Built by walking parents up and reversing, so a folder nested six deep costs
 * six lookups rather than a search of the whole list per level. A parent that
 * is missing — a half-applied sync, a row deleted while a tab was open — ends
 * the walk rather than throwing: a short trail is still worth drawing.
 */
export function crumbsOf(
  items: ApiItem[],
  collections: ApiCollection[],
  itemId: string | null
): Crumb[] {
  if (!itemId) return [];

  const byId = new Map(items.map((item) => [item.id, item]));
  const item = byId.get(itemId);
  if (!item) return [];

  const trail: Crumb[] = [];
  let current: ApiItem | undefined = item;
  // `seen` guards a cycle. Nothing should ever write one, and a window that
  // hangs because something did is a worse answer than a truncated trail.
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.push({
      id: current.id,
      name: current.name,
      kind: current.kind === "folder" ? "folder" : "request",
    });
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  const collection = collections.find((entry) => entry.id === item.collectionId);
  if (collection) {
    trail.push({ id: collection.id, name: collection.name, kind: "collection" });
  }

  return trail.reverse();
}
