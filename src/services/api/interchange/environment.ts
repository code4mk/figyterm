/**
 * Environments, in and out.
 *
 * Nothing resolves a variable yet — the scope chain is the next phase. This
 * exists because an import that silently dropped somebody's environment file
 * would do it at exactly the moment they were moving their work across, which
 * is the worst possible moment, and because "export and port" has to mean the
 * environments too or it does not mean much.
 *
 * The scope — one environment, or the globals that apply everywhere — rides on
 * a vendor-prefixed key. It is matched by its suffix rather than by an exact
 * name so a file from any tool in this family reads the same, and written back
 * from the original so a round trip keeps whatever prefix it arrived with.
 */

import { ImportedEnvironment, ImportedVariable } from "./import";
import { asObject, asString, RawObject } from "./schema";

/** The key a new environment gets, when there is no original to copy one from. */
const SCOPE_KEY = "_variable_scope";

export interface StoredEnvironment {
  name: string;
  isGlobal: boolean;
  variables: ImportedVariable[];
  raw: unknown;
}

/**
 * The document for an environment.
 *
 * Secrets are written with the type that marks them, not stripped: this is an
 * export the person asked for, to a file they chose, and an environment export
 * that quietly emptied its tokens would be useless for the one job it has.
 * What must never happen — a secret in a *synced* row — is a different
 * question, answered in the sync phase.
 */
export function writeEnvironment(environment: StoredEnvironment): RawObject {
  const original = asObject(environment.raw) ?? {};
  const document: RawObject = { ...original };

  document.name = environment.name;
  document.values = environment.variables.map((variable) => {
    const entry: RawObject = {
      key: variable.key,
      value: variable.value,
      type: variable.secret ? "secret" : "default",
    };
    entry.enabled = variable.enabled;
    return entry;
  });

  const existing = Object.keys(original).find((key) => key.endsWith(SCOPE_KEY));
  document[existing ?? SCOPE_KEY] = environment.isGlobal ? "globals" : "environment";
  return document;
}

export function writeEnvironmentFile(environment: StoredEnvironment): string {
  return `${JSON.stringify(writeEnvironment(environment), null, 2)}\n`;
}

/** A name for the file an environment is saved to. */
export function environmentFileName(environment: { name: string; isGlobal: boolean }): string {
  const base = environment.isGlobal ? "globals" : environment.name;
  return `${slug(base)}.json`;
}

/** A name for the file a collection is saved to. */
export function collectionFileName(name: string): string {
  return `${slug(name)}.json`;
}

/**
 * A filename that will survive every filesystem this app runs on.
 *
 * Windows refuses `< > : " / \ | ? *` and trailing dots outright, so a
 * collection called `GET /users?x=1` has to become something else before it can
 * be saved at all.
 */
function slug(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  return cleaned === "" ? "collection" : cleaned;
}

/** Re-exported so callers have one import for the environment side. */
export type { ImportedEnvironment };

export function environmentSummary(environment: ImportedEnvironment): string {
  const count = environment.variables.length;
  return `${environment.name} · ${count} variable${count === 1 ? "" : "s"}`;
}

export function asEnvironmentName(value: unknown): string {
  return asString(asObject(value)?.name, "Environment");
}
