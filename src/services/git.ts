import { invoke } from "@tauri-apps/api/core";
import { isLinux } from "./platform";

/**
 * Typed wrappers over the git commands in `src-tauri/src/commands/git.rs`.
 *
 * Two path forms travel through here and they are not interchangeable. `path`
 * is absolute and in the platform's own form, which is what the file tree and
 * the open buffers are keyed by; `relative` is repo-relative with forward
 * slashes, which is what goes back to git as an argument. Every function that
 * changes something takes the relative form, because that is the one git can
 * act on regardless of where the repository sits.
 */

export type GitChange =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "untracked"
  | "conflicted";

export interface GitFile {
  /** Absolute, platform form. */
  path: string;
  /** Repo-relative, forward slashes — the argument form. */
  relative: string;
  /** Where a rename or copy came from, repo-relative. */
  from: string | null;
  staged: GitChange | null;
  unstaged: GitChange | null;
}

export interface GitRepo {
  isRepo: boolean;
  /** The repository top level, which may be above the open folder. */
  root: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  truncated: boolean;
}

export interface GitHunk {
  /** First changed line in the working file, 1-based. */
  line: number;
  /** Lines of the working file covered. Zero for a pure deletion. */
  lines: number;
  /** Lines removed. Non-zero alongside `lines` means modified, not added. */
  removed: number;
}

export interface GitFileDiff {
  /** Not in HEAD: every line is new, and the caller marks them. */
  untracked: boolean;
  hunks: GitHunk[];
}

/** Not a repository, and not an error — the common case for most folders. */
export const NO_REPO: GitRepo = {
  isRepo: false,
  root: null,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  truncated: false,
};

export function gitStatus(dir: string): Promise<GitRepo> {
  return invoke<GitRepo>("git_status", { dir });
}

export function gitFileHunks(dir: string, path: string): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_file_hunks", { dir, path });
}

/** The working tree against HEAD — what committing this file would record. */
export function gitFileDiff(dir: string, path: string): Promise<string> {
  return invoke<string>("git_file_diff", { dir, path });
}

export function gitStage(dir: string, paths: string[]): Promise<void> {
  return invoke<void>("git_stage", { dir, paths });
}

export function gitUnstage(dir: string, paths: string[]): Promise<void> {
  return invoke<void>("git_unstage", { dir, paths });
}

export function gitDiscard(dir: string, paths: string[]): Promise<void> {
  return invoke<void>("git_discard", { dir, paths });
}

/** Commits the index, returning git's own summary line. */
export function gitCommit(dir: string, message: string): Promise<string> {
  return invoke<string>("git_commit", { dir, message });
}

/**
 * An absolute path as git would name it, or null if it isn't in the repository.
 *
 * Needed for every file the editor has open, not only the changed ones: the
 * change gutter has to ask about a file whose answer is "nothing changed", and
 * that file is not in the status list to look up.
 *
 * Compared case-insensitively off Linux, for the same reason `sameFolder` in
 * `EditorModal` is: macOS and Windows match paths that way, and one differing
 * capital between what git printed and what the filesystem canonicalised to
 * would silently mean "not in this repository".
 */
export function repoRelative(repoRoot: string, path: string): string | null {
  const matches = isLinux
    ? path.startsWith(repoRoot)
    : path.toLowerCase().startsWith(repoRoot.toLowerCase());
  if (!matches) return null;

  const rest = path.slice(repoRoot.length).replace(/^[/\\]+/, "");
  if (!rest) return null;
  // Forward slashes, always: that is the only separator git accepts in a
  // pathspec, on Windows included.
  return rest.split(/[/\\]+/).join("/");
}

/**
 * The change a row should show.
 *
 * The working tree wins over the index: a file modified *since* it was staged
 * is, to the person looking at the tree, modified. VS Code decorates the same
 * way, and the panel below shows both halves separately anyway.
 */
export function effectiveChange(file: GitFile): GitChange {
  return file.unstaged ?? file.staged ?? "modified";
}

/** The single letter git itself uses, for the tree's badge column. */
export function changeBadge(change: GitChange): string {
  switch (change) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "typeChanged":
      return "T";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
    default:
      return "M";
  }
}

export function changeLabel(change: GitChange): string {
  switch (change) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "typeChanged":
      return "Type changed";
    case "untracked":
      return "Untracked";
    case "conflicted":
      return "Conflicted";
    default:
      return "Modified";
  }
}
