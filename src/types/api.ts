/**
 * The API client's wire types, mirroring `src-tauri/src/http/mod.rs`.
 *
 * Both sides of `api_send` are described here and nowhere else, so a field
 * renamed in Rust fails the typecheck rather than arriving as `undefined` in a
 * response pane. Serde is set to camelCase over there for the same reason:
 * one spelling, both languages.
 */

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A header as the editor holds it: with an id to key the row, and a tick. */
export interface HeaderRow {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}

export type BodyMode = "none" | "raw" | "urlencoded" | "formdata" | "file" | "graphql";

/** One field of a form or multipart body. */
export interface BodyField {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  /** Multipart only: a part whose content is a file on disk. */
  kind: "text" | "file";
  filePath?: string;
  /** Sent for this part when it should not be guessed. */
  contentType?: string;
}

/** The body as the editor holds it.
 *
 * Every mode's state is kept, not just the active one's: switching from a form
 * to raw and back must not empty the form, and a stray click on the selector
 * should cost nothing. Only the mode decides what is sent. */
export interface RequestBody {
  mode: BodyMode;
  /** Raw text, and the query for a GraphQL body. */
  text: string;
  /** Sent as `Content-Type` unless a header already sets one, and unless the
   * mode implies its own (a form is form-encoded whatever this says). */
  contentType: string;
  /** Form and multipart fields. */
  fields?: BodyField[];
  /** The file whose contents are the whole body. */
  filePath?: string;
  /** GraphQL variables, as JSON text. */
  graphqlVariables?: string;
}

export interface SendOptions {
  /** 0 means no limit. */
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
  maxBodyBytes: number;
}

export const DEFAULT_SEND_OPTIONS: SendOptions = {
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 10,
  verifyTls: true,
  maxBodyBytes: 32 * 1024 * 1024,
};

/** One field as it crosses to Rust: no id, no tick, no view state. */
export interface SendField {
  key: string;
  value: string;
  filePath?: string;
  contentType?: string;
}

/** The body as Rust receives it — the shape decides how it is built. */
export type SendBody =
  | { mode: "none" }
  | { mode: "raw"; text: string }
  | { mode: "urlencoded"; fields: SendField[] }
  | { mode: "formdata"; fields: SendField[] }
  | { mode: "file"; path: string }
  | { mode: "graphql"; query: string; variables: string };

/** What actually crosses to Rust: no ids, no disabled rows, no view state. */
export interface SendInput {
  id: string;
  method: string;
  url: string;
  headers: { name: string; value: string }[];
  body: SendBody;
  options: SendOptions;
}

export interface HeaderPair {
  name: string;
  value: string;
}

export interface ResponseBody {
  /** Set when the bytes were valid UTF-8. */
  text: string | null;
  /** Set otherwise — an image, a protobuf, a gzip stream. */
  base64: string | null;
  bytes: number;
  truncated: boolean;
}

export interface Timing {
  totalMs: number;
  /** Until the response head arrived, excluding the download. */
  waitMs: number;
  downloadMs: number;
}

export interface Hop {
  status: number;
  from: string;
  to: string;
  elapsedMs: number;
}

/** The request as the client assembled it, headers and all. */
export interface SentRequest {
  method: string;
  url: string;
  headers: HeaderPair[];
  bodyBytes: number;
}

export interface ApiResponse {
  id: string;
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HeaderPair[];
  body: ResponseBody;
  timing: Timing;
  finalUrl: string;
  remoteAddress: string | null;
  redirects: Hop[];
  sent: SentRequest;
}

export type ApiErrorKind =
  | "invalid-request"
  | "connect"
  | "tls"
  | "timeout"
  | "too-many-redirects"
  | "cancelled"
  | "body"
  | "other";

export interface ApiError {
  kind: ApiErrorKind;
  message: string;
}

/** Emitted while a body is still arriving. `total` is null with no
 * `Content-Length`, which is common — the UI must not need it. */
export interface ApiProgress {
  id: string;
  received: number;
  total: number | null;
}

// ─── Stored things ───────────────────────────────────────────────────────────
//
// Mirroring `src-tauri/src/store/model.rs`. The webview holds these to draw
// with; Rust owns them.

export interface ApiCollection {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  rank: string;
  updatedAt: number;
  /** Set on a copy kept when a sync found both sides had changed the row. */
  conflictedAt: number | null;
  /** The pre-request and test scripts hanging off this level of the tree. */
  events: unknown;
  /** The block a request inherits when it has none of its own. */
  auth: unknown;
  /** The outermost scope under the environment, in the format's own shape:
   * a list of `{key, value, disabled?}`. */
  variables: unknown;
}

export type ItemKind = "folder" | "request";

/** A folder or a request in the tree. The request's contents are loaded
 * separately — the rail needs a thousand names and no bodies to draw itself. */
export interface ApiItem {
  id: string;
  collectionId: string;
  parentId: string | null;
  kind: ItemKind;
  name: string;
  /** A folder's own description, as markdown. Empty on a request, whose
   * description stays in the document it was imported from. */
  description: string;
  rank: string;
  updatedAt: number;
  /** A request's method and URL ride along with the tree, so the rail can draw
   * a method chip and search by URL without a query per row. Null for folders. */
  method: string | null;
  url: string | null;
  /** A folder's or request's own auth and variables — the inner links of the
   * chain. Null on most rows, which is what inheritance means. */
  auth: unknown;
  variables: unknown;
  /** Set on a copy kept when a sync found both sides had changed the row. */
  conflictedAt: number | null;
  /** The scripts hanging off this folder or request. */
  events: unknown;
}

/** Per-request overrides of how the send behaves. Absent means the defaults. */
export interface RequestSettings {
  followRedirects?: boolean;
  maxRedirects?: number;
  verifyTls?: boolean;
  timeoutMs?: number;
}

/** An auth block as the editor holds it: a type and flat parameters. `inherit`
 * means there is no block, which is what makes the chain walk upwards. */
export interface DraftAuth {
  type: string;
  params: Record<string, string>;
}

/** Everything the editor holds for one request, and all that is saved of it.
 *
 * Auth and settings are part of the draft rather than separate state, so the
 * dirty mark, the session and ⌘S all cover them without knowing they exist. */
export interface RequestDraft {
  method: HttpMethod;
  url: string;
  headers: HeaderRow[];
  body: RequestBody;
  auth: DraftAuth;
  settings: RequestSettings;
  /** This request's own scripts. What it inherits is not here — that comes
   * from the tree at send time. */
  scripts: { prerequest: string; test: string };
}

export interface SavedRequest {
  itemId: string;
  method: string;
  url: string;
  headers: HeaderRow[];
  body: RequestBody;
  settings: RequestSettings | null;
}

/** A response as history keeps it: everything but the bytes, which are on disk. */
export type StoredResponse = Omit<ApiResponse, "body"> & {
  body: Omit<ResponseBody, "text" | "base64">;
};

export interface HistoryEntry {
  id: string;
  itemId: string | null;
  sentAt: number;
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  sizeBytes: number | null;
  /** Set instead of `status` when the send never produced a response. */
  error: string | null;
  request: SendInput;
  response: StoredResponse | null;
  hasBody: boolean;
}

/** A response somebody kept against a request. */
export interface ApiExample {
  id: string;
  itemId: string;
  name: string;
  status: number | null;
  statusText: string | null;
  headers: HeaderPair[] | null;
  body: string | null;
  rank: string;
  /** The entry it was imported from, so an export puts back what came in. */
  raw: unknown;
}

/**
 * An example as the rail draws it: a row, and nothing more.
 *
 * Separate from `ApiExample` because the rail wants every example in the
 * workspace and none of their bodies — a collection with two hundred kept
 * responses is a megabyte nobody has asked to see, arriving on every start.
 */
export interface ApiExampleSummary {
  id: string;
  itemId: string;
  name: string;
  status: number | null;
  rank: string;
}

/** One open tab, as the session remembers it across restarts. */
export interface SessionTab {
  id: string;
  itemId: string | null;
  name: string;
  draft: RequestDraft;
  /** `"folder"` or `"collection"` for a tab editing one of those; absent means
   * a request, which is what every session written before them holds. */
  kind?: string;
  /** The row such a tab was editing. Its contents are not saved here: the row
   * is the truth, and a stale copy in the session would quietly win over what
   * another window had since written. */
  scopeId?: string | null;
}

export interface ApiSession {
  tabs: SessionTab[];
  activeTabId: string | null;
  /** Which collections and folders were open in the rail. */
  expanded: string[];
  /** The environment whose variables are in play. Null for none. */
  activeEnvironmentId?: string | null;
  /** Which of the sidebar's three sections was showing. */
  rail?: string;
  /** Whether the sidebar was collapsed to its icon strip. */
  railCollapsed?: boolean;
  /** How wide its section was, in pixels. */
  railWidth?: number;
  /** Whether the response sat below the request or beside it. */
  split?: string;
  /** Where the divider was left, keyed by layout then by panel. */
  splitSizes?: Record<string, Record<string, number>>;
}

/** A variable inside an environment. Nothing resolves one yet — that is the
 * next phase — but an import must not drop them. */
export interface ApiVariable {
  id: string;
  key: string;
  /** The **initial** value: what exports, what syncs, what a colleague gets
   * when they open the file. Also the one nobody wants a real token in. */
  value: string;
  /** What this machine resolves with instead, when it has one. Never
   * exported, never synced. Null means "use the initial value", which is not
   * the same as an empty string — that is a deliberate blank. */
  currentValue: string | null;
  enabled: boolean;
  /** Marked so the sync phase knows which values must never leave the machine
   * in a shared row. */
  secret: boolean;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  /** The one unnamed environment whose variables apply everywhere. */
  isGlobal: boolean;
  updatedAt: number;
  conflictedAt: number | null;
  variables: ApiVariable[];
  /** The document it was imported from, so an export puts back what came in. */
  raw: unknown;
}

/**
 * A workspace: one wall between one body of work and another.
 *
 * Everything else hangs off one, directly or through a collection, and sync is
 * scoped per workspace — so two of them are two separate bodies of work that
 * never see each other's rows.
 */
export interface ApiWorkspace {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface ApiSnapshot {
  workspaceId: string;
  /** Every workspace there is, so the picker draws without a second call. */
  workspaces: ApiWorkspace[];
  collections: ApiCollection[];
  items: ApiItem[];
  session: ApiSession | null;
  history: HistoryEntry[];
  environments: ApiEnvironment[];
  examples: ApiExampleSummary[];
}

// ─── Sync ────────────────────────────────────────────────────────────────────
//
// Mirroring `src-tauri/src/sync/`. Nothing secret appears here: the project key
// and any refresh token live in the OS keychain and never cross to the webview.

/** What libpq calls `sslmode`, with the same meanings and the same spellings —
 * whoever is setting this up has a connection string in front of them. */
export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

/** A Postgres database this app connects to itself. Holds no password: that is
 * in the OS keychain. */
export interface DirectConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  schema: string;
  /** What the database's own logs call this app. */
  applicationName: string;
  connectTimeoutSecs: number;
  /** A query longer than this is cancelled by the server. 0 means no limit. */
  statementTimeoutMs: number;
  sslMode: SslMode;
  caPath: string | null;
  clientCertPath: string | null;
  clientKeyPath: string | null;
}

export const DEFAULT_DIRECT_CONFIG: DirectConfig = {
  host: "localhost",
  port: 5432,
  database: "figyman",
  user: "",
  schema: "figyman",
  applicationName: "FigyMan",
  connectTimeoutSecs: 15,
  statementTimeoutMs: 30_000,
  sslMode: "require",
  caPath: null,
  clientCertPath: null,
  clientKeyPath: null,
};

export interface SyncConfig {
  /** Always `direct`: Postgres, wherever it is. Kept so a config written
   * before the hosted mode was removed still loads. */
  mode: string;
  /** Empty. What the hosted mode kept its base URL in. */
  url: string;
  schema: string;
  /** The account signed in, when one is. */
  email: string | null;
  intervalSecs: number;
  syncOnFocus: boolean;
  syncHistory: boolean;
  /** Whether a database is connected at all. Set by connecting, cleared by
   * disconnecting — not a preference. */
  enabled: boolean;
  /** Whether passes run on their own: the interval, and the window opening.
   * Off does not mean syncing is off — the Sync button still works. */
  auto: boolean;
  /** Set in direct mode. */
  direct: DirectConfig | null;
}

/** What one pass did. */
export interface SyncOutcome {
  pushed: number;
  pulled: number;
  conflicts: number;
  /** Rows still queued afterwards — non-zero when something failed. */
  pending: number;
  finishedAt: number;
  error: string | null;
  /** Stopped part-way, by the user or by the deadline. Not a failure: what
   * moved is kept, and the next pass carries on from there. */
  stopped: boolean;
}

/**
 * Where a pass has got to, as it gets there.
 *
 * Per table and per batch, not per pass: a sync of a few thousand rows is
 * seconds of nothing followed by a number, and "seconds of nothing" is
 * indistinguishable from "hung" — which is the state people need to tell
 * apart.
 */
export interface SyncStep {
  /** `push`, `pull`, or `done`. */
  phase: "push" | "pull" | "done";
  table: string;
  /** Which table this is, of how many. The only honest basis for a bar:
   * nothing knows how many rows are coming until they stop coming. */
  index: number;
  total: number;
  /** Rows moved for this table so far. */
  rows: number;
}

/** What a connection test found. */
export interface SyncProbe {
  reachable: boolean;
  latencyMs: number;
  schemaReady: boolean;
  missing: string[];
  message: string;
}

export interface SyncStatus {
  config: SyncConfig;
  /** Whether a key for this project is in the keychain. */
  hasKey: boolean;
  pending: number;
  conflicts: number;
  last: SyncOutcome | null;
}
