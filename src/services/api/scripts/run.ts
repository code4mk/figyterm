/**
 * Running one script, and stopping it if it will not stop itself.
 *
 * A worker per script rather than one kept warm: two requests' scripts must not
 * be able to see each other's globals, and the cheapest way to guarantee that
 * is a fresh global for each. A worker costs about a millisecond to start,
 * which against a request that takes tens is nothing.
 *
 * The timeout is the reason this shape was chosen at all — see the argument in
 * `worker.ts`. `terminate()` stops an endless loop from outside, without the
 * script's cooperation, which no in-process interpreter can promise as simply.
 */

import { ScriptOutcome } from "./pm";
import { ScriptJob, ScriptReply, SCRIPT_TIMEOUT_MS } from "./protocol";

/** An outcome for a script that never got to run, or never stopped. */
function failed(error: string): ScriptOutcome {
  return {
    tests: [],
    logs: [],
    changes: { globals: {}, collection: {}, environment: {} },
    error,
  };
}

export interface ScriptRun {
  outcome: ScriptOutcome;
  durationMs: number;
}

/**
 * Runs a script in a sandbox and returns what it did.
 *
 * Never rejects: a script that breaks, times out, or cannot be started at all
 * comes back as an outcome with an error on it, because every caller wants to
 * carry on and report rather than to unwind.
 */
export function runScript(
  job: ScriptJob,
  timeoutMs = SCRIPT_TIMEOUT_MS
): Promise<ScriptRun> {
  return new Promise((resolve) => {
    let worker: Worker;
    const started = Date.now();

    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      resolve({
        outcome: failed(`The script sandbox would not start: ${error}`),
        durationMs: 0,
      });
      return;
    }

    let settled = false;
    const finish = (run: ScriptRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(run);
    };

    const timer = setTimeout(() => {
      finish({
        outcome: failed(
          `The script was still running after ${timeoutMs} ms and was stopped.`
        ),
        durationMs: Date.now() - started,
      });
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent<ScriptReply>) => {
      const reply = event.data;
      // A reply for another job cannot happen with one worker per job, but a
      // reply with no outcome would mean something other than our own code
      // sent it.
      if (reply?.id !== job.id || !reply.outcome) return;
      finish({ outcome: reply.outcome, durationMs: reply.durationMs });
    };

    worker.onerror = (event) => {
      finish({
        outcome: failed(event.message || "The script sandbox failed"),
        durationMs: Date.now() - started,
      });
    };

    worker.postMessage(job);
  });
}
