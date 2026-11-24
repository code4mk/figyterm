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
  | { kind: "toolFailed"; id: string; name: string; error: string }
  | { kind: "toolRefused"; id: string; name: string; reason: string }
  | { kind: "needsApproval"; id: string; name: string; arguments: Record<string, unknown> }
  | {
      kind: "turn";
      input: number;
      cached: number;
      output: number;
      costUsd: number;
      hitRate: number;
    }
  | { kind: "finished"; reason: string }
  | { kind: "failed"; error: string };

export interface AgentSettings {
  /** The part before `/chat/completions`. */
  baseUrl: string;
  model: string;
  /**
   * Only on the call that sets it, and never handed back: a window that
   * can read the key is a window that can leak it into a screenshot or a
   * bug report. Leave it empty to keep the one already stored.
   */
  apiKey?: string;
  temperature?: number;
  /** Dollars per million tokens. Data, because a price in a binary is wrong. */
  inputPrice?: number;
  cachedPrice?: number;
  outputPrice?: number;
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
  hasKey: boolean;
  /** Whether the web tools will work. The key itself never comes back. */
  hasExaKey: boolean;
  /** The settings as stored, with the key removed. */
  settings: AgentSettings;
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

/** Answers a permission question. `remember` is per command, never per class. */
export function agentApprove(id: string, allow: boolean, remember?: string): Promise<void> {
  return invoke("agent_approve", { id, allow, remember: remember ?? null });
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
