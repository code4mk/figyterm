/**
 * The webview's side of syncing.
 *
 * Thin, like `client.ts` and `store.ts`: every decision — which side wins, what
 * to push, when the watermark moves — is in Rust, where the database and the
 * network both are. What crosses here is the status panel's numbers and the
 * connection form's answers.
 *
 * **No secret crosses this boundary.** The project key goes one way, into the
 * keychain, when it is first entered; nothing reads it back out into the
 * window, and `hasKey` is the only thing the panel is told about it.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { DirectConfig, SyncOutcome, SyncProbe, SyncStatus, SyncStep } from "../../types/api";

const SYNC_EVENT = "api://sync";
const SYNC_STEP_EVENT = "api://sync-step";

export function status(): Promise<SyncStatus> {
  return invoke<SyncStatus>("api_sync_status");
}

/**
 * Whether a key is already stored for what is configured.
 *
 * Asked when the connection panel opens, not with every status read. Reading
 * the keychain can put up an OS password prompt, and doing that on every
 * window open — to draw a dot — is not a trade worth making.
 */
export function hasStoredKey(): Promise<boolean> {
  return invoke<boolean>("api_sync_has_key");
}

/**
 * Creates the tables, and nothing else.
 *
 * Its own call because it was the one step with no way to see it: it ran
 * inside Connect, so a migration the database refused looked exactly like a
 * database nobody had set up yet.
 */
export function migrate(config: DirectConfig, password: string): Promise<SyncProbe> {
  return invoke<SyncProbe>("api_sync_migrate", { config, password });
}

/** Tries a Postgres database without saving anything, and without creating
 * the schema — a test that changed the database would not be a test. */
export function testDirect(config: DirectConfig, password: string): Promise<SyncProbe> {
  return invoke<SyncProbe>("api_sync_test_direct", { config, password });
}

/**
 * Saves a Postgres database, creating the schema if it is not there.
 *
 * Unlike the hosted mode this one can set itself up: it has a connection to the
 * database rather than to something in front of it, so the SQL runs here rather
 * than being copied into somebody's console.
 */
export function connectDirect(params: {
  config: DirectConfig;
  password: string;
  intervalSecs: number;
  syncOnFocus: boolean;
}): Promise<SyncProbe> {
  return invoke<SyncProbe>("api_sync_connect_direct", params);
}

export function disconnect(): Promise<void> {
  return invoke("api_sync_disconnect");
}

/**
 * When passes run on their own. `auto` is not a master switch: turning it off
 * leaves the connection alone and leaves the Sync button working, because
 * pressing that button is itself the request.
 */
export function settings(params: {
  auto: boolean;
  intervalSecs: number;
  syncOnFocus: boolean;
}): Promise<void> {
  return invoke("api_sync_settings", params);
}

export function now(): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("api_sync_now");
}

/**
 * Asks the pass in flight to stop at its next boundary.
 *
 * Returns as soon as the ask is registered, not when the pass ends — the pass
 * reports what it managed through the usual `onSync` event, like any other.
 */
export function stop(): Promise<void> {
  return invoke("api_sync_stop");
}

/** The SQL that prepares a Postgres database, to show and to copy. */
export function setupSql(schema: string): Promise<string> {
  return invoke<string>("api_sync_setup_sql", { schema });
}

/** Goes back to the copy taken before syncing started. */
export function restore(): Promise<void> {
  return invoke("api_sync_restore");
}

/** Fires when a pass finishes, wherever it was started from. */
export function onSync(handler: (outcome: SyncOutcome) => void): Promise<UnlistenFn> {
  return listen<SyncOutcome>(SYNC_EVENT, (event) => handler(event.payload));
}

/** Every table as it moves, so a pass can be watched rather than waited for. */
export function onSyncStep(handler: (step: SyncStep) => void): Promise<UnlistenFn> {
  return listen<SyncStep>(SYNC_STEP_EVENT, (event) => handler(event.payload));
}
