/**
 * Which scripts run, and in what order.
 *
 * The format hangs scripts off every level of the tree: a collection can set an
 * auth header for everything in it, a folder can set one for its own requests,
 * and a request can do something of its own. They all run, outermost first —
 * which is the order that makes the outer ones useful, since an inner script
 * can then see and override what they did.
 *
 * Pure, and separate from the sandbox, because "which scripts and in what
 * order" is a question about the tree rather than about JavaScript.
 */

import { ApiCollection, ApiItem } from "../../../types/api";
import { ancestry } from "../scopes";

export type EventKind = "prerequest" | "test";

/** One script to run, and where it came from — the label a failure is filed
 * under, so "which folder set this header?" has an answer. */
export interface CollectedScript {
  from: string;
  code: string;
}

/** Reads the format's `event[]`, which stores a script as its lines. */
export function scriptFrom(events: unknown, kind: EventKind): string | null {
  if (!Array.isArray(events)) return null;

  for (const entry of events) {
    if (typeof entry !== "object" || entry === null) continue;
    const event = entry as Record<string, unknown>;
    if (event.listen !== kind) continue;

    const script = event.script as Record<string, unknown> | undefined;
    if (!script) continue;

    // `exec` is the usual shape — one entry per line — but a single string
    // appears in documents written by hand.
    const exec = script.exec;
    const code = Array.isArray(exec)
      ? exec.map((line) => (typeof line === "string" ? line : "")).join("\n")
      : typeof exec === "string"
        ? exec
        : "";

    // An empty script is what a collection has after somebody deleted the body
    // and left the block behind. Running it would be a no-op with a cost.
    if (code.trim() !== "") return code;
  }
  return null;
}

/**
 * The format's `event[]`, from the two scripts an editor holds.
 *
 * Whatever was already there for the *other* kind is kept: a request whose test
 * script is being edited must not lose its pre-request one, and a block this
 * app has never heard of — a listener some other tool added — is left alone.
 */
export function eventsWith(
  existing: unknown,
  scripts: { prerequest: string; test: string }
): unknown[] | null {
  const others = (Array.isArray(existing) ? existing : []).filter((entry) => {
    const event = entry as Record<string, unknown> | null;
    return event?.listen !== "prerequest" && event?.listen !== "test";
  });

  const written = [...others];
  for (const kind of ["prerequest", "test"] as const) {
    const code = scripts[kind];
    if (code.trim() === "") continue;
    written.push({
      listen: kind,
      script: { type: "text/javascript", exec: code.split("\n") },
    });
  }

  // Nothing at all is stored as nothing, rather than as an empty list: the
  // column being null is what "this row has no scripts" looks like.
  return written.length > 0 ? written : null;
}

/**
 * Every script that applies to a request, outermost first.
 *
 * The collection's, then each folder's from the top down, then the request's
 * own — so the innermost has the last word, exactly as it does for variables
 * and for auth.
 */
export function collectScripts(params: {
  item: ApiItem | null;
  items: ApiItem[];
  collections: ApiCollection[];
  kind: EventKind;
}): CollectedScript[] {
  const { item, items, collections, kind } = params;
  const found: CollectedScript[] = [];

  if (item) {
    const collection = collections.find(
      (candidate) => candidate.id === item.collectionId
    );
    if (collection) {
      // A collection keeps its events in the document it was imported from;
      // there is no column for them, so they are read from there.
      const raw = collection as unknown as { events?: unknown };
      const code = scriptFrom(raw.events, kind);
      if (code) found.push({ from: collection.name, code });
    }
  }

  // `ancestry` runs innermost first, so the folders are reversed to put the
  // outermost one in front.
  const chain = ancestry(item, items);
  for (const ancestor of [...chain].reverse()) {
    const code = scriptFrom(ancestor.events, kind);
    if (code) found.push({ from: ancestor.name, code });
  }

  return found;
}
