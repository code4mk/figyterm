/**
 * One request, from a draft to a response: scripts, variables, auth, the wire,
 * then the tests.
 *
 * Extracted so the window and the collection runner go through the *same* path.
 * Two implementations of this would drift within a week — the runner would
 * resolve variables slightly differently, or forget the pre-request script, and
 * the difference would show up as "it works when I press Send".
 *
 * It takes a context rather than reading a store, so it can be called for a tab
 * or for the fiftieth request of a run without either knowing about the other.
 * Nothing here is applied: the variable changes come back for the caller to
 * write, which is what lets a run report what it did.
 */

import {
  ApiCollection,
  ApiEnvironment,
  ApiError,
  ApiItem,
  ApiResponse,
  ApiVariable,
  DEFAULT_SEND_OPTIONS,
  RequestDraft,
  SendInput,
} from "../../types/api";
import { applyAuth, effectiveAuth } from "./auth";
import { sendRequest, toApiError } from "./client";
import { buildSendInput } from "./request";
import { authChain, buildScopes } from "./scopes";
import { resolveBody, resolveRequest, resolveText, Scope } from "./template";
import { normalizeUrl } from "./url";
import { collectScripts } from "./scripts/events";
import { LogLine, ScriptRequest, ScriptScopes, TestResult, VariableChanges } from "./scripts/pm";
import { runScripts } from "./scripts/session";

/** What the scripts around one send did. */
export interface ScriptRun {
  tests: TestResult[];
  logs: LogLine[];
  errors: { from: string; message: string }[];
  durationMs: number;
}

export interface ExecuteContext {
  /** The stored row, when the request is one. Null for a scratch tab. */
  item: ApiItem | null;
  items: ApiItem[];
  collections: ApiCollection[];
  environments: ApiEnvironment[];
  activeEnvironmentId: string | null;
  draft: RequestDraft;
  name: string;
  /** A data file's row, for a run going round more than once. */
  data?: Record<string, string>;
  iteration?: number;
  iterationCount?: number;
  /** Send even with variables that resolved to nothing. */
  force?: boolean;
  verifyTls?: boolean;
  /** Called when the scripts are done and the request is about to go out, so a
   * window can show that something is happening. */
  onSending?: (input: SendInput) => void;
}

export interface ExecuteResult {
  input: SendInput | null;
  response: ApiResponse | null;
  error: ApiError | null;
  /** Names with no value anywhere. Non-empty means nothing was sent. */
  unresolved: string[];
  scripts: ScriptRun | null;
  changes: {
    globals: VariableChanges;
    collection: VariableChanges;
    environment: VariableChanges;
  };
}

const NO_CHANGES = () => ({ globals: {}, collection: {}, environment: {} });

/** Resolves the variables inside an auth block's parameters. */
function resolveParams(
  params: Record<string, string>,
  scopes: Scope[]
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    resolved[key] = resolveText(value, scopes).text;
  }
  return resolved;
}

/** The variables the three scopes a script sees hold, in the format's terms. */
export function scriptScopes(context: ExecuteContext): ScriptScopes {
  /*
    The **current** value wins, exactly as `resolving` in `scopes.ts` has it.

    This used to read `variable.value` — the initial one — and that made a
    script's own writes invisible to it. The round trip is what gives it away:
    `applyScriptChanges` stores what a script sets as the *current* value,
    deliberately, so a token fetched at runtime is never exported with the
    collection. Reading back the initial value meant `pm.environment.set` wrote
    to one field and `pm.environment.get` read another, so the variable looked
    frozen at whatever was last typed into the initial column — and anything the
    user themselves had put in the current column was invisible to scripts too,
    while `{{the_same_name}}` in the URL resolved to it perfectly.
  */
  const asRecord = (variables: ApiVariable[]) =>
    Object.fromEntries(
      variables
        .filter((variable) => variable.enabled)
        .map((variable) => [variable.key, variable.currentValue ?? variable.value])
    );

  const globals = context.environments.find((environment) => environment.isGlobal);
  const active = context.environments.find(
    (environment) => environment.id === context.activeEnvironmentId && !environment.isGlobal
  );
  const collection = context.item
    ? context.collections.find((candidate) => candidate.id === context.item!.collectionId)
    : undefined;

  return {
    globals: globals ? asRecord(globals.variables) : {},
    // A collection's variables are stored as the format's list; the scope
    // chain module reads that shape, so this borrows its reader through the
    // caller rather than parsing it twice.
    collection: collection ? collectionRecord(collection) : {},
    // A data row rides with the environment for the duration of a run: it is
    // read-only, and the format has no separate scope a script can write to.
    environment: { ...(active ? asRecord(active.variables) : {}), ...(context.data ?? {}) },
    // Left undefined when nothing is selected, which is what Postman reports
    // and what a script guarding with `pm.environment.name || ""` expects.
    environmentName: active?.name,
  };
}

/**
 * The scopes as a run has left them, for the script that runs next.
 *
 * A pre-request script sets a token and the test script reads it back — in the
 * same send, before anything has been written to disk. Handing the test phase a
 * freshly built scope meant it saw the environment as it was *before* the
 * request went out, so a variable the pre-request script had just set came back
 * undefined and the test that checked it failed for no visible reason.
 *
 * `null` is an unset, which is why this deletes rather than storing the word.
 */
export function withScriptChanges(
  scopes: ScriptScopes,
  changes: { globals: VariableChanges; collection: VariableChanges; environment: VariableChanges }
): ScriptScopes {
  const merge = (values: Record<string, string>, updates: VariableChanges) => {
    const next = { ...values };
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return next;
  };

  return {
    globals: merge(scopes.globals, changes.globals),
    collection: merge(scopes.collection, changes.collection),
    environment: merge(scopes.environment, changes.environment),
    environmentName: scopes.environmentName,
  };
}

function collectionRecord(collection: ApiCollection): Record<string, string> {
  const list = Array.isArray(collection.variables) ? collection.variables : [];
  const record: Record<string, string> = {};
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const variable = entry as Record<string, unknown>;
    if (typeof variable.key === "string" && variable.disabled !== true) {
      record[variable.key] = variable.value === undefined ? "" : String(variable.value);
    }
  }
  return record;
}

/** The chain, with a data row as the innermost scope when there is one. */
function scopesFor(context: ExecuteContext): Scope[] {
  const chain = buildScopes({
    item: context.item,
    items: context.items,
    collections: context.collections,
    environments: context.environments,
    activeEnvironmentId: context.activeEnvironmentId,
  });

  if (!context.data || Object.keys(context.data).length === 0) return chain;
  return [
    {
      label: "Data file",
      variables: Object.entries(context.data).map(([key, value]) => ({
        key,
        value,
        enabled: true,
      })),
    },
    ...chain,
  ];
}

export async function executeRequest(context: ExecuteContext): Promise<ExecuteResult> {
  const info = {
    requestName: context.name,
    iteration: context.iteration ?? 0,
    iterationCount: context.iterationCount ?? 1,
  };

  let sending: ScriptRequest = {
    method: context.draft.method,
    url: context.draft.url,
    headers: context.draft.headers
      .filter((header) => header.enabled && header.name.trim() !== "")
      .map((header) => ({ name: header.name.trim(), value: header.value })),
    body: context.draft.body.mode === "raw" ? context.draft.body.text : "",
  };

  const changes = NO_CHANGES();
  let scripts: ScriptRun | null = null;

  const record = (outcome: {
    tests: TestResult[];
    logs: LogLine[];
    errors: { from: string; message: string }[];
    durationMs: number;
  }) => {
    scripts = {
      tests: [...(scripts?.tests ?? []), ...outcome.tests],
      logs: [...(scripts?.logs ?? []), ...outcome.logs],
      errors: [...(scripts?.errors ?? []), ...outcome.errors],
      durationMs: (scripts?.durationMs ?? 0) + outcome.durationMs,
    };
  };

  // ─── Before the wire ──────────────────────────────────────────────────────
  //
  // A pre-request script's edits apply to *this* send: it is doing it for the
  // call about to be made, not editing the request somebody saved.
  const before = collectScripts({
    item: context.item,
    items: context.items,
    collections: context.collections,
    kind: "prerequest",
  });

  if (before.length > 0) {
    const outcome = await runScripts({
      scripts: before,
      request: sending,
      scopes: scriptScopes(context),
      info,
      kind: "prerequest",
      newId: () => crypto.randomUUID(),
    });
    record(outcome);
    if (outcome.request) sending = outcome.request;
    Object.assign(changes.globals, outcome.changes.globals);
    Object.assign(changes.collection, outcome.changes.collection);
    Object.assign(changes.environment, outcome.changes.environment);
  }

  // A variable a pre-request script just set has to be resolvable by the
  // request that follows, so its changes join the chain before resolution.
  const scopes = scopesFor(context);
  if (Object.keys(changes.environment).length > 0) {
    scopes.unshift({
      label: "Script",
      variables: Object.entries(changes.environment)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => ({ key, value: value as string, enabled: true })),
    });
  }

  /*
    Resolved first, normalised second — and the order is the whole point.

    `normalizeUrl` puts `https://` in front of anything that does not already
    carry a scheme. A URL bar holding `{{base_url}}/oauth/token` does not: it
    starts with a brace. So normalising first produced
    `https://{{base_url}}/oauth/token`, and resolution then filled in a
    `base_url` that was itself `https://host` — sending
    `https://https://host/oauth/token`, which the server never saw because
    there is no host called "https".

    Nothing can know whether a templated URL has a scheme until the templates
    are gone, so the guess has to come after them.
  */
  const resolved = resolveRequest(
    {
      url: sending.url,
      headers: sending.headers.map((header) => ({ ...header, enabled: true })),
      // The body is resolved below, as a whole. Passing the raw text here as
      // well would resolve it twice, and a `{{$guid}}` resolved twice is two
      // different values — one of which would be reported as what was sent.
      body: "",
    },
    scopes
  );
  const resolvedUrl = normalizeUrl(resolved.url);

  /*
    The body, every mode of it.

    This used to resolve `raw` and nothing else, so a form field holding
    `{{client_id}}` went out with the braces still in it — and since nothing
    scanned those fields, `unresolved` was empty and the send was not blocked.
    The request looked right, and the server answered about an application
    called "{{client_id}}".
  */
  const resolvedBody = resolveBody(
    // A pre-request script may have rewritten the raw text, and `sending.body`
    // is where that lands — it is a string because that is the shape scripts
    // see. Every other mode's contents are only on the draft.
    context.draft.body.mode === "raw"
      ? { ...context.draft.body, text: sending.body }
      : context.draft.body,
    scopes
  );
  const unresolved = [
    ...resolved.unresolved,
    ...resolvedBody.unresolved.filter((name) => !resolved.unresolved.includes(name)),
  ];

  if (unresolved.length > 0 && !context.force) {
    return {
      input: null,
      response: null,
      error: null,
      unresolved,
      scripts,
      changes,
    };
  }

  // ─── The wire ─────────────────────────────────────────────────────────────

  const chainInput = {
    item: context.item,
    items: context.items,
    collections: context.collections,
    environments: context.environments,
    activeEnvironmentId: context.activeEnvironmentId,
  };
  const auth =
    context.draft.auth.type === "inherit"
      ? effectiveAuth(authChain(chainInput))
      : context.draft.auth;

  const authed = applyAuth(
    { type: auth.type, params: resolveParams(auth.params, scopes) },
    { url: resolvedUrl, headers: resolved.headers }
  );

  const input = buildSendInput({
    id: crypto.randomUUID(),
    method: sending.method,
    url: authed.url,
    headers: authed.headers.map((header, index) => ({
      id: `r${index}`,
      name: header.name,
      value: header.value,
      enabled: header.enabled,
    })),
    body: resolvedBody.body,
    options: {
      ...DEFAULT_SEND_OPTIONS,
      ...context.draft.settings,
      verifyTls: context.verifyTls ?? context.draft.settings.verifyTls ?? true,
    },
  });

  context.onSending?.(input);

  let response: ApiResponse | null = null;
  let error: ApiError | null = null;
  try {
    response = await sendRequest(input);
  } catch (thrown) {
    error = toApiError(thrown);
  }

  // ─── After the wire ───────────────────────────────────────────────────────
  //
  // A send that failed has no response to assert against, so the tests are
  // skipped rather than run against nothing.
  if (response) {
    const after = collectScripts({
      item: context.item,
      items: context.items,
      collections: context.collections,
      kind: "test",
    });

    if (after.length > 0) {
      const outcome = await runScripts({
        scripts: after,
        request: sending,
        response: {
          code: response.status,
          status: response.statusText,
          headers: response.headers,
          body: response.body.text ?? "",
          responseTime: response.timing.totalMs,
          responseSize: response.body.bytes,
        },
        // As the pre-request phase left them, not as they were before it ran.
        scopes: withScriptChanges(scriptScopes(context), changes),
        info,
        kind: "test",
        newId: () => crypto.randomUUID(),
      });
      record(outcome);
      Object.assign(changes.globals, outcome.changes.globals);
      Object.assign(changes.collection, outcome.changes.collection);
      Object.assign(changes.environment, outcome.changes.environment);
    }
  }

  return {
    input,
    response,
    error: error ?? (authed.note ? { kind: "other", message: authed.note } : null),
    unresolved: [],
    scripts,
    changes,
  };
}
