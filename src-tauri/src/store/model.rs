//! The rows, as the webview sees them.
//!
//! camelCase across the boundary, like the rest of the app's types. Anything
//! stored as JSON (`headers`, `body`, the session) crosses as a real value
//! rather than a string, so the webview never parses what Rust already has.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A workspace: one wall between one set of collections and another.
///
/// Everything else in the database hangs off one, directly or through a
/// collection, and sync is scoped per workspace — so two of them are two
/// separate bodies of work that never see each other's rows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub description: String,
    pub rank: String,
    pub updated_at: i64,
    /// Set on a copy kept when a sync found both sides had changed the row.
    pub conflicted_at: Option<i64>,
    /// The pre-request and test scripts hanging off this level of the tree.
    pub events: Option<Value>,
    /// The block a request inherits when it has none of its own, and the
    /// outermost scope of variables under the environment. Both cross as real
    /// values rather than strings: the webview resolves the chain, because that
    /// is a pure function with tests and Rust would only be a second copy.
    pub auth: Option<Value>,
    pub variables: Option<Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Folder,
    Request,
}

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Folder => "folder",
            ItemKind::Request => "request",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "folder" => Some(ItemKind::Folder),
            "request" => Some(ItemKind::Request),
            _ => None,
        }
    }
}

/// A folder or a request in a collection's tree. The request's *contents* live
/// in `SavedRequest`, keyed by the same id — the rail needs a thousand names
/// and no bodies at all to draw itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub collection_id: String,
    pub parent_id: Option<String>,
    pub kind: ItemKind,
    pub name: String,
    /// Markdown, as the format stores it. Carried with the tree rather than
    /// fetched per row: the folder tab wants it the moment a folder is clicked,
    /// and it is a few words on the rows that have one at all.
    pub description: String,
    pub rank: String,
    pub updated_at: i64,
    /// A request's method and URL come along with the tree.
    ///
    /// They are two columns on a row the rail is already reading, and having
    /// them here is what lets the rail draw a method chip and search by URL
    /// without a query per row. Absent for folders.
    pub method: Option<String>,
    pub url: Option<String>,
    /// A folder's or request's own auth and variables — the inner links of the
    /// chain. Null on most rows, which is what inheritance means.
    pub auth: Option<Value>,
    pub variables: Option<Value>,
    /// Set on a copy kept when a sync found both sides had changed the row.
    pub conflicted_at: Option<i64>,
    /// The scripts hanging off this folder or request.
    pub events: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRequest {
    pub item_id: String,
    pub method: String,
    pub url: String,
    pub headers: Value,
    pub body: Value,
    /// Redirects, TLS verification, timeout — the per-request overrides.
    pub settings: Option<Value>,
}

/// One send that happened, without its response body.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub item_id: Option<String>,
    pub sent_at: i64,
    pub method: String,
    pub url: String,
    pub status: Option<i64>,
    pub duration_ms: Option<i64>,
    pub size_bytes: Option<i64>,
    /// Set instead of `status` when the send never produced a response.
    pub error: Option<String>,
    pub request: Value,
    /// Headers, timing and redirects — everything but the body.
    pub response: Option<Value>,
    pub has_body: bool,
}

/// What `api_history_add` is given. The body is passed separately because it
/// goes to a file rather than a column.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHistory {
    pub item_id: Option<String>,
    pub method: String,
    pub url: String,
    pub status: Option<i64>,
    pub duration_ms: Option<i64>,
    pub size_bytes: Option<i64>,
    pub error: Option<String>,
    pub request: Value,
    pub response: Option<Value>,
}

/// Everything the window needs to draw itself on open.
///
/// One round trip rather than four: the tree, the tabs that were open and the
/// recent history are all wanted at once, and three separate awaits would paint
/// the window three times.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub workspace_id: String,
    /// Every workspace there is, so the picker can be drawn without a second
    /// round trip on every open.
    pub workspaces: Vec<Workspace>,
    pub collections: Vec<Collection>,
    pub items: Vec<Item>,
    /// The open tabs and their drafts, as the webview last wrote them.
    pub session: Option<Value>,
    pub history: Vec<HistoryEntry>,
    /// Imported environments. Nothing resolves a variable yet — that is the
    /// next phase — but an import must not drop them, and the rail lists them.
    pub environments: Vec<Environment>,
    /// Every kept response, without its body, so the rail can hang them under
    /// the request they belong to.
    pub examples: Vec<ExampleSummary>,
}

// ─── Interchange ─────────────────────────────────────────────────────────────
//
// Reading and writing the collection format is pure TypeScript — it is JSON in
// and JSON out, and it is testable under Node with real files. What crosses to
// Rust is the result: a whole tree in one transaction on the way in, and every
// row plus its original document on the way out.

/// A collection to create, with its whole tree, in one call.
///
/// One command rather than a create per row: an import of two hundred requests
/// would otherwise be two hundred round trips, and a failure halfway through
/// would leave a half-imported collection that looks like a complete one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCollection {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub rank: String,
    pub auth: Option<Value>,
    pub variables: Option<Value>,
    pub events: Option<Value>,
    /// The document exactly as it arrived, so export can put back whatever this
    /// model does not understand.
    pub raw: Option<Value>,
    pub items: Vec<ImportItem>,
}

/// One entry of an imported tree.
///
/// `parent` is an index into the same list rather than an id, because the ids
/// do not exist until Rust makes them. The list is depth-first, so a parent is
/// always earlier than its children.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub kind: ItemKind,
    pub name: String,
    /// Defaulted: a document written before the reader emitted descriptions,
    /// and every hand-written fixture, has no field here.
    #[serde(default)]
    pub description: String,
    pub rank: String,
    pub parent: Option<usize>,
    pub auth: Option<Value>,
    pub events: Option<Value>,
    pub variables: Option<Value>,
    pub raw: Option<Value>,
    /// Present for a request, absent for a folder.
    pub request: Option<ImportRequest>,
    /// Saved responses from the document's `response[]`.
    #[serde(default)]
    pub examples: Vec<NewExample>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub method: String,
    pub url: String,
    pub headers: Value,
    pub body: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEnvironment {
    pub name: String,
    #[serde(default)]
    pub is_global: bool,
    pub raw: Option<Value>,
    pub variables: Vec<ImportVariable>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportVariable {
    pub key: String,
    #[serde(default)]
    pub value: String,
    /// Absent from an imported document, which has no such concept; supplied
    /// by the environment tab, which does.
    #[serde(default)]
    pub current_value: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub secret: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub id: String,
    pub key: String,
    /// What exports and syncs. Shared with everyone who has the collection.
    pub value: String,
    /// What this machine actually resolves with, when it has one of its own.
    /// Never exported, never synced. `None` means "use the initial value".
    pub current_value: Option<String>,
    pub enabled: bool,
    pub secret: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub is_global: bool,
    pub updated_at: i64,
    pub conflicted_at: Option<i64>,
    pub variables: Vec<Variable>,
    /// The document it was imported from, if it was imported.
    pub raw: Option<Value>,
}

/// A response somebody kept.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub id: String,
    pub item_id: String,
    pub name: String,
    pub status: Option<i64>,
    pub status_text: Option<String>,
    pub headers: Option<Value>,
    pub body: Option<String>,
    pub rank: String,
    /// The entry it was imported from, so export puts back what came in.
    pub raw: Option<Value>,
}

/// An example as the rail draws it: enough to show a row, and nothing more.
///
/// Separate from `Example` because the rail wants every example in the
/// workspace at once and none of their bodies. A collection with two hundred
/// kept responses is a megabyte of bodies nobody has asked to see, arriving on
/// every start.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleSummary {
    pub id: String,
    pub item_id: String,
    pub name: String,
    pub status: Option<i64>,
    pub rank: String,
}

/// One to create, from a real response or from an imported document.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewExample {
    pub name: String,
    pub status: Option<i64>,
    pub status_text: Option<String>,
    pub headers: Option<Value>,
    pub body: Option<String>,
    #[serde(default)]
    pub raw: Option<Value>,
}

/// Everything needed to write a collection back out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBundle {
    pub name: String,
    pub description: String,
    pub auth: Option<Value>,
    pub variables: Option<Value>,
    pub events: Option<Value>,
    pub raw: Option<Value>,
    pub items: Vec<ExportItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: ItemKind,
    pub name: String,
    pub description: String,
    pub rank: String,
    pub auth: Option<Value>,
    pub events: Option<Value>,
    pub variables: Option<Value>,
    pub raw: Option<Value>,
    pub request: Option<ExportRequest>,
    pub examples: Vec<Example>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub method: String,
    pub url: String,
    pub headers: Value,
    pub body: Value,
}
