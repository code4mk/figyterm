/**
 * The agent, as the window sees it.
 *
 * Everything here is a wrapper over `src-tauri/src/agent/`. The loop, the
 * tools and the ledger are Rust; this file is the four commands that reach
 * them and the shape of the events that come back. There is no turn loop on
 * this side and there must never be one — `docs/CODE-AGENT.md` says it in
 * bold, and the reason is that two implementations of "what happens after a
 * tool call" diverge within a month.
 *
 * The event names are matched as strings. There is a test in
 * `agent/session.rs` that pins them, because a serde default producing
 * `cost_usd` where this expects `costUsd` would leave the status bar reading
 * `undefined` with nothing in either build to say why.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Which conversation a call is about.
 *
 * The window and the editor panel are two sessions in one Tauri window —
 * different preamble, different tool set, different cache — so every call
 * that touches a conversation says which. `agent/ledger.rs` files the
 * rows under it too, which is how we find out whether the panel is paying
 * for itself.
 */
export type Surface = "window" | "panel";

/** What a tool does to the world, which is what a permission prompt is about. */
export type ToolClass = "read" | "write" | "exec" | "net";

export interface ToolInfo {
  name: string;
  description: string;
  class: ToolClass;
  /** The OpenAI-compatible definition, exactly as it goes to the provider. */
  schema: unknown;
}

/**
 * One thing that happened during a turn.
 *
 * A discriminated union on `kind`, mirroring `TurnEvent` in
 * `agent/session.rs`. Adding a variant there without adding it here is a
 * compile error at every `switch`, which is the point of writing it this
 * way rather than as a bag of optional fields.
 */
export type TurnEvent =
  | { kind: "text"; text: string }
  | { kind: "toolStarted"; id: string; name: string }
  | {
      kind: "toolFinished";
      id: string;
      name: string;
      text: string;
      detail: unknown | null;
      /** What this result costs on every remaining turn of the session. */
      tokens: number;
    }
  /**
   * The arguments are in and the tool is about to run.
   *
   * `toolStarted` comes off the stream the moment the model names a
   * tool, before it has said what to do with it — so the row appears
   * with a verb and nothing else, and this is what fills it in.
   */
  | { kind: "toolRunning"; id: string; name: string; target: string; why: string }
  /**
   * A line from a tool that is still running.
   *
   * Only `bash` sends these. None of it reaches the model, which
   * gets the whole output once, at the end — this is for the person
   * watching a two-minute build.
   */
  | { kind: "toolProgress"; id: string; line: string }
  | { kind: "toolFailed"; id: string; name: string; error: string }
  | { kind: "toolRefused"; id: string; name: string; reason: string }
  | { kind: "needsApproval"; id: string; name: string; arguments: Record<string, unknown> }
  /** A question of the model's own, from `ask_user`. */
  | {
      kind: "askingUser";
      id: string;
      question: string;
      options: string[];
      /** A plan's steps, when that is what is being asked about. */
      steps: string[];
    }
  | {
      kind: "turn";
      input: number;
      cached: number;
      output: number;
      costUsd: number;
      hitRate: number;
      /** How full the window is, when its size is configured. */
      contextPercent: number | null;
    }
  | { kind: "compacting" }
  | { kind: "compacted"; messages: number }
  | {
      kind: "retrying";
      attempt: number;
      total: number;
      seconds: number;
      reason: string;
    }
  | { kind: "finished"; reason: string }
  | { kind: "failed"; error: string };

/**
 * One model, where to reach it, and what it costs.
 *
 * A list rather than a single setting, because the single setting was
 * wrong about how this is used: a cheap model for the panel and an
 * expensive one for a refactor, a local endpoint and a hosted one, two
 * providers while deciding between them. Switching meant retyping a
 * base URL and a key, which nobody does twice — they pick one and stop
 * comparing.
 */
export interface ProviderModel {
  /** Stable across edits, minted here. What `active` points at. */
  id: string;
  /** What to call it. Empty means the model name does. */
  label: string;
  /** The part before `/chat/completions`. */
  baseUrl: string;
  model: string;
  /**
   * Only on the call that sets it, and never handed back: a window that
   * can read a key can leak it into a screenshot or a bug report. Leave
   * it out to keep the one already stored.
   */
  apiKey?: string;
  /** Whether one is stored. The key itself never comes back. */
  hasKey?: boolean;
  temperature?: number;
  /** Dollars per million tokens. Data, because a price in a binary is wrong. */
  inputPrice?: number;
  cachedPrice?: number;
  outputPrice?: number;
  /** Its context window in tokens. Nothing on the wire reports it. */
  contextWindow?: number;
}

export interface AgentSettings {
  /** Every model set up, in the order they are shown. */
  models: ProviderModel[];
  /**
   * Whether typesafe.ai's Jev narrows the tool list before the model
   * sees it. Off unless this is on *and* there is a key.
   *
   * It trades: fewer tool definitions in the prefix against a round
   * trip per message and a prefix rewrite whenever the set grows. At
   * our size the default is off, and `agent/picker.rs` has the
   * arithmetic.
   */
  router?: boolean;
  routerKey?: string;
  routerModel?: string;
  /** Dollars per million input tokens, as data rather than a guess. */
  routerPrice?: number;
  /** Which one is used, by id. */
  active?: string | null;
  /** What one conversation may spend before it stops and says so. */
  budgetUsd?: number;
  /**
   * Exa, for `search_web` and `fetch_url`. Without it the agent has no web
   * tools at all — which is a configuration rather than a failure, and the
   * tools say so if the model reaches for them.
   */
  exaKey?: string;
}

export interface Totals {
  turns: number;
  input: number;
  cached: number;
  output: number;
  costUsd: number;
  /** Spent by the tools rather than the model — Exa, so far. */
  toolCostUsd: number;
  /** 0–100. Below ~70 over a long session is a bug, not a tuning opportunity. */
  hitRate: number;
  largestToolResult: number;
}

/** Every tool the model will be offered, in prefix order. */
export function agentTools(): Promise<ToolInfo[]> {
  return invoke<ToolInfo[]>("agent_tools");
}

/**
 * What the agent is actually set up with.
 *
 * One question with one owner. The window used to assemble this from "is
 * there a key" plus its own copy of the settings, and a window that has to
 * guess at the backend's state eventually guesses wrong — in this case by
 * refusing to send a message the agent would have accepted.
 */
export interface AgentStatus {
  /** Whether the chosen model has a key, which is the whole of "can I send". */
  hasKey: boolean;
  /** Whether the web tools will work. The key itself never comes back. */
  hasExaKey: boolean;
  /** Whether the tool router is on, and whether it could be. */
  router: boolean;
  hasRouterKey: boolean;
  routerModel?: string | null;
  routerPrice?: number | null;
  /** The model a turn would use, by id. */
  active: string | null;
  /** Its name, for the footer. Empty when nothing is set up. */
  model: string;
  /** Every model, with the keys replaced by whether there is one. */
  models: ProviderModel[];
  budgetUsd?: number;
  /** Where they are written — stated when saving, because it is plaintext. */
  path: string;
}

/** Saves the settings, stores the key, and answers with what stuck. */
export function agentConfigure(settings: AgentSettings): Promise<AgentStatus> {
  return invoke<AgentStatus>("agent_configure", { settings });
}

export function agentStatus(): Promise<AgentStatus> {
  return invoke<AgentStatus>("agent_status");
}

/**
 * One user message, carried to the end of whatever it sets off.
 *
 * Resolves when the turn is over. Everything worth showing has already
 * arrived as events by then — this resolving is the signal that the
 * composer can be re-enabled, not where the answer is.
 */
export function agentSend(
  prompt: string,
  mode: string,
  system: string,
  surface: Surface
): Promise<void> {
  return invoke("agent_send", { request: { prompt, mode, system, surface } });
}

/**
 * Answers an `ask_user` card.
 *
 * One string, which is the option as it was picked. The tool puts it in
 * the conversation verbatim, so this is what the model reads as the
 * person's own words.
 */
export function agentAnswer(
  id: string,
  answer: string,
  surface: Surface,
  /** An approved plan lifts plan mode, in the turn that proposed it. */
  mode?: string
): Promise<void> {
  return invoke("agent_answer", { id, answer, surface, mode: mode ?? null });
}

/**
 * Answers a permission question. `remember` is per command, never per class.
 *
 * `mode` is how "allow all edits this session" keeps its promise: it
 * changes the mode of the turn that is running, rather than the one after
 * it. Granting it and then being asked again two tool calls later reads
 * as the button not having worked.
 */
export function agentApprove(
  id: string,
  allow: boolean,
  surface: Surface,
  remember?: string,
  mode?: string
): Promise<void> {
  return invoke("agent_approve", {
    id,
    allow,
    surface,
    remember: remember ?? null,
    mode: mode ?? null,
  });
}

export function agentCancel(surface: Surface): Promise<void> {
  return invoke("agent_cancel", { surface });
}

/** Forgets the conversation. The folder, the key and the model stay. */
export function agentClear(surface: Surface): Promise<void> {
  return invoke("agent_clear", { surface });
}

export interface ToolResult {
  text: string;
  detail: unknown | null;
  approxTokens: number;
}

/**
 * Runs one tool directly, with no model and no permission prompt.
 *
 * For `!` in the composer: the user typed the command, so there is nobody
 * to ask. It does **not** enter the conversation — the loop owns the
 * history, and a window that could append to it would be a second writer
 * of the one thing that must stay append-only.
 */
export function agentCallTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return invoke<ToolResult>("agent_call_tool", { name, args });
}

export function agentUsage(surface: Surface): Promise<Totals> {
  return invoke<Totals>("agent_usage", { surface });
}

/* ─── The project's own instructions ──────────────────────────────────────── */

/**
 * `FIGY.md`, as the window reports it.
 *
 * The token count is the point of showing this at all: the rules sit in
 * the cached prefix of every request for the whole session, and a window
 * that hides the cost is a window that invites a thousand-line file.
 */
export interface ProjectRules {
  name: string;
  path: string;
  tokens: number;
  /** Past the cap, and the prompt says so to the model as well. */
  truncated: boolean;
}

/**
 * What the *next* conversation in this folder will be given.
 *
 * A running session keeps the copy it started with: the prefix is frozen,
 * so an edit to `FIGY.md` applies after `/clear` rather than immediately.
 */
export function agentRules(): Promise<ProjectRules | null> {
  return invoke<ProjectRules | null>("agent_rules");
}

/* ─── Where the window is going ───────────────────────────────────────────── */

/**
 * What the next request will carry, and what it is made of.
 *
 * Two kinds of number in here, and the difference is the point.
 * `measured` is the provider's own count for the last turn and is
 * exact. Everything else is characters over four. They do not add up,
 * and the dialog says so rather than scaling the parts until they do:
 * the parts answer *what* is filling the window, the total answers how
 * full it is.
 */
export interface ContextBreakdown {
  model: string;
  /** The window, when it is configured. Nothing on the wire reports it. */
  window: number | null;
  measured: number;
  system: number;
  tools: number;
  user: number;
  assistant: number;
  toolResults: number;
  messages: number;
  turns: number;
  /** Tools on the table, and how many this surface has. */
  toolsOffered: number;
  toolsTotal: number;
  /**
   * What the tool picker did on the last message, when there is one.
   *
   * The only place a silent fallback can be seen. During a turn a
   * router that cannot be reached quietly offers everything, which is
   * right and makes "narrowed" and "not running" look identical.
   */
  picker: string | null;
  /** The five largest tool results — where a window usually goes. */
  heaviest: { name: string; tokens: number }[];
}

/** What one real call to the tool picker did. */
export interface RouterCheck {
  ok: boolean;
  /** What it chose. Empty when it could not be reached. */
  picked: string[];
  total: number;
  costUsd: number;
  error: string | null;
}

/**
 * Makes one real request to the tool picker and says what happened.
 *
 * A router that falls back silently is right during a turn and
 * useless when the question is whether it works at all — switched
 * off, bad key, and changed endpoint all look identical from the
 * outside. This is the call made on purpose, with the failure kept.
 */
export function agentTestRouter(surface: Surface): Promise<RouterCheck> {
  return invoke<RouterCheck>("agent_test_router", { surface });
}

/** `null` when this folder has no conversation yet. */
export function agentContext(surface: Surface): Promise<ContextBreakdown | null> {
  return invoke<ContextBreakdown | null>("agent_context", { surface });
}

/* ─── Conversations, between runs ─────────────────────────────────────────── */

/** One line in the resume list. */
export interface Conversation {
  sessionId: string;
  /** The first thing that was asked, as one line. */
  title: string;
  model: string;
  /** User messages — what "turns" means to a reader. */
  turns: number;
  /** Everything in the history, which is what it costs to send again. */
  messages: number;
  spentUsd: number;
  /** Milliseconds since the epoch, formatted here rather than in Rust. */
  updatedAt: number;
}

/** A call, as a resumed transcript shows it. */
export interface PastCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PastMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  calls: PastCall[];
  /** Tool results only: the id of the call this answers. */
  answers: string | null;
}

export interface Resumed {
  sessionId: string;
  title: string;
  model: string;
  spentUsd: number;
  messages: PastMessage[];
}

/** What was being worked on in this folder before, newest first. */
export function agentConversations(surface: Surface): Promise<Conversation[]> {
  return invoke<Conversation[]>("agent_conversations", { surface });
}

/**
 * Picks a past conversation back up.
 *
 * **Not free.** The provider's cache is keyed on a prefix it saw minutes
 * ago, not days, so the first message after this pays for the whole
 * conversation again — which is why it is a thing you choose rather than
 * something that happens on launch.
 */
export function agentResume(surface: Surface, sessionId: string): Promise<Resumed> {
  return invoke<Resumed>("agent_resume", { surface, sessionId });
}

/** Removes a stored conversation. What is on screen stays on screen. */
export function agentForgetConversation(sessionId: string): Promise<void> {
  return invoke("agent_forget_conversation", { sessionId });
}

/**
 * Subscribes to the turn.
 *
 * Returns the unlisten function, so it can be handed straight back from a
 * `useEffect`. One subscription per window: the backend emits to the window
 * that asked, and a second listener would double every line of the answer.
 */
export function onAgentEvent(handler: (event: TurnEvent) => void): Promise<UnlistenFn> {
  return listen<TurnEvent>("agent://event", (event) => handler(event.payload));
}
