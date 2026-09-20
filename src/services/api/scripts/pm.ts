/**
 * The object a collection's scripts are written against.
 *
 * A pre-request script sets a variable or rewrites a header; a test script
 * checks the response. Both do it through one global, and a client that does
 * not provide it cannot run anybody's existing collection — which would make
 * the lossless import of phase 2 a fairly hollow achievement.
 *
 * This module is the whole API surface, and it is deliberately *not* the
 * sandbox. It is pure: given a context, it builds the object and records what
 * the script did to it. The worker is a shell that locks its globals down and
 * calls this; the tests call the same thing directly, which is why almost all
 * of the behaviour here is checked under Node rather than through a browser.
 *
 * What is missing is named rather than faked. `pm.sendRequest` is the notable
 * one: a script that sends its own request needs the network from inside a
 * sandbox that has had the network taken away, and pretending otherwise would
 * mean a script that silently did nothing.
 */

import { expect, AssertionError } from "./assert";

export interface ScriptHeader {
  name: string;
  value: string;
}

/** The request a script can read, and — before it is sent — change. */
export interface ScriptRequest {
  method: string;
  url: string;
  headers: ScriptHeader[];
  body: string;
}

export interface ScriptResponse {
  code: number;
  status: string;
  headers: ScriptHeader[];
  body: string;
  responseTime: number;
  responseSize: number;
}

/** The variables in play, by scope, innermost last — matching the chain the
 * app resolves with elsewhere. */
export interface ScriptScopes {
  globals: Record<string, string>;
  collection: Record<string, string>;
  environment: Record<string, string>;
  /**
   * The active environment's name, for `pm.environment.name`.
   *
   * Undefined when none is selected, which is a state scripts are entitled to
   * see — and the reason this is threaded through at all. Collections in the
   * wild branch on the environment's name (`name.replace("Acme - ", "")` to
   * pick a per-environment token variable), and without it those scripts do
   * not merely misbehave, they throw on the first line and take every script
   * after them down with them.
   */
  environmentName?: string;
}

export interface ScriptInfo {
  requestName: string;
  /** 0-based, for a runner going round more than once. */
  iteration: number;
  iterationCount: number;
  eventName: "prerequest" | "test";
}

export interface TestResult {
  name: string;
  passed: boolean;
  /** The assertion message, or the error a broken test threw. */
  error?: string;
}

export interface LogLine {
  level: "log" | "warn" | "error";
  text: string;
}

/** What a script changed. `null` means "unset", which is different from "". */
export type VariableChanges = Record<string, string | null>;

export interface ScriptChanges {
  globals: VariableChanges;
  collection: VariableChanges;
  environment: VariableChanges;
  /** Present when a pre-request script rewrote the request. */
  request?: ScriptRequest;
}

export interface ScriptOutcome {
  tests: TestResult[];
  logs: LogLine[];
  changes: ScriptChanges;
  /** Set when the script itself threw, outside any test. */
  error?: string;
}

export interface ScriptContext {
  request: ScriptRequest;
  response?: ScriptResponse;
  scopes: ScriptScopes;
  info: ScriptInfo;
  /** Injected so a test of this module is not a test of the clock. */
  now?: () => number;
}

/** One scope's variables, and a record of what was done to them. */
class VariableScope {
  readonly changes: VariableChanges = {};

  /**
   * The scope's own name — set for the environment, absent for the others.
   *
   * Postman puts it on the environment only (`pm.environment.name`); globals
   * and collection variables have no such thing, and inventing one here would
   * be a compatibility trap of its own: a script could read it, work in this
   * client, and fail in Postman.
   */
  constructor(
    private readonly values: Record<string, string>,
    readonly name?: string
  ) {}

  get(key: string): string | undefined {
    return this.values[key];
  }

  set(key: string, value: unknown): void {
    const text = value === undefined || value === null ? "" : String(value);
    this.values[key] = text;
    this.changes[key] = text;
  }

  has(key: string): boolean {
    return key in this.values;
  }

  unset(key: string): void {
    delete this.values[key];
    this.changes[key] = null;
  }

  clear(): void {
    for (const key of Object.keys(this.values)) this.unset(key);
  }

  toObject(): Record<string, string> {
    return { ...this.values };
  }
}

/** How big a logged value may be before it is cut short. A script that logs a
 * megabyte of JSON should not be able to fill the panel with it. */
const MAX_LOG = 2000;

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const text = JSON.stringify(value, null, 2) ?? String(value);
    return text.length > MAX_LOG ? `${text.slice(0, MAX_LOG)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * Builds the `pm` object and the `console` that goes with it.
 *
 * `finish()` returns everything the script did. Nothing is applied here: the
 * caller decides what to do with the changes, which is what lets a run be
 * reported without being committed.
 */
export function createPm(context: ScriptContext) {
  const tests: TestResult[] = [];
  const logs: LogLine[] = [];
  const now = context.now ?? (() => Date.now());

  const globals = new VariableScope({ ...context.scopes.globals });
  const collection = new VariableScope({ ...context.scopes.collection });
  const environment = new VariableScope(
    { ...context.scopes.environment },
    context.scopes.environmentName
  );

  // A mutable copy: a pre-request script may rewrite any of it, and the
  // original is what the caller compares against to see whether it did.
  //
  // The headers are a *list* behind an API rather than a bare array, because
  // that is how scripts touch them — `pm.request.headers.upsert({…})` is the
  // line that adds an Authorization header in every collection there is.
  const requestHeaders: ScriptHeader[] = context.request.headers.map((header) => ({
    ...header,
  }));

  const headerApi = (headers: ScriptHeader[]) => ({
    all: () => headers.map((header) => ({ ...header })),
    get: (name: string) =>
      headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value,
    has: (name: string) =>
      headers.some((header) => header.name.toLowerCase() === name.toLowerCase()),
    add: (header: { key?: string; name?: string; value: string }) => {
      headers.push({ name: header.key ?? header.name ?? "", value: header.value });
    },
    upsert: (header: { key?: string; name?: string; value: string }) => {
      const name = header.key ?? header.name ?? "";
      const existing = headers.find(
        (entry) => entry.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) existing.value = header.value;
      else headers.push({ name, value: header.value });
    },
    remove: (name: string) => {
      const index = headers.findIndex(
        (header) => header.name.toLowerCase() === name.toLowerCase()
      );
      if (index !== -1) headers.splice(index, 1);
    },
  });

  const request = {
    method: context.request.method,
    url: context.request.url,
    body: context.request.body,
    headers: headerApi(requestHeaders),
  };

  /** What the request now is, flat, for the caller to send. */
  const currentRequest = (): ScriptRequest => ({
    method: request.method,
    url: request.url,
    headers: requestHeaders.map((header) => ({ ...header })),
    body: request.body,
  });

  /** `pm.response.json()`, with a failure a test can catch and report. */
  const parseJson = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`The response is not JSON: ${(error as Error).message}`);
    }
  };

  const response = context.response
    ? {
        code: context.response.code,
        status: context.response.status,
        responseTime: context.response.responseTime,
        responseSize: context.response.responseSize,
        headers: headerApi(context.response.headers.map((header) => ({ ...header }))),
        text: () => context.response!.body,
        json: () => parseJson(context.response!.body),

        /**
         * `pm.response.to.have.status(200)`, which is how almost every real
         * test script starts.
         *
         * A separate little chain rather than an `Expectation`, because what
         * it asserts *about* is the response rather than a value: `status`
         * takes a code or a name, and `header` takes a name and an optional
         * value.
         */
        get to() {
          const self = response!;
          const chain = {
            get have() {
              return chain;
            },
            get be() {
              return chain;
            },
            get and() {
              return chain;
            },
            status(wanted: number | string) {
              if (typeof wanted === "number") {
                expect(self.code, "response status").to.equal(wanted);
              } else {
                expect(self.status, "response status").to.equal(wanted);
              }
              return chain;
            },
            header(name: string, value?: string) {
              const actual = self.headers.get(name);
              expect(actual !== undefined, `header ${name}`).to.be.true;
              if (value !== undefined) expect(actual, `header ${name}`).to.equal(value);
              return chain;
            },
            body(expected?: string) {
              if (expected === undefined) {
                expect(self.text().length > 0, "response body").to.be.true;
              } else {
                expect(self.text(), "response body").to.equal(expected);
              }
              return chain;
            },
            jsonBody(expected?: unknown) {
              const parsed = self.json();
              if (expected !== undefined) {
                expect(parsed, "response body").to.eql(expected);
              }
              return chain;
            },
            get ok() {
              expect(self.code >= 200 && self.code < 300, "response status").to.be.true;
              return chain;
            },
            get json() {
              self.json();
              return chain;
            },
            get success() {
              return chain.ok;
            },
          };
          return chain;
        },
      }
    : undefined;

  const pm = {
    info: { ...context.info },

    globals,
    collectionVariables: collection,
    environment,

    /** The chain, innermost first, which is what a script means by "the value
     * of this variable right now". */
    variables: {
      get: (key: string): string | undefined =>
        environment.get(key) ?? collection.get(key) ?? globals.get(key),
      has: (key: string): boolean =>
        environment.has(key) || collection.has(key) || globals.has(key),
      /** Setting through the chain writes to the environment, which is where a
       * script that says `pm.variables.set` almost always means. */
      set: (key: string, value: unknown) => environment.set(key, value),
      toObject: () => ({
        ...globals.toObject(),
        ...collection.toObject(),
        ...environment.toObject(),
      }),
    },

    request,
    response,

    expect,

    test(name: string, body: () => void): void {
      try {
        body();
        tests.push({ name, passed: true });
      } catch (error) {
        tests.push({
          name,
          passed: false,
          error:
            error instanceof AssertionError
              ? error.message
              : `${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? String(error)}`,
        });
      }
    },

    /** Named rather than faked: a sandbox with the network taken away cannot
     * send one, and a silent no-op would be worse than an error. */
    sendRequest(): never {
      throw new Error(
        "pm.sendRequest is not available: scripts run without network access. Make the call a request of its own."
      );
    },

    /** Kept because scripts call it before doing their own thing; there is no
     * runner state to stop yet, so it is recorded and ignored. */
    setNextRequest(name: string | null): void {
      logs.push({ level: "warn", text: `setNextRequest(${render(name)}) is not honoured yet` });
    },
  };

  const console = {
    log: (...args: unknown[]) => logs.push({ level: "log", text: args.map(render).join(" ") }),
    warn: (...args: unknown[]) => logs.push({ level: "warn", text: args.map(render).join(" ") }),
    error: (...args: unknown[]) => logs.push({ level: "error", text: args.map(render).join(" ") }),
    info: (...args: unknown[]) => logs.push({ level: "log", text: args.map(render).join(" ") }),
    debug: (...args: unknown[]) => logs.push({ level: "log", text: args.map(render).join(" ") }),
  };

  /** Whether a pre-request script actually rewrote anything. */
  const requestChanged = (): boolean =>
    request.method !== context.request.method ||
    request.url !== context.request.url ||
    request.body !== context.request.body ||
    requestHeaders.length !== context.request.headers.length ||
    requestHeaders.some(
      (header, index) =>
        header.name !== context.request.headers[index]?.name ||
        header.value !== context.request.headers[index]?.value
    );

  const finish = (error?: unknown): ScriptOutcome => ({
    tests,
    logs,
    changes: {
      globals: globals.changes,
      collection: collection.changes,
      environment: environment.changes,
      ...(requestChanged() ? { request: currentRequest() } : {}),
    },
    ...(error === undefined
      ? {}
      : {
          error:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
        }),
  });

  return { pm, console, finish, now };
}
