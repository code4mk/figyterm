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

export async function createTerminalSession(
  cols: number,
  rows: number
): Promise<TerminalSession> {
  const raw = await invoke<RawTerminalSession>("create_terminal_session", {
    cols,
    rows,
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
