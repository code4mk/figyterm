/**
 * What a folder or a collection holds, as a tab edits it.
 *
 * A folder in this format is not a label. It carries a description, an auth
 * block, variables and scripts, and everything under it inherits all four —
 * which is why "open the folder" has to mean something, and why the two levels
 * get the same surface: the only difference between them is that a collection
 * is the outermost one.
 *
 * Pure, and out of the store, because reading a row into a draft and folding a
 * draft back into a row is exactly the kind of symmetry that goes wrong
 * silently. A description that round-trips into `null` and back into `""` is a
 * row that reports itself dirty for ever.
 */

import { ApiCollection, ApiItem, DraftAuth } from "../../types/api";
import { readAuth, writeAuth } from "./auth";
import { Variable } from "./template";
import { eventsWith, scriptFrom } from "./scripts/events";
import { variablesFrom, variablesTo } from "./scopes";

/** Which panel of the folder or collection tab is showing. */
export type ScopeTab = "overview" | "auth" | "scripts" | "variables";

/** No block of its own, which is what inheriting means. */
const INHERIT: DraftAuth = { type: "inherit", params: {} };

/** Everything the tab edits. */
export interface ScopeDraft {
  name: string;
  description: string;
  auth: DraftAuth;
  variables: Variable[];
  scripts: { prerequest: string; test: string };
}

/**
 * A row, as a draft.
 *
 * `events` is read here and written back through `eventsWith`, so a listener
 * this app has never heard of — one some other tool added — survives a save it
 * was not part of.
 */
export function scopeFrom(row: ApiCollection | ApiItem): ScopeDraft {
  return {
    name: row.name,
    description: row.description ?? "",
    auth: readAuth(row.auth) ?? INHERIT,
    variables: variablesFrom(row.variables),
    scripts: {
      prerequest: scriptFrom(row.events, "prerequest") ?? "",
      test: scriptFrom(row.events, "test") ?? "",
    },
  };
}

/** An empty one, for a row that has gone while its tab was open. */
export function emptyScope(): ScopeDraft {
  return {
    name: "",
    description: "",
    auth: INHERIT,
    variables: [],
    scripts: { prerequest: "", test: "" },
  };
}

/**
 * A draft, as the columns a save writes.
 *
 * `auth` goes back as `null` when it is on Inherit, because for a folder that
 * *is* what inheriting means: an absent block passes the question up, and an
 * explicit `noauth` block stops it. Writing `{"type":"inherit"}` would be
 * inventing a block the format has no word for.
 */
export function scopeTo(draft: ScopeDraft, existingEvents: unknown) {
  return {
    // A row with no name is a row nobody can find in the rail, so an empty one
    // becomes the same placeholder a new folder gets rather than being saved.
    name: draft.name.trim() === "" ? "Untitled" : draft.name.trim(),
    description: draft.description,
    auth: writeAuth(draft.auth),
    variables: variablesTo(draft.variables),
    events: eventsWith(existingEvents, draft.scripts),
  };
}
