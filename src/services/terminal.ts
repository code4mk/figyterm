import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { TerminalSession, TerminalOutputEvent } from "../types/terminal";

interface RawTerminalSession {
  id: string;
  shell: string;
  cwd: string;
  title: string;
  created_at: number;
  status: "running" | "exited";
}

/**
 * A program for the pty to run instead of the user's login shell.
 *
 * `args` is a list and stays one all the way to `CommandBuilder`, so a folder
 * path with a space — or a `$(` — in it is one argument and not shell source.
 */
export interface PtyCommand {
  program: string;
  args: string[];
}

export interface CreateSessionOptions {
  cwd?: string;
  /** Absent means the login shell, which is every caller but the Claude window. */
  command?: PtyCommand;
  /**
   * Decide the session's id here rather than in the backend.
   *
   * Only the Claude window needs this: `claude --session-id <uuid>` has to be
   * told the id before the process starts, so the id cannot be something the
   * backend hands back afterwards.
   */
  sessionId?: string;
}

export async function createTerminalSession(
  cols: number,
  rows: number,
  cwdOrOptions?: string | CreateSessionOptions
): Promise<TerminalSession> {
  const options: CreateSessionOptions =
    typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : cwdOrOptions ?? {};

  const raw = await invoke<RawTerminalSession>("create_terminal_session", {
    cols,
    rows,
    cwd: options.cwd ?? null,
    command: options.command ?? null,
    sessionId: options.sessionId ?? null,
  });
  return {
    id: raw.id,
    shell: raw.shell,
    cwd: raw.cwd,
    title: raw.title,
    createdAt: raw.created_at,
    status: raw.status,
  };
}

export async function writeTerminalSession(
  sessionId: string,
  data: Uint8Array
): Promise<void> {
  await invoke("write_terminal_session", {
    sessionId,
    data: Array.from(data),
  });
}

export async function resizeTerminalSession(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  await invoke("resize_terminal_session", { sessionId, cols, rows });
}

export async function closeTerminalSession(
  sessionId: string
): Promise<void> {
  await invoke("close_terminal_session", { sessionId });
}

export async function getDefaultShell(): Promise<string> {
  return invoke<string>("get_default_shell");
}

export async function getDefaultWorkingDirectory(): Promise<string> {
  return invoke<string>("get_default_working_directory");
}

export async function listenTerminalOutput(
  callback: (event: TerminalOutputEvent) => void
): Promise<UnlistenFn> {
  return listen<TerminalOutputEvent>("terminal-output", (event) => {
    callback(event.payload);
  });
}
