export interface TerminalSession {
  id: string;
  shell: string;
  cwd: string;
  title: string;
  createdAt: number;
  status: "running" | "exited";
}

export interface TerminalTab {
  id: string;
  session: TerminalSession;
  isActive: boolean;
}

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalOutputEvent {
  session_id: string;
  data: number[];
}
