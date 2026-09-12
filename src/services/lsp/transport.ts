/**
 * The wire between the webview and `commands/lsp.rs`.
 *
 * One listener for every server rather than one per client. Tauri delivers each
 * event to every registered listener, so a per-client listener would have three
 * servers each parsing the other two's traffic — and document sync means that
 * traffic is every keystroke. Here the JSON is parsed once and dispatched by id.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { IncomingMessage } from "./protocol";

/** Mirrors `ServerInfo` in `lsp/server.rs`. */
export interface LspServerInfo {
  id: string;
  language: string;
  program: string;
  resolved: string | null;
  root: string;
  pid: number | null;
  startedAt: number;
  alive: boolean;
  stderr: string[];
}

/** Mirrors `ExitInfo`. */
export interface LspExitInfo {
  id: string;
  code: number | null;
  /** False means it died on its own, which is what triggers a restart. */
  expected: boolean;
  stderr: string[];
}

interface Handler {
  message: (message: IncomingMessage) => void;
  exit: (info: LspExitInfo) => void;
}

const handlers = new Map<string, Handler>();

/** Started once, on the first registration, and never torn down. */
let listening: Promise<UnlistenFn[]> | null = null;

function ensureListening(): Promise<UnlistenFn[]> {
  if (listening) return listening;

  listening = Promise.all([
    listen<{ id: string; body: string }>("lsp://message", (event) => {
      const handler = handlers.get(event.payload.id);
      if (!handler) return;
      let message: IncomingMessage;
      try {
        message = JSON.parse(event.payload.body) as IncomingMessage;
      } catch {
        // A server that emits something that isn't JSON has a bug, and there is
        // nothing useful to do with it beyond not throwing inside an event
        // handler — which would take the listener down with it.
        console.warn("lsp: unparseable message from", event.payload.id);
        return;
      }
      try {
        handler.message(message);
      } catch (error) {
        console.error("lsp: handler threw", error);
      }
    }),
    listen<LspExitInfo>("lsp://exit", (event) => {
      handlers.get(event.payload.id)?.exit(event.payload);
    }),
  ]);

  return listening;
}

export async function register(id: string, handler: Handler): Promise<void> {
  handlers.set(id, handler);
  await ensureListening();
}

export function unregister(id: string): void {
  handlers.delete(id);
}

export function startServer(options: {
  id: string;
  language: string;
  program: string;
  args: string[];
  root: string;
}): Promise<LspServerInfo> {
  return invoke<LspServerInfo>("lsp_start", options);
}

/** Fire and forget: replies arrive as events, not as this promise's value. */
export function sendMessage(id: string, message: unknown): Promise<void> {
  return invoke<void>("lsp_send", { id, message: JSON.stringify(message) });
}

export function stopServer(id: string): Promise<void> {
  return invoke<void>("lsp_stop", { id });
}

export function serverStatus(): Promise<LspServerInfo[]> {
  return invoke<LspServerInfo[]>("lsp_status");
}
