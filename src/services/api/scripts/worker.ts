/**
 * The sandbox: a worker with its dangerous globals taken away.
 *
 * **The decision, since the plan asked for it in writing.** Two ways to run a
 * collection's scripts: an embedded JavaScript engine in Rust, or a locked-down
 * worker in the webview. This is the worker, for four reasons:
 *
 * 1. **A worker can be stopped.** `terminate()` kills an infinite loop dead,
 *    from outside, with no cooperation from the script. An embedded engine
 *    needs an interrupt callback threaded through it to do the same job less
 *    certainly.
 * 2. **It costs no dependency.** The engine options are a C library (a
 *    compiler on three platforms, which this project has already declined once
 *    over a crypto crate) or a large pure-Rust one. A worker is already there.
 * 3. **A worker has no ambient authority to remove.** It has no DOM, no
 *    `window`, and no Tauri bridge — that lives on the page. What is left is
 *    `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB` and a
 *    handful of others, and those are a list that can be written down and
 *    removed, which is what happens below before any script runs.
 * 4. **The API is the message.** What crosses is a request, a response and some
 *    variables — all data. The interesting part, `pm.ts`, is then a pure module
 *    that the tests exercise directly, without a browser.
 *
 * **What this sandbox is not.** It isolates mistakes and casual mischief: an
 * endless loop, a script that tries to phone home, a script that would
 * otherwise scribble on the app's storage. It is not a defence against an
 * attacker with an exploit for the JavaScript engine itself — no client in this
 * class offers that, and claiming it would be worse than saying so. Scripts
 * arrive inside collections people import; treat one the way you would treat a
 * script somebody emailed you.
 */

import { createPm, ScriptOutcome } from "./pm";
import { ScriptJob, ScriptReply } from "./protocol";

/**
 * Everything a script must not be able to reach.
 *
 * The network ones are the point; `importScripts` is there because it is
 * network access wearing a hat; storage is there because the app's own data
 * lives in it; and `postMessage` is there so a script cannot forge a result
 * before the real one is sent.
 */
const FORBIDDEN = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "MessageChannel",
  "postMessage",
  "navigator",
  "Notification",
  "createImageBitmap",
  "close",
];

/**
 * Takes the globals away, at every level they are defined.
 *
 * `delete self.fetch` is not enough: in a worker most of these live on
 * `WorkerGlobalScope.prototype`, and deleting the own-property leaves the
 * inherited one in place. Each name is overwritten with `undefined` and made
 * non-configurable all the way up the chain, so it cannot be put back either.
 */
function lockDown(): void {
  let target: object | null = globalThis;
  const seen = new Set<object>();

  while (target && !seen.has(target)) {
    seen.add(target);
    for (const name of FORBIDDEN) {
      if (!Object.getOwnPropertyDescriptor(target, name)) continue;
      try {
        Object.defineProperty(target, name, {
          value: undefined,
          writable: false,
          configurable: false,
          enumerable: false,
        });
      } catch {
        // A property that refuses to be redefined is left alone rather than
        // failing the whole lock-down; the ones that matter are configurable.
      }
    }
    target = Object.getPrototypeOf(target);
  }
}

// Captured before the lock-down removes the global, so the result can still be
// sent while a script cannot send anything.
const post = self.postMessage.bind(self);

lockDown();

self.onmessage = (event: MessageEvent<ScriptJob>) => {
  const job = event.data;
  const started = Date.now();

  const { pm, console: shim, finish } = createPm({
    request: job.request,
    response: job.response,
    scopes: job.scopes,
    info: job.info,
  });

  let outcome: ScriptOutcome;
  try {
    // The script is a function body with `pm` and `console` as its arguments
    // and nothing else in scope that it did not bring — the globals it might
    // otherwise have reached for are gone.
    const run = new Function("pm", "console", job.code);
    run(pm, shim);
    outcome = finish();
  } catch (error) {
    outcome = finish(error);
  }

  const reply: ScriptReply = {
    id: job.id,
    outcome,
    durationMs: Date.now() - started,
  };
  post(reply);
};
