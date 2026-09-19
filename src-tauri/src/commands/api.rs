//! The two calls the API client makes.
//!
//! `api_send` is one request, start to finish, and returns the whole response —
//! a request/response command for a request/response protocol, which is why
//! this needs none of the event plumbing the language servers do. The one event
//! is download progress, which cannot wait for the call to return by
//! definition.

use tauri::{AppHandle, Emitter, State};

use crate::http::{send, ApiState, ClientKey, Progress, SendError, SendInput, SendOutput};

/// Bytes received so far, while a body is still arriving.
pub const PROGRESS_EVENT: &str = "api://progress";

/// Sends one request and waits for the whole response.
///
/// `input.id` is the webview's handle on it: pass the same id to `api_cancel`
/// to stop it. Sending twice under one id cancels the first, which is what a
/// Send button pressed twice should do.
///
/// The error type is a struct rather than a string, so the UI can offer the
/// remedy that goes with the failure — a longer timeout, or verification
/// turned off for a host whose certificate it already knows about.
#[tauri::command]
pub async fn api_send(
    app: AppHandle,
    state: State<'_, ApiState>,
    input: SendInput,
) -> Result<SendOutput, SendError> {
    let client = state.client(ClientKey {
        verify_tls: input.options.verify_tls,
    })?;

    let id = input.id.clone();
    let cancel = state.register(&id);

    let on_progress = move |progress: Progress| {
        let _ = app.emit(PROGRESS_EVENT, progress);
    };

    let result = send::execute(client, input, cancel, &on_progress).await;
    state.finish(&id);
    result
}

/// Stops a send. Returns whether there was one to stop — cancelling a send that
/// has just come back is a race the UI should not have to think about, not an
/// error.
#[tauri::command]
pub fn api_cancel(state: State<'_, ApiState>, id: String) -> bool {
    state.finish(&id)
}

// ─── Collections ─────────────────────────────────────────────────────────────
//
// Everything below is the store, not the wire. The division is the one in
// `docs/API-CLIENT.md`: Rust owns the data, the webview owns the view, and a
// tree of a few thousand requests crosses once when the window opens.
//
// Ranks arrive already computed. They are fractional indexes, and the
// arithmetic lives in `services/api/rank.ts` where it is tested; a second
// implementation here would be a second thing to get wrong.

use crate::store::model::{
    Collection, HistoryEntry, Item, ItemKind, NewHistory, SavedRequest, Snapshot, Workspace,
};
use crate::store::{queries, StoreResult, StoreState};
use serde_json::Value;
use uuid::Uuid;

/// Everything the window needs to draw itself: the tree, the tabs that were
/// open, and recent history. One call, because three would paint three times.
#[tauri::command(async)]
pub fn api_bootstrap(app: AppHandle, state: State<'_, StoreState>) -> StoreResult<Snapshot> {
    state.with(&app, queries::snapshot)
}

// ─── Workspaces ──────────────────────────────────────────────────────────────
//
// A wall between one body of work and another. Everything else hangs off one,
// and sync is scoped per workspace — so switching is switching the whole
// window, not filtering it.

#[tauri::command(async)]
pub fn api_workspaces(app: AppHandle, state: State<'_, StoreState>) -> StoreResult<Vec<Workspace>> {
    state.with(&app, queries::workspaces)
}

/// Makes one and opens it. Making a workspace and then having to go and find
/// it is two steps where the intent was one.
#[tauri::command(async)]
pub fn api_workspace_create(
    app: AppHandle,
    state: State<'_, StoreState>,
    name: String,
) -> StoreResult<Snapshot> {
    state.with(&app, |connection| {
        let id = queries::create_workspace(connection, &name)?;
        queries::set_active_workspace(connection, &id)?;
        queries::snapshot(connection)
    })
}

#[tauri::command(async)]
pub fn api_workspace_rename(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
    name: String,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::rename_workspace(connection, &id, &name)
    })
}

/// Switches, and returns everything in the one that was switched to.
///
/// A whole snapshot rather than an acknowledgement: the tree, the
/// environments, the history and the examples all change together, and two
/// calls would paint the new workspace with the old workspace's tree.
#[tauri::command(async)]
pub fn api_workspace_open(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
) -> StoreResult<Snapshot> {
    state.with(&app, |connection| {
        queries::set_active_workspace(connection, &id)?;
        queries::snapshot(connection)
    })
}

/// Deletes it, and returns what is left — which is a different workspace, so
/// the window has somewhere to be before it draws again.
#[tauri::command(async)]
pub fn api_workspace_delete(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
) -> StoreResult<Snapshot> {
    state.with(&app, |connection| {
        queries::delete_workspace(connection, &id)?;
        queries::snapshot(connection)
    })
}

// ─── Collections ─────────────────────────────────────────────────────────────

#[tauri::command(async)]
pub fn api_collection_create(
    app: AppHandle,
    state: State<'_, StoreState>,
    name: String,
    rank: String,
) -> StoreResult<Collection> {
    state.with(&app, |connection| {
        let workspace = queries::workspace_id(connection)?;
        queries::create_collection(connection, &workspace, &name, &rank)
    })
}

#[tauri::command(async)]
pub fn api_collection_rename(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
    name: String,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::rename_collection(connection, &id, &name)
    })
}

#[tauri::command(async)]
pub fn api_collection_delete(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::delete_collection(connection, &id)
    })
}

// ─── Items ───────────────────────────────────────────────────────────────────

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn api_item_create(
    app: AppHandle,
    state: State<'_, StoreState>,
    collection_id: String,
    parent_id: Option<String>,
    kind: ItemKind,
    name: String,
    rank: String,
) -> StoreResult<Item> {
    state.with(&app, |connection| {
        queries::create_item(
            connection,
            &collection_id,
            parent_id.as_deref(),
            kind,
            &name,
            &rank,
        )
    })
}

#[tauri::command(async)]
pub fn api_item_rename(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
    name: String,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::rename_item(connection, &id, &name)
    })
}

#[tauri::command(async)]
pub fn api_item_move(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
    collection_id: String,
    parent_id: Option<String>,
    rank: String,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::move_item(connection, &id, &collection_id, parent_id.as_deref(), &rank)
    })
}

#[tauri::command(async)]
pub fn api_item_delete(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
) -> StoreResult<()> {
    state.with(&app, |connection| queries::delete_item(connection, &id))
}

#[tauri::command(async)]
pub fn api_item_duplicate(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
    name: String,
    rank: String,
) -> StoreResult<Vec<Item>> {
    state.with(&app, |connection| {
        queries::duplicate_item(connection, &id, &name, &rank)
    })
}

// ─── Requests ────────────────────────────────────────────────────────────────

#[tauri::command(async)]
pub fn api_request_load(
    app: AppHandle,
    state: State<'_, StoreState>,
    item_id: String,
) -> StoreResult<Option<SavedRequest>> {
    state.with(&app, |connection| {
        queries::load_request(connection, &item_id)
    })
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn api_request_save(
    app: AppHandle,
    state: State<'_, StoreState>,
    item_id: String,
    method: String,
    url: String,
    headers: Value,
    body: Value,
    settings: Option<Value>,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::save_request(
            connection,
            &item_id,
            &method,
            &url,
            &headers,
            &body,
            settings.as_ref(),
        )
    })
}

/// The auth block on a folder or a request.
///
/// `None` removes it, and removing it is not the same as setting "no auth" —
/// one inherits from the folder above, the other sends nothing. The store keeps
/// the difference because the format does.
#[tauri::command(async)]
pub fn api_item_auth_save(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
    auth: Option<Value>,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::save_item_auth(connection, &id, auth.as_ref())
    })
}

/// The pre-request and test scripts on a folder or a request.
#[tauri::command(async)]
pub fn api_item_events_save(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
    events: Option<Value>,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::save_item_events(connection, &id, events.as_ref())
    })
}

/// A collection's auth and variables, saved together because the panel that
/// edits them shows them together.
#[tauri::command(async)]
pub fn api_collection_scope_save(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
    auth: Option<Value>,
    variables: Option<Value>,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::save_collection_scope(connection, &id, auth.as_ref(), variables.as_ref())
    })
}

/// Everything the folder or collection tab edits, in one write.
///
/// A payload rather than six parameters: it is one form being saved, and six
/// positional arguments across the boundary is five chances to pass them in the
/// wrong order — two of which are strings and would not be caught by anything.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSave {
    pub id: String,
    pub name: String,
    pub description: String,
    pub auth: Option<Value>,
    pub variables: Option<Value>,
    pub events: Option<Value>,
}

/// One command rather than four, because the tab saves all of it at once: four
/// would bump the row's revision four times and enqueue it four times for a
/// single save, and a failure partway would leave a folder holding its new auth
/// beside its old scripts.
#[tauri::command(async)]
pub fn api_item_scope_save(
    app: AppHandle,
    state: State<'_, StoreState>,
    payload: ScopeSave,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::save_item_scope(
            connection,
            &payload.id,
            &payload.name,
            &payload.description,
            payload.auth.as_ref(),
            payload.variables.as_ref(),
            payload.events.as_ref(),
        )
    })
}

/// The same, one level up.
#[tauri::command(async)]
pub fn api_collection_overview_save(
    app: AppHandle,
    state: State<'_, StoreState>,
    payload: ScopeSave,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::save_collection_overview(
            connection,
            &payload.id,
            &payload.name,
            &payload.description,
            payload.auth.as_ref(),
            payload.variables.as_ref(),
            payload.events.as_ref(),
        )
    })
}

/// Creates or updates an environment and its variables.
#[tauri::command(async)]
pub fn api_environment_save(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: Option<String>,
    name: String,
    is_global: bool,
    variables: Vec<crate::store::model::ImportVariable>,
) -> StoreResult<String> {
    state.with(&app, |connection| {
        let workspace = queries::workspace_id(connection)?;
        queries::save_environment(
            connection,
            &workspace,
            id.as_deref(),
            &name,
            is_global,
            &variables,
        )
    })
}

/// The open tabs and their drafts.
///
/// Written whole and debounced rather than per keystroke. It is the reason an
/// unsaved request survives a crash: the draft is here even when the collection
/// row still holds the last saved version.
#[tauri::command(async)]
pub fn api_session_save(
    app: AppHandle,
    state: State<'_, StoreState>,
    session: Value,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        let workspace = queries::workspace_id(connection)?;
        queries::set_meta(
            connection,
            &queries::session_key(&workspace),
            &session.to_string(),
        )
    })
}

// ─── History ─────────────────────────────────────────────────────────────────

/// Records a send, spilling the response body to a file.
///
/// The body is written before the row that points at it, so there is no moment
/// where history claims a body that is not on disk. The reverse — a file with
/// no row — is merely a byte or two of rubbish that the next prune sweeps up.
#[tauri::command(async)]
pub fn api_history_add(
    app: AppHandle,
    state: State<'_, StoreState>,
    entry: NewHistory,
    body: Option<String>,
) -> StoreResult<String> {
    let id = Uuid::new_v4().to_string();
    let mut body_path: Option<String> = None;

    if let Some(body) = body {
        if !body.is_empty() {
            let path = state.bodies_dir(&app)?.join(&id);
            std::fs::write(&path, body).map_err(|e| e.to_string())?;
            body_path = Some(path.to_string_lossy().into_owned());
        }
    }

    let stale = state.with(&app, |connection| {
        let workspace = queries::workspace_id(connection)?;
        queries::add_history(connection, &workspace, &id, &entry, body_path.as_deref())?;
        queries::prune_history(connection, &workspace)
    })?;

    // Outside the transaction: a file that will not delete is not a reason to
    // fail a send that has already happened.
    for path in stale {
        let _ = std::fs::remove_file(path);
    }

    Ok(id)
}

#[tauri::command(async)]
pub fn api_history_list(
    app: AppHandle,
    state: State<'_, StoreState>,
    limit: usize,
) -> StoreResult<Vec<HistoryEntry>> {
    state.with(&app, |connection| {
        let workspace = queries::workspace_id(connection)?;
        queries::list_history(connection, &workspace, limit)
    })
}

/// The stored body of one history entry, read back from its file.
#[tauri::command(async)]
pub fn api_history_body(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
) -> StoreResult<Option<String>> {
    let path = state.with(&app, |connection| {
        queries::history_body_path(connection, &id)
    })?;

    match path {
        None => Ok(None),
        // A missing file is a body that has been pruned or removed by hand, not
        // an error: the entry's metadata is still worth showing.
        Some(path) => Ok(std::fs::read_to_string(path).ok()),
    }
}

#[tauri::command(async)]
pub fn api_history_clear(app: AppHandle, state: State<'_, StoreState>) -> StoreResult<()> {
    let paths = state.with(&app, |connection| {
        let workspace = queries::workspace_id(connection)?;
        queries::clear_history(connection, &workspace)
    })?;
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

// ─── Interchange ─────────────────────────────────────────────────────────────
//
// Reading and writing the collection format itself is TypeScript: it is JSON in
// and JSON out, and it is testable under Node against real exported files,
// which is where the risk in this feature actually lives. Rust does the two
// things TypeScript cannot — a whole tree in one transaction, and a file at a
// path the native dialog just returned.

use crate::store::model::{
    Environment, Example, ExportBundle, ImportCollection, ImportEnvironment, NewExample,
};

/// Creates a collection, its tree and its requests in one transaction.
#[tauri::command(async)]
pub fn api_import_collection(
    app: AppHandle,
    state: State<'_, StoreState>,
    payload: ImportCollection,
) -> StoreResult<String> {
    state.with(&app, |connection| {
        let workspace = queries::workspace_id(connection)?;
        queries::import_collection(connection, &workspace, &payload)
    })
}

/// Everything needed to write a collection back out, including each row's
/// original document.
#[tauri::command(async)]
pub fn api_export_collection(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
) -> StoreResult<ExportBundle> {
    state.with(&app, |connection| {
        queries::export_collection(connection, &id)
    })
}

#[tauri::command(async)]
pub fn api_import_environment(
    app: AppHandle,
    state: State<'_, StoreState>,
    payload: ImportEnvironment,
) -> StoreResult<String> {
    state.with(&app, |connection| {
        let workspace = queries::workspace_id(connection)?;
        queries::import_environment(connection, &workspace, &payload)
    })
}

#[tauri::command(async)]
pub fn api_environments(
    app: AppHandle,
    state: State<'_, StoreState>,
) -> StoreResult<Vec<Environment>> {
    state.with(&app, |connection| {
        let workspace = queries::workspace_id(connection)?;
        queries::environments(connection, &workspace)
    })
}

#[tauri::command(async)]
pub fn api_environment_delete(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::delete_environment(connection, &id)
    })
}

/// The responses kept against one request.
#[tauri::command(async)]
pub fn api_examples(
    app: AppHandle,
    state: State<'_, StoreState>,
    item_id: String,
) -> StoreResult<Vec<Example>> {
    state.with(&app, |connection| queries::examples(connection, &item_id))
}

/// Keeps a response. The rank is the caller's, from the same fractional index
/// the tree uses, so a new one lands at the end of the list.
#[tauri::command(async)]
pub fn api_example_save(
    app: AppHandle,
    state: State<'_, StoreState>,
    item_id: String,
    rank: String,
    example: NewExample,
) -> StoreResult<String> {
    state.with(&app, |connection| {
        queries::save_example(connection, &item_id, &rank, &example)
    })
}

#[tauri::command(async)]
pub fn api_example_rename(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
    name: String,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        queries::rename_example(connection, &id, &name)
    })
}

#[tauri::command(async)]
pub fn api_example_delete(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: String,
) -> StoreResult<()> {
    state.with(&app, |connection| queries::delete_example(connection, &id))
}

/// How much of a file this will read before giving up.
///
/// A collection of a few thousand requests is a handful of megabytes; anything
/// past this is not one, and reading it would mean holding it, parsing it and
/// then finding out.
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

/// Reads a file the user picked.
///
/// Deliberately not `fs_read_text`: that one is scoped to the editor's
/// registered workspace roots, and a collection being imported lives wherever
/// the person keeps their downloads. Widening those roots to reach it would
/// trade the editor's boundary for this window's convenience. The authorisation
/// here is the native file dialog the path came from.
#[tauri::command(async)]
pub fn api_read_file(path: String) -> StoreResult<String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "{path} is {} MB, which is larger than this can import",
            meta.len() / (1024 * 1024)
        ));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Every `.json` file directly inside a directory, so a folder of exports can
/// be imported in one go. Not recursive: a home directory chosen by mistake
/// should not become a filesystem crawl.
#[tauri::command(async)]
pub fn api_list_json_files(path: String) -> StoreResult<Vec<String>> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            found.push(path.to_string_lossy().into_owned());
        }
    }
    found.sort();
    Ok(found)
}

/// Writes an export to the path the save dialog returned.
#[tauri::command(async)]
pub fn api_write_file(path: String, contents: String) -> StoreResult<()> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}
