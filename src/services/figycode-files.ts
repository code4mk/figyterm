/**
 * Real files, for the `@` mention list.
 *
 * The thin half of `src-tauri/src/commands/figy_files.rs`: the window
 * declares the folder once, and every keystroke after that is a ranking pass
 * over an index already in memory on the Rust side. Nothing is walked here
 * and nothing is ranked here — both would mean shipping the file list across
 * the IPC boundary on every letter, which is the cost this design exists to
 * avoid.
 *
 * Why these commands and not `fs_list_files`: that one goes through the
 * editor's root guard, and `fs_set_roots` replaces the whole list rather
 * than adding to it, so Figy Code calling it would take the editor's open
 * folder away. The module comment in the Rust file has the longer version.
 */

import { invoke } from "@tauri-apps/api/core";

export interface ProjectInfo {
  /** The canonical form — what the window should then display and compare. */
  root: string;
  files: number;
  folders: number;
  /** The index stopped early; the list is not everything in the folder. */
  truncated: boolean;
}

export interface FileHit {
  /** Relative to the root, `/`-separated, with a trailing slash on a folder. */
  path: string;
  isDir: boolean;
  /** Bytes. Zero for a folder, and for anything that would not stat. */
  size: number;
}

/** Points the window at a folder and indexes it. Slow once, then not again. */
export function openProjectIndex(path: string): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("figy_open_project", { path });
}

/** The best matches for what has been typed after an `@`. */
export function findFiles(query: string, limit = 12): Promise<FileHit[]> {
  return invoke<FileHit[]>("figy_find_files", { query, limit });
}

/**
 * What a row says to the right of the path.
 *
 * Folders count for nothing here — the number of files inside one is a
 * second walk for a line nobody reads — so they simply say what they are.
 */
export function hitMeta(hit: FileHit): string {
  if (hit.isDir) return "folder";
  if (hit.size < 1024) return `${hit.size} B`;
  if (hit.size < 1024 * 1024) return `${Math.round(hit.size / 1024)} KB`;
  return `${(hit.size / (1024 * 1024)).toFixed(1)} MB`;
}
