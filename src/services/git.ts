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

/** One entry in the history list. */
export interface GitCommit {
  sha: string;
  /** Git's own abbreviation, which respects `core.abbrev`. */
  short: string;
  author: string;
  email: string;
  /** ISO 8601 — formatted here rather than parsed from a locale. */
  date: string;
  subject: string;
  /** `HEAD -> main, origin/main, tag: v1.2`. Empty when undecorated. */
  refs: string;
  /** A merge, whose diff is therefore against its first parent. */
  merge: boolean;
}

/** A file as one commit changed it. */
export interface GitCommitFile {
  relative: string;
  change: GitChange;
  from: string | null;
  /** Both zero for a binary file — git reports `-`, having no lines to count. */
  added: number;
  removed: number;
}

/** Everything the history drawer shows about one commit. */
export interface GitCommitDetail {
  commit: GitCommit;
  /** The message below the subject, verbatim — blank lines and all. */
  body: string;
  files: GitCommitFile[];
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

/** One page of history, newest first. */
export function gitLog(dir: string, skip: number, limit?: number): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", { dir, skip, limit });
}

export function gitCommitDetail(dir: string, sha: string): Promise<GitCommitDetail> {
  return invoke<GitCommitDetail>("git_commit_detail", { dir, sha });
}

export function gitCommitDiff(dir: string, sha: string, path: string): Promise<string> {
  return invoke<string>("git_commit_diff", { dir, sha, path });
}

/**
 * Updates the remote-tracking refs. Changes nothing in the working tree, which
 * is why it is the safe half of "sync" and has no confirmation.
 */
export function gitFetch(dir: string): Promise<string> {
  return invoke<string>("git_fetch", { dir });
}

/** Pushes the current branch, publishing it if it has no upstream yet. */
export function gitPush(dir: string): Promise<string> {
  return invoke<string>("git_push", { dir });
}

/**
 * A date as a history list wants it: how long ago for anything recent, the
 * date itself once "23 days ago" has stopped being easier to read than "3 Aug".
 */
export function relativeDate(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "a minute ago";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;

  const sameYear = new Date(then).getFullYear() === new Date(now).getFullYear();
  return new Date(then).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
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

/**
 * A set of changes counted by what actually happened to the file.
 *
 * Git has eight status letters and nobody wants a legend for them, so they
 * collapse into the four things people say out loud:
 *
 * - **new** — `added`, `untracked` and `copied`. A copy is a file that wasn't
 *   there before, whatever git knows about where its contents came from.
 * - **edited** — `modified` and `typeChanged`. A file becoming a symlink is a
 *   strange edit, not a fifth category.
 * - **deleted** — `deleted`.
 * - **renamed** — kept apart, because a rename is neither new nor edited and
 *   folding it into either overstates what changed. `R100` moved a file and
 *   touched nothing in it.
 *
 * `conflicted` gets its own count too: it is a state to resolve rather than a
 * change that has happened.
 */
export interface ChangeTally {
  total: number;
  added: number;
  edited: number;
  deleted: number;
  renamed: number;
  conflicted: number;
}

export function tally(changes: GitChange[]): ChangeTally {
  const counted: ChangeTally = {
    total: changes.length,
    added: 0,
    edited: 0,
    deleted: 0,
    renamed: 0,
    conflicted: 0,
  };

  for (const change of changes) {
    switch (change) {
      case "added":
      case "untracked":
      case "copied":
        counted.added++;
        break;
      case "deleted":
        counted.deleted++;
        break;
      case "renamed":
        counted.renamed++;
        break;
      case "conflicted":
        counted.conflicted++;
        break;
      default:
        counted.edited++;
    }
  }

  return counted;
}

/**
 * The tally as chips, skipping the empty ones.
 *
 * `kind` is a `GitChange`, so the chips are coloured by the same rules the
 * tree rows and the change gutter use — "new" is the green the gutter draws an
 * added line in, and there is one palette rather than three.
 */
export function tallyParts(
  counted: ChangeTally
): { key: string; label: string; count: number; kind: GitChange }[] {
  return [
    { key: "edited", label: "edited", count: counted.edited, kind: "modified" as GitChange },
    { key: "added", label: "new", count: counted.added, kind: "added" as GitChange },
    { key: "deleted", label: "deleted", count: counted.deleted, kind: "deleted" as GitChange },
    { key: "renamed", label: "renamed", count: counted.renamed, kind: "renamed" as GitChange },
    {
      key: "conflicted",
      label: "conflicted",
      count: counted.conflicted,
      kind: "conflicted" as GitChange,
    },
  ].filter((part) => part.count > 0);
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
