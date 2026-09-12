/**
 * One listener for every Claude conversation's output, dispatching by session id.
 *
 * The obvious shape — each conversation subscribing to `terminal-output` and
 * filtering for its own id — costs N listeners each examining N streams, on the
 * UI thread, for every chunk of output. With a handful of conversations alive
 * that is a hundred comparisons per chunk, and nothing caps how many there may
 * be. So there is one subscription per event, a `Map` from session id to
 * handler, and no filtering at all.
 *
 * A shell pane keeps its own listener in `Terminal.tsx`. That is not a
 * duplicate to clean up: a pane owns exactly one session for its whole life,
 * where this exists because a single component owns many.
 */

import { listen, UnlistenFn } from "@tauri-apps/api/event";

interface OutputPayload {
  session_id: string;
  data: number[];
}

interface ExitPayload {
  session_id: string;
}

export interface SessionHandlers {
  onOutput: (data: Uint8Array) => void;
  /** The child ended on its own. Not called for a session we closed. */
  onExit: () => void;
}

const handlers = new Map<string, SessionHandlers>();

/**
 * Started on the first subscription and never torn down.
 *
 * Keeping it open costs one listener for the life of the app and removes a
 * whole class of race: a conversation that starts while the previous one is
 * being cleaned up would otherwise be able to miss the first bytes of its own
 * output, which for a program that draws a TUI on startup means a window
 * painted half-way.
 */
let started: Promise<UnlistenFn[]> | null = null;

function ensureStarted(): void {
  if (started) return;
  started = Promise.all([
    listen<OutputPayload>("terminal-output", (event) => {
      const handler = handlers.get(event.payload.session_id);
      if (handler) handler.onOutput(new Uint8Array(event.payload.data));
    }),
    listen<ExitPayload>("terminal-exit", (event) => {
      const handler = handlers.get(event.payload.session_id);
      if (handler) handler.onExit();
    }),
  ]);
}

/** Returns the unsubscribe function. */
export function subscribeSession(sessionId: string, handler: SessionHandlers): () => void {
  ensureStarted();
  handlers.set(sessionId, handler);
  return () => {
    // Only if it is still ours: a resumed conversation re-registers under the
    // same id, and a late cleanup from the previous process must not remove
    // the new one's handler.
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
  };
}
