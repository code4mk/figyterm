/**
 * Answering the agent's questions about code, with the language server the
 * app is already running.
 *
 * `src-tauri/src/agent/code.rs` explains why the request comes *here*
 * rather than being asked in Rust: a second client would start a second
 * `rust-analyzer`, which is gigabytes and half a minute of indexing on
 * exactly the projects where these tools are worth having — while an
 * identical server sits warm in this process with the documents open.
 *
 * `lsp` is a module-level singleton for the same reason, stated in its own
 * file: "two editor modals would otherwise each start one". This hangs off
 * that one, and starts nothing the editor would not have started itself.
 *
 * ## The two conversions that live here
 *
 * **Positions.** The model reads line numbers out of `read` and `grep`,
 * which number from one as every editor does. LSP numbers from zero. The
 * conversion happens at this edge, once, in both directions.
 *
 * **Text.** The request carries the file's contents, because the agent may
 * be working in a folder the editor has never opened — and the editor's
 * filesystem commands are fenced by the editor's own roots.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { lsp } from "./lsp/manager";
import type { LspSession } from "./lsp/manager";

/** What the agent asked. Mirrors `Ask` in `agent/code.rs`. */
interface LspAsk {
  id: string;
  op: "definition" | "references" | "diagnostics";
  path: string;
  text: string;
  /** 1-based, as the model was shown. */
  line: number;
  column: number;
}

/** How long to wait for a server that is still starting up. */
const READY_TIMEOUT_MS = 20_000;

/** How long to give a server to publish diagnostics for a file it just saw. */
const DIAGNOSTICS_SETTLE_MS = 1_200;

function reply(id: string, result: unknown, error?: string): void {
  void invoke("agent_lsp_reply", {
    id,
    result: error ? null : (result ?? null),
    error: error ?? null,
  }).catch(() => {
    /* The turn was cancelled; there is nobody left to tell. */
  });
}

/**
 * Opens the file against its server and waits for the server to be ready.
 *
 * `lsp.open` is the editor's own path, so the document is registered the
 * way an opened buffer would be — which is what the server needs before it
 * will answer about it. The session is closed again afterwards: leaving it
 * open would make the agent look like a buffer nobody can see, and keep a
 * server alive past its idle timeout.
 */
async function withSession<T>(
  ask: LspAsk,
  work: (session: LspSession) => Promise<T>
): Promise<T> {
  const sessions = lsp.open(ask.path, () => ask.text);
  if (sessions.length === 0) {
    throw new Error(
      "no language server for that file here — check the editor's language-server " +
        "setting, or use grep"
    );
  }
  // The first is the primary; the others are companions like Tailwind,
  // which have nothing to say about a definition.
  const session = sessions[0];

  try {
    await waitUntilReady(session);
    return await work(session);
  } finally {
    for (const open of sessions) open.close();
  }
}

function waitUntilReady(session: LspSession): Promise<void> {
  if (session.client) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      session.onBind(() => {});
      reject(new Error("the language server is still starting — try again, or use grep"));
    }, READY_TIMEOUT_MS);

    session.onBind((client) => {
      if (!client) return;
      window.clearTimeout(timer);
      resolve();
    });
  });
}

/** 1-based from the model, 0-based for the protocol. */
function position(ask: LspAsk) {
  return { line: Math.max(0, ask.line - 1), character: Math.max(0, ask.column - 1) };
}

async function answer(ask: LspAsk): Promise<unknown> {
  switch (ask.op) {
    case "definition":
      return withSession(ask, (session) =>
        session.client!.definition(session.uri, position(ask))
      );

    case "references":
      return withSession(ask, (session) =>
        session.client!.references(session.uri, position(ask))
      );

    /*
      Diagnostics are pushed, not asked for.

      The server publishes them after it has looked at the document, which
      is some time after `didOpen` — so this opens the file, waits for the
      first publication, and falls back to whatever is already known for
      that URI. Returning an empty list a hundred milliseconds too early
      would tell the model its edit compiled.
    */
    case "diagnostics":
      return withSession(ask, async (session) => {
        const existing = lsp.diagnosticsFor(session.uri);
        if (existing.length) return existing;

        const published = await new Promise<unknown[] | null>((resolve) => {
          const timer = window.setTimeout(() => {
            off();
            resolve(null);
          }, DIAGNOSTICS_SETTLE_MS);
          const off = lsp.onDiagnostics(session.uri, (items) => {
            window.clearTimeout(timer);
            off();
            resolve(items);
          });
        });
        return published ?? lsp.diagnosticsFor(session.uri);
      });
  }
}

/**
 * Starts answering. Returns the unlisten function.
 *
 * Mounted once by the app shell rather than by the Figy Code window: the
 * agent can be asked a question while its window is minimised, and a
 * listener that came and went with the window would drop the reply and
 * leave the turn waiting out its timeout.
 */
export function serveAgentLsp(): Promise<UnlistenFn> {
  return listen<LspAsk>("agent://lsp-request", (event) => {
    const ask = event.payload;
    answer(ask)
      .then((result) => reply(ask.id, result))
      .catch((error: unknown) =>
        reply(ask.id, null, error instanceof Error ? error.message : String(error))
      );
  });
}
