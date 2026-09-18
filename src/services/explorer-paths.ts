import { isLinux, isWindows } from "./platform";

/**
 * Path arithmetic the file tree does on its own, without touching the disk.
 *
 * Kept apart from `editor-fs` on purpose: everything here is string work with
 * no Tauri command behind it, which is what lets it be tested (`npm test` runs
 * these in plain Node, where `invoke` doesn't exist).
 *
 * The rules a rename has to obey live here too. Renaming `src` to `source` is
 * not only a call to the backend: every open tab under it, and every remembered
 * expansion, is now pointing at a path that no longer exists — and the only way
 * to fix those is to rewrite the prefix, which is `remapPath`.
 */

/**
 * macOS and Windows preserve the case a name was created with but match
 * without it; Linux treats `Src` and `src` as two different folders. The same
 * rule `editorStore` compares buffer paths by, for the same reason: getting it
 * wrong means a moved file is either missed or matched twice.
 */
export const PATHS_CASE_SENSITIVE = isLinux;

/**
 * Both separators, always.
 *
 * `paths.ts` spells the *shell's* separator, where being strict matters. Here
 * it doesn't: a Windows path can legally mix `/` and `\`, and treating `/` as a
 * separator on Linux costs nothing beyond a filename containing a backslash
 * being split — which is a rounding error against getting Windows wrong.
 */
const SEPARATORS = "/\\";

function isSep(ch: string | undefined): boolean {
  return ch !== undefined && ch.length === 1 && SEPARATORS.includes(ch);
}

function fold(path: string, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase();
}

/** Whether two paths name the same entry. */
export function samePath(a: string, b: string, caseSensitive = PATHS_CASE_SENSITIVE): boolean {
  return fold(a, caseSensitive) === fold(b, caseSensitive);
}

/**
 * Whether `path` sits inside `dir`, at any depth.
 *
 * `dir` itself is not inside itself. The separator check is what stops
 * `/srcery/a.ts` reading as being under `/src`, which a bare `startsWith` says
 * it is — and a move that believed it would rewrite paths that had nothing to
 * do with the folder that moved.
 */
export function isUnder(path: string, dir: string, caseSensitive = PATHS_CASE_SENSITIVE): boolean {
  const p = fold(path, caseSensitive);
  const d = fold(dir, caseSensitive);
  if (d.length === 0 || p.length <= d.length || !p.startsWith(d)) return false;
  // `/` and `C:\` carry their own separator; anything else needs the next
  // character of `path` to be one.
  return isSep(d[d.length - 1]) || isSep(p[d.length]);
}

/**
 * What `path` becomes when `from` is renamed or moved to `to`, or null when
 * `path` is somewhere else entirely and nothing needs to change.
 *
 * The tail is spliced on verbatim rather than re-joined, so whatever separators
 * were in the original survive.
 */
export function remapPath(
  path: string,
  from: string,
  to: string,
  caseSensitive = PATHS_CASE_SENSITIVE
): string | null {
  if (samePath(path, from, caseSensitive)) return to;
  if (isUnder(path, from, caseSensitive)) return to + path.slice(from.length);
  return null;
}

/**
 * Whether `from` can be moved into `toDir`.
 *
 * Three ways it can't: into itself, into its own descendant — which on a real
 * filesystem either fails or, worse, succeeds and takes the folder with it —
 * and into the folder it is already in, which is work for no change.
 */
export function canMoveInto(
  from: string,
  toDir: string,
  fromParent: string,
  caseSensitive = PATHS_CASE_SENSITIVE
): boolean {
  if (samePath(from, toDir, caseSensitive)) return false;
  if (isUnder(toDir, from, caseSensitive)) return false;
  if (samePath(fromParent, toDir, caseSensitive)) return false;
  return true;
}

/**
 * Characters a file name may not contain.
 *
 * Control characters first, and everywhere. macOS and Linux *accept* them —
 * only NUL and `/` are refused — which is exactly what makes them dangerous:
 * `\u0001explore.md` is a different file from `explore.md`, sorts next to it,
 * and reads identically in every listing. In the tree it draws as a row of
 * empty boxes with an X through them, which is what one of these looks like
 * when no font has a glyph for it. Nobody types one; they arrive by paste,
 * from a terminal selection or an editor that kept the raw bytes.
 *
 * Then the separators, since a name containing one is a path and would turn a
 * rename into a move, and on Windows the five further characters the
 * filesystem refuses outright.
 *
 * Deliberately *not* stripped: anything merely non-Latin. A Bengali or
 * Japanese name is a name.
 */
const ILLEGAL_IN_NAME = isWindows
  ? /[\u0000-\u001F\u007F-\u009F\\/:*?"<>|]/g
  : /[\u0000-\u001F\u007F-\u009F/]/g;

/**
 * `raw` with everything a file name can't hold removed.
 *
 * Applied as the field is typed into, so a paste carrying invisible characters
 * is refused at the door rather than becoming a file nobody can name.
 */
export function cleanName(raw: string): string {
  return raw.replace(ILLEGAL_IN_NAME, "");
}

/** One row of the flattened tree, as far as this module is concerned. */
export interface TreeRow {
  path: string;
  isDir: boolean;
  expanded: boolean;
}

/**
 * Which folder the explorer header's New File / New Folder creates in.
 *
 * The last open folder *as the tree is drawn* — the bottom-most one on screen,
 * which is also where the new row will appear. With every folder collapsed
 * there is no such folder and it falls back to the root, where the new row
 * lands at the very bottom of the tree.
 *
 * Reading it off the drawn rows rather than off the expanded *set* is what
 * makes it match what the user can see: a folder can be remembered as expanded
 * while its parent is collapsed, and creating a file into something invisible
 * looks like nothing happened.
 */
export function newEntryParent(rows: readonly TreeRow[], root: string): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.isDir && row.expanded) return row.path;
  }
  return root;
}
