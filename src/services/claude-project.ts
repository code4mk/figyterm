/**
 * What a Claude project *is*, and the command line it turns into.
 *
 * Deliberately free of imports. Everything here is arithmetic over strings —
 * which is what makes it the part with tests, and what keeps `npm test` able to
 * run it under plain Node with no DOM and no Tauri. The parts that talk to the
 * backend live in `claude.ts`, and the parts that persist live in
 * `claude-session.ts`.
 *
 * The design notes are in `docs/CLAUDE-CODE.md`; the two rules worth repeating
 * where the code is:
 *
 * - **A project has no name.** It is called whatever its primary folder is
 *   called, derived on every read so the two can never disagree.
 * - **Additional folders are append-only.** There is no removal, here or
 *   anywhere else.
 */

/** Permission modes the CLI accepts, as `--permission-mode` values. */
export type PermissionMode =
  | "manual"
  | "acceptEdits"
  | "auto"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

/**
 * One conversation: a session id we minted, and the folder set it was actually
 * launched with.
 */
export interface Conversation {
  /** Passed to the CLI as `--session-id`. Also names the transcript on disk. */
  sessionId: string;
  /** From the transcript's first user message; falls back to an ordinal. */
  title: string;
  startedAt: number;
  /** Null while the pty is alive. */
  endedAt: number | null;
  /**
   * The folder set this session was launched with.
   *
   * Not the same thing as the project's: a folder added to the project while
   * this conversation was already running was never granted *here*, and that
   * difference is exactly what the folders strip draws and what decides which
   * folders are worth offering to `/add-dir`.
   */
  launchedWith: { root: string; extraDirs: string[] };
}

export interface ClaudeProject {
  id: string;
  /** The primary folder. Claude's cwd, and the source of the project's name. */
  root: string;
  /** Append-only; see the module docs. */
  extraDirs: string[];
  conversations: Conversation[];
  createdAt: number;
  lastUsedAt: number;
  pinned?: boolean;
  /** Launch options, per project because they are a property of the work. */
  model?: string;
  permissionMode?: PermissionMode;
}

/**
 * The last segment of a path, whichever separator it uses.
 *
 * Its own rather than `editor-fs`'s `basename`, because that module is part of
 * the lazily-loaded editor and this one must stay importable by a Node test.
 * Trailing separators are stripped first: `~/work/api/` is still `api`.
 */
export function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path.startsWith("/") ? "/" : path;
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * What a project is called.
 *
 * Derived, never stored. A drive root (`C:\`) and the filesystem root both
 * survive `lastSegment` as themselves rather than as an empty string, which is
 * the one case that would otherwise produce a nameless row in the switcher.
 */
export function projectName(project: Pick<ClaudeProject, "root">): string {
  return lastSegment(project.root) || project.root;
}

/** Trailing separators removed, so two spellings of one folder are one folder. */
export function normalizeFolder(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return trimmed || path.trim();
}

/**
 * Whether `folder` is already covered by the project.
 *
 * The primary folder counts: Claude can already reach it, so adding it as an
 * extra would be a chip that grants nothing.
 */
export function alreadyCovered(project: Pick<ClaudeProject, "root" | "extraDirs">, folder: string): boolean {
  const wanted = normalizeFolder(folder);
  if (normalizeFolder(project.root) === wanted) return true;
  return project.extraDirs.some((dir) => normalizeFolder(dir) === wanted);
}

/**
 * Additional folders granted to the project but not to this conversation.
 *
 * What the "add to this conversation" affordance offers. Empty for a
 * conversation started after the last folder was added, which is the usual case.
 */
export function ungrantedDirs(
  project: Pick<ClaudeProject, "extraDirs">,
  conversation: Pick<Conversation, "launchedWith">
): string[] {
  const granted = new Set(conversation.launchedWith.extraDirs.map(normalizeFolder));
  return project.extraDirs.filter((dir) => !granted.has(normalizeFolder(dir)));
}

export interface LaunchOptions {
  /** A conversation being started: its id goes in as `--session-id`. */
  sessionId: string;
  /** True to `--resume` that id instead of starting it. */
  resume?: boolean;
}

/**
 * The argv for one conversation.
 *
 * A list, not a string, all the way down to `CommandBuilder` in Rust — so
 * nothing here escapes anything, and a folder called `$(rm -rf ~)` is a folder
 * called `$(rm -rf ~)`.
 *
 * Kept to flags that have been in the CLI for a long time. Every one we add is
 * one that can be renamed out from under us, and the window's job is to start
 * Claude Code, not to configure it — `--dangerously-skip-permissions` in
 * particular is deliberately not reachable from here.
 */
export function claudeArgs(project: ClaudeProject, launch: LaunchOptions): string[] {
  const args: string[] = [];

  if (launch.resume) {
    args.push("--resume", launch.sessionId);
  } else {
    args.push("--session-id", launch.sessionId);
  }

  // Names the session in the CLI's own `/resume` picker and in the terminal
  // title, so a conversation started here is recognisable from a plain shell.
  args.push("--name", projectName(project));

  // `--add-dir` takes a variadic list, so one flag covers every folder. Omitted
  // entirely when there are none rather than passed empty.
  const dirs = project.extraDirs.map(normalizeFolder).filter(Boolean);
  if (dirs.length) args.push("--add-dir", ...dirs);

  if (project.model) args.push("--model", project.model);
  if (project.permissionMode) args.push("--permission-mode", project.permissionMode);

  return args;
}

/**
 * The `/add-dir` line to type into a running conversation.
 *
 * Returned as text rather than written here, because writing into someone's
 * prompt box is the caller's decision to make explicitly — see the note in
 * `docs/CLAUDE-CODE.md`.
 */
export function addDirCommand(folder: string): string {
  return `/add-dir ${normalizeFolder(folder)}\r`;
}

/** A conversation's label, for a tab. */
export function conversationTitle(conversation: Conversation, index: number): string {
  return conversation.title.trim() || `Conversation ${index + 1}`;
}
