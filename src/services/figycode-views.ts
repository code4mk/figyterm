/**
 * What `/context`, `/usage`, `/tools` and `/resume` say — once, for
 * both surfaces.
 *
 * There are two front ends onto one backend: the FigyCode window and
 * the panel in the editor. They draw differently, and for a while they
 * also *said different things* — the window's context screen led with
 * the estimate and the panel's with the provider's measured count; the
 * window listed six parts in wire order and the panel five in an order
 * of its own; the window's spend table had a total and the panel's did
 * not; a conversation was "4 messages" in one and "4 turns" in the
 * other.
 *
 * None of that was a decision. Each was a reasonable call made twice,
 * and the result is two screens about the same conversation that
 * cannot both be right. Somebody checking a number in the panel and
 * then in the window has to work out which one lied.
 *
 * So the content lives here and the components render it. Layout stays
 * theirs — a 560px dialog and a 320px column genuinely need different
 * shapes — but every label, every order, every number and every
 * footnote comes out of this file. A view they disagree about is now a
 * compile error or a failing test rather than something to notice in a
 * screenshot.
 *
 * Everything in here is pure, which is the other half of the point: it
 * is tested in `figycode-views.test.ts` without a DOM.
 */

import type { ContextBreakdown, Conversation, ToolInfo, Totals } from "./figycode-agent";
import { formatCost, formatTokens } from "./figycode-blocks";

/* ─── Which command opens what ────────────────────────────────────────────── */

/**
 * The screens a slash command can open.
 *
 * Named once so both surfaces agree on the set. The window draws each
 * as a dialog and the panel as a tab in one sheet, but *which* screen a
 * command opens is not a thing either of them should be deciding for
 * itself.
 */
export type Screen = "settings" | "context" | "usage" | "tools" | "resume" | "project";

/**
 * Every command the composer offers, and what it does.
 *
 * `"clear"` is the one that is an action rather than a screen.
 *
 * This exists because `/project` was offered by the completion popup
 * on both surfaces and handled on only one: typing it in the editor
 * panel completed from the list and then answered "No command
 * /project". A command list and a command handler written in two
 * places drift the moment one of them gains an entry, so the handler
 * reads from this and a test checks it against `COMMANDS`.
 */
export const COMMAND_SCREEN: Record<string, Screen | "clear"> = {
  // `/settings` is unlisted and accepted, because it is what the
  // dialog is now and half of everybody will try it.
  "/model": "settings",
  "/settings": "settings",
  "/context": "context",
  "/usage": "usage",
  "/tools": "tools",
  "/resume": "resume",
  "/project": "project",
  "/folder": "project",
  "/folders": "project",
  "/clear": "clear",
};

/** What a command opens, or null when there is no such command. */
export function screenFor(name: string): Screen | "clear" | null {
  return COMMAND_SCREEN[name] ?? null;
}

/* ─── /context ────────────────────────────────────────────────────────────── */

/**
 * The parts of the context window, **in the order they go on the
 * wire**.
 *
 * Not sorted by size, and not grouped into "what you can do about it".
 * The order is the thing that decides what a cache keeps: `tools`,
 * then the preamble, then the conversation — and a part is invalidated
 * by anything before it changing. A list in any other order is a list
 * that cannot be reasoned about.
 */
export const CONTEXT_PARTS = [
  {
    key: "tools",
    label: "Tool definitions",
    note: "Sent before anything else, on every turn, for the whole session",
  },
  { key: "system", label: "System prompt", note: "Frozen at the start, including FIGY.md" },
  { key: "user", label: "What you asked", note: "Every message you have sent" },
  {
    key: "assistant",
    label: "What it said",
    note: "Answers, and the arguments of its tool calls",
  },
  {
    key: "toolResults",
    label: "Tool results",
    note: "Each one re-sent on every later turn — usually the largest part",
  },
  {
    key: "imageTokens",
    label: "Pictures",
    note: "The one part that cannot be trimmed — an image is its size for good",
  },
] as const;

export interface Part {
  key: string;
  label: string;
  note: string;
  tokens: number;
  /** Of the scale the bar is drawn against, 0–1. */
  share: number;
}

export interface ContextView {
  /** The sum of the parts, at four characters a token. */
  estimated: number;
  /** The provider's own count for the last turn. Exact, and different. */
  measured: number;
  /** Zero when no window is configured — nothing on the wire reports it. */
  window: number;
  free: number;
  /**
   * The free part's share of the bar, on the same scale as the parts.
   *
   * In the model rather than at each call site, which is where the two
   * surfaces had computed it slightly differently — they agreed only
   * because `free` is zero whenever the window is unknown.
   */
  freeShare: number;
  percent: number | null;
  parts: Part[];
  heaviest: { name: string; tokens: number; share: number }[];
  /** The lines of fact under the breakdown, in order. */
  facts: string[];
  /** Why the heaviest list is worth reading. */
  heaviestNote: string;
}

export function contextView(context: ContextBreakdown): ContextView {
  const raw = CONTEXT_PARTS.map((part) => ({ ...part, tokens: context[part.key] }));
  const estimated = raw.reduce((sum, part) => sum + part.tokens, 0);
  const window = context.window ?? 0;
  /*
    Against the window where there is one, against itself where there
    is not: a bar with no scale is a bar that says nothing.
  */
  const scale = window > 0 ? window : Math.max(estimated, 1);
  const free = Math.max(0, window - estimated);
  const percent = window > 0 ? Math.min(100, Math.round((estimated / window) * 100)) : null;
  const top = Math.max(1, context.heaviest[0]?.tokens ?? 1);

  return {
    estimated,
    measured: context.measured,
    window,
    free,
    freeShare: free / scale,
    percent,
    parts: raw.map((part) => ({ ...part, share: part.tokens / scale })),
    heaviest: context.heaviest.map((one) => ({ ...one, share: one.tokens / top })),
    heaviestNote:
      "Each of these is re-sent with every later message. A 3k result on turn three of a " +
      "thirty-turn session is about 80k input tokens.",
    facts: [
      `${context.messages} message${context.messages === 1 ? "" : "s"} · ${
        context.turns
      } from you${
        context.images > 0
          ? ` · ${context.images} picture${context.images === 1 ? "" : "s"}`
          : ""
      } · ${context.model || "no model"}`,
      /*
        What the picker did, said here and nowhere else.

        A router that cannot be reached offers everything and says
        nothing during the turn, which is the right behaviour and makes
        "narrowed", "switched off" and "not running" identical from the
        transcript. This line is the difference.
      */
      `${context.toolsOffered} of ${context.toolsTotal} tools offered${
        context.picker ? ` · picker: ${context.picker}` : " · no tool picker"
      }`,
      /*
        Said rather than hidden. The parts are an estimate at four
        characters a token; the provider's own count for the last
        request is the real number, and they will not agree.
      */
      context.measured > 0
        ? `The last request measured ${formatTokens(
            context.measured
          )}. The breakdown above is an estimate.`
        : "An estimate at four characters a token, until the first turn is measured.",
    ],
  };
}

/** What a context screen says with nothing sent yet. Both of them. */
export const CONTEXT_EMPTY =
  "Nothing has been asked in this folder yet. The window fills from the first message — " +
  "and the tool definitions are in it before that.";

/* ─── /usage ──────────────────────────────────────────────────────────────── */

export interface UsageView {
  turns: number;
  /** The model and the tools together, which is what was spent. */
  total: number;
  perTurn: number;
  hitRate: number;
  /** Below about 70 over a long session is a bug, not a tuning chance. */
  healthy: boolean;
  /** Where the tokens went: cached, fresh, written. */
  flow: { key: string; label: string; tokens: number; share: number }[];
  /** The model, the tools, and the total — kept apart on purpose. */
  spend: { key: string; label: string; note?: string; cost: number; total?: boolean }[];
  /** The verdict on the cache, once there is enough session to judge. */
  verdict: { value: string; healthy: boolean; text: string } | null;
  /** The early warning, when there is one. */
  largest: { tokens: number; note: string } | null;
}

export function usageView(totals: Totals): UsageView {
  const fresh = Math.max(0, totals.input - totals.cached);
  const all = Math.max(1, totals.input + totals.output);
  const total = totals.costUsd + totals.toolCostUsd;
  const healthy = totals.hitRate >= 70;

  return {
    turns: totals.turns,
    total,
    perTurn: totals.turns > 0 ? total / totals.turns : 0,
    hitRate: totals.hitRate,
    healthy,
    flow: [
      { key: "user", label: "Read from cache", tokens: totals.cached, share: totals.cached / all },
      { key: "toolResults", label: "Sent fresh", tokens: fresh, share: fresh / all },
      {
        key: "assistant",
        label: "Written back",
        tokens: totals.output,
        share: totals.output / all,
      },
    ],
    spend: [
      { key: "model", label: "The model", cost: totals.costUsd },
      /*
        Kept apart from the model's own cost. Folding them together
        makes a search-heavy session read as an expensive model, which
        sends somebody to change the wrong setting.
      */
      {
        key: "tools",
        label: "Tools",
        note: "Exa, and the tool picker",
        cost: totals.toolCostUsd,
      },
      { key: "total", label: "Total", cost: total, total: true },
    ],
    /*
      Not before there is a session to judge. Two turns in, a low rate
      means the first turn had nothing to hit — which is how caching
      works, not a problem.
    */
    verdict:
      totals.turns > 2
        ? {
            value: `${totals.hitRate}%`,
            healthy,
            text: healthy
              ? "read from cache — most of each turn's input is not being re-sent, which is where nearly all of the saving is."
              : "read from cache. Below about 70% over a long conversation means something is changing the start of the request between turns — the tool list and the system prompt are the usual culprits.",
          }
        : null,
    /*
      The early warning this screen exists for. A result that was
      expensive once is expensive on every turn after it, so a spike
      shows up one turn after it starts rather than twenty.
    */
    largest:
      totals.largestToolResult > 0
        ? {
            tokens: totals.largestToolResult,
            note: "re-sent with every message after the one that fetched it",
          }
        : null,
  };
}

export const USAGE_EMPTY = "Nothing has been sent yet.";

/** How healthy a cache rate reads, in one word. Both screens. */
export function cacheWord(totals: Totals): string {
  if (totals.hitRate >= 70) return "healthy";
  return totals.turns > 2 ? "too low" : "early days";
}

/* ─── /tools ──────────────────────────────────────────────────────────────── */

export interface ToolRowView {
  name: string;
  description: string;
  cls: ToolInfo["class"];
  tokens: number;
  /** Of the heaviest row, 0–1 — so the bars have a visible top. */
  share: number;
  /** Of the whole list, for a percentage column where there is room. */
  of: number;
}

export interface ToolsView {
  count: number;
  total: number;
  average: number;
  /** How many of each class, for the line under the figures. */
  classes: { cls: ToolInfo["class"]; n: number }[];
  /** The weight of each class, for a bar. */
  weights: { cls: ToolInfo["class"]; tokens: number; share: number }[];
  rows: ToolRowView[];
  /** What the picker did, when it narrowed. */
  offered: { count: number; by: string } | null;
  note: string;
}

const CLASS_ORDER: ToolInfo["class"][] = ["read", "write", "exec", "net"];

/** What each class does, in the fewest words that are still true. */
export const CLASS_NOTE: Record<ToolInfo["class"], string> = {
  read: "reads the project · never asks",
  write: "changes a file · asks unless the session says otherwise",
  exec: "runs a program · asks every time until told otherwise per command",
  net: "leaves the machine · asks every time, with the URL shown",
};

/**
 * Four characters a token, which is the usual rule of thumb for
 * English and close enough for JSON.
 *
 * The same arithmetic the context screen's estimate uses, so the two
 * numbers are comparable — a tools total that was counted differently
 * from the `tools` row in `/context` would be two answers to one
 * question.
 */
export function schemaTokens(schema: unknown): number {
  return JSON.stringify(schema).length / 4;
}

/**
 * Sorted by weight, descending.
 *
 * Alphabetical answers "is `grep` there"; by weight it answers "what am
 * I paying for", which is the question somebody opens this to ask.
 */
export function toolsView(tools: ToolInfo[], context: ContextBreakdown | null): ToolsView {
  const rows = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      cls: tool.class,
      tokens: schemaTokens(tool.schema),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const top = Math.max(1, rows[0]?.tokens ?? 1);

  const weights = CLASS_ORDER.map((cls) => {
    const tokens = rows
      .filter((row) => row.cls === cls)
      .reduce((sum, row) => sum + row.tokens, 0);
    return { cls, tokens, share: tokens / Math.max(1, total) };
  }).filter((one) => one.tokens > 0);

  return {
    count: rows.length,
    total,
    average: rows.length ? total / rows.length : 0,
    classes: CLASS_ORDER.map((cls) => ({
      cls,
      n: rows.filter((row) => row.cls === cls).length,
    })).filter((one) => one.n > 0),
    weights,
    rows: rows.map((row) => ({
      ...row,
      share: row.tokens / top,
      of: total > 0 ? row.tokens / total : 0,
    })),
    /*
      What *this* surface was offered, out of what exists.

      `agent_tools` answers with the registry; a surface may be offered
      fewer — the editor's panel gets seven of twenty-four, and the
      tool picker narrows further per message. Only the breakdown
      knows, which is why this screen needs both calls.
    */
    offered:
      context?.picker && context.toolsOffered < rows.length
        ? { count: context.toolsOffered, by: context.picker }
        : null,
    note:
      "Definitions are the first thing in the request and caching is a prefix match, so this " +
      "list is decided once at session start and not changed — a set that varied would rewrite " +
      "the cache on the turn it varied. Token figures are estimated at four characters each.",
  };
}

export const TOOLS_EMPTY = "The tool list could not be read.";

/* ─── /resume ─────────────────────────────────────────────────────────────── */

/**
 * How long ago, in the fewest characters that are still useful.
 *
 * Was local to the window's dialog, which is why the panel's list had
 * no time on it at all.
 */
export function when(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 18 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 42 * 3600) return "yesterday";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * One conversation, as both lists show it.
 *
 * `turns` is counted as **messages** because that is what it is — the
 * window said "4 messages" and the panel said "4 turns" about the same
 * number, which is the kind of disagreement nobody notices and
 * everybody has to resolve once.
 */
export function conversationRow(one: Conversation): { title: string; meta: string } {
  return {
    title: one.title || "Untitled",
    meta: `${one.turns} ${one.turns === 1 ? "message" : "messages"} · ${formatCost(
      one.spentUsd
    )} · ${when(one.updatedAt)}`,
  };
}

/**
 * Why picking one up is not free, said on both screens.
 *
 * The provider's cache is keyed on a prefix it saw minutes ago, not
 * days, so the first message after resuming pays for the whole
 * conversation again.
 */
export const RESUME_NOTE =
  "Picking one up re-sends the whole conversation on the first message, which that turn pays " +
  "for — the provider's cache is keyed on a prefix it saw minutes ago, not days.";

export const RESUME_EMPTY = "Nothing has been asked in this folder yet.";
