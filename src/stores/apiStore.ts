/**
 * The API client's state: the tree, the open tabs, and what came back.
 *
 * The store owns persistence. Components call actions and read state; nothing
 * outside this file talks to `services/api/store.ts`. That is what lets the
 * request pane be a component that knows about one draft and has no idea a
 * collection exists.
 *
 * Two rules, both of which the phase 0 window did not need and phase 1 does:
 *
 * - **A draft is never lost.** Editing does not write to the collection — it
 *   writes to the session, debounced, which is restored on the next open. A
 *   request is only saved into its collection when asked (⌘S), exactly as the
 *   code editor in this app behaves. So the dirty dot means "differs from what
 *   is saved", never "about to be lost".
 * - **Tree edits are optimistic, deletes are not.** A rename that waits for
 *   SQLite is a rename you can watch happen; a delete that removes the row
 *   before the write lands can leave the rail showing a tree the database
 *   disagrees with, so it reloads after.
 */

import { create } from "zustand";
import {
  ApiCollection,
  ApiSnapshot,
  ApiWorkspace,
  ApiEnvironment,
  ApiExampleSummary,
  ApiError,
  ApiExample,
  DraftAuth,
  SyncOutcome,
  SyncStatus,
  ApiItem,
  ApiResponse,
  ApiSession,
  SessionTab,
  HeaderRow,
  HistoryEntry,
  HttpMethod,
  ItemKind,
  RequestBody,
  RequestDraft,
  StoredResponse,
} from "../types/api";
import * as api from "../services/api/store";
import { EnvVariable } from "../services/api/store";
import { cancelRequest } from "../services/api/client";
import { blankHeader } from "../services/api/request";
import {
  DEFAULT_SPLIT,
  PanelLayout,
  readLayout,
  readSplit,
  SplitLayout,
} from "../services/api/layout";
import {
  append as appendConsole,
  ConsoleEntry,
  ConsoleLevel,
  NewConsoleEntry,
} from "../services/api/console";
import { formatBytes, formatDuration } from "../services/api/format";
import { paramsOf, QueryRow, syncParams, withParams } from "../services/api/params";
import { rankAfter, rankAt } from "../services/api/rank";
import {
  emptyScope,
  ScopeDraft,
  scopeFrom,
  ScopeTab,
  scopeTo,
} from "../services/api/scope";
import { readAuth, writeAuth } from "../services/api/auth";
import { buildScopes, variablesFrom, variablesTo } from "../services/api/scopes";
import { Scope, Variable } from "../services/api/template";
import { siblingsOf } from "../services/api/tree";
import { ImportNote, ImportOutcome, readDocument } from "../services/api/interchange/import";
import { writeCollectionFile } from "../services/api/interchange/export";
import {
  collectionFileName,
  environmentFileName,
  writeEnvironmentFile,
} from "../services/api/interchange/environment";
import { looksLikeCurl, parseCurl } from "../services/api/interchange/curl";
import { CodeTarget } from "../services/api/interchange/codegen";
import * as sync from "../services/api/sync";
import { executeRequest, ScriptRun } from "../services/api/execute";
import { eventsWith, scriptFrom } from "../services/api/scripts/events";
import { DataFile, readDataFile } from "../services/api/runner/data";
import {
  requestsUnder,
  reportToJson,
  runCollection,
  RunEntry,
  RunReport,
} from "../services/api/runner/run";
import { VariableChanges } from "../services/api/scripts/pm";

/** Re-exported so a component can name what the Tests tab is given without
 * reaching past the store into the module that produced it. */
export type { ScriptRun };
export type { RunEntry, RunReport };

/** What the runner was pointed at: a whole collection, or one folder of it. */
export interface RunTarget {
  kind: "collection" | "folder";
  id: string;
  name: string;
}

export interface RunState {
  open: boolean;
  target: RunTarget | null;
  iterations: number;
  delayMs: number;
  stopOnFailure: boolean;
  /** A data file's rows, when one was chosen. */
  data: DataFile | null;
  dataName: string | null;
  running: boolean;
  done: number;
  total: number;
  /** Filled as the run goes, so two hundred requests are not a blank panel. */
  entries: RunEntry[];
  report: RunReport | null;
}

/**
 * How narrow and wide the sidebar may be dragged.
 *
 * The lower bound is where a method chip and a short name still fit; below it
 * the tree is a column of ellipses, and somebody who wants less than that
 * wants it collapsed, which is what ⌘B is for.
 */
const MIN_RAIL = 180;
const MAX_RAIL = 520;

/** How long typing settles before the session is written. */
const SESSION_DEBOUNCE = 500;

export type RailView = "collections" | "environments" | "history";

/** An environment as its tab holds it. */
export interface EnvDraft {
  name: string;
  isGlobal: boolean;
  variables: EnvVariable[];
}

/** In the order the icon strip draws them. */
export const RAIL_VIEWS: RailView[] = ["collections", "environments", "history"];

export type RequestTab =
  | "params"
  | "auth"
  | "headers"
  | "body"
  | "scripts"
  | "settings"
  | "code";
export type ResponseTab = "body" | "tests" | "headers" | "request" | "timing";

/**
 * One open request, folder or collection.
 *
 * Everything below `draft` is view state, deliberately not saved into the
 * collection — a response is not part of a request.
 *
 * A folder or collection tab uses `scope` and leaves `draft` at its default:
 * one list of tabs rather than two, because the tab strip, the keyboard and the
 * session all work on "the tabs" and would each need a second case.
 */
export interface Tab {
  id: string;
  /** What this tab edits. */
  kind: "request" | "folder" | "collection" | "environment" | "example" | "sync";
  /** Null for a scratch tab that has never been saved into a collection. */
  itemId: string | null;
  /** The folder or collection row, on a tab that edits one. */
  scopeId: string | null;
  /** What that row holds, and what it held when the tab opened. */
  scope: ScopeDraft | null;
  savedScope: ScopeDraft | null;
  scopeTab: ScopeTab;
  /** An environment tab's rows, and what they were when it opened. `"new"` as
   * the `scopeId` means one that has not been created yet. */
  env: EnvDraft | null;
  savedEnv: EnvDraft | null;
  /**
   * The kept response an example tab is showing, and the name being edited.
   *
   * There is at most **one** example tab, and opening another example swaps
   * what is in it. A request with six kept responses is ordinary, and a tab
   * apiece turns reading them into housekeeping — six tabs all named after the
   * same request.
   */
  example: ApiExample | null;
  exampleName: string;
  /**
   * The request the example belongs to. Deliberately not `itemId`: `openItem`
   * matches on that, so an example tab carrying one would be focused when
   * somebody clicked the *request* in the sidebar — the request would not
   * open, and the pane's own way back to it would silently do nothing.
   */
  exampleOwner: string | null;
  name: string;
  draft: RequestDraft;
  /** What the collection holds, for the dirty dot. Null for a scratch tab. */
  saved: RequestDraft | null;
  response: ApiResponse | null;
  error: ApiError | null;
  sendingId: string | null;
  received: number;
  /** Variables with no value anywhere, from the last attempt to send. Cleared
   * as soon as the draft changes, because the answer may have changed too. */
  unresolved: string[];
  /** What the last run's scripts did: assertions, console output, failures. */
  scripts: ScriptRun | null;
  /** Responses kept against this request. Loaded when the tab opens. */
  examples: ApiExample[];
  /** Which one the response pane is showing instead of the live response. */
  viewingExample: string | null;
  /**
   * The query, as the Params tab shows it.
   *
   * View state, not draft state, and derived from `draft.url` — which stays
   * the only copy of what will be sent. The rows exist so the table can keep a
   * row's identity while it is being typed in, and so an **unticked**
   * parameter has somewhere to wait: it cannot live in the URL, because the
   * URL is what goes on the wire.
   *
   * Not saved. Unticking a parameter is something you do for a minute, and a
   * collection that carried a disabled one around would be a collection with
   * an invisible difference from what it sends.
   */
  params: QueryRow[];
  requestTab: RequestTab;
  responseTab: ResponseTab;
  /** Which language the Code tab is showing. Per tab, because someone working
   * in two services is often working in two languages. */
  codeTarget: CodeTarget;
  pretty: boolean;
  /** Whether the response body wraps long lines. On by default: a raw JSON
   * body is one line, and an unwrapped one is a horizontal scrollbar. */
  wrap: boolean;
  /** Off only while working around a certificate failure, never persisted. */
  verifyTls: boolean;
}

interface ApiState {
  ready: boolean;
  /** Set when the database will not open — the window says so rather than
   * pretending to be empty, which would invite someone to start again. */
  storeError: string | null;
  /**
   * Set when a sync pass or the status read failed.
   *
   * Separate from `storeError` on purpose. These used to share one field, and
   * the banner that renders it says "Collections could not be opened" — so a
   * keychain prompt somebody dismissed reported itself as the local database
   * being broken, which is both alarming and false. The collections are on
   * this machine and were never involved.
   */
  syncError: string | null;

  /** Every workspace there is, oldest first. */
  workspaces: ApiWorkspace[];
  /** The one that is open. Everything below is what is inside it. */
  workspaceId: string | null;

  collections: ApiCollection[];
  items: ApiItem[];
  history: HistoryEntry[];
  environments: ApiEnvironment[];
  /** Every kept response in the workspace, without its body — what the rail
   * hangs under each request. The full ones live on the tab that opened them. */
  examples: ApiExampleSummary[];
  /** Whose variables are in play. Null for none, which is a valid choice. */
  activeEnvironmentId: string | null;
  /** What the last import did, for the report. Null when it has been read. */
  report: ImportReport | null;
  /** How syncing is set up and how the last pass went. Null before it is read. */
  sync: SyncStatus | null;
  /** Whether the connection panel is open. */
  connecting: boolean;
  syncing: boolean;
  /** What the runner is set up to do, and how it is going. */
  run: RunState;
  /** What the window has done, newest last. Bounded — see `console.ts`. */
  console: ConsoleEntry[];
  consoleOpen: boolean;
  expanded: Set<string>;
  rail: RailView;
  /** The sidebar shrunk to its icon strip. The section it was on is kept, so
   * re-opening it returns to where the work was rather than to the default. */
  railCollapsed: boolean;
  /** Where the response sits. Below by default: a URL is wide and short and a
   * JSON body is narrow and tall, so a side-by-side split wraps everything on
   * any window that is not very wide. */
  split: SplitLayout;
  /** Where the divider was left, per layout — the two are not interchangeable,
   * and carrying one's proportion over to the other is how a split ends up
   * somewhere nobody put it. */
  splitSizes: Record<SplitLayout, PanelLayout>;
  query: string;
  /** How wide the sidebar's section is, in pixels. Dragged, and remembered. */
  railWidth: number;

  tabs: Tab[];
  activeTabId: string | null;

  hydrate: () => Promise<void>;

  /** Adds a line to the console. Public because the runner logs too. */
  log: (entry: NewConsoleEntry) => void;
  clearConsole: () => void;
  /** Dismisses the sync banner. The failure stays in the console. */
  setSyncError: (message: string | null) => void;
  toggleConsole: (open?: boolean) => void;

  setRail: (view: RailView) => void;
  /** Collapses or opens the sidebar; with no argument, flips it. */
  toggleRail: (collapsed?: boolean) => void;
  setRailWidth: (width: number) => void;
  setSplit: (split: SplitLayout) => void;
  /** Called when the divider is let go, not while it is moving. */
  setSplitSize: (split: SplitLayout, layout: PanelLayout) => void;
  setQuery: (query: string) => void;
  toggleExpanded: (id: string) => void;

  createCollection: (name: string) => Promise<void>;
  /**
   * Opens a workspace, replacing everything on screen with what is in it.
   *
   * Tabs included: a tab is a request in a collection, and a collection lives
   * in exactly one workspace — so a tab carried across would be a tab pointing
   * at a row this workspace cannot see.
   */
  openWorkspace: (id: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;

  renameCollection: (id: string, name: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  createItem: (
    collectionId: string,
    parentId: string | null,
    kind: ItemKind,
    name: string
  ) => Promise<string | null>;
  renameItem: (id: string, name: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  duplicateItem: (id: string) => Promise<void>;
  moveItem: (
    id: string,
    collectionId: string,
    parentId: string | null,
    index: number
  ) => Promise<void>;

  openItem: (itemId: string) => Promise<void>;
  /** Opens a folder or a collection as a tab of its own. */
  openScope: (kind: "folder" | "collection", id: string) => void;
  patchScope: (tabId: string, patch: Partial<ScopeDraft>) => void;
  saveScope: (tabId: string) => Promise<void>;
  openScratch: () => void;
  closeTab: (tabId: string) => void;
  /** Closes every tab, or every tab but one. */
  closeTabs: (keep?: string) => void;
  setActiveTab: (tabId: string) => void;
  patchDraft: (tabId: string, patch: Partial<RequestDraft>) => void;
  /** The query table wrote; the URL follows it. */
  setParams: (tabId: string, params: QueryRow[]) => void;
  patchTab: (tabId: string, patch: Partial<Tab>) => void;
  saveTab: (tabId: string) => Promise<void>;
  saveTabInto: (tabId: string, collectionId: string, parentId: string | null) => Promise<void>;

  send: (tabId: string, options?: { verifyTls?: boolean; force?: boolean }) => Promise<void>;
  cancel: (tabId: string) => void;
  /** Writes back what a script changed. Public because the runner uses it too. */
  applyScriptChanges: (
    changes: { globals: VariableChanges; collection: VariableChanges; environment: VariableChanges },
    item: ApiItem | null
  ) => Promise<void>;

  setActiveEnvironment: (id: string | null) => void;
  /** Opens an environment as a tab; `"new"` makes one. Null does nothing. */
  openEnvironment: (id: string | null) => void;
  /**
   * The sync tab: what the last pass did, what is queued, and what is moving.
   *
   * A tab rather than the modal, because watching a pass is something you do
   * *while* working — a modal over the whole window is the one arrangement
   * that makes that impossible, and closing it to get back to work is also
   * closing the thing you were watching. There is at most one.
   */
  openSync: () => void;
  patchEnv: (tabId: string, patch: Partial<EnvDraft>) => void;
  saveEnvTab: (tabId: string) => Promise<void>;
  saveEnvironment: (
    id: string | null,
    name: string,
    isGlobal: boolean,
    variables: EnvVariable[]
  ) => Promise<void>;
  saveCollectionScope: (id: string, variables: Variable[]) => Promise<void>;
  /** The chain a tab's request sits in, for the variable strip and the peek. */
  scopesFor: (tabId: string) => Scope[];

  openRunner: (target: RunTarget | null) => void;
  setRunOptions: (options: Partial<Pick<RunState, "iterations" | "delayMs" | "stopOnFailure">>) => void;
  loadRunData: (path: string) => Promise<void>;
  clearRunData: () => void;
  startRun: () => Promise<void>;
  stopRun: () => void;
  exportRun: (path: string) => Promise<void>;

  refreshSync: () => Promise<void>;
  openConnection: (open: boolean) => void;
  syncNow: () => Promise<void>;
  /** Called when a pass finished elsewhere — the timer, or another window. */
  syncFinished: (outcome: SyncOutcome) => Promise<void>;

  openHistory: (entryId: string) => Promise<void>;
  clearHistory: () => Promise<void>;

  /** Keeps the response currently on screen, under this request. */
  saveExample: (tabId: string, name: string) => Promise<void>;
  /**
   * By example id, not by tab: the rail renames and deletes them too, and the
   * same example can be on screen in more than one place at once.
   */
  renameExample: (id: string, name: string) => Promise<void>;
  deleteExample: (id: string) => Promise<void>;
  viewExample: (tabId: string, id: string | null) => void;
  /** Opens the request an example belongs to, showing that example. */
  openExample: (itemId: string, exampleId: string) => Promise<void>;
  renameExampleTab: (tabId: string, name: string) => void;
  saveExampleTab: (tabId: string) => Promise<void>;

  importFiles: (paths: string[]) => Promise<void>;
  importDirectory: (path: string) => Promise<void>;
  exportCollection: (id: string, path: string) => Promise<void>;
  exportEnvironment: (id: string, path: string) => Promise<void>;
  deleteEnvironment: (id: string) => Promise<void>;
  dismissReport: () => void;
  /** Turns a pasted cURL command into the active tab's request. Returns
   * whether it was one. */
  pasteCurl: (tabId: string, text: string) => boolean;
  suggestedFileName: (id: string, kind: "collection" | "environment") => string;
}

/** What one import did, shown once and then dismissed. */
export interface ImportReport {
  files: number;
  collections: number;
  folders: number;
  requests: number;
  environments: number;
  variables: number;
  notes: ImportNote[];
}

/** A request with no auth block of its own inherits, which is the default. */
export const INHERIT: DraftAuth = { type: "inherit", params: {} };

function emptyDraft(): RequestDraft {
  return {
    method: "GET",
    url: "",
    headers: [blankHeader(crypto.randomUUID())],
    body: { mode: "none", text: "", contentType: "application/json" },
    auth: INHERIT,
    settings: {},
    scripts: { prerequest: "", test: "" },
  };
}

function newTab(partial: Partial<Tab> = {}): Tab {
  // Seeded from whatever URL the tab is opening with — a saved request, a
  // history entry, a pasted cURL command — so the Params tab is right the
  // first time it is looked at rather than only after the URL is touched.
  const params =
    partial.params ??
    (partial.draft ? paramsOf(partial.draft.url, () => crypto.randomUUID()) : []);

  return {
    id: crypto.randomUUID(),
    kind: "request",
    itemId: null,
    scopeId: null,
    scope: null,
    savedScope: null,
    scopeTab: "overview",
    env: null,
    savedEnv: null,
    example: null,
    exampleName: "",
    exampleOwner: null,
    name: "Untitled",
    draft: emptyDraft(),
    saved: null,
    response: null,
    error: null,
    sendingId: null,
    received: 0,
    unresolved: [],
    scripts: null,
    examples: [],
    viewingExample: null,
    requestTab: "params",
    responseTab: "body",
    codeTarget: "curl",
    pretty: true,
    wrap: true,
    verifyTls: true,
    ...partial,
    // After the spread: a caller that passed a draft but no params would
    // otherwise have `undefined` put back over the rows computed from it.
    params,
  };
}

/** Whether a tab differs from what its collection holds. */
export function isDirty(tab: Tab): boolean {
  if (tab.kind === "example") {
    // The only editable thing on an example is its name.
    return tab.example !== null && tab.exampleName !== tab.example.name;
  }
  if (tab.kind === "environment") {
    if (!tab.env) return false;
    // A new one is dirty from the start: it does not exist yet, and a save
    // button that looks inert on something unsaved is a lie.
    if (!tab.savedEnv) return true;
    return JSON.stringify(tab.env) !== JSON.stringify(tab.savedEnv);
  }
  if (tab.kind !== "request") {
    if (!tab.scope || !tab.savedScope) return false;
    return JSON.stringify(tab.scope) !== JSON.stringify(tab.savedScope);
  }
  if (!tab.itemId) return tab.draft.url !== "" || tab.draft.body.text !== "";
  if (!tab.saved) return true;
  return JSON.stringify(tab.draft) !== JSON.stringify(tab.saved);
}

/** A name for a request that has never been given one. */
function nameFor(draft: RequestDraft): string {
  const url = draft.url.trim();
  if (url === "") return "Untitled";
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("?")[0]!;
  return path.length > 40 ? `${path.slice(0, 39)}…` : path;
}

export const useApiStore = create<ApiState>((set, get) => {
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Never reused within a session, so a console line's key is stable even
   * after the buffer has dropped the lines below it. */
  let nextLogId = 1;

  /** Writes the open tabs and their drafts, debounced. */
  const persistSession = () => {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      sessionTimer = null;
      const { tabs, activeTabId, expanded, rail, railCollapsed, railWidth, split, splitSizes } =
        get();
      const session: ApiSession = {
        tabs: tabs.map((tab) => ({
          id: tab.id,
          itemId: tab.itemId,
          name: tab.name,
          draft: tab.draft,
          kind: tab.kind,
          scopeId: tab.scopeId,
        })),
        activeTabId,
        expanded: [...expanded],
        activeEnvironmentId: get().activeEnvironmentId,
        rail,
        railCollapsed,
        railWidth,
        split,
        splitSizes,
      };
      void api.saveSession(session).catch(() => {
        // A session that will not write is not worth interrupting anyone over:
        // the tabs are on screen and the requests are in the collection.
      });
    }, SESSION_DEBOUNCE);
  };

  /**
   * Takes a whole snapshot as the new truth — a different workspace.
   *
   * Everything goes: the tree, the environments, the history, and the tabs.
   * A tab belongs to a collection and a collection to one workspace, so
   * keeping them would leave the window pointing at rows it can no longer
   * reach.
   *
   * The tabs come back empty rather than restored from the snapshot's session.
   * The session is stored per workspace and is the right one here, but
   * rebuilding a tab needs the same care `hydrate` takes — a row that has gone,
   * an example whose body is not in the snapshot — and a second copy of that
   * would be a second thing to get wrong. Reopening one is a click in the rail.
   */
  const adopt = (snapshot: ApiSnapshot) => {
    const session = snapshot.session;
    set({
      workspaces: snapshot.workspaces ?? [],
      workspaceId: snapshot.workspaceId,
      collections: snapshot.collections,
      items: snapshot.items,
      history: snapshot.history,
      environments: snapshot.environments ?? [],
      examples: snapshot.examples ?? [],
      expanded: new Set(snapshot.collections.map((collection) => collection.id)),
      // An environment id from the session only counts if this workspace has
      // it: environments are per workspace, and one from the last one would
      // resolve nothing while looking selected.
      activeEnvironmentId:
        snapshot.environments.find(
          (environment) => environment.id === session?.activeEnvironmentId
        )?.id ?? null,
      tabs: [],
      activeTabId: null,
      query: "",
      report: null,
      storeError: null,
    });
  };

  /** Re-reads the tree after a write whose effects are wider than one row. */
  const reload = async () => {
    try {
      const snapshot = await api.bootstrap();
      set({
        workspaces: snapshot.workspaces ?? [],
        workspaceId: snapshot.workspaceId,
        collections: snapshot.collections,
        items: snapshot.items,
        history: snapshot.history,
        environments: snapshot.environments ?? [],
        examples: snapshot.examples ?? [],
      });
    } catch (error) {
      set({ storeError: String(error) });
    }
  };

  /**
   * What the scripts around one send had to say.
   *
   * Shared by the window and the runner, so a failure reads the same either
   * way — a run that reports differently from a single send is a run nobody
   * can compare against one.
   */
  const logScripts = (run: ScriptRun | null, tabId: string | undefined, name: string) => {
    if (!run) return;
    const log = get().log;

    for (const line of run.logs) {
      const level: ConsoleLevel =
        line.level === "error" ? "error" : line.level === "warn" ? "warn" : "info";
      log({ level, source: "script", tabId, text: line.text, detail: name });
    }
    for (const failure of run.errors) {
      log({
        level: "error",
        source: "script",
        tabId,
        text: `The script from ${failure.from} did not finish`,
        detail: failure.message,
      });
    }
    for (const assertion of run.tests) {
      if (assertion.passed) continue;
      log({
        level: "error",
        source: "script",
        tabId,
        text: `${name}: ${assertion.name}`,
        detail: assertion.error ?? undefined,
      });
    }
  };

  /**
   * What an import did.
   *
   * The report panel says the same thing and is dismissed in a second. The
   * console is where it is still readable an hour later, when somebody is
   * working out why a collection is missing two requests.
   */
  const logImport = (report: ImportReport) => {
    const log = get().log;
    log({
      level: report.notes.some((note) => note.level === "error") ? "error" : "info",
      source: "import",
      text: `Imported ${report.collections} collection${report.collections === 1 ? "" : "s"}, ${report.requests} request${report.requests === 1 ? "" : "s"}, ${report.environments} environment${report.environments === 1 ? "" : "s"}`,
      detail: `from ${report.files} file${report.files === 1 ? "" : "s"}`,
    });
    for (const note of report.notes) {
      log({
        level: note.level === "error" ? "error" : note.level === "warning" ? "warn" : "info",
        source: "import",
        text: note.message,
      });
    }
  };

  const updateTab = (tabId: string, patch: Partial<Tab> | ((tab: Tab) => Partial<Tab>)) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, ...(typeof patch === "function" ? patch(tab) : patch) } : tab
      ),
    }));
  };

  return {
    ready: false,
    storeError: null,
    syncError: null,
    collections: [],
    items: [],
    history: [],
    examples: [],
    environments: [],
    activeEnvironmentId: null,
    report: null,
    sync: null,
    connecting: false,
    syncing: false,
    run: {
      open: false,
      target: null,
      iterations: 1,
      delayMs: 0,
      stopOnFailure: false,
      data: null,
      dataName: null,
      running: false,
      done: 0,
      total: 0,
      entries: [],
      report: null,
    },
    console: [],
    consoleOpen: false,
    expanded: new Set<string>(),
    rail: "collections",
    railCollapsed: false,
    split: "bottom",
    splitSizes: DEFAULT_SPLIT,
    query: "",
    railWidth: 240,
    tabs: [],
    activeTabId: null,
    workspaces: [],
    workspaceId: null,

    hydrate: async () => {
      if (get().ready) return;
      try {
        const snapshot = await api.bootstrap();
        const session = snapshot.session;

        /**
         * A saved tab, rebuilt.
         *
         * A folder or collection tab is rebuilt from the row rather than from
         * the session: the row is the truth, and restoring a copy written
         * before another window edited it would quietly reinstate the old
         * values the next time somebody pressed save. A tab whose row has since
         * gone is dropped rather than restored onto nothing.
         */
        const restore = (saved: SessionTab): Tab | null => {
          /*
            An example tab is not restored.

            What it holds is the kept response itself, which this function
            cannot read — it is synchronous, and the bodies are not in the
            snapshot. A hollow one would say "that example is no longer there"
            about an example that is perfectly fine. The rail lists every
            example under its request, so it is one click back.
          */
          if (saved.kind === "example") return null;

          if (
            saved.kind !== "folder" &&
            saved.kind !== "collection" &&
            saved.kind !== "environment"
          ) {
            return newTab({
              id: saved.id,
              itemId: saved.itemId,
              name: saved.name,
              draft: saved.draft,
            });
          }

          if (saved.kind === "environment") {
            // Never restored as "new": an unsaved environment has nothing to
            // rebuild from, and restoring one would be an empty form claiming
            // to be somebody's work.
            const environment = snapshot.environments.find(
              (candidate) => candidate.id === saved.scopeId
            );
            if (!environment) return null;
            const env: EnvDraft = {
              name: environment.name,
              isGlobal: environment.isGlobal,
              variables: environment.variables.map((variable) => ({
                key: variable.key,
                value: variable.value,
                currentValue: variable.currentValue,
                enabled: variable.enabled,
                secret: variable.secret,
              })),
            };
            return newTab({
              id: saved.id,
              kind: "environment",
              scopeId: environment.id,
              name: environment.isGlobal ? "Globals" : environment.name,
              env,
              savedEnv: JSON.parse(JSON.stringify(env)) as EnvDraft,
            });
          }

          const row =
            saved.kind === "collection"
              ? snapshot.collections.find((candidate) => candidate.id === saved.scopeId)
              : snapshot.items.find((candidate) => candidate.id === saved.scopeId);
          if (!row || !saved.scopeId) return null;

          const scope = scopeFrom(row);
          return newTab({
            id: saved.id,
            kind: saved.kind,
            scopeId: saved.scopeId,
            name: row.name,
            scope,
            savedScope: JSON.parse(JSON.stringify(scope)) as ScopeDraft,
          });
        };

        const tabs = (session?.tabs ?? [])
          .map(restore)
          .filter((tab): tab is Tab => tab !== null);

        set({
          workspaces: snapshot.workspaces ?? [],
          workspaceId: snapshot.workspaceId,
          collections: snapshot.collections,
          items: snapshot.items,
          history: snapshot.history,
          environments: snapshot.environments ?? [],
          examples: snapshot.examples ?? [],
          expanded: new Set(session?.expanded ?? snapshot.collections.map((c) => c.id)),
          // Validated rather than cast: a session written by a later version
          // could name a section this one does not have.
          rail: RAIL_VIEWS.includes(session?.rail as RailView)
            ? (session!.rail as RailView)
            : "collections",
          railCollapsed: session?.railCollapsed === true,
          railWidth:
            typeof session?.railWidth === "number" && Number.isFinite(session.railWidth)
              ? Math.max(MIN_RAIL, Math.min(MAX_RAIL, session.railWidth))
              : 240,
          split: readSplit(session?.split),
          splitSizes: {
            bottom: readLayout(session?.splitSizes?.bottom, DEFAULT_SPLIT.bottom),
            right: readLayout(session?.splitSizes?.right, DEFAULT_SPLIT.right),
          },
          // An environment that has since been deleted is not selected, rather
          // than leaving a pointer to nothing that silently resolves nothing.
          activeEnvironmentId:
            snapshot.environments.find(
              (environment) => environment.id === session?.activeEnvironmentId
            )?.id ?? null,
          tabs,
          activeTabId:
            tabs.find((tab) => tab.id === session?.activeTabId)?.id ?? tabs[0]?.id ?? null,
          ready: true,
          storeError: null,
        });

        /*
          A first run opens onto something to type in; every run after it
          opens onto whatever was left.

          This used to be an effect in the window: "no tabs, so make one",
          which meant closing the last tab spawned a replacement in the same
          frame and there was no way to have none. Nobody could clear the
          strip, and the empty state was unreachable. Keyed on the *session*
          rather than on the tab count — a session with no tabs in it is
          somebody who closed them all, and that is an answer.
        */
        if (!session) get().openScratch();

        // What the collection holds, so the dirty dot is honest about a draft
        // restored from the session — and the kept responses, so the strip
        // above the pane has them without waiting to be asked. A tab restored
        // from a session was never opened in this run, and everything
        // `openItem` does on the way in has to be done here too.
        for (const tab of tabs) {
          if (!tab.itemId) continue;

          const examples = await api.examples(tab.itemId).catch(() => []);
          if (examples.length > 0) updateTab(tab.id, { examples });

          const saved = await api.loadRequest(tab.itemId);
          if (!saved) continue;
          const item = snapshot.items.find((row) => row.id === tab.itemId);
          updateTab(tab.id, {
            saved: {
              method: saved.method as HttpMethod,
              url: saved.url,
              headers: saved.headers,
              body: saved.body,
              auth: readAuth(item?.auth) ?? INHERIT,
              settings: saved.settings ?? {},
              scripts: {
                prerequest: scriptFrom(item?.events, "prerequest") ?? "",
                test: scriptFrom(item?.events, "test") ?? "",
              },
            },
          });
        }
      } catch (error) {
        set({ ready: true, storeError: String(error) });
      }
    },

    /**
     * One line in the console.
     *
     * The id comes from a counter rather than from the array's length, because
     * the buffer drops its oldest line once it is full and a length-derived id
     * would start repeating — giving React two children with the same key.
     */
    log: (entry) => {
      set((state) => ({
        console: appendConsole(state.console, entry, nextLogId++, Date.now()),
      }));
    },

    clearConsole: () => set({ console: [] }),

    setSyncError: (message) => set({ syncError: message }),

    toggleConsole: (open) => set((state) => ({ consoleOpen: open ?? !state.consoleOpen })),

    // Clicking the section you are already on collapses the sidebar, the way
    // every icon strip in every editor behaves.
    setRail: (view) => {
      set((state) => ({
        rail: view,
        railCollapsed: state.railCollapsed ? false : state.rail === view,
      }));
      persistSession();
    },

    toggleRail: (collapsed) => {
      set((state) => ({ railCollapsed: collapsed ?? !state.railCollapsed }));
      persistSession();
    },

    /** Clamped here rather than in the drag handler, so a width restored from
     * a session written by a wider window is brought back into range too. */
    setRailWidth: (width) => {
      set({ railWidth: Math.max(MIN_RAIL, Math.min(MAX_RAIL, Math.round(width))) });
      persistSession();
    },

    setSplit: (split) => {
      set({ split });
      persistSession();
    },

    setSplitSize: (split, layout) => {
      set((state) => ({ splitSizes: { ...state.splitSizes, [split]: layout } }));
      persistSession();
    },

    setQuery: (query) => set({ query }),

    toggleExpanded: (id) => {
      set((state) => {
        const expanded = new Set(state.expanded);
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        return { expanded };
      });
      persistSession();
    },

    createCollection: async (name) => {
      try {
        const rank = rankAfter(get().collections);
        const collection = await api.createCollection(name, rank);
        set((state) => ({
          collections: [...state.collections, collection],
          expanded: new Set(state.expanded).add(collection.id),
        }));
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    /*
      Switching workspaces.

      Everything on screen is replaced, tabs included. A tab is a request in a
      collection and a collection belongs to exactly one workspace, so a tab
      carried across would point at a row the new workspace cannot see — and
      saving it would write into the workspace somebody just left.

      The session is written for the workspace being left before the switch, so
      coming back finds the tabs as they were.
    */
    openWorkspace: async (id) => {
      const state = get();
      if (state.workspaceId === id) return;

      try {
        const snapshot = await api.openWorkspace(id);
        adopt(snapshot);
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    createWorkspace: async (name) => {
      const trimmed = name.trim();
      if (trimmed === "") return;
      try {
        adopt(await api.createWorkspace(trimmed));
        get().log({ level: "info", source: "store", text: `Workspace ${trimmed} created` });
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    renameWorkspace: async (id, name) => {
      const trimmed = name.trim();
      if (trimmed === "") return;
      // Optimistic, like every other rename here: the name is on screen before
      // SQLite has been asked, and a failure puts the tree back.
      set({
        workspaces: get().workspaces.map((row) =>
          row.id === id ? { ...row, name: trimmed } : row
        ),
      });
      await api.renameWorkspace(id, trimmed).catch((error) => {
        set({ storeError: String(error) });
        void reload();
      });
    },

    /**
     * Deletes one, and everything in it.
     *
     * Not optimistic: this removes collections, environments and history, and
     * a window that had already drawn the deletion when the write failed would
     * be a window claiming work is gone that is not.
     */
    deleteWorkspace: async (id) => {
      try {
        adopt(await api.deleteWorkspace(id));
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    renameCollection: async (id, name) => {
      set((state) => ({
        collections: state.collections.map((collection) =>
          collection.id === id ? { ...collection, name } : collection
        ),
      }));
      await api.renameCollection(id, name).catch((error) => set({ storeError: String(error) }));
    },

    deleteCollection: async (id) => {
      // Collected before the delete: afterwards these rows are gone from the
      // tree, and there would be nothing left to match the open tabs against.
      const gone = new Set(
        get()
          .items.filter((item) => item.collectionId === id)
          .map((item) => item.id)
      );
      try {
        await api.deleteCollection(id);
      } catch (error) {
        set({ storeError: String(error) });
      }
      await reload();
      // Tabs for requests that no longer exist become scratch tabs rather than
      // closing: the draft is still someone's work.
      //
      // A folder or collection tab closes instead. There is nothing in it that
      // is not on the row, so leaving one open would be an editor pointed at
      // nothing, whose save button would fail every time it was pressed.
      set((state) => {
        const tabs = state.tabs
          .filter(
            (tab) =>
              tab.kind === "request" ||
              !(tab.scopeId && (tab.scopeId === id || gone.has(tab.scopeId)))
          )
          .map((tab) =>
            tab.itemId && gone.has(tab.itemId) ? { ...tab, itemId: null, saved: null } : tab
          );
        return {
          tabs,
          activeTabId: tabs.some((tab) => tab.id === state.activeTabId)
            ? state.activeTabId
            : (tabs[tabs.length - 1]?.id ?? null),
        };
      });
      persistSession();
    },

    createItem: async (collectionId, parentId, kind, name) => {
      try {
        const rank = rankAfter(siblingsOf(get().items, collectionId, parentId));
        const item = await api.createItem({ collectionId, parentId, kind, name, rank });
        set((state) => ({
          items: [...state.items, item],
          expanded: parentId ? new Set(state.expanded).add(parentId) : state.expanded,
        }));
        return item.id;
      } catch (error) {
        set({ storeError: String(error) });
        return null;
      }
    },

    renameItem: async (id, name) => {
      set((state) => ({
        items: state.items.map((item) => (item.id === id ? { ...item, name } : item)),
        tabs: state.tabs.map((tab) => (tab.itemId === id ? { ...tab, name } : tab)),
      }));
      await api.renameItem(id, name).catch((error) => set({ storeError: String(error) }));
      persistSession();
    },

    deleteItem: async (id) => {
      try {
        await api.deleteItem(id);
      } catch (error) {
        set({ storeError: String(error) });
      }
      await reload();
      set((state) => {
        const alive = (rowId: string) => state.items.some((item) => item.id === rowId);
        // As above: a request tab keeps its draft and becomes scratch, a folder
        // tab has nothing of its own to keep and closes.
        const tabs = state.tabs
          .filter((tab) => tab.kind === "request" || !tab.scopeId || alive(tab.scopeId))
          .map((tab) =>
            tab.itemId && !alive(tab.itemId) ? { ...tab, itemId: null, saved: null } : tab
          );
        return {
          tabs,
          activeTabId: tabs.some((tab) => tab.id === state.activeTabId)
            ? state.activeTabId
            : (tabs[tabs.length - 1]?.id ?? null),
        };
      });
      persistSession();
    },

    duplicateItem: async (id) => {
      const item = get().items.find((row) => row.id === id);
      if (!item) return;
      try {
        const rank = rankAfter(siblingsOf(get().items, item.collectionId, item.parentId));
        const made = await api.duplicateItem(id, `${item.name} copy`, rank);
        set((state) => ({ items: [...state.items, ...made] }));
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    moveItem: async (id, collectionId, parentId, index) => {
      const state = get();
      const siblings = siblingsOf(state.items, collectionId, parentId).filter(
        (item) => item.id !== id
      );
      const rank = rankAt(siblings, index);

      set({
        items: state.items.map((item) =>
          item.id === id ? { ...item, collectionId, parentId, rank } : item
        ),
      });
      try {
        await api.moveItem({ id, collectionId, parentId, rank });
        // A folder takes its subtree's collection with it, which is a change
        // this optimistic update cannot make on its own.
        if (state.items.find((item) => item.id === id)?.kind === "folder") await reload();
      } catch (error) {
        set({ storeError: String(error) });
        await reload();
      }
    },

    openItem: async (itemId) => {
      const existing = get().tabs.find((tab) => tab.itemId === itemId);
      if (existing) {
        set({ activeTabId: existing.id });
        persistSession();
        return;
      }

      const item = get().items.find((row) => row.id === itemId);
      if (!item) return;

      let draft = emptyDraft();
      try {
        const saved = await api.loadRequest(itemId);
        if (saved) {
          draft = {
            method: (saved.method || "GET") as HttpMethod,
            url: saved.url,
            headers:
              saved.headers.length > 0
                ? saved.headers
                : [blankHeader(crypto.randomUUID())],
            body: saved.body?.mode
              ? saved.body
              : { mode: "none", text: "", contentType: "application/json" },
            // The auth block lives on the item rather than the request row —
            // folders have one too, and they have no request row.
            auth: readAuth(item.auth) ?? INHERIT,
            settings: saved.settings ?? {},
            scripts: {
              prerequest: scriptFrom(item.events, "prerequest") ?? "",
              test: scriptFrom(item.events, "test") ?? "",
            },
          };
        }
      } catch (error) {
        set({ storeError: String(error) });
      }

      const tab = newTab({
        itemId,
        name: item.name,
        draft,
        saved: JSON.parse(JSON.stringify(draft)) as RequestDraft,
      });
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      persistSession();

      // After the tab is on screen: an example is worth waiting for, but not
      // worth making the request wait.
      const examples = await api.examples(itemId).catch(() => []);
      if (examples.length > 0) updateTab(tab.id, { examples });
    },

    /**
     * A folder or a collection, as a tab.
     *
     * The row itself is the draft: unlike a request, everything a folder holds
     * already came across with the tree, so there is nothing to fetch and the
     * tab opens in the same frame it was clicked in.
     */
    openScope: (kind, id) => {
      const existing = get().tabs.find((tab) => tab.kind === kind && tab.scopeId === id);
      if (existing) {
        set({ activeTabId: existing.id });
        persistSession();
        return;
      }

      const row =
        kind === "collection"
          ? get().collections.find((candidate) => candidate.id === id)
          : get().items.find((candidate) => candidate.id === id);
      if (!row) return;

      const scope = scopeFrom(row);
      const tab = newTab({
        kind,
        scopeId: id,
        name: row.name,
        scope,
        savedScope: JSON.parse(JSON.stringify(scope)) as ScopeDraft,
      });
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      persistSession();
    },

    patchScope: (tabId, patch) => {
      updateTab(tabId, (tab) => ({
        scope: { ...(tab.scope ?? emptyScope()), ...patch },
        // The strip follows the name as it is typed, the way a request tab
        // follows its URL.
        name:
          patch.name !== undefined && patch.name.trim() !== ""
            ? patch.name
            : tab.name,
      }));
      persistSession();
    },

    saveScope: async (tabId) => {
      const tab = get().tabs.find((row) => row.id === tabId);
      if (!tab || tab.kind === "request" || !tab.scope || !tab.scopeId) return;

      const id = tab.scopeId;
      const existing =
        tab.kind === "collection"
          ? get().collections.find((row) => row.id === id)
          : get().items.find((row) => row.id === id);

      // The row may have been deleted in another window while this tab sat
      // open. Writing would create nothing and report success.
      if (!existing) {
        set({ storeError: "That folder is no longer there." });
        return;
      }

      const written = scopeTo(tab.scope, existing.events);
      try {
        if (tab.kind === "collection") await api.saveCollectionOverview({ id, ...written });
        else await api.saveItemScope({ id, ...written });
      } catch (error) {
        set({ storeError: String(error) });
        return;
      }

      await reload();
      updateTab(tabId, {
        name: written.name,
        savedScope: JSON.parse(JSON.stringify(tab.scope)) as ScopeDraft,
      });
      persistSession();
    },

    openScratch: () => {
      const tab = newTab();
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      persistSession();
    },

    closeTabs: (keep) => {
      const { tabs } = get();
      for (const tab of tabs) {
        // Anything in flight is cancelled rather than left running with
        // nowhere to report back to.
        if (tab.id !== keep && tab.sendingId) void cancelRequest(tab.sendingId);
      }
      const left = keep ? tabs.filter((tab) => tab.id === keep) : [];
      set({ tabs: left, activeTabId: left[0]?.id ?? null });
      persistSession();
    },

    closeTab: (tabId) => {
      const { tabs, activeTabId } = get();
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) return;

      const closing = tabs[index]!;
      if (closing.sendingId) void cancelRequest(closing.sendingId);

      const left = tabs.filter((tab) => tab.id !== tabId);
      set({
        tabs: left,
        activeTabId:
          activeTabId === tabId ? (left[index] ?? left[index - 1])?.id ?? null : activeTabId,
      });
      persistSession();
    },

    setActiveTab: (tabId) => {
      set({ activeTabId: tabId });
      persistSession();
    },

    patchDraft: (tabId, patch) => {
      updateTab(tabId, (tab) => ({
        draft: { ...tab.draft, ...patch },
        unresolved: [],
        // A URL that changed took the query with it, so the table follows.
        // `syncParams` returns the very same array when nothing about the
        // query moved, which is what stops the Params tab re-rendering on
        // every keystroke somewhere else in the URL.
        params:
          patch.url === undefined
            ? tab.params
            : syncParams(patch.url, tab.params, () => crypto.randomUUID()),
      }));
      persistSession();
    },

    /**
     * The other direction: the table wrote, so the URL follows.
     *
     * The rows are kept as given — including the unticked ones, which is the
     * only reason they are stored at all — and the URL is rebuilt from the
     * ones that will actually be sent.
     */
    setParams: (tabId, params) => {
      updateTab(tabId, (tab) => ({
        params,
        draft: { ...tab.draft, url: withParams(tab.draft.url, params) },
        unresolved: [],
      }));
      persistSession();
    },

    patchTab: (tabId, patch) => {
      updateTab(tabId, patch);
      if ("name" in patch || "itemId" in patch) persistSession();
    },

    saveTab: async (tabId) => {
      const tab = get().tabs.find((row) => row.id === tabId);
      // ⌘S means "save this tab" whatever the tab is, so the shortcut and the
      // button have one entry point rather than a case each.
      if (tab?.kind === "example") {
        await get().saveExampleTab(tabId);
        return;
      }
      if (tab?.kind === "environment") {
        await get().saveEnvTab(tabId);
        return;
      }
      if (tab && tab.kind !== "request") {
        await get().saveScope(tabId);
        return;
      }
      if (!tab?.itemId) return;
      try {
        await api.saveRequest({
          itemId: tab.itemId,
          method: tab.draft.method,
          url: tab.draft.url,
          headers: tab.draft.headers,
          body: tab.draft.body,
          settings: tab.draft.settings,
        });
        const itemId = tab.itemId;
        const auth = writeAuth(tab.draft.auth);
        await api.saveItemAuth(itemId, auth);

        const item = get().items.find((row) => row.id === itemId);
        const events = eventsWith(item?.events, tab.draft.scripts);
        await api.saveItemEvents(itemId, events);
        updateTab(tabId, (current) => ({
          saved: JSON.parse(JSON.stringify(current.draft)) as RequestDraft,
        }));
        // The rail draws the method and URL, so it has to hear about this.
        set((state) => ({
          items: state.items.map((item) =>
            item.id === itemId
              ? { ...item, method: tab.draft.method, url: tab.draft.url, auth, events }
              : item
          ),
        }));
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    saveTabInto: async (tabId, collectionId, parentId) => {
      const tab = get().tabs.find((row) => row.id === tabId);
      if (!tab) return;
      const name = tab.name === "Untitled" ? nameFor(tab.draft) : tab.name;

      const itemId = await get().createItem(collectionId, parentId, "request", name);
      if (!itemId) return;

      updateTab(tabId, { itemId, name });
      await get().saveTab(tabId);
      persistSession();
    },

    send: async (tabId, options = {}) => {
      const state = get();
      const tab = state.tabs.find((row) => row.id === tabId);
      if (!tab) return;

      if (tab.sendingId) void cancelRequest(tab.sendingId);
      const item = tab.itemId
        ? state.items.find((row) => row.id === tab.itemId) ?? null
        : null;

      // A placeholder while the pre-request scripts run: they can take a moment
      // and the window should not look asleep.
      updateTab(tabId, {
        sendingId: "scripts",
        error: null,
        response: null,
        received: 0,
        unresolved: [],
        responseTab: "body",
      });

      let cancelId: string | null = null;
      const outcome = await executeRequest({
        item,
        items: state.items,
        collections: state.collections,
        environments: state.environments,
        activeEnvironmentId: state.activeEnvironmentId,
        draft: tab.draft,
        name: tab.name,
        force: options.force,
        verifyTls: options.verifyTls ?? tab.verifyTls,
        onSending: (input) => {
          cancelId = input.id;
          updateTab(tabId, { sendingId: input.id });
        },
      });

      // The tab may have been closed, or sent again, while this was in flight.
      const current = get().tabs.find((row) => row.id === tabId);
      if (!current || (cancelId !== null && current.sendingId !== cancelId)) return;

      await get().applyScriptChanges(outcome.changes, item);
      logScripts(outcome.scripts, tabId, tab.name);

      if (outcome.unresolved.length > 0) {
        // The one case where nothing goes on the wire at all. Without a line
        // here, a blocked send looks like a send that vanished.
        get().log({
          level: "warn",
          source: "request",
          tabId,
          text: `${tab.name} was not sent`,
          detail: `No value for ${outcome.unresolved.map((name) => `{{${name}}}`).join(", ")}`,
        });
        updateTab(tabId, {
          sendingId: null,
          unresolved: outcome.unresolved,
          error: null,
          scripts: outcome.scripts,
        });
        return;
      }

      const cancelled = outcome.error?.kind === "cancelled";

      if (outcome.error && !cancelled) {
        get().log({
          level: "error",
          source: "request",
          tabId,
          text: `${outcome.input?.method ?? tab.draft.method} ${outcome.input?.url ?? tab.draft.url} failed`,
          detail: `${outcome.error.kind}: ${outcome.error.message}`,
        });
      } else if (outcome.response) {
        const { status, statusText, timing, body } = outcome.response;
        get().log({
          // A 4xx or 5xx is not an error in this window — the request worked
          // and the server said no — but it is what somebody scanning the log
          // is looking for, so it is coloured.
          level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
          source: "request",
          tabId,
          text: `${outcome.input?.method ?? ""} ${outcome.response.finalUrl || outcome.input?.url || ""}`.trim(),
          detail: `${status} ${statusText} · ${formatDuration(timing.totalMs)} · ${formatBytes(body.bytes)}`,
        });
      }

      updateTab(tabId, {
        sendingId: null,
        response: outcome.response,
        error: cancelled ? null : outcome.error,
        scripts: outcome.scripts,
        verifyTls: options.verifyTls ?? tab.verifyTls,
        // A run with assertions in it opens on them: the answer people want
        // from a tested request is whether it passed.
        responseTab: (outcome.scripts?.tests.length ?? 0) > 0 ? "tests" : "body",
      });

      if (cancelled || !outcome.input) return;

      try {
        const { text, base64, ...meta } = outcome.response?.body ?? {};
        const stored: StoredResponse | null = outcome.response
          ? { ...outcome.response, body: meta as StoredResponse["body"] }
          : null;
        await api.addHistory(
          {
            itemId: current.itemId,
            method: outcome.input.method,
            url: outcome.input.url,
            status: outcome.response?.status ?? null,
            durationMs: outcome.response?.timing.totalMs ?? null,
            sizeBytes: outcome.response?.body.bytes ?? null,
            error: outcome.error?.message ?? null,
            request: outcome.input,
            response: stored,
          },
          text ?? base64 ?? null
        );
        set({ history: await api.listHistory(100) });
      } catch {
        // History is a convenience. A send that worked must not be reported as
        // having failed because the log of it could not be written.
      }
    },

    /**
     * Writes back what a script changed.
     *
     * Environments and globals are rows; a collection's variables are a JSON
     * column. Both are written whole, because that is how they are stored, and
     * a script that set one variable has not touched the others.
     */
    applyScriptChanges: async (changes, item) => {
      const state = get();

      const writeEnvironment = async (environment: ApiEnvironment | undefined, updates: Record<string, string | null>) => {
        if (!environment || Object.keys(updates).length === 0) return;
        // A script sets the **current** value, never the initial one. A token
        // a pre-request script fetched belongs to this machine and this hour;
        // writing it into the initial value would export it with the
        // collection and push it to everybody else.
        const variables: EnvVariable[] = environment.variables
          .filter((variable) => updates[variable.key] !== null)
          .map((variable) => ({
            key: variable.key,
            value: variable.value,
            currentValue:
              variable.key in updates
                ? (updates[variable.key] as string)
                : variable.currentValue,
            enabled: variable.enabled,
            secret: variable.secret,
          }));

        for (const [key, value] of Object.entries(updates)) {
          if (value === null) continue;
          if (!variables.some((variable) => variable.key === key)) {
            // A name the environment did not have. The initial value stays
            // empty, so what is shared is the name and not the secret.
            variables.push({ key, value: "", currentValue: value, enabled: true, secret: false });
          }
        }

        await get().saveEnvironment(
          environment.id,
          environment.name,
          environment.isGlobal,
          variables
        );
      };

      await writeEnvironment(
        state.environments.find((environment) => environment.id === state.activeEnvironmentId),
        changes.environment
      );
      await writeEnvironment(
        state.environments.find((environment) => environment.isGlobal),
        changes.globals
      );

      if (item && Object.keys(changes.collection).length > 0) {
        const collection = state.collections.find(
          (candidate) => candidate.id === item.collectionId
        );
        if (collection) {
          const variables = variablesFrom(collection.variables).filter(
            (variable) => changes.collection[variable.key] !== null
          );
          for (const [key, value] of Object.entries(changes.collection)) {
            if (value === null) continue;
            const existing = variables.find((variable) => variable.key === key);
            if (existing) existing.value = value;
            else variables.push({ key, value, enabled: true });
          }
          await get().saveCollectionScope(collection.id, variables);
        }
      }
    },

    cancel: (tabId) => {
      const tab = get().tabs.find((row) => row.id === tabId);
      if (tab?.sendingId) void cancelRequest(tab.sendingId);
    },

    openHistory: async (entryId) => {
      const entry = get().history.find((row) => row.id === entryId);
      if (!entry) return;

      const headers: HeaderRow[] = entry.request.headers.map((header) => ({
        id: crypto.randomUUID(),
        name: header.name,
        value: header.value,
        enabled: true,
      }));
      const body: RequestBody =
        entry.request.body.mode === "raw"
          ? { mode: "raw", text: entry.request.body.text, contentType: "application/json" }
          : { mode: "none", text: "", contentType: "application/json" };

      const tab = newTab({
        name: entry.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""),
        draft: {
          method: entry.request.method as HttpMethod,
          url: entry.request.url,
          headers: [...headers, blankHeader(crypto.randomUUID())],
          body,
          // Whatever auth the original send used is already baked into the
          // headers it recorded, so replaying it must not apply a second one.
          auth: { type: "noauth", params: {} },
          settings: {},
          scripts: { prerequest: "", test: "" },
        },
      });

      // The response as it was, body and all, so a history entry opens into
      // something you can read rather than an empty pane.
      if (entry.response) {
        const text = entry.hasBody ? await api.historyBody(entryId).catch(() => null) : null;
        tab.response = {
          ...entry.response,
          body: { ...entry.response.body, text, base64: null },
        };
      } else if (entry.error) {
        tab.error = { kind: "other", message: entry.error };
      }

      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id, rail: "collections" }));
      persistSession();
    },

    clearHistory: async () => {
      try {
        await api.clearHistory();
        set({ history: [] });
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    // ─── Interchange ───────────────────────────────────────────────────────

    importFiles: async (paths) => {
      const report: ImportReport = {
        files: 0,
        collections: 0,
        folders: 0,
        requests: 0,
        environments: 0,
        variables: 0,
        notes: [],
      };

      for (const path of paths) {
        const name = path.split(/[\\/]/).pop() ?? path;
        report.files++;

        let outcome: ImportOutcome;
        try {
          outcome = readDocument(await api.readFile(path), name);
        } catch (error) {
          report.notes.push({ level: "error", message: `${name} could not be read: ${error}` });
          continue;
        }

        report.notes.push(...outcome.notes);
        report.folders += outcome.counts.folders;
        report.requests += outcome.counts.requests;
        report.variables += outcome.counts.variables;

        // One collection at a time, each in its own transaction: a file that
        // fails should not take the five that already worked down with it.
        for (const collection of outcome.collections) {
          try {
            await api.importCollection({ ...collection, rank: rankAfter(get().collections) });
            report.collections++;
          } catch (error) {
            report.notes.push({
              level: "error",
              message: `"${collection.name}" from ${name} was not imported: ${error}`,
            });
          }
          // Reloaded between collections so the next rank is computed against
          // what is actually there.
          await reload();
        }

        for (const environment of outcome.environments) {
          try {
            await api.importEnvironment(environment);
            report.environments++;
          } catch (error) {
            report.notes.push({
              level: "error",
              message: `"${environment.name}" from ${name} was not imported: ${error}`,
            });
          }
        }
      }

      await reload();
      logImport(report);
      set((state) => ({
        report,
        // Everything that arrived is opened, so an import is visibly an import
        // rather than a rail that looks unchanged.
        expanded: new Set([...state.expanded, ...state.collections.map((c) => c.id)]),
        rail: "collections",
      }));
    },

    importDirectory: async (path) => {
      try {
        const files = await api.listJsonFiles(path);
        if (files.length === 0) {
          set({
            report: {
              files: 0,
              collections: 0,
              folders: 0,
              requests: 0,
              environments: 0,
              variables: 0,
              notes: [{ level: "warning", message: "That folder holds no .json files." }],
            },
          });
          return;
        }
        await get().importFiles(files);
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    exportCollection: async (id, path) => {
      try {
        const bundle = await api.exportCollection(id);
        await api.writeFile(path, writeCollectionFile(bundle));
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    exportEnvironment: async (id, path) => {
      const environment = get().environments.find((row) => row.id === id);
      if (!environment) return;
      try {
        await api.writeFile(path, writeEnvironmentFile(environment));
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    deleteEnvironment: async (id) => {
      set((state) => {
        // A tab pointed at it closes too: there is nothing in one that is not
        // on the row, so leaving it open would be an editor pointed at
        // nothing whose save would fail every time.
        const tabs = state.tabs.filter(
          (tab) => !(tab.kind === "environment" && tab.scopeId === id)
        );
        return {
          environments: state.environments.filter((row) => row.id !== id),
          tabs,
          activeTabId: tabs.some((tab) => tab.id === state.activeTabId)
            ? state.activeTabId
            : (tabs[tabs.length - 1]?.id ?? null),
          // Nothing resolves from a deleted environment.
          activeEnvironmentId:
            state.activeEnvironmentId === id ? null : state.activeEnvironmentId,
        };
      });
      await api.deleteEnvironment(id).catch((error) => set({ storeError: String(error) }));
      persistSession();
    },

    dismissReport: () => set({ report: null }),

    /**
     * A pasted cURL command becomes the request.
     *
     * Checked before anything is replaced, and it returns false for a paste
     * that is not one — so pasting an ordinary URL into the bar stays a paste
     * into the bar.
     */
    pasteCurl: (tabId, text) => {
      if (!looksLikeCurl(text)) return false;
      const parsed = parseCurl(text);
      if (!parsed) return false;

      const tab = get().tabs.find((row) => row.id === tabId);
      if (!tab) return false;

      updateTab(tabId, (current) => ({
        draft: {
          ...current.draft,
          method: parsed.method,
          url: parsed.url,
          headers: [...parsed.headers, blankHeader(crypto.randomUUID())],
          body: parsed.body,
        },
        name: current.itemId ? current.name : nameFor({ ...current.draft, url: parsed.url }),
        // A pasted command replaces the URL wholesale, so the query table is
        // read from the new one rather than merged with the old one's — none
        // of those rows describe this request any more.
        params: paramsOf(parsed.url, () => crypto.randomUUID()),
        requestTab: parsed.body.mode === "raw" ? "body" : "headers",
      }));
      persistSession();

      if (parsed.notes.length > 0) {
        set({
          report: {
            files: 0,
            collections: 0,
            folders: 0,
            requests: 1,
            environments: 0,
            variables: 0,
            notes: parsed.notes.map((message) => ({ level: "warning" as const, message })),
          },
        });
      }
      return true;
    },

    // ─── Examples ──────────────────────────────────────────────────────────

    saveExample: async (tabId, name) => {
      const tab = get().tabs.find((row) => row.id === tabId);
      if (!tab?.itemId || !tab.response) return;

      const { itemId, response } = tab;
      const rank = rankAfter(tab.examples);
      const label = name.trim() === "" ? `${response.status} ${response.statusText}` : name;

      try {
        const id = await api.saveExample({
          itemId,
          rank,
          example: {
            name: label,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.body.text,
          },
        });
        const examples = await api.examples(itemId);
        updateTab(tabId, { examples });

        // Into the rail's index too, with the request expanded, so the row
        // appears under it rather than behind a twisty nobody knows to press.
        set((state) => ({
          examples: [...state.examples, { id, itemId, name: label, status: response.status, rank }],
          expanded: new Set(state.expanded).add(itemId),
        }));
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    // Both of these touch two places: the index the rail draws from, and any
    // open tab that is also showing the example. Missing either leaves a row
    // on screen that no longer exists.
    renameExample: async (id, name) => {
      set((state) => ({
        examples: state.examples.map((example) =>
          example.id === id ? { ...example, name } : example
        ),
        tabs: state.tabs.map((tab) => ({
          ...tab,
          examples: tab.examples.map((example) =>
            example.id === id ? { ...example, name } : example
          ),
        })),
      }));
      await api.renameExample(id, name).catch((error) => set({ storeError: String(error) }));
    },

    deleteExample: async (id) => {
      set((state) => ({
        examples: state.examples.filter((example) => example.id !== id),
        // A tab showing the one that has gone closes: there is nothing in it
        // that is not the example.
        tabs: state.tabs
          // The example tab closes with the example it was showing: there is
          // nothing in it that is not the example.
          .filter((tab) => !(tab.kind === "example" && tab.example?.id === id))
          .map((tab) => ({
            ...tab,
            examples: tab.examples.filter((example) => example.id !== id),
            viewingExample: tab.viewingExample === id ? null : tab.viewingExample,
          })),
      }));
      await api.deleteExample(id).catch((error) => set({ storeError: String(error) }));
    },

    viewExample: (tabId, id) => updateTab(tabId, { viewingExample: id }),

    /**
     * An example, in the one tab examples get.
     *
     * A second example does not make a second tab — it replaces what is in
     * this one. A request with six kept responses is ordinary, and a tab
     * apiece turns reading them into housekeeping: six tabs all named after
     * the same request, which is what opening three examples used to do.
     *
     * The request's own tab is left alone, so the live response and a kept one
     * can be on screen at the same time.
     */
    openExample: async (itemId, exampleId) => {
      // Already showing it: nothing to read, nothing to replace.
      const showing = get().tabs.find(
        (tab) => tab.kind === "example" && tab.example?.id === exampleId
      );
      if (showing) {
        set({ activeTabId: showing.id });
        persistSession();
        return;
      }

      // The rail's index carries names and statuses and no bodies, on purpose,
      // so the whole example is read here.
      const examples = await api.examples(itemId).catch(() => []);
      const example = examples.find((row) => row.id === exampleId);
      if (!example) {
        set({ storeError: "That example is no longer there." });
        return;
      }

      const existing = get().tabs.find((tab) => tab.kind === "example");
      if (existing) {
        updateTab(existing.id, {
          example,
          exampleName: example.name,
          exampleOwner: itemId,
          name: example.name,
        });
        set({ activeTabId: existing.id });
        persistSession();
        return;
      }

      const tab = newTab({
        kind: "example",
        example,
        exampleName: example.name,
        exampleOwner: itemId,
        name: example.name,
      });
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      persistSession();
    },

    renameExampleTab: (tabId, name) => {
      updateTab(tabId, { exampleName: name, name: name.trim() === "" ? "Example" : name });
      persistSession();
    },

    saveExampleTab: async (tabId) => {
      const tab = get().tabs.find((row) => row.id === tabId);
      if (!tab || tab.kind !== "example" || !tab.example) return;

      const name = tab.exampleName.trim() === "" ? "Example" : tab.exampleName.trim();
      await get().renameExample(tab.example.id, name);
      updateTab(tabId, { name, exampleName: name, example: { ...tab.example, name } });
      persistSession();
    },

    // ─── Variables and scopes ──────────────────────────────────────────────

    setActiveEnvironment: (id) => {
      set({ activeEnvironmentId: id });
      // Every open tab's unresolved list was computed against the old
      // environment, so it no longer means anything.
      set((state) => ({ tabs: state.tabs.map((tab) => ({ ...tab, unresolved: [] })) }));
      persistSession();
    },

    /**
     * An environment, as a tab.
     *
     * A tab rather than the modal it used to be: editing an environment is
     * something you do *while* looking at the request that needs it, and a
     * sheet over the whole window is the one arrangement that makes that
     * impossible.
     */
    openSync: () => {
      const existing = get().tabs.find((tab) => tab.kind === "sync");
      if (existing) {
        set({ activeTabId: existing.id });
        persistSession();
        return;
      }

      const tab = newTab({ kind: "sync", name: "Sync" });
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
      persistSession();
    },

    openEnvironment: (id) => {
      if (id === null) return;

      const existing = get().tabs.find(
        (tab) => tab.kind === "environment" && tab.scopeId === id
      );
      if (existing) {
        set({ activeTabId: existing.id, rail: "environments" });
        persistSession();
        return;
      }

      const row = id === "new" ? null : get().environments.find((e) => e.id === id);
      if (id !== "new" && !row) return;

      const env: EnvDraft = row
        ? {
            name: row.name,
            isGlobal: row.isGlobal,
            variables: row.variables.map((variable) => ({
              key: variable.key,
              value: variable.value,
              currentValue: variable.currentValue,
              enabled: variable.enabled,
              secret: variable.secret,
            })),
          }
        : { name: "New environment", isGlobal: false, variables: [] };

      const tab = newTab({
        kind: "environment",
        scopeId: id,
        name: env.isGlobal ? "Globals" : env.name,
        env,
        // Null for a new one, which is what makes it dirty from the start.
        savedEnv: row ? (JSON.parse(JSON.stringify(env)) as EnvDraft) : null,
      });
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      persistSession();
    },

    patchEnv: (tabId, patch) => {
      updateTab(tabId, (tab) => ({
        env: { ...(tab.env ?? { name: "", isGlobal: false, variables: [] }), ...patch },
        name:
          patch.name !== undefined && patch.name.trim() !== "" && !tab.env?.isGlobal
            ? patch.name
            : tab.name,
      }));
      persistSession();
    },

    saveEnvTab: async (tabId) => {
      const tab = get().tabs.find((row) => row.id === tabId);
      if (!tab || tab.kind !== "environment" || !tab.env) return;

      const name = tab.env.name.trim() === "" ? "Environment" : tab.env.name.trim();
      // Blank rows are scaffolding for typing into, not variables.
      const variables = tab.env.variables.filter(
        (variable) => variable.key.trim() !== ""
      );

      try {
        const id = await api.saveEnvironment({
          id: tab.scopeId === "new" ? null : tab.scopeId,
          name,
          isGlobal: tab.env.isGlobal,
          variables: variables.map((variable) => ({
            ...variable,
            key: variable.key.trim(),
          })),
        });
        await reload();
        // A new one now has a real id, so the tab stops being "new" — without
        // this, saving twice would create a second environment.
        updateTab(tabId, (current) => ({
          scopeId: id,
          name: current.env?.isGlobal ? "Globals" : name,
          env: current.env ? { ...current.env, name } : current.env,
          savedEnv: current.env
            ? (JSON.parse(JSON.stringify({ ...current.env, name })) as EnvDraft)
            : null,
        }));
      } catch (error) {
        set({ storeError: String(error) });
      }
      persistSession();
    },

    saveEnvironment: async (id, name, isGlobal, variables) => {
      try {
        // Written whole, secret flags and current values included. This used
        // to force `secret: false` on every row, which silently un-marked
        // every secret an import had brought in the first time anybody saved.
        await api.saveEnvironment({ id, name, isGlobal, variables });
      } catch (error) {
        set({ storeError: String(error) });
      }
      await reload();
    },

    saveCollectionScope: async (id, variables) => {
      const collection = get().collections.find((row) => row.id === id);
      if (!collection) return;
      const written = variablesTo(variables);
      set((state) => ({
        collections: state.collections.map((row) =>
          row.id === id ? { ...row, variables: written } : row
        ),
      }));
      await api
        .saveCollectionScope(id, collection.auth ?? null, written)
        .catch((error) => set({ storeError: String(error) }));
    },

    scopesFor: (tabId) => {
      const state = get();
      const tab = state.tabs.find((row) => row.id === tabId);
      const item = tab?.itemId
        ? state.items.find((row) => row.id === tab.itemId) ?? null
        : null;
      return buildScopes({
        item,
        items: state.items,
        collections: state.collections,
        environments: state.environments,
        activeEnvironmentId: state.activeEnvironmentId,
      });
    },

    // ─── The runner ────────────────────────────────────────────────────────

    openRunner: (target) =>
      set((state) => ({
        run: {
          ...state.run,
          open: target !== null,
          target: target ?? state.run.target,
          // A new target starts a fresh run rather than showing the last one's
          // answers under a different name.
          ...(target && target.id !== state.run.target?.id
            ? { entries: [], report: null, done: 0, total: 0 }
            : {}),
        },
      })),

    setRunOptions: (options) =>
      set((state) => ({ run: { ...state.run, ...options } })),

    loadRunData: async (path) => {
      try {
        const text = await api.readFile(path);
        const name = path.split(/[\\/]/).pop() ?? path;
        set((state) => ({
          run: { ...state.run, data: readDataFile(text, name), dataName: name },
        }));
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    clearRunData: () =>
      set((state) => ({ run: { ...state.run, data: null, dataName: null } })),

    stopRun: () => set((state) => ({ run: { ...state.run, running: false } })),

    startRun: async () => {
      const state = get();
      const target = state.run.target;
      if (!target || state.run.running) return;

      const items = requestsUnder(state.items, target);
      if (items.length === 0) {
        set((current) => ({
          run: { ...current.run, entries: [], report: null, done: 0, total: 0 },
          storeError: `${target.name} has no requests in it.`,
        }));
        return;
      }

      // Every request's saved contents, read before the run starts: a run of
      // fifty should not be fifty round trips to the database interleaved with
      // fifty to the network.
      const requests = [];
      for (const item of items) {
        const saved = await api.loadRequest(item.id).catch(() => null);
        requests.push({
          item,
          name: item.name,
          draft: {
            method: (saved?.method || "GET") as HttpMethod,
            url: saved?.url ?? "",
            headers: saved?.headers ?? [],
            body: saved?.body?.mode
              ? saved.body
              : { mode: "none" as const, text: "", contentType: "application/json" },
            auth: readAuth(item.auth) ?? INHERIT,
            settings: saved?.settings ?? {},
            scripts: {
              prerequest: scriptFrom(item.events, "prerequest") ?? "",
              test: scriptFrom(item.events, "test") ?? "",
            },
          },
        });
      }

      set((current) => ({
        run: { ...current.run, running: true, entries: [], report: null, done: 0, total: 0 },
      }));
      get().log({
        level: "info",
        source: "runner",
        text: `Running ${target.name}`,
        detail: `${items.length} request${items.length === 1 ? "" : "s"}`,
      });

      const report = await runCollection({
        requests,
        items: state.items,
        collections: state.collections,
        environments: state.environments,
        activeEnvironmentId: state.activeEnvironmentId,
        target: target.name,
        iterations: state.run.iterations,
        delayMs: state.run.delayMs,
        stopOnFailure: state.run.stopOnFailure,
        data: state.run.data?.rows ?? [],
        onChanges: (changes, item) => get().applyScriptChanges(changes, item),
        onProgress: (entry, done, total) => {
          set((current) => ({
            run: { ...current.run, entries: [...current.run.entries, entry], done, total },
          }));
          // Only what went wrong. A hundred passing requests would push
          // everything else out of a five-hundred-line buffer, and they are
          // already listed, in order, in the runner panel.
          if (entry.error || entry.failed > 0) {
            get().log({
              level: "error",
              source: "runner",
              text: `${entry.name} — ${entry.method} ${entry.url}`,
              detail:
                entry.error ??
                entry.tests
                  .filter((assertion) => !assertion.passed)
                  .map((assertion) => `${assertion.name}: ${assertion.error ?? "failed"}`)
                  .join("; "),
            });
          }
        },
        // Read fresh each time rather than captured: Stop sets it while the
        // run is in the middle of a request.
        shouldStop: () => !get().run.running,
      });

      set((current) => ({ run: { ...current.run, running: false, report } }));
      get().log({
        level: report.failed > 0 || report.errored > 0 ? "error" : "info",
        source: "runner",
        text: `${target.name} finished — ${report.passed} passed, ${report.failed} failed`,
        detail: report.stoppedBecause ?? `${report.entries.length} sent`,
      });
      // A run's scripts may have set variables, and its requests are in the
      // history now.
      set({ history: await api.listHistory(100).catch(() => get().history) });
    },

    exportRun: async (path) => {
      const report = get().run.report;
      if (!report) return;
      try {
        await api.writeFile(path, reportToJson(report));
      } catch (error) {
        set({ storeError: String(error) });
      }
    },

    // ─── Sync ──────────────────────────────────────────────────────────────

    refreshSync: async () => {
      try {
        set({ sync: await sync.status(), syncError: null });
      } catch (error) {
        // A status panel that cannot be read is not worth a banner over the
        // whole window; the panel says so when it is opened.
        set({ syncError: String(error) });
      }
    },

    openConnection: (open) => set({ connecting: open }),

    syncNow: async () => {
      if (get().syncing) return;
      set({ syncing: true });
      try {
        const outcome = await sync.now();
        await get().syncFinished(outcome);
        set({ syncError: null });
      } catch (error) {
        // Not `storeError`: a pass that could not run has nothing to do with
        // whether the collections opened, and saying otherwise sends people
        // looking for a corrupt database that is fine.
        const message = String(error);
        set({ syncError: message });
        get().log({
          level: "error",
          source: "sync",
          text: "Sync could not run",
          detail: message,
        });
      } finally {
        set({ syncing: false });
      }
    },

    syncFinished: async (outcome) => {
      // Anything may have arrived, so the tree is re-read rather than patched.
      // Open tabs keep their drafts: they are the session's, not the tree's.
      if (outcome.pulled > 0) await reload();
      await get().refreshSync();

      // A pass that pushed and pulled nothing is the one worth being able to
      // see: it is indistinguishable from a pass that never ran.
      get().log({
        level: outcome.error ? "error" : outcome.conflicts > 0 ? "warn" : "info",
        source: "sync",
        text: outcome.error
          ? "Sync failed"
          : `Synced — ${outcome.pushed} up, ${outcome.pulled} down`,
        detail:
          outcome.error ??
          ([
            outcome.conflicts > 0 ? `${outcome.conflicts} conflicted` : null,
            outcome.pending > 0 ? `${outcome.pending} still queued` : null,
          ]
            .filter(Boolean)
            .join(", ") ||
            undefined),
      });
    },

    suggestedFileName: (id, kind) => {
      if (kind === "environment") {
        const environment = get().environments.find((row) => row.id === id);
        return environment ? environmentFileName(environment) : "environment.json";
      }
      const collection = get().collections.find((row) => row.id === id);
      return collectionFileName(collection?.name ?? "collection");
    },
  };
});
