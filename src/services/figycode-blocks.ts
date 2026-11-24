/**
 * What the Figy Code window draws, and the few decisions it makes for
 * itself.
 *
 * This was `figycode-demo.ts`, which held an invented transcript as well as
 * these types. The transcript is gone: the window is wired to the real loop
 * in `src-tauri/src/agent/` and everything in it now happened. What is left
 * here is the shape of a block, the slash commands, and three small
 * functions about text.
 *
 * **Nothing in this file is unreachable.** A block kind with nothing
 * producing it was deleted rather than kept for later — the renderers for
 * plans and to-do lists are in the history, and will come back with the
 * `plan` and `todo_write` tools that produce them. A window full of states
 * that cannot happen is a window nobody can reason about.
 */

/* ─── Slash commands ──────────────────────────────────────────────────────── */

export interface Command {
  name: string;
  summary: string;
}

export const COMMANDS: Command[] = [
  { name: "/model", summary: "which model, and where to reach it" },
  { name: "/tools", summary: "what the agent can do, and what it costs to offer" },
  { name: "/usage", summary: "tokens, cache hit rate and spend this session" },
  { name: "/clear", summary: "start a new conversation in this folder" },
];

/**
 * Which commands to offer for what has been typed.
 *
 * Prefix first, then anything containing it, because `/u` should put
 * `/usage` above a command that merely has a `u` in the middle of a word
 * nobody is thinking of.
 */
export function filterCommands(query: string): Command[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return COMMANDS;
  const starts = COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
  const contains = COMMANDS.filter(
    (c) => !starts.includes(c) && c.name.slice(1).toLowerCase().includes(q)
  );
  return [...starts, ...contains];
}

/**
 * The `@word` being typed at the caret, if there is one.
 *
 * Returns the query without its `@`, or `null` when the caret is not inside
 * a mention — which is most of the time, and is why this is a function
 * rather than a regex repeated at three call sites. A mention ends at
 * whitespace, so `@src/services/` is one and `@file and then` is not.
 */
export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // An `@` only opens a mention at the start of a word.
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

/* ─── Permission modes ────────────────────────────────────────────────────── */

/**
 * The three the window cycles with shift+tab, spelled as
 * `agent/policy.rs` spells them — these strings go to the backend.
 */
export type PermissionMode = "ask" | "acceptEdits" | "plan";

export const MODE_LABEL: Record<PermissionMode, string> = {
  ask: "ask before edits",
  acceptEdits: "accept edits on",
  plan: "plan mode on",
};

export const MODE_NOTE: Record<PermissionMode, string> = {
  ask: "shift+tab to cycle",
  acceptEdits: "shift+tab to cycle",
  plan: "nothing will be changed · shift+tab to cycle",
};

export function cycleMode(mode: PermissionMode): PermissionMode {
  return mode === "ask" ? "acceptEdits" : mode === "acceptEdits" ? "plan" : "ask";
}

/* ─── The pieces a transcript is made of ──────────────────────────────────── */

/** A line in a rendered hunk. `…` is the gap between two of them. */
export interface DiffLine {
  no: number | null;
  sign: "+" | "-" | " " | "…";
  text: string;
}

export type ToolKind = "read" | "search" | "edit" | "write" | "bash";

export interface ToolRow {
  kind: ToolKind;
  /** `Read`, `Edit`, `Bash` — the verb, as the call was named. */
  name: string;
  /** The path, pattern or command it applies to. Empty while it streams. */
  target: string;
  /** The first line of the result, or the error. */
  meta?: string;
  added?: number;
  removed?: number;
  diff?: DiffLine[];
  output?: string[];
  /** Still going: the row is drawn with a spinner rather than a glyph. */
  running?: boolean;
  failed?: boolean;
  /** Declined by the mode or by the user. Not a failure, and not red. */
  refused?: boolean;
}

export type NoticeTone = "stop" | "warn" | "info" | "error";

export interface NoticeAction {
  label: string;
  primary?: boolean;
}

export interface Notice {
  tone: NoticeTone;
  title: string;
  body: string;
  actions?: NoticeAction[];
}

export interface PromptOption {
  label: string;
  /** The quiet half of the line. */
  hint?: string;
  /** A chord that picks this option without arrowing to it. */
  chord?: string;
}

/**
 * A question the run has stopped on.
 *
 * Two things, not one: **what is about to happen** and **what you want to
 * do about it**. They were a single card and should not have been — the
 * proposal is the same object the transcript will show once it has run,
 * and a decision is a short list with a keyboard line under it. Welding
 * them together made the diff part of the dialog, which is why a
 * four-line edit produced a dialog nobody could take in at a glance.
 *
 * So `title`, `command` and `diff` describe the proposal, and `question`
 * is the sentence above the options. They are rendered as separate cards.
 */
export interface Prompt {
  variant: "edit" | "bash" | "question" | "plan";
  /** The proposal's heading: `Edit Dockerfile`, `Bash command`. */
  title: string;
  /** The decision, as a sentence: `Make this edit to Dockerfile?` */
  question: string;
  subtitle?: string;
  /** For `bash`: the command, shown as a shell line. */
  command?: string;
  /** For `bash`: what it will touch, in one muted line. */
  facts?: string;
  diff?: DiffLine[];
  options: PromptOption[];
  footer: string;
  /** Which option means no, so Escape can pick it. */
  denyIndex: number;
}

/** Everything that can appear in the scroll. */
export type Block =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "tool"; callId: string; tool: ToolRow }
  | { id: number; kind: "notice"; notice: Notice };

/* ─── Small arithmetic the footer and the spinner need ────────────────────── */

/** `14s`, then `2m 41s`. Seconds all the way down would read as a stopwatch. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** `940`, `2.1k`, `31k`. One decimal only where it says something. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/**
 * `$0.0042`, `$1.37`. Four decimals under a cent, because the interesting
 * number early in a session is tenths of a cent and `$0.00` says nothing.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
