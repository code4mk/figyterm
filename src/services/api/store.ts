/**
 * The webview's side of the collection store.
 *
 * One function per command, and nothing else — no caching, no merging, no
 * optimism. `stores/apiStore.ts` is where state lives and where an optimistic
 * update is decided on; this file only crosses the boundary, so that "what does
 * the database do" and "what does the rail show" never have to be untangled
 * from each other.
 *
 * Ranks are passed in, never computed here: they come from `rank.ts`, which is
 * tested, and a second implementation would be a second thing to get wrong.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  ApiCollection,
  ApiExample,
  ApiItem,
  ApiSession,
  ApiSnapshot,
  ApiWorkspace,
  HeaderPair,
  HeaderRow,
  HistoryEntry,
  ItemKind,
  RequestBody,
  RequestSettings,
  SavedRequest,
  SendInput,
  StoredResponse,
} from "../../types/api";
import { ImportedCollection, ImportedVariable } from "./interchange/import";
import { ExportBundle } from "./interchange/export";

/** Everything the window needs to draw itself, in one round trip. */
export function bootstrap(): Promise<ApiSnapshot> {
  return invoke<ApiSnapshot>("api_bootstrap");
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

export function workspaces(): Promise<ApiWorkspace[]> {
  return invoke<ApiWorkspace[]>("api_workspaces");
}

/** Makes one and opens it, returning everything in it — which is nothing yet. */
export function createWorkspace(name: string): Promise<ApiSnapshot> {
  return invoke<ApiSnapshot>("api_workspace_create", { name });
}

export function renameWorkspace(id: string, name: string): Promise<void> {
  return invoke("api_workspace_rename", { id, name });
}

/**
 * Switches, and brings back everything in the one switched to.
 *
 * A whole snapshot rather than an acknowledgement: the tree, the environments,
 * the history and the examples all change together, and two calls would paint
 * the new workspace with the old workspace's tree.
 */
export function openWorkspace(id: string): Promise<ApiSnapshot> {
  return invoke<ApiSnapshot>("api_workspace_open", { id });
}

/** Deletes it and returns what is left, which is a different workspace. */
export function deleteWorkspace(id: string): Promise<ApiSnapshot> {
  return invoke<ApiSnapshot>("api_workspace_delete", { id });
}

// ─── Collections ─────────────────────────────────────────────────────────────

export function createCollection(name: string, rank: string): Promise<ApiCollection> {
  return invoke<ApiCollection>("api_collection_create", { name, rank });
}

export function renameCollection(id: string, name: string): Promise<void> {
  return invoke("api_collection_rename", { id, name });
}

export function deleteCollection(id: string): Promise<void> {
  return invoke("api_collection_delete", { id });
}

export function createItem(params: {
  collectionId: string;
  parentId: string | null;
  kind: ItemKind;
  name: string;
  rank: string;
}): Promise<ApiItem> {
  return invoke<ApiItem>("api_item_create", params);
}

export function renameItem(id: string, name: string): Promise<void> {
  return invoke("api_item_rename", { id, name });
}

export function moveItem(params: {
  id: string;
  collectionId: string;
  parentId: string | null;
  rank: string;
}): Promise<void> {
  return invoke("api_item_move", params);
}

export function deleteItem(id: string): Promise<void> {
  return invoke("api_item_delete", { id });
}

/** Copies an item, and a folder's whole subtree. Returns every new row. */
export function duplicateItem(id: string, name: string, rank: string): Promise<ApiItem[]> {
  return invoke<ApiItem[]>("api_item_duplicate", { id, name, rank });
}

export function loadRequest(itemId: string): Promise<SavedRequest | null> {
  return invoke<SavedRequest | null>("api_request_load", { itemId });
}

export function saveRequest(params: {
  itemId: string;
  method: string;
  url: string;
  headers: HeaderRow[];
  body: RequestBody;
  settings: RequestSettings | null;
}): Promise<void> {
  return invoke("api_request_save", params);
}

/** The auth block on a folder or a request. `null` removes it, which is what
 * makes the row inherit from its parent again. */
export function saveItemAuth(id: string, auth: unknown): Promise<void> {
  return invoke("api_item_auth_save", { id, auth });
}

/** The pre-request and test scripts on a folder or a request. */
export function saveItemEvents(id: string, events: unknown): Promise<void> {
  return invoke("api_item_events_save", { id, events });
}

/** A collection's own auth and variables — the outermost scope under the
 * environment. */
export function saveCollectionScope(
  id: string,
  auth: unknown,
  variables: unknown
): Promise<void> {
  return invoke("api_collection_scope_save", { id, auth, variables });
}

/**
 * Everything the folder tab edits, in one write.
 *
 * One call rather than four: four would bump the row's revision four times and
 * queue it for syncing four times for a single save, and a failure partway
 * would leave a folder holding its new auth beside its old scripts.
 */
export interface ScopeSave {
  id: string;
  name: string;
  description: string;
  auth: unknown;
  variables: unknown;
  events: unknown;
}

export function saveItemScope(payload: ScopeSave): Promise<void> {
  return invoke("api_item_scope_save", { payload });
}

/** The same, one level up. */
export function saveCollectionOverview(payload: ScopeSave): Promise<void> {
  return invoke("api_collection_overview_save", { payload });
}

/** Creates or updates an environment and its variables. */
/** One row of an environment, as it is written. No id: the store rewrites the
 * whole set, and the ids are its own. */
export interface EnvVariable {
  key: string;
  /** The initial value — shared, exported, synced. */
  value: string;
  /** This machine's own, or null to fall back to the initial. */
  currentValue: string | null;
  enabled: boolean;
  secret: boolean;
}

export function saveEnvironment(params: {
  id: string | null;
  name: string;
  isGlobal: boolean;
  variables: EnvVariable[];
}): Promise<string> {
  return invoke<string>("api_environment_save", params);
}

/** The open tabs and their drafts. Written whole, and debounced by the store. */
export function saveSession(session: ApiSession): Promise<void> {
  return invoke("api_session_save", { session });
}

export function addHistory(
  entry: {
    itemId: string | null;
    method: string;
    url: string;
    status: number | null;
    durationMs: number | null;
    sizeBytes: number | null;
    error: string | null;
    request: SendInput;
    response: StoredResponse | null;
  },
  body: string | null
): Promise<string> {
  return invoke<string>("api_history_add", { entry, body });
}

export function listHistory(limit: number): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("api_history_list", { limit });
}

/** The stored body of one history entry. Null when it was pruned. */
export function historyBody(id: string): Promise<string | null> {
  return invoke<string | null>("api_history_body", { id });
}

export function clearHistory(): Promise<void> {
  return invoke("api_history_clear");
}

// ─── Interchange ─────────────────────────────────────────────────────────────

/** Creates a collection, its tree and its requests in one transaction. */
export function importCollection(payload: ImportedCollection): Promise<string> {
  return invoke<string>("api_import_collection", { payload });
}

export function importEnvironment(payload: {
  name: string;
  isGlobal: boolean;
  raw: unknown;
  variables: ImportedVariable[];
}): Promise<string> {
  return invoke<string>("api_import_environment", { payload });
}

/** Everything needed to write a collection back out, each row with the
 * document it was imported from. */
export function exportCollection(id: string): Promise<ExportBundle> {
  return invoke<ExportBundle>("api_export_collection", { id });
}

export function deleteEnvironment(id: string): Promise<void> {
  return invoke("api_environment_delete", { id });
}

// ─── Examples ────────────────────────────────────────────────────────────────

export function examples(itemId: string): Promise<ApiExample[]> {
  return invoke<ApiExample[]>("api_examples", { itemId });
}

export function saveExample(params: {
  itemId: string;
  rank: string;
  example: {
    name: string;
    status: number | null;
    statusText: string | null;
    headers: HeaderPair[] | null;
    body: string | null;
  };
}): Promise<string> {
  return invoke<string>("api_example_save", params);
}

export function renameExample(id: string, name: string): Promise<void> {
  return invoke("api_example_rename", { id, name });
}

export function deleteExample(id: string): Promise<void> {
  return invoke("api_example_delete", { id });
}

/** Reads a file the user picked in the native dialog. */
export function readFile(path: string): Promise<string> {
  return invoke<string>("api_read_file", { path });
}

/** The `.json` files directly inside a directory the user picked. */
export function listJsonFiles(path: string): Promise<string[]> {
  return invoke<string[]>("api_list_json_files", { path });
}

export function writeFile(path: string, contents: string): Promise<void> {
  return invoke("api_write_file", { path, contents });
}
