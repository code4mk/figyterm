/**
 * The Claude window's half of the backend.
 *
 * Everything here crosses to Rust. The string arithmetic it builds on lives in
 * `claude-project.ts`, which imports nothing and is where the tests are.
 */

import { invoke } from "@tauri-apps/api/core";
import { createTerminalSession, PtyCommand } from "./terminal";
import { TerminalSession } from "../types/terminal";
import { ClaudeProject, claudeArgs, LaunchOptions } from "./claude-project";

export interface ClaudeProbe {
  found: boolean;
  /** The absolute path that would be spawned. */
  path: string | null;
  /** As `claude --version` reports it, verbatim. */
  version: string | null;
  /** Why it isn't usable, when it isn't. */
  error: string | null;
}

/**
 * Where `claude` is, and whether it runs.
 *
 * Not memoised here on purpose: someone who installs the CLI while the window
 * is open and presses "Check again" should be believed. The expensive half —
 * asking the login shell what `PATH` really is — is already cached in Rust.
 */
export async function probeClaude(): Promise<ClaudeProbe> {
  return invoke<ClaudeProbe>("claude_probe");
}

/**
 * The first user message of a conversation, for its tab title.
 *
 * `null` for every kind of failure, including a transcript that isn't where we
 * guessed it would be. A tab keeps its ordinal in that case and nothing else
 * changes — see `commands/claude.rs`.
 */
export async function conversationTitleFromDisk(
  root: string,
  sessionId: string
): Promise<string | null> {
  try {
    return await invoke<string | null>("claude_transcript_head", { root, sessionId });
  } catch {
    return null;
  }
}

export interface PastConversation {
  sessionId: string;
  title: string | null;
  /**
   * The git branch it was working on, where the CLI recorded one.
   *
   * Null for a folder that isn't a repository — and worth having, because a
   * project with several branches in flight has several conversations that
   * otherwise look alike.
   */
  branch: string | null;
  /** The transcript's mtime, epoch millis. */
  updatedAt: number;
}

/**
 * Conversations the CLI has recorded for a folder that FigyTerm didn't start.
 *
 * Every project has a history that predates the window knowing about it —
 * work done in a plain shell, or before the project was added here — and all
 * of it resumes by id. An empty list is the answer for any kind of failure.
 */
export async function pastConversations(
  root: string,
  exclude: string[],
  limit = 20
): Promise<PastConversation[]> {
  try {
    return await invoke<PastConversation[]>("claude_past_conversations", {
      root,
      exclude,
      limit,
    });
  } catch {
    return [];
  }
}

/**
 * Whether this conversation already exists on disk.
 *
 * Which decides `--resume <id>` against `--session-id <id>`. Getting it wrong
 * is not a soft failure — the CLI answers a reused id with `Error: Session ID
 * <id> is already in use.` and exits — so it is asked rather than remembered.
 */
async function sessionExists(root: string, sessionId: string): Promise<boolean> {
  try {
    return await invoke<boolean>("claude_session_exists", { root, sessionId });
  } catch {
    return false;
  }
}

/**
 * Starts a conversation in a pty, resuming it if it already exists.
 *
 * The session id is decided by the caller and passed twice over: once to the
 * CLI, so the conversation *is* that id, and once to the pty so FigyTerm's own
 * bookkeeping uses the same one. One id for the conversation, the transcript,
 * the tab and the pty is the whole reason resume is exact.
 *
 * **Whether to resume is looked up here, not passed in.** A flag decided when
 * a tab was opened can be stale by the time the process starts — the
 * conversation may have run and exited in between — and every way of being
 * wrong ends in the CLI refusing to start. The filesystem knows the answer.
 */
export async function startConversation(
  project: ClaudeProject,
  launch: Omit<LaunchOptions, "resume">,
  size: { cols: number; rows: number },
  program: string
): Promise<TerminalSession> {
  const resume = await sessionExists(project.root, launch.sessionId);

  const command: PtyCommand = {
    program,
    args: claudeArgs(project, { ...launch, resume }),
  };

  return createTerminalSession(size.cols, size.rows, {
    cwd: project.root,
    command,
    sessionId: launch.sessionId,
  });
}
