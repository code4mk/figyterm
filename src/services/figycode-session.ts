/**
 * The transcript, as a function of the events that produced it.
 *
 * `(state, event) => state`, and nothing else. No `invoke`, no timers, no
 * React — which is what makes the awkward parts testable: text arriving in
 * forty pieces that must become one paragraph, a tool row that is created
 * when the call starts and filled in when it ends, a permission question
 * that has to find its own answer again two seconds later.
 *
 * The window used to hold a scripted version of all of this. The scripts
 * are gone; the rendering is the same, which is the useful half of having
 * built the prototype first.
 */

import type { PastMessage, TurnEvent } from "./figycode-agent";
import type { Block, DiffLine, Prompt, ToolKind, ToolRow } from "./figycode-blocks";
import { addedLines, lineDiff } from "./figycode-diff";

/** A question the run has stopped on, waiting for the user. */
export interface LivePrompt {
  /** The tool call's id, which the answer must quote back. */
  id: string;
  /** What "don't ask again" would remember, or null when it cannot. */
  rememberKey: string | null;
  prompt: Prompt;
}

export interface SessionState {
  blocks: Block[];
  live: LivePrompt | null;
  running: boolean;
  /** What the spinner says. */
  status: string;
  /** The last turn's accounting, for the status bar. */
  usage: {
    input: number;
    cached: number;
    output: number;
    costUsd: number;
    hitRate: number;
    contextPercent: number | null;
  } | null;
  /** Dollars so far, which is the number worth watching while it climbs. */
  spent: number;
  /**
   * Characters streamed in this turn.
   *
   * The real token count arrives with the provider's usage block, at the
   * *end* of the turn — so a counter wired to that reads zero for the
   * forty seconds anybody is watching it. This is the rough one that
   * moves, and it is replaced by the true figure the moment it lands.
   */
  streamed: number;
  /** The id of the next block, so ids are stable and unique. */
  nextId: number;
}

export function emptySession(): SessionState {
  return {
    blocks: [],
    live: null,
    running: false,
    status: "Working…",
    usage: null,
    spent: 0,
    streamed: 0,
    nextId: 1,
  };
}

/** The user's own turn, which the window adds rather than the backend. */
export function pushUser(state: SessionState, text: string): SessionState {
  return {
    ...state,
    blocks: [...state.blocks, { id: state.nextId, kind: "user", text }],
    nextId: state.nextId + 1,
    running: true,
    status: "Working…",
    streamed: 0,
    live: null,
  };
}

/* ─── A conversation picked back up ───────────────────────────────────────── */

/**
 * The transcript, rebuilt from the messages rather than from the events.
 *
 * Everything else in this file is `(state, event) => state`, and a resumed
 * conversation is the one case with no events to replay: what was stored is
 * the conversation, because the conversation is the thing that survives.
 *
 * So some of the screen does not come back, and it is worth being plain
 * about which. A tool's `detail` — the structured half that never entered
 * the conversation and only ever existed so the window could draw a diff —
 * is not stored, so a resumed edit shows the result it reported rather
 * than the tinted before-and-after. Storing `detail` would mean keeping a
 * second copy of every file the agent touched, for a view of work that is
 * already done.
 */
export function resumeSession(messages: PastMessage[], spentUsd: number): SessionState {
  const blocks: Block[] = [];
  let nextId = 1;
  /** Where each call's row landed, so its result can find it. */
  const rowOf = new Map<string, number>();

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      blocks.push({ id: nextId++, kind: "user", text: message.content });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content.trim()) {
        blocks.push({ id: nextId++, kind: "assistant", text: message.content });
      }
      for (const call of message.calls) {
        rowOf.set(call.id, blocks.length);
        blocks.push({
          id: nextId++,
          kind: "tool",
          callId: call.id,
          tool: {
            kind: kindOf(call.name),
            name: title(call.name),
            target: subjectOf(call.name, call.arguments),
          },
        });
      }
      continue;
    }

    // A tool result, which belongs to a row that is already there.
    const at = message.answers != null ? rowOf.get(message.answers) : undefined;
    const block = at != null ? blocks[at] : undefined;
    if (!block || block.kind !== "tool") continue;
    blocks[at as number] = {
      ...block,
      tool: { ...block.tool, meta: summarise(message.content), ...body(message.content, null) },
    };
  }

  return { ...emptySession(), blocks, nextId, spent: spentUsd };
}

/* ─── Tools ───────────────────────────────────────────────────────────────── */

/**
 * Which glyph a tool row wears: hollow for the ones that only look, filled
 * for the ones that change something. The distinction is what a reader
 * scans for, so it is carried by the shape rather than by the verb.
 */
function kindOf(tool: string): ToolKind {
  switch (tool) {
    case "read":
    case "ls":
      return "read";
    case "grep":
      return "search";
    case "edit":
    case "move":
    case "delete":
      return "edit";
    case "write":
      return "write";
    default:
      return "bash";
  }
}

/** `read` → `Read`, `bash_output` → `Bash output`. */
function title(tool: string): string {
  const words = tool.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The one argument worth putting on the row beside the verb.
 *
 * A row reading `Edit` and nothing else is a row that says only that
 * something happened. The path, the pattern or the command is the thing
 * anybody scanning the transcript is actually looking for.
 */
export function subjectOf(tool: string, args: Record<string, unknown>): string {
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  };
  switch (tool) {
    case "grep":
      return first("pattern") ?? "";
    case "bash":
    case "bash_output":
    case "bash_kill":
      return first("cmd", "id") ?? "";
    case "move":
      return `${first("from") ?? ""} → ${first("to") ?? ""}`;
    case "search_web":
      return first("query") ?? "";
    case "fetch_url":
      return first("url") ?? "";
    default:
      return first("path", "cmd", "pattern", "url", "query", "id") ?? "";
  }
}

/* ─── The reducer ─────────────────────────────────────────────────────────── */

export function applyEvent(state: SessionState, event: TurnEvent): SessionState {
  switch (event.kind) {
    /*
      Text arrives in fragments and has to become one paragraph.

      Appending to the last block when it is already an assistant turn is
      the whole of it — a block per fragment would render as forty lines of
      two words, and re-joining them afterwards would mean the window held
      the stream twice.
    */
    case "text": {
      const streamed = state.streamed + event.text.length;
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === "assistant") {
        const blocks = [...state.blocks];
        blocks[blocks.length - 1] = { ...last, text: last.text + event.text };
        return { ...state, blocks, streamed };
      }
      return {
        ...state,
        streamed,
        blocks: [...state.blocks, { id: state.nextId, kind: "assistant", text: event.text }],
        nextId: state.nextId + 1,
      };
    }

    /*
      A tool row appears when the call starts, not when it finishes.

      The arguments are still streaming at this point, so there is nothing
      to put beside the verb yet — but a row that appears immediately is
      how the window says "it is doing something" during the two seconds a
      grep takes.
    */
    case "toolStarted":
      return {
        ...state,
        status: `${title(event.name)}…`,
        blocks: [
          ...state.blocks,
          {
            id: state.nextId,
            kind: "tool",
            callId: event.id,
            tool: { kind: kindOf(event.name), name: title(event.name), target: "", running: true },
          },
        ],
        nextId: state.nextId + 1,
      };

    case "toolFinished":
      return patchTool(state, event.id, (tool) => ({
        ...tool,
        running: false,
        meta: summarise(event.text),
        /*
          The body, so every row can be opened.

          A transcript of one-line summaries is a transcript you have to
          take on trust. The result is already in the conversation and
          already paid for; showing it costs nothing further and is the
          difference between watching an agent work and watching it claim
          to have worked.
        */
        ...body(event.text, event.detail),
        ...fromDetail(event.detail),
      }));

    case "toolFailed":
      return patchTool(state, event.id, (tool) => ({
        ...tool,
        running: false,
        failed: true,
        meta: event.error,
      }));

    /*
      A refusal is not a failure, and must not look like one.

      Plan mode declining an edit is the mode working. Rendering it in red
      beside a crash would teach people that plan mode is broken.
    */
    case "toolRefused":
      return patchTool(state, event.id, (tool) => ({
        ...tool,
        running: false,
        refused: true,
        meta: event.reason,
      }));

    case "needsApproval":
      return { ...state, live: promptFor(event.id, event.name, event.arguments) };

    /*
      A wait, not a failure.

      It goes in the spinner's label rather than the transcript: a
      notice per attempt would be four notices for one hiccup, and what
      the reader needs is "it is still going, here is why it is quiet".
    */
    case "retrying":
      return {
        ...state,
        status: `${event.reason.split(":")[0]} — trying again in ${event.seconds}s (${event.attempt} of ${event.total})`,
      };

    case "turn":
      return {
        ...state,
        usage: {
          input: event.input,
          cached: event.cached,
          output: event.output,
          costUsd: event.costUsd,
          hitRate: event.hitRate,
          contextPercent: event.contextPercent,
        },
        spent: state.spent + event.costUsd,
      };

    /*
      Summarising is a model call with nothing streaming, so the spinner
      says what the pause is. The result is one line in the transcript,
      because a conversation quietly losing its middle is the kind of
      thing somebody should be able to see happened.
    */
    case "compacting":
      return { ...state, status: "Summarising the conversation so far…" };

    case "compacted":
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            id: state.nextId,
            kind: "notice",
            notice: {
              tone: "info",
              title: "Earlier turns summarised",
              body: `The conversation was near the model's limit, so what came before was replaced with a summary. ${event.messages} messages remain.`,
            },
          },
        ],
        nextId: state.nextId + 1,
      };

    case "finished": {
      const base = { ...state, running: false, live: null };
      if (event.reason !== "step_limit") return base;
      return {
        ...base,
        blocks: [
          ...base.blocks,
          {
            id: base.nextId,
            kind: "notice",
            notice: {
              tone: "warn",
              title: "Stopped after 40 steps",
              body: "The work so far is kept. Say what to do next.",
            },
          },
        ],
        nextId: base.nextId + 1,
      };
    }

    /*
      An interruption is not an error.

      It is the one "failure" the user caused on purpose, and the window
      has a quieter card for it — the alternative is a red box every time
      somebody presses Escape.
    */
    case "failed": {
      const interrupted = event.error === "Interrupted";
      return {
        ...state,
        running: false,
        live: null,
        blocks: [
          ...state.blocks,
          {
            id: state.nextId,
            kind: "notice",
            notice: interrupted
              ? {
                  tone: "stop",
                  title: "Interrupted by you",
                  body: "Stopped where it was. The work so far is kept.",
                  // Picking it back up is one word, and typing that word
                  // is the thing anybody does next.
                  actions: [{ label: "Carry on", primary: true }],
                }
              : { tone: "error", title: "The turn failed", body: event.error },
          },
        ],
        nextId: state.nextId + 1,
      };
    }
  }
}

/** Updates the row belonging to a call, by the id the backend gave it. */
function patchTool(
  state: SessionState,
  callId: string,
  change: (tool: ToolRow) => ToolRow
): SessionState {
  const index = state.blocks.findIndex((b) => b.kind === "tool" && b.callId === callId);
  if (index < 0) return state;
  const block = state.blocks[index];
  if (block.kind !== "tool") return state;

  const blocks = [...state.blocks];
  blocks[index] = { ...block, tool: change(block.tool) };
  return { ...state, blocks };
}

/** How many lines of a tool's output the window keeps. */
const MAX_BODY_LINES = 400;

/**
 * What a row shows when it is opened: a diff where there is one, the
 * result's own text otherwise.
 *
 * An edit and a write get a diff because the question they answer is
 * "what changed", and a wall of before-and-after is a worse answer than
 * four lines with two of them tinted. Everything else — a grep's matches,
 * a command's output, a page's text — is already laid out the way it
 * should be read.
 */
function body(text: string, detail: unknown): Partial<ToolRow> {
  const d = (detail && typeof detail === "object" ? detail : {}) as Record<string, unknown>;

  if (typeof d.old === "string" && typeof d.new === "string") {
    const at = typeof d.line === "number" ? d.line : 1;
    return { diff: lineDiff(d.old, d.new, at) };
  }
  if (typeof d.content === "string" && d.content) {
    const diff: DiffLine[] = addedLines(d.content);
    if (d.contentTruncated) diff.push({ no: null, sign: "…", text: "" });
    return { diff };
  }

  // The first line is the summary on the row itself; repeating it inside
  // the body is a heading nobody asked for.
  const rest = text.split("\n").slice(1).filter((line) => line.trim().length > 0);
  if (rest.length === 0) return {};
  return {
    output:
      rest.length > MAX_BODY_LINES
        ? [...rest.slice(0, MAX_BODY_LINES), `… ${rest.length - MAX_BODY_LINES} more lines`]
        : rest,
  };
}

/**
 * The first line of a tool's result, as the row's summary.
 *
 * The whole result is in the conversation and costs tokens there; showing
 * it again in the row would be a wall of text per call. The first line is
 * what every tool here writes its headline on.
 */
function summarise(text: string): string {
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

/**
 * What the tool told the window but not the model.
 *
 * `detail` never enters the conversation — it is the half of a tool's
 * answer that exists so the window can draw something better than the
 * sentence the model is reading.
 */
function fromDetail(detail: unknown): Partial<ToolRow> {
  if (!detail || typeof detail !== "object") return {};
  const d = detail as Record<string, unknown>;
  const out: Partial<ToolRow> = {};
  if (typeof d.path === "string") out.target = d.path;
  if (typeof d.cmd === "string") out.target = d.cmd;
  if (typeof d.pattern === "string") out.target = d.pattern;
  if (typeof d.added === "number") out.added = d.added;
  if (typeof d.removed === "number") out.removed = d.removed;
  return out;
}

/* ─── Permission questions ────────────────────────────────────────────────── */

/**
 * The card for a tool that needs an answer.
 *
 * Three shapes, by what is about to happen: a command gets its command
 * line, an edit gets its path and the text it is replacing, and anything
 * else is a plain question. The options differ too — "don't ask again" is
 * only offered where there is something specific to remember.
 */
export function promptFor(
  id: string,
  tool: string,
  args: Record<string, unknown>
): LivePrompt {
  const text = (key: string): string => {
    const value = args[key];
    return typeof value === "string" ? value : "";
  };

  if (tool === "bash" || tool === "bash_kill") {
    const command = text("cmd") || text("id");
    const head = command.split(/\s+/).slice(0, 2).join(" ");
    return {
      id,
      rememberKey: head ? `${tool}:${head}` : null,
      prompt: {
        variant: "bash",
        title: "Bash command",
        question: args.background ? "Start this in the background?" : "Run this command?",
        command,
        facts: `in the project folder${args.background ? " · in the background" : ""}`,
        options: [
          { label: "Yes" },
          { label: `Yes, and don't ask again for ${head}` },
          { label: "No, tell FigyCode what to do instead", chord: "esc" },
        ],
        footer: "↑↓ select · ↵ confirm · esc to say no",
        denyIndex: 2,
      },
    };
  }

  if (tool === "edit" || tool === "write" || tool === "move" || tool === "delete") {
    const path = text("path") || `${text("from")} → ${text("to")}`;
    const old = text("old");
    const replacement = text("new");
    return {
      id,
      rememberKey: null,
      prompt: {
        variant: "edit",
        title: `${title(tool)} ${path}`,
        question: questionFor(tool, path),
        // The same view the row will show once it has run, so saying yes
        // does not change what you were looking at.
        diff: old || replacement ? lineDiff(old, replacement) : undefined,
        options: [
          { label: "Yes" },
          { label: "Yes, allow all edits this session", chord: "shift+tab" },
          { label: "No, tell FigyCode what to change", chord: "esc" },
        ],
        footer: "↑↓ select · ↵ confirm",
        denyIndex: 2,
      },
    };
  }

  return {
    id,
    rememberKey: tool,
    prompt: {
      variant: "question",
      title: title(tool),
      question: questionFor(tool, subjectOf(tool, args)),
      subtitle: subjectOf(tool, args),
      options: [
        { label: "Yes" },
        { label: `Yes, and don't ask again for ${tool}` },
        { label: "No", chord: "esc" },
      ],
      footer: "↑↓ select · ↵ confirm · esc to say no",
      denyIndex: 2,
    },
  };
}

/**
 * The sentence above the options.
 *
 * Named after the thing rather than the tool — "Make this edit to
 * Dockerfile?" rather than "Run edit?" — because what is being approved is
 * a change to a file, and the tool that makes it is an implementation
 * detail of the agent, not of the decision.
 */
function questionFor(tool: string, subject: string): string {
  const name = subject.split("/").filter(Boolean).pop() ?? subject;
  switch (tool) {
    case "edit":
      return `Make this edit to ${name}?`;
    case "write":
      return `Create ${name}?`;
    case "move":
      return `Move ${subject}?`;
    case "delete":
      return `Move ${name} to the trash?`;
    case "search_web":
      return `Search the web for “${subject}”?`;
    case "fetch_url":
      return `Fetch ${name}?`;
    default:
      return `Run ${tool}${subject ? ` on ${name}` : ""}?`;
  }
}

/**
 * What an answer means: whether to run it, and what to remember.
 *
 * Option 1 is always yes-once and the deny index is always no; the middle
 * option is the only one that varies, and it is the only one that writes
 * anything down.
 */
export function answerOf(
  live: LivePrompt,
  index: number
): { allow: boolean; remember?: string; acceptEdits: boolean } {
  if (index === live.prompt.denyIndex) return { allow: false, acceptEdits: false };
  const label = live.prompt.options[index]?.label ?? "";
  return {
    allow: true,
    remember: index === 1 ? live.rememberKey ?? undefined : undefined,
    // The edit card's middle option is a mode change rather than a memory:
    // "all edits this session" is exactly what acceptEdits means.
    acceptEdits: /allow all edits/i.test(label),
  };
}
