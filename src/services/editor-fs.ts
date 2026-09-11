import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { isSeparator, lastSeparatorIndex, PATH_SEP } from "./paths";

/**
 * The editor's filesystem calls, one wrapper per Rust command.
 *
 * Every path handed to these is resolved and checked against the workspace
 * roots on the other side (see `commands/fs.rs`), so a call can legitimately
 * fail with "outside the folders open in the editor" — that's a bug in the
 * caller, not something to retry.
 */

export type LineEnding = "lf" | "crlf";
export type FileEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be";
export type FileKind = "text" | "binary" | "tooLarge" | "missing";

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isHidden: boolean;
  isSymlink: boolean;
  size: number;
  /** Epoch millis; the conflict check compares against this. */
  mtime: number;
  readonly: boolean;
}

export interface OpenedFile {
  kind: FileKind;
  size: number;
  mtime: number;
  readonly: boolean;
  /** `\n`-normalised. `lineEnding` says what to write back. */
  content: string;
  encoding: FileEncoding;
  lineEnding: LineEnding;
  /** Too big to highlight; opens read-only. */
  large: boolean;
}

export interface WriteOutcome {
  status: "written" | "conflict";
  mtime: number;
}

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  includeHidden: boolean;
  includeIgnored: boolean;
}

export interface SearchMatch {
  path: string;
  /** 1-based. */
  line: number;
  /**
   * 0-based index into `text`, for highlighting the hit in the results panel.
   *
   * Not the column in the file: `text` is a window around the match on a long
   * line, so on those two it starts partway in. Use `lineColumn` to go to it.
   */
  column: number;
  /** 0-based column in the source line — what "go to" needs. */
  lineColumn: number;
  length: number;
  text: string;
}

export interface FileList {
  root: string;
  /** Paths relative to `root`. */
  files: string[];
  truncated: boolean;
}

interface SearchResultPayload {
  id: number;
  matches: SearchMatch[];
}

interface SearchDonePayload {
  id: number;
  total: number;
  complete: boolean;
  error: string | null;
}

interface ChangePayload {
  paths: string[];
  /** The burst was too big to itemise — reload everything on screen. */
  overflow: boolean;
}

// ─── Roots ──────────────────────────────────────────────────────────────────

/**
 * Declares which folders the editor may touch, replacing any previous list.
 *
 * Returns the canonical form of each root, which is what the explorer should
 * then use — so the two sides never disagree about the root's name (`/tmp`
 * against `/private/tmp` on macOS, a `\\?\` prefix on Windows).
 */
export function setRoots(paths: string[]): Promise<string[]> {
  return invoke<string[]>("fs_set_roots", { paths });
}

// ─── Reading ────────────────────────────────────────────────────────────────

export function listDir(path: string, showHidden: boolean): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("fs_list_dir", { path, showHidden });
}

export function statPath(path: string): Promise<FileEntry> {
  return invoke<FileEntry>("fs_stat", { path });
}

export function readTextFile(path: string): Promise<OpenedFile> {
  return invoke<OpenedFile>("fs_read_text", { path });
}

export function listFiles(root: string, showHidden: boolean): Promise<FileList> {
  return invoke<FileList>("fs_list_files", { root, showHidden });
}

// ─── Writing ────────────────────────────────────────────────────────────────

/**
 * Saves a buffer.
 *
 * `expectedMtime` is what the buffer was loaded at; pass it and a file that
 * changed underneath comes back as `status: "conflict"` with nothing written.
 * Pass `null` to overwrite regardless — which is only correct after the user
 * has been asked.
 */
export function writeTextFile(
  path: string,
  content: string,
  encoding: FileEncoding,
  lineEnding: LineEnding,
  expectedMtime: number | null
): Promise<WriteOutcome> {
  return invoke<WriteOutcome>("fs_write_text", {
    path,
    content,
    encoding,
    lineEnding,
    expectedMtime,
  });
}

export function createPath(path: string, isDir: boolean): Promise<string> {
  return invoke<string>("fs_create", { path, isDir });
}

export function renamePath(from: string, to: string): Promise<string> {
  return invoke<string>("fs_rename", { from, to });
}

export function deletePath(path: string, toTrash: boolean): Promise<void> {
  return invoke("fs_delete", { path, toTrash });
}

export function revealPath(path: string): Promise<void> {
  return invoke("fs_reveal", { path });
}

// ─── Search ─────────────────────────────────────────────────────────────────

/** Returns the search's id; results arrive as events carrying it. */
export function startSearch(
  root: string,
  query: string,
  options: SearchOptions
): Promise<number> {
  return invoke<number>("fs_search", { root, query, options });
}

export function cancelSearch(): Promise<void> {
  return invoke("fs_cancel_search");
}

export function onSearchResult(
  handler: (id: number, matches: SearchMatch[]) => void
): Promise<UnlistenFn> {
  return listen<SearchResultPayload>("editor://search-result", (event) =>
    handler(event.payload.id, event.payload.matches)
  );
}

export function onSearchDone(
  handler: (payload: SearchDonePayload) => void
): Promise<UnlistenFn> {
  return listen<SearchDonePayload>("editor://search-done", (event) => handler(event.payload));
}

// ─── Watching ───────────────────────────────────────────────────────────────

/** Returns `"native"`, or `"poll"` when the platform watcher was unavailable. */
export function watchRoot(path: string): Promise<string> {
  return invoke<string>("fs_watch_root", { path });
}

export function unwatch(): Promise<void> {
  return invoke("fs_unwatch");
}

export function onFsChange(
  handler: (paths: string[], overflow: boolean) => void
): Promise<UnlistenFn> {
  return listen<ChangePayload>("editor://fs-change", (event) =>
    handler(event.payload.paths, event.payload.overflow)
  );
}

// ─── Path helpers ───────────────────────────────────────────────────────────

/**
 * These work on real filesystem paths rather than shell tokens, but the
 * separator rules are the same ones `paths.ts` already spells out per platform —
 * including that Windows accepts `/` in a path the user typed.
 */

export function basename(path: string): string {
  const trimmed = stripTrailingSeparator(path);
  const cut = lastSeparatorIndex(trimmed);
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

export function dirname(path: string): string {
  const trimmed = stripTrailingSeparator(path);
  const cut = lastSeparatorIndex(trimmed);
  if (cut < 0) return "";
  // A path directly under the root keeps the root's separator, so `/a` gives
  // `/` rather than an empty string that resolves to the wrong place.
  return cut === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, cut);
}

export function joinPath(base: string, ...parts: string[]): string {
  return parts.reduce((acc, part) => {
    if (!part) return acc;
    if (!acc) return part;
    return stripTrailingSeparator(acc) + PATH_SEP + part;
  }, base);
}

function stripTrailingSeparator(path: string): string {
  let end = path.length;
  // Never strips the whole thing: `/` and `C:\` are their own parents.
  while (end > 1 && isSeparator(path[end - 1])) end--;
  return path.slice(0, end);
}

/**
 * `path` expressed relative to `root`, or the path unchanged if it's outside.
 *
 * The root itself is the empty string, not its own name. Returning the name was
 * a bug with teeth: the breadcrumb's root button fed the result back through
 * `joinPath(root, …)`, which turned `~/project` into `~/project/project` and
 * failed with "Path does not exist". Callers that want a label for the root
 * should ask `basename` for one.
 */
export function relativeTo(root: string, path: string): string {
  const base = stripTrailingSeparator(root);
  if (path === base) return "";
  if (!path.startsWith(base)) return path;
  const rest = path.slice(base.length);
  return isSeparator(rest[0]) ? rest.slice(1) : rest;
}

/** The path's segments, for the breadcrumb. */
export function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
