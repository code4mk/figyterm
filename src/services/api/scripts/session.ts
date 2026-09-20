/**
 * Running every script that applies to one request, in order, threading what
 * each one did into the next.
 *
 * A collection's script sets a variable and the folder's script reads it; that
 * only works if the second sees the first's changes. So the scopes are carried
 * through the chain rather than taken fresh each time, and what comes out at
 * the end is the sum of all of them — which the caller then applies once.
 *
 * Nothing here applies anything. A run can be reported without being committed,
 * which is what lets a collection runner show what a script would do.
 */

import { CollectedScript } from "./events";
import {
  LogLine,
  ScriptInfo,
  ScriptRequest,
  ScriptResponse,
  ScriptScopes,
  TestResult,
  VariableChanges,
} from "./pm";
import { runScript } from "./run";

export interface ScriptSessionResult {
  tests: TestResult[];
  logs: LogLine[];
  /** The sum of every script's changes, innermost last. */
  changes: {
    globals: VariableChanges;
    collection: VariableChanges;
    environment: VariableChanges;
  };
  /** The request as the last pre-request script left it, when one changed it. */
  request?: ScriptRequest;
  /** Scripts that broke, by where they came from. */
  errors: { from: string; message: string }[];
  durationMs: number;
}

/** Applies a set of changes to a scope, so the next script sees them. */
function apply(values: Record<string, string>, changes: VariableChanges): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete values[key];
    else values[key] = value;
  }
}

export async function runScripts(params: {
  scripts: CollectedScript[];
  request: ScriptRequest;
  response?: ScriptResponse;
  scopes: ScriptScopes;
  info: Omit<ScriptInfo, "eventName">;
  kind: "prerequest" | "test";
  newId: () => string;
}): Promise<ScriptSessionResult> {
  const started = Date.now();
  const result: ScriptSessionResult = {
    tests: [],
    logs: [],
    changes: { globals: {}, collection: {}, environment: {} },
    errors: [],
    durationMs: 0,
  };

  // Copies, mutated as the chain runs so each script sees the last one's work.
  const scopes: ScriptScopes = {
    globals: { ...params.scopes.globals },
    collection: { ...params.scopes.collection },
    environment: { ...params.scopes.environment },
    // Not a variable, so it is carried rather than copied-and-mutated: no
    // script renames the environment it is running in.
    environmentName: params.scopes.environmentName,
  };
  let request = params.request;

  for (const script of params.scripts) {
    const { outcome } = await runScript({
      id: params.newId(),
      code: script.code,
      request,
      response: params.response,
      scopes,
      info: { ...params.info, eventName: params.kind },
    });

    result.tests.push(...outcome.tests);
    // Which script a line came from matters when three of them log.
    result.logs.push(
      ...outcome.logs.map((line) => ({ ...line, text: `[${script.from}] ${line.text}` }))
    );
    if (outcome.error) result.errors.push({ from: script.from, message: outcome.error });

    apply(scopes.globals, outcome.changes.globals);
    apply(scopes.collection, outcome.changes.collection);
    apply(scopes.environment, outcome.changes.environment);

    Object.assign(result.changes.globals, outcome.changes.globals);
    Object.assign(result.changes.collection, outcome.changes.collection);
    Object.assign(result.changes.environment, outcome.changes.environment);

    if (outcome.changes.request) {
      request = outcome.changes.request;
      result.request = request;
    }
  }

  result.durationMs = Date.now() - started;
  return result;
}
