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

/**
 * Tells the backend which folders this window may reach beyond its
 * project, replacing whatever it had.
 *
 * Until this existed, the extra folders were a line in
 * `localStorage` and nothing else: the settings said the agent could
 * read `~/acme-mcp` and every tool refused it, because the only
 * folder the backend had been told about was the root. Answers with
 * the ones that resolved.
 */
export function setExtraDirs(dirs: string[]): Promise<string[]> {
  return invoke<string[]>("figy_set_extra_dirs", { dirs });
}

/** One image out of the project, for an `@` mention of it. */
export interface ReadImage {
  name: string;
  mime: string;
  bytes: number;
  /** Base64, no `data:` prefix. */
  data: string;
}

/**
 * Reads an image out of the project, resolved against the folders
 * the agent may reach.
 *
 * For `@screenshot.png`: the mention names a file and the window
 * turns it into an attachment, so a picture arrives the way every
 * other picture does — on the user's message. Without it the
 * mention was a path, the agent called `read`, and was told the
 * file was binary.
 */
export function readImage(path: string): Promise<ReadImage> {
  return invoke<ReadImage>("figy_read_image", { path });
}

/** What is in a folder, as `/project` lists it beside each one. */
export interface DirCount {
  files: number;
  folders: number;
  /** The walk stopped at the limit, so these are a floor. */
  truncated: boolean;
}

/**
 * Counts a folder without adopting it.
 *
 * Deliberately not `openProjectIndex`, which is the obvious reuse and
 * the wrong one: that points the whole window at the folder and
 * replaces the `@` index with it, so counting an extra folder would
 * move the project out from under the conversation.
 */
export function countDir(path: string): Promise<DirCount> {
  return invoke<DirCount>("figy_count_dir", { path });
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
