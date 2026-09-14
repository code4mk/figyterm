/**
 * What a drawing project *is*, and the arithmetic over a list of them.
 *
 * Deliberately free of anything that touches the DOM, IndexedDB or Tauri —
 * which is what makes this the part with tests, and what keeps `npm test` able
 * to run it under plain Node. `fuzzy.ts` is the one import, and it is pure
 * scoring for the same reason. The parts that persist live in `drawing-db.ts`,
 * and the parts that orchestrate live in `stores/drawingStore.ts`.
 *
 * The design notes are in `docs/DRAWING.md`; the two rules worth repeating
 * where the code is:
 *
 * - **A project's id is opaque and its name is not.** Renaming is a label
 *   change and must never invalidate anything pointing at the project. This is
 *   the opposite of a Claude project, which is named after its folder.
 * - **A project always has a name.** There is no state in which one is blank,
 *   so every path that could produce one reverts instead.
 */

import { fuzzyFilter } from "./fuzzy";

/** The row in the rail. Small, and never holds scene content. */
export interface DrawingProject {
  id: string;
  name: string;
  favorite: boolean;
  createdAt: number;
  /** Bumped by autosave. The rail's sort key under `favorite`. */
  updatedAt: number;
  /** Visible elements, for the row's subtitle — so the rail needs no scene. */
  elementCount: number;
}

/**
 * The scene, in its own store.
 *
 * `elements` and `files` are Excalidraw's own shapes, held as `unknown` here
 * rather than imported: this module must stay loadable by a Node test, and the
 * canvas is the only place that needs to know what an element is. It casts at
 * that boundary and nowhere else.
 */
export interface DrawingScene {
  projectId: string;
  elements: readonly unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export const UNTITLED = "Untitled drawing";

/**
 * A name as it should be stored, or `null` if it is not a name at all.
 *
 * Callers treat `null` as "keep what was there" rather than as an error — an
 * empty rename box is someone changing their mind, not a validation failure.
 */
export function normalizeName(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * The name a new project gets.
 *
 * `Untitled drawing`, then `Untitled drawing 2`, and so on to the first free
 * number rather than to one past the highest — a list whose 2 was renamed
 * should reuse 2, not leave a hole and call the new one 4.
 */
export function nextUntitledName(existing: readonly string[]): string {
  const taken = new Set(existing.map((name) => name.trim()));
  if (!taken.has(UNTITLED)) return UNTITLED;
  for (let n = 2; ; n++) {
    const candidate = `${UNTITLED} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The name a copy gets: `x` → `x copy` → `x copy 2`.
 *
 * Duplicating a copy gives `x copy 2`, not `x copy copy`, because the second is
 * how you end up with `x copy copy copy` by the afternoon.
 */
export function duplicateName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.trim()));
  const base = `${name.trim().replace(/ copy(?: \d+)?$/, "")} copy`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Rail order: favourites first, then most recently touched.
 *
 * A copy, never in place — the store holds this array and React compares it by
 * identity.
 */
export function sortProjects(projects: readonly DrawingProject[]): DrawingProject[] {
  return [...projects].sort(
    (a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt
  );
}

/**
 * The rail's contents for a given query.
 *
 * An empty query is not a filter *and not a sort*: the list comes back in the
 * order it was given. The store is the single owner of that order — it sorts
 * when the window opens and when a project is favourited, and otherwise leaves
 * it alone. Sorting here as well would undo that on every render, because
 * autosave bumps `updatedAt` a few times a minute and `updatedAt` is the sort
 * key: the drawing you are working on would climb to the top and push the rest
 * of the list down under your cursor while you drew on it.
 *
 * A non-empty query ranks by relevance instead, and the caller drops the
 * headings — you searched, so the best match belongs at the top whether or not
 * it has a star.
 */
export function searchProjects(
  projects: readonly DrawingProject[],
  query: string
): DrawingProject[] {
  const trimmed = query.trim();
  if (!trimmed) return [...projects];
  return fuzzyFilter([...projects], trimmed, (project) => project.name).map((r) => r.item);
}

/**
 * How many elements are actually on the canvas.
 *
 * Excalidraw tombstones rather than removes, because undo needs the tombstones.
 * The subtitle counts what you can see.
 */
export function visibleElementCount(elements: readonly { isDeleted?: boolean }[]): number {
  let count = 0;
  for (const element of elements) if (!element?.isDeleted) count++;
  return count;
}

/**
 * The slice of Excalidraw's `appState` worth keeping.
 *
 * A whitelist rather than a blocklist: the runtime `appState` is large, carries
 * transient things (the selection, the pointer, open dialogs) that must not come
 * back, and includes `collaborators` — a `Map`, which is not what we want in a
 * stored record even though structured clone would take it.
 *
 * `theme` is **deliberately absent**. It belongs to the app, not to the
 * drawing; persisting it would resurrect last night's dark mode in this
 * morning's light one.
 */
export const PERSISTED_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "currentItemStrokeColor",
  "currentItemBackgroundColor",
  "currentItemFillStyle",
  "currentItemStrokeWidth",
  "currentItemStrokeStyle",
  "currentItemRoughness",
  "currentItemOpacity",
  "currentItemFontFamily",
  "currentItemFontSize",
  "currentItemTextAlign",
  "currentItemStartArrowhead",
  "currentItemEndArrowhead",
  "currentItemRoundness",
  "gridSize",
  "gridModeEnabled",
  "objectsSnapModeEnabled",
  "zenModeEnabled",
  "viewModeEnabled",
  // Where you were looking. Reopening a project should not scroll you to the
  // origin of a drawing you last worked on three screens to the right.
  "scrollX",
  "scrollY",
  "zoom",
] as const;

/** Narrows a live `appState` to the keys above, dropping anything undefined. */
export function pickAppState(appState: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!appState) return picked;
  for (const key of PERSISTED_APP_STATE_KEYS) {
    if (appState[key] !== undefined) picked[key] = appState[key];
  }
  return picked;
}

/**
 * Adds a new project without disturbing the order of the existing ones.
 *
 * A new drawing is never a favourite, so it goes at the top of the
 * non-favourites — which is where you are looking — and every other row stays
 * exactly where it was. Re-sorting the whole list here would snap it back to
 * recency order the instant you pressed New, which is the same jump that
 * sorting on autosave used to cause.
 *
 * It also keeps the array favourites-first, which the rail relies on: it draws
 * favourites above the rest, and its keyboard cursor indexes the flat list.
 */
export function insertProject(
  projects: readonly DrawingProject[],
  project: DrawingProject
): DrawingProject[] {
  const firstOrdinary = projects.findIndex((p) => !p.favorite);
  if (firstOrdinary === -1) return [...projects, project];
  return [...projects.slice(0, firstOrdinary), project, ...projects.slice(firstOrdinary)];
}

/** A fresh project row. The id is the only thing about it that is forever. */
export function createProject(name: string, now = Date.now()): DrawingProject {
  return {
    id: newId(),
    name,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    elementCount: 0,
  };
}

/**
 * An id for a new project.
 *
 * `crypto.randomUUID` needs a secure context, which the Tauri webview is and a
 * plain `http://` dev server on a LAN address is not — hence the fallback,
 * which does not need to be cryptographic to be unique enough for a local list.
 */
export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
