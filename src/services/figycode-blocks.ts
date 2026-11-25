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
  { name: "/model", summary: "model, keys, limits and prices" },
  { name: "/tools", summary: "what the agent can do, and what it costs to offer" },
  { name: "/project", summary: "the folder, the index, and what else it can reach" },
  { name: "/context", summary: "what is filling the context window" },
  { name: "/usage", summary: "tokens, cache hit rate and spend this session" },
  { name: "/resume", summary: "pick up a conversation from this folder" },
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
  /**
   * What the model said it was doing, in its own words.
   *
   * `bash` and `task` ask for it, because those are the two whose
   * row says least: `Bash npm run build` is a fact and "checking the
   * change compiles" is the reason, and over two minutes of watching
   * it is the reason somebody wants.
   */
  why?: string;
  /**
   * Output arriving while the tool is still running.
   *
   * Kept apart from `output`, which is the finished result. These are
   * the last few lines of a build, shown live and replaced by the
   * real thing when it lands.
   */
  live?: string[];
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

/* ─── The plan ────────────────────────────────────────────────────────────── */

/**
 * The three answers to a plan, spelled as `agent/tools/plan.rs` spells
 * them.
 *
 * The strings go back to the tool, which compares them against the
 * labels it offered — it is the only way the backend can know what the
 * answer *meant*. They are here so the window can map the same strings
 * to the mode each one leaves behind, and a change on one side without
 * the other makes an approved plan read as a refused one.
 */
export const PLAN_GO_AHEAD = "Go ahead with this plan";
export const PLAN_GO_AHEAD_NO_ASKING = "Go ahead, and don't ask about edits";
export const PLAN_NOT_YET = "No — I'll say what to change";

/** Which mode an answer to a plan leaves the session in, if it changes it. */
export function modeAfterPlan(answer: string): PermissionMode | null {
  if (answer === PLAN_GO_AHEAD) return "ask";
  if (answer === PLAN_GO_AHEAD_NO_ASKING) return "acceptEdits";
  return null;
}

export type TodoStatus = "pending" | "running" | "done";

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

/**
 * Reads a `todo_write` result back out of its own text.
 *
 * For a resumed conversation. The structured half of a tool's answer is
 * not stored — it never entered the conversation — but this tool writes
 * its list into the result the model reads, so the list can be recovered
 * from the one copy that *is* kept. The glyphs are the ones
 * `tools/todo.rs` writes.
 */
export function todosFromText(text: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const status: TodoStatus | null = trimmed.startsWith("✓")
      ? "done"
      : trimmed.startsWith("▸")
        ? "running"
        : trimmed.startsWith("○")
          ? "pending"
          : null;
    if (!status) continue;
    const body = trimmed.slice(1).trim();
    if (body) items.push({ text: body, status });
  }
  return items;
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
  /** For `plan`: the steps being proposed, drawn above the decision. */
  steps?: string[];
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
  | { id: number; kind: "notice"; notice: Notice }
  /**
   * The plan, of which there is at most one.
   *
   * A new `todo_write` moves it to the end rather than adding a second:
   * the list is a thing with a current state, not an event that happened,
   * and ten copies of it down the scroll would bury the work between them.
   */
  | { id: number; kind: "todos"; items: TodoItem[] };

/* ─── Typing a number ─────────────────────────────────────────────────────── */

/**
 * Bengali digits to Latin ones: `০.৬` becomes `0.6`.
 *
 * The number row of a Bangla InScript layout produces these, and
 * `Number("০.৬")` is `NaN` — so without this, typing a price with the
 * keyboard you are already using silently sets it to nothing.
 */
export function toLatinDigits(text: string): string {
  return text.replace(/[\u09E6-\u09EF]/g, (d) => String(d.charCodeAt(0) - 0x09e6));
}

/** What may be in the box while a number is still being typed. */
const PARTIAL_NUMBER = /^[0-9]*[.,]?[0-9]*$/;

/**
 * One keystroke in a number field: what the box should now show, and
 * what that means as a number.
 *
 * `null` means the keystroke is refused and nothing changes.
 *
 * It exists as a function because the obvious version is wrong in a way
 * that is invisible until somebody tries to type a real price. A field
 * whose value is `Number(text)` turns `0.` into `0` on the keystroke
 * after the zero, re-renders as `"0"`, and eats the decimal point —
 * making `0.10`, and every other fractional price, impossible to enter.
 *
 * So the text and the number are two different things, and the text is
 * what the box shows. Half-way through `0.10` the value really is zero
 * for one keystroke — that part was never wrong — but the box goes on
 * saying `0.` and the next digit lands where it should.
 *
 * An empty box, and a lone separator, are "no number" rather than zero:
 * a context window of 0 and one nobody has set are different things.
 * A letter is refused rather than silently becoming zero, which is how
 * `Number("3x") || 0` used to turn a typo into a price of nothing.
 */
export function typedNumber(raw: string): { text: string; value: number | undefined } | null {
  const text = toLatinDigits(raw.trim());
  if (!PARTIAL_NUMBER.test(text)) return null;
  const parsed = text.replace(",", ".");
  return {
    text,
    value: parsed === "" || parsed === "." ? undefined : Number(parsed),
  };
}

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
