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
  /** A merge is in progress and has stopped — conflicted, or just unfinished. */
  merging: boolean;
  /** What is being merged in: a branch name, or a short SHA. */
  mergeHead: string | null;
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
  /** On this branch but not on its upstream — committed here and nowhere else. */
  unpushed: boolean;
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
  merging: false,
  mergeHead: null,
};

export function gitStatus(dir: string): Promise<GitRepo> {
  return invoke<GitRepo>("git_status", { dir });
}

/**
 * The paths git is ignoring, with directories collapsed.
 *
 * `node_modules` comes back as one entry rather than forty thousand, so
 * membership is "this path, or any directory above it" — see [`isIgnored`].
 */
export function gitIgnored(dir: string): Promise<string[]> {
  return invoke<string[]>("git_ignored", { dir });
}

/**
 * Whether `path` is ignored, given the collapsed set from [`gitIgnored`].
 *
 * Walks up rather than matching directly, because the set holds `…/node_modules`
 * and the question is usually about a file several levels inside it. Bounded by
 * the path's own depth, and the common answer — an empty set — costs nothing.
 */
export function isIgnored(path: string, ignored: ReadonlySet<string>): boolean {
  if (!ignored.size) return false;
  if (ignored.has(path)) return true;

  let at = path;
  for (;;) {
    const cut = Math.max(at.lastIndexOf("/"), at.lastIndexOf("\\"));
    // Stop at the filesystem root rather than looping on "/" forever.
    if (cut <= 0) return false;
    at = at.slice(0, cut);
    if (ignored.has(at)) return true;
  }
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

/**
 * Brings the upstream's commits into the working tree.
 *
 * The one call here that can leave the repository mid-operation: a pull that
 * conflicts stops with the files marked, which `gitStatus` then reports as
 * `conflicted` and the panel draws as such. The message it rejects with is
 * git's own and says which files.
 */
export function gitPull(dir: string): Promise<string> {
  return invoke<string>("git_pull", { dir });
}

/** Pushes the current branch, publishing it if it has no upstream yet. */
export function gitPush(dir: string): Promise<string> {
  return invoke<string>("git_push", { dir });
}

/** The tracked remote's URL, raw. Empty when the repository has no remote. */
export function gitRemoteUrl(dir: string): Promise<string> {
  return invoke<string>("git_remote_url", { dir });
}

/** Where the conflict markers are in one file. */
export interface GitConflictFile {
  relative: string;
  /** Line of each `<<<<<<<`, 1-based. Empty when the file holds no markers. */
  lines: number[];
  /** True when more markers were found than are worth listing. */
  truncated: boolean;
}

/**
 * Which lines each conflicted file has its markers on.
 *
 * An empty `lines` is an answer, not a failure: a file can be unmerged with no
 * markers in it — deleted on one side and modified on the other — and those
 * are settled by taking a whole side rather than by editing.
 */
export function gitConflictMarks(
  dir: string,
  paths: string[]
): Promise<GitConflictFile[]> {
  return invoke<GitConflictFile[]>("git_conflict_marks", { dir, paths });
}

/**
 * Takes one whole side of each conflicted file, and marks them resolved.
 *
 * `ours` is the branch that was checked out when the merge began, `theirs` the
 * one being merged in. Both are staged afterwards, because a file rewritten but
 * left unmerged in the index still blocks the commit.
 */
export function gitResolveWith(
  dir: string,
  paths: string[],
  side: "ours" | "theirs"
): Promise<void> {
  return invoke("git_resolve_with", { dir, paths, side });
}

/** Marks conflicted files resolved as they now stand — the hand-edited case. */
export function gitMarkResolved(dir: string, paths: string[]): Promise<void> {
  return invoke("git_mark_resolved", { dir, paths });
}

/** Abandons the merge and restores the working tree. */
export function gitMergeAbort(dir: string): Promise<string> {
  return invoke<string>("git_merge_abort", { dir });
}

/** A branch the picker can switch to. */
export interface GitBranch {
  /** `main` for a local branch, `origin/main` for a remote-tracking one. */
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  /** The tip's commit date, ISO 8601. */
  date: string;
  /** The tip's subject, so a name in the list means something. */
  subject: string;
}

/** Local and remote-tracking branches, current first, then most recent. */
export function gitBranches(dir: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_branches", { dir });
}

/**
 * Checks out `name`. A remote one is created locally, tracking it.
 *
 * Rejects with git's own words when the working tree is in the way — "Your
 * local changes to the following files would be overwritten by checkout" names
 * the files, which is the whole of what the caller needs to offer a stash.
 */
export function gitSwitch(dir: string, name: string, remote: boolean): Promise<string> {
  return invoke<string>("git_switch", { dir, name, remote });
}

/** One entry in `git stash list`. */
export interface GitStash {
  /** The stash commit. Every operation is keyed by this, never by position. */
  sha: string;
  /** Where it sat when the list was read, for the `stash@{n}` label. */
  index: number;
  /** The branch it was made on, when git recorded one. */
  branch: string | null;
  message: string;
  date: string;
}

export function gitStashList(dir: string): Promise<GitStash[]> {
  return invoke<GitStash[]>("git_stash_list", { dir });
}

/** Puts the working tree away, untracked files included. */
export function gitStashPush(dir: string, message: string): Promise<string> {
  return invoke<string>("git_stash_push", { dir, message });
}

/** Applies a stash; `pop` also drops it once it has applied cleanly. */
export function gitStashRestore(dir: string, sha: string, pop: boolean): Promise<string> {
  return invoke<string>("git_stash_restore", { dir, sha, pop });
}

/**
 * The files a stash would bring back.
 *
 * Untracked files included — they are stashed, so they are part of the answer
 * to "what is in here", and they are the ones most easily forgotten.
 */
export function gitStashFiles(dir: string, sha: string): Promise<GitCommitFile[]> {
  return invoke<GitCommitFile[]>("git_stash_files", { dir, sha });
}

export function gitStashDrop(dir: string, sha: string): Promise<string> {
  return invoke<string>("git_stash_drop", { dir, sha });
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
