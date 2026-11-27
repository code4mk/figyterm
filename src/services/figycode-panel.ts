/**
 * The editor panel's half of the agent: its preamble, and the context it
 * hands over for free.
 *
 * The panel's whole value is being **short and cheap**. It sits beside
 * one buffer and answers questions about it; the moment it grows a
 * shell, a plan and thirty turns it is the FigyCode window drawn
 * narrower, and we will have built the window twice. Everything here is
 * in service of that — a preamble that tells the model it is small, and
 * a seed that means the first turn does not spend a round trip finding
 * out what is on screen.
 *
 * ## Why the context is seeded rather than offered as a tool
 *
 * The obvious design is `current_file()` and `current_selection()`
 * tools. It costs a whole extra round trip — a request, a tool call, a
 * result, a second request — to learn two facts the panel already knows
 * and could have typed. The cheapest turn an agent can have is the one
 * where the context was free.
 *
 * ## Why the seed is in the *message* and not the system prompt
 *
 * Order on the wire is `tools → system → messages`, and caching is a
 * prefix match. The open file changes every time somebody clicks a tab;
 * in the preamble that is a cache miss per click, and the preamble is
 * the one thing in the request guaranteed to be read every turn. In a
 * user message it is appended after everything already cached, so it
 * costs its own tokens and nothing else's.
 */

/**
 * What the editor can see, at the moment a message is sent.
 *
 * Deliberately a snapshot rather than a subscription: what matters is
 * what was on screen when the person pressed enter, not what is on
 * screen when the model gets round to reading it.
 */
export interface EditorContext {
  /** The active tab, as a path the agent can pass to `read`. */
  file: string | null;
  /** The other open tabs, by name. Context, not an instruction. */
  tabs: string[];
  /** The main selection, if anything is selected. */
  selection: { text: string; startLine: number; endLine: number } | null;
}

export function emptyContext(): EditorContext {
  return { file: null, tabs: [], selection: null };
}

/**
 * How much selected text rides along.
 *
 * ⌘A is one keystroke, and a four-thousand-line file pasted into a
 * prompt is a context the panel cannot afford and an excerpt nobody
 * meant to send. Past this the line numbers are the useful part: they
 * say where to `read`.
 */
export const MAX_SELECTION = 2_000;

/** At what point the tab list stops being context and starts being noise. */
const MAX_TABS = 8;

/**
 * The context block for a message, given what the last one said.
 *
 * Only what changed. The first message carries everything; after that,
 * repeating "the open file is still `App.tsx`" on every turn pays for a
 * fact already three messages up in the same conversation. A changed
 * file or a new selection is news and goes; an unchanged one does not.
 *
 * Returns the empty string when there is nothing to say, which the
 * caller takes as "send the message as typed".
 */
export function seedContext(now: EditorContext, before: EditorContext | null): string {
  const lines: string[] = [];
  const first = before === null;

  if (now.file && (first || now.file !== before.file)) {
    lines.push(`Open file: ${now.file}`);
  }

  /*
    The tab strip, once.

    It is the cheapest useful thing the panel knows — "this person is
    working across these four files" is most of what a question like
    "where does this get called" needs — and it is also the thing that
    changes most often for the least reason. So: on the first message,
    and never again.
  */
  if (first && now.tabs.length > 0) {
    const shown = now.tabs.slice(0, MAX_TABS);
    const rest = now.tabs.length - shown.length;
    lines.push(`Other tabs open: ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`);
  }

  const selection = now.selection;
  if (selection && (first || !sameSelection(selection, before.selection))) {
    const at = `lines ${selection.startLine}–${selection.endLine}`;
    const text = selection.text;
    if (text.length > MAX_SELECTION) {
      /*
        Not the text, then — the address of it.

        A truncated excerpt is worse than no excerpt: the model reads
        half a function, answers about the half it saw, and nothing in
        the message says the other half existed. Saying where it is
        instead costs twenty tokens and the model can `read` exactly
        the range if it wants it.
      */
      lines.push(
        `Selected: ${at} of ${now.file ?? "the open file"} ` +
          `(${text.length} characters — too much to quote; read the range if you need it)`
      );
    } else {
      lines.push(`Selected, ${at}:`, "```", text, "```");
    }
  }

  return lines.join("\n");
}

function sameSelection(
  a: EditorContext["selection"],
  b: EditorContext["selection"]
): boolean {
  if (!a || !b) return a === b;
  return a.startLine === b.startLine && a.endLine === b.endLine && a.text === b.text;
}

/**
 * The message as it goes to the backend: the context, then what was
 * typed.
 *
 * Context first, because it is the setting and the sentence is the
 * request — and because a message that opens with four lines of code
 * and ends with "what does this do" reads the way somebody would say
 * it.
 */
export function withContext(prompt: string, context: string): string {
  if (!context) return prompt;
  return `${context}\n\n${prompt}`;
}

/**
 * The panel's preamble.
 *
 * **Not the window's**, and that is the point rather than an oversight.
 * A different preamble is a different cache prefix; sharing one would
 * mean the panel's short turns and the window's long ones writing over
 * each other's cached prefix all day — paying 1.25× to write a cache
 * entry in order to destroy one that was saving 10×.
 *
 * It used to also be a smaller *job*: the panel was offered seven tools
 * and this said so, in as many words. Both surfaces carry the whole
 * registry now, so the sentence that said "you cannot run commands,
 * use git, or reach the network" is gone — it would be a lie, and a
 * preamble that lies about the tools produces a model that apologises
 * instead of working.
 *
 * What is left that is still particular to this surface:
 *
 * - **Be short.** The column is the width of a sidebar. This is about
 *   the shape of the answer, not the size of the job.
 * - **The file is already given.** Nothing else knows that, and it is
 *   the panel's whole advantage.
 * - **Say when the window is the better place.** Not because the panel
 *   cannot do it, but because a sixty-turn refactor is easier to read
 *   at 960px. A suggestion, not a refusal.
 */
export const PANEL_SYSTEM = [
  "You are FigyCode, answering from a panel beside an open file in the Figylo editor.",
  "The person can see the file; you are usually helping with the part they are looking at.",
  "",
  "Be brief. The column is the width of a sidebar — one or two paragraphs, or a small",
  "diff. That is about how you answer, not about what you are willing to do.",
  "",
  "The open file and anything selected are given to you in the message. Do not ask what",
  "file this is.",
  "",
  "You have the same tools as the main FigyCode window: reading and searching, editing,",
  "writing and moving files, the shell, git, the language server, web search, and",
  "sub-agents. Use them. Running the test to see whether the fix worked is better than",
  "guessing at it from the source.",
  "",
  "Every tool takes a `why`: four or five words on what this call is for, in your own",
  "words, written for the person rather than for yourself. The panel shows it on the row",
  "instead of the path or the command, so a long call is something to read rather than a",
  "spinner. Always pass it.",
  "",
  "For anything with more than two or three steps, write the plan down with `todo_write`",
  "before you start, mark one item `running` while you are on it, and update it as you go.",
  "",
  "Edit rather than describe an edit. `edit` replaces exact text, so copy the lines out of",
  "a `read` rather than retyping them from memory.",
  "",
  // The pathology this replaces: asked to build a Docker image and
  // report back, a model with only `bash_output` polls it. Each poll
  // is a whole round trip that re-sends the conversation, so a
  // four-minute build arrived as forty rows that each said "still
  // running, 7 lines" and forty times the input bill.
  "For something slow — a build, a test suite, an install — start it with",
  "background=true and then call `bash_wait` on its id. It returns when the command is",
  "done, with its exit code. **Never poll `bash_output` in a loop**: each call is a",
  "whole request that re-sends this conversation, and it tells the person nothing that",
  "the waiting row does not already show them. When the wait comes back, say what",
  "happened in a sentence — whether it worked, and what to do about it if it did not.",

  "",
  // Not a refusal — it has the tools. A judgement about where the work
  // is easier to follow, which is a real thing and worth saying once.
  "If a request turns into a long job — a refactor across many files, or anything that",
  "will take dozens of turns — say so in a sentence and offer to continue in the FigyCode",
  "window, which has the room for it. Then do what they say.",
].join("\n");
