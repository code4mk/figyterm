//! The agent's IPC surface.
//!
//! The loop lives in `agent/session.rs` and dispatches tools in-process; a
//! turn is a dozen calls and a round trip through IPC per call would be
//! latency for nothing. What crosses the boundary is four things: configure
//! it, send a message, answer a permission question, stop.
//!
//! Everything the window needs to draw goes out as one event stream,
//! `agent://event`, rather than as return values. A turn produces text as it
//! is generated, tool calls as they start and finish, and a cost line per
//! round trip — none of which can wait for the call to return.
//!
//! `agent_call_tool` stays from before the loop existed. It is the
//! development surface: a way to ask "what does `grep` actually return for
//! that?" without a model in the way.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::sync::oneshot;

use crate::agent::ledger::{Ledger, Price, Surface, Totals};
use crate::agent::message::ToolCall;
use crate::agent::policy::Mode;
use crate::agent::provider::{OpenAiProvider, ProviderConfig};
use crate::agent::shell::{Shell, SystemShell};
use crate::agent::session::{
    Approver, OfferEverything, Session, SessionConfig, Turn, TurnEvent,
};
use crate::agent::tools::{self, ToolContext};
use crate::agent::workspace::Workspace;
use crate::secrets::{self, Credential};

/// The event every turn is narrated through.
pub const AGENT_EVENT: &str = "agent://event";

/// Where the key is kept. One account name, because this is the app's own
/// provider setting rather than one per project.
const KEY_ACCOUNT: &str = "figycode:provider";

/* ─── State ──────────────────────────────────────────────────────────────── */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// The part before `/chat/completions`.
    pub base_url: String,
    pub model: String,
    /// Only on the call that sets it. Afterwards it lives in the keychain
    /// and never comes back out to the webview.
    pub api_key: Option<String>,
    pub temperature: Option<f32>,
    /// Dollars per million tokens, as data rather than a table baked into
    /// the binary — the one certain thing about a price in a release is that
    /// it is out of date.
    pub input_price: Option<f64>,
    pub cached_price: Option<f64>,
    pub output_price: Option<f64>,
}

#[derive(Default)]
pub struct AgentState {
    settings: Mutex<Option<AgentSettings>>,
    /// Per window: the conversation, so a second window is a second session.
    sessions: Mutex<HashMap<String, Session>>,
    /// The turn in flight, so Escape can reach it.
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Permission questions waiting on an answer, by tool-call id.
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /// Commands the user said not to ask about again, this session.
    remembered: Mutex<Vec<String>>,
    /// Opened once, on disk, and shared: two windows write to one file.
    ledger: Mutex<Option<Arc<Ledger>>>,
    /// One shell per window, so its background commands die with it.
    shells: Mutex<HashMap<String, Arc<SystemShell>>>,
}

pub fn forget_window(state: &AgentState, label: &str) {
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(label);
    }
    // Dropping the shell kills what it was running. A window's `npm run dev`
    // holding port 1420 against the next one, with nothing on screen to
    // blame, is the alternative.
    if let Ok(mut shells) = state.shells.lock() {
        shells.remove(label);
    }
    if let Ok(mut running) = state.running.lock() {
        // Dropping the sender cancels the turn, which is what a closed
        // window should do to a model it is still paying for.
        running.remove(label);
    }
}

/* ─── Tools, for inspection ──────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub class: String,
    /// The OpenAI-compatible definition, exactly as it goes on the wire.
    pub schema: Value,
}

#[tauri::command]
pub fn agent_tools() -> Vec<ToolInfo> {
    tools::specs()
        .into_iter()
        .map(|spec| ToolInfo {
            name: spec.name.to_string(),
            description: spec.description.to_string(),
            class: serde_json::to_value(spec.class)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default(),
            schema: spec.as_openai(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub text: String,
    pub detail: Option<Value>,
    pub approx_tokens: usize,
}

#[tauri::command(async)]
pub fn agent_call_tool(
    window: Window,
    workspace: State<Workspace>,
    name: String,
    args: Value,
) -> Result<ToolResult, String> {
    let root = workspace
        .root(window.label())
        .ok_or_else(|| "No folder is open in FigyCode".to_string())?;
    let out = tools::call(&ToolContext::new(root), &name, &args)?;
    Ok(ToolResult {
        approx_tokens: tools::output::approx_tokens(&out.text),
        text: out.text,
        detail: out.detail,
    })
}

/* ─── Configuration ──────────────────────────────────────────────────────── */

/// Points the agent at a provider.
///
/// The key goes to the OS keychain and nowhere else — not to settings, not
/// to the ledger, and never back to the webview. Everything else is kept in
/// memory, because it is a setting rather than a secret and the window
/// already holds the copy the user is editing.
#[tauri::command]
pub fn agent_configure(state: State<AgentState>, settings: AgentSettings) -> Result<(), String> {
    if let Some(key) = settings.api_key.as_ref().filter(|k| !k.trim().is_empty()) {
        secrets::store(Credential::Key, KEY_ACCOUNT, key.trim())?;
    }
    let mut stored = settings.clone();
    stored.api_key = None;
    *state.settings.lock().map_err(|e| e.to_string())? = Some(stored);
    Ok(())
}

/// Whether a key has been stored, which is all the webview may know.
#[tauri::command]
pub fn agent_has_key() -> Result<bool, String> {
    Ok(secrets::read(Credential::Key, KEY_ACCOUNT)?.is_some())
}

/* ─── A turn ─────────────────────────────────────────────────────────────── */

/// Asks the window, and waits for the person.
///
/// The question went out as a `NeedsApproval` event before this is called;
/// all this does is park a channel under the call's id for `agent_approve`
/// to fire. A dropped sender — the window closing, the turn cancelled —
/// reads as a no, which is the right way round.
struct WindowApprover<'a> {
    state: &'a AgentState,
}

impl Approver for WindowApprover<'_> {
    async fn approve(&self, call: &ToolCall, _arguments: &Value) -> bool {
        let (tx, rx) = oneshot::channel();
        match self.state.pending.lock() {
            Ok(mut pending) => {
                pending.insert(call.id.clone(), tx);
            }
            Err(_) => return false,
        }
        rx.await.unwrap_or(false)
    }

    fn remembered(&self, key: &str) -> bool {
        self.state
            .remembered
            .lock()
            .map(|list| list.iter().any(|k| k == key))
            .unwrap_or(false)
    }
}

/// Answers a permission question. `remember` adds the command to the
/// session's allow list — per command, never per class.
#[tauri::command]
pub fn agent_approve(
    state: State<AgentState>,
    id: String,
    allow: bool,
    remember: Option<String>,
) -> Result<(), String> {
    if allow {
        if let Some(key) = remember.filter(|k| !k.is_empty()) {
            if let Ok(mut list) = state.remembered.lock() {
                if !list.contains(&key) {
                    list.push(key);
                }
            }
        }
    }
    let sender = state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    match sender {
        Some(sender) => {
            let _ = sender.send(allow);
            Ok(())
        }
        // The turn was cancelled while the card was on screen. Not an error
        // worth showing: the answer simply has nowhere to go.
        None => Ok(()),
    }
}

/// Stops the turn this window is running.
#[tauri::command]
pub fn agent_cancel(window: Window, state: State<AgentState>) -> Result<(), String> {
    if let Some(sender) = state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(window.label())
    {
        let _ = sender.send(());
    }
    // Any question still on screen is answered no, so nothing is left
    // waiting on a person who has already pressed Escape.
    if let Ok(mut pending) = state.pending.lock() {
        for (_, sender) in pending.drain() {
            let _ = sender.send(false);
        }
    }
    Ok(())
}

/// One user message, carried to the end of whatever it sets off.
///
/// Returns when the turn is over. Everything worth watching has already
/// gone out as events by then — this returning is the signal that the
/// composer can be re-enabled, not where the answer arrives.
#[tauri::command(async)]
pub async fn agent_send(
    app: AppHandle,
    window: Window,
    state: State<'_, AgentState>,
    workspace: State<'_, Workspace>,
    prompt: String,
    mode: Mode,
    system: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let root = workspace
        .root(&label)
        .ok_or_else(|| "No folder is open in FigyCode".to_string())?;

    let settings = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "FigyCode has no model configured yet".to_string())?;
    let key = secrets::read(Credential::Key, KEY_ACCOUNT)?
        .ok_or_else(|| "FigyCode has no API key — add one in settings".to_string())?;

    let price = Price {
        input: settings.input_price.unwrap_or(0.0),
        cached_input: settings.cached_price.unwrap_or(0.0),
        output: settings.output_price.unwrap_or(0.0),
    };

    let provider = OpenAiProvider::new(ProviderConfig {
        base_url: settings.base_url.clone(),
        api_key: key,
        model: settings.model.clone(),
        temperature: settings.temperature,
        timeout: Duration::from_secs(300),
    });

    // The session is taken out of the map for the turn and put back after,
    // so the lock is never held across an await — a turn is minutes long,
    // and holding it would freeze every other command on this state.
    let mut session = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&label)
        .unwrap_or_else(|| {
            Session::new(
                SessionConfig {
                    session_id: format!("{label}:{}", now_ms()),
                    surface: Surface::Window,
                    model: settings.model.clone(),
                    price,
                    mode,
                },
                system,
            )
        });

    let (cancel_tx, cancel_rx) = oneshot::channel();
    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label.clone(), cancel_tx);

    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<TurnEvent>();
    let emitter = window.clone();
    let pump = tokio::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            let _ = emitter.emit(AGENT_EVENT, &event);
        }
    });

    // Cloned as its own type and then widened: `Arc::clone` inside a block
    // annotated `Arc<dyn Shell>` resolves against the trait object and will
    // not take a `&Arc<SystemShell>`.
    let system = {
        let mut shells = state.shells.lock().map_err(|e| e.to_string())?;
        Arc::clone(
            shells
                .entry(label.clone())
                .or_insert_with(|| Arc::new(SystemShell::new())),
        )
    };
    let shell: Arc<dyn Shell> = system;
    let ledger = ledger(&app, &state);
    let result = session
        .send(
            &prompt,
            Turn {
                provider: &provider,
                picker: &OfferEverything,
                approver: &WindowApprover { state: &state },
                ctx: &ToolContext::new(root).with_shell(shell),
                ledger: ledger.as_deref(),
            },
            events_tx,
            cancel_rx,
        )
        .await;

    // Dropped so the pump sees the channel close and finishes emitting
    // before the command returns; otherwise the last event can arrive after
    // the window has already re-enabled the composer.
    let _ = pump.await;

    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&label);
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label, session);

    result
}

/// What this window's session has spent.
#[tauri::command]
pub fn agent_usage(
    app: AppHandle,
    window: Window,
    state: State<AgentState>,
) -> Result<Totals, String> {
    let session_id = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
        .map(|session| session.id().to_string());
    let (Some(session_id), Some(ledger)) = (session_id, ledger(&app, &state)) else {
        // Nothing has been asked yet, which is zero rather than an error.
        return Ok(Totals::default());
    };
    ledger.totals(&session_id)
}

/// The ledger, opened once and shared.
///
/// On disk, in its own file beside the API client's — **not** in
/// `figyman.db`, which is synced to a user's own Postgres, and a record of
/// what they asked a model is nobody's business but this machine's.
///
/// An `Arc` because the turn must not hold the state's lock across an
/// await: a turn is minutes long, and every other command on this state
/// would wait behind it.
fn ledger(app: &AppHandle, state: &AgentState) -> Option<Arc<Ledger>> {
    let mut guard = state.ledger.lock().ok()?;
    if guard.is_none() {
        let dir = app.path().app_data_dir().ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        *guard = Ledger::open(&dir.join("figy-agent.db")).ok().map(Arc::new);
    }
    guard.clone()
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
