/**
 * What crosses into the sandbox and what comes back.
 *
 * All data: a request, a response, some variables, and the script's own source.
 * Nothing in here is a function or a handle, which is what lets the sandbox be
 * a worker with no way to reach anything it was not given.
 */

import { ScriptInfo, ScriptOutcome, ScriptRequest, ScriptResponse, ScriptScopes } from "./pm";

export interface ScriptJob {
  id: string;
  code: string;
  request: ScriptRequest;
  /** Present for a test script, absent for a pre-request one. */
  response?: ScriptResponse;
  scopes: ScriptScopes;
  info: ScriptInfo;
}

export interface ScriptReply {
  id: string;
  outcome: ScriptOutcome;
  durationMs: number;
}

/** How long a script may run before it is stopped.
 *
 * Generous, because a slow script is usually doing something, and stopped
 * outright rather than warned about, because the alternative to a hard limit is
 * a window that has to be killed. */
export const SCRIPT_TIMEOUT_MS = 5_000;
