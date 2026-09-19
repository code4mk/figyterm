/**
 * The chain a request sits in.
 *
 * Two things are inherited, and both walk the same path — the request, then
 * each folder above it, then the collection, then the active environment, then
 * the globals:
 *
 * - **Variables**, where the innermost value for a name wins.
 * - **Auth**, where the innermost *block* wins, and an absent block means
 *   "keep looking" while an explicit `noauth` means "stop".
 *
 * Kept apart from the store so it can be run under Node. Both walks are easy to
 * get subtly wrong — an off-by-one in the order silently sends production
 * credentials to a staging host — and neither needs a database to test.
 */

import { ApiCollection, ApiEnvironment, ApiItem, ApiVariable } from "../../types/api";
import { Scope, Variable } from "./template";

/**
 * Reads the interchange format's `variable[]` into the shape resolution wants.
 *
 * Tolerant of what real documents hold: a value may be a number or a boolean,
 * and `disabled` is the format's flag where this app says `enabled`.
 */
export function variablesFrom(value: unknown): Variable[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key : null;
    if (!key) return [];
    return [
      {
        key,
        value: row.value === undefined || row.value === null ? "" : String(row.value),
        enabled: row.disabled !== true,
      },
    ];
  });
}

/** The reverse, for writing a collection's variables back to the document. */
export function variablesTo(variables: Variable[]): unknown[] {
  return variables.map((variable) => {
    const entry: Record<string, unknown> = { key: variable.key, value: variable.value };
    if (!variable.enabled) entry.disabled = true;
    return entry;
  });
}

/**
 * What an environment variable actually resolves to.
 *
 * **The current value wins.** That is the whole point of the pair: the initial
 * value is what gets shared — exported with the file, pushed to everyone — and
 * the current one is what this machine is really using. `null` means there is
 * no separate current value, which is not the same as an empty one: an empty
 * current value is somebody deliberately sending nothing.
 */
function resolving(variable: ApiVariable): Variable {
  return {
    key: variable.key,
    value: variable.currentValue ?? variable.value,
    enabled: variable.enabled,
  };
}

/** Every item from a request up to the top of its collection, innermost first. */
export function ancestry(item: ApiItem | null, items: ApiItem[]): ApiItem[] {
  if (!item) return [];
  const byId = new Map(items.map((row) => [row.id, row]));
  const chain: ApiItem[] = [item];
  const seen = new Set<string>([item.id]);

  let parent = item.parentId ? byId.get(item.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    chain.push(parent);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return chain;
}

export interface ChainInput {
  /** The request being sent, when it is one that lives in a collection. */
  item: ApiItem | null;
  items: ApiItem[];
  collections: ApiCollection[];
  environments: ApiEnvironment[];
  activeEnvironmentId: string | null;
}

/**
 * The scopes, innermost first.
 *
 * A scratch request that has never been saved still gets the environment and
 * the globals — it has no collection to inherit from, and refusing it variables
 * would make the URL bar useless for the thing it is most used for.
 */
export function buildScopes(input: ChainInput): Scope[] {
  const scopes: Scope[] = [];

  for (const ancestor of ancestry(input.item, input.items)) {
    const variables = variablesFrom(ancestor.variables);
    if (variables.length > 0) {
      scopes.push({
        label: ancestor.name,
        variables,
        kind: ancestor.kind === "folder" ? "folder" : "request",
      });
    }
  }

  if (input.item) {
    const collection = input.collections.find(
      (candidate) => candidate.id === input.item!.collectionId
    );
    const variables = variablesFrom(collection?.variables);
    if (collection && variables.length > 0) {
      scopes.push({ label: collection.name, variables, kind: "collection" });
    }
  }

  const active = input.environments.find(
    (environment) => environment.id === input.activeEnvironmentId && !environment.isGlobal
  );
  if (active) {
    scopes.push({
      label: active.name,
      variables: active.variables.map(resolving),
      kind: "environment",
    });
  }

  const globals = input.environments.find((environment) => environment.isGlobal);
  if (globals) {
    scopes.push({
      label: "Globals",
      variables: globals.variables.map(resolving),
      kind: "global",
    });
  }

  return scopes;
}

/**
 * The auth blocks to consider, innermost first.
 *
 * Every link is included, `null` and all, because `effectiveAuth` needs to see
 * the gaps: a folder with no block is what passes the question up to the
 * collection, and dropping the empty links would change which one answers.
 */
export function authChain(input: ChainInput): unknown[] {
  const chain: unknown[] = ancestry(input.item, input.items).map((row) => row.auth ?? null);

  if (input.item) {
    const collection = input.collections.find(
      (candidate) => candidate.id === input.item!.collectionId
    );
    chain.push(collection?.auth ?? null);
  }
  return chain;
}
