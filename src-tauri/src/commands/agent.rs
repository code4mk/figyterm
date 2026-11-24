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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::sync::oneshot;

use crate::agent::code::{Ask, Bridge, Lsp};
use crate::agent::ledger::{Ledger, Price, Surface, Totals};
use crate::agent::message::ToolCall;
use crate::agent::policy::Mode;
use crate::agent::provider::{OpenAiProvider, ProviderConfig};
use crate::agent::shell::{Shell, SystemShell};
use crate::agent::web::{Exa, Web};
use crate::agent::session::{
    Approver, OfferEverything, Session, SessionConfig, Turn, TurnEvent,
};
use crate::agent::store::{Conversation, Store};
use crate::agent::tools::{self, ToolContext};
use crate::agent::workspace::Workspace;

/// The event every turn is narrated through.
pub const AGENT_EVENT: &str = "agent://event";

/// A question for the window's language-server client. See `agent/code.rs`
/// for why these go out rather than being asked in Rust.
pub const AGENT_LSP_EVENT: &str = "agent://lsp-request";

/// Where the provider settings are kept, **key and all, in plain text**.
///
/// The rest of this app puts credentials in the OS keychain and says so
/// loudly — see `secrets/mod.rs`, which refuses to fall back to a file.
/// This one does not, deliberately and temporarily: the agent is being
/// built against a self-hosted endpoint with a throwaway token, and a
/// keychain prompt on every launch of a debug build is friction with
/// nothing behind it yet.
///
/// What that costs: anything that can read this user's files can read the
/// key. The file is written 0600 where the platform understands it, which
/// narrows it to this account and no further, and the window states the
/// path when it saves — a secret in a place nobody mentioned is worse than
/// one in a place everybody knows about.
///
/// **Before this ships to anyone**, `secrets::store(Credential::Key, …)` is
/// the three-line change that moves it, and `TASKS.md` carries it as an
/// open item.
const SETTINGS_FILE: &str = "figycode-agent.json";

/* ─── State ──────────────────────────────────────────────────────────────── */

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSettings {
    /// The part before `/chat/completions`.
    pub base_url: String,
    pub model: String,
    /// Stored, but never handed back to the webview: a window that can
    /// read the key is a window that can leak it into a screenshot, a log
    /// or a bug report.
    pub api_key: Option<String>,
    pub temperature: Option<f32>,
    /// Dollars per million tokens, as data rather than a table baked into
    /// the binary — the one certain thing about a price in a release is that
    /// it is out of date.
    pub input_price: Option<f64>,
    pub cached_price: Option<f64>,
    pub output_price: Option<f64>,
    /// The model's context window in tokens. Nothing on the wire says
    /// it, so it is a setting beside the model name.
    pub context_window: Option<u32>,
    /// What one conversation may spend before it stops.
    pub budget_usd: Option<f64>,
    /// Exa, for `search_web` and `fetch_url`. Absent means the agent has
    /// no web tools — which is a configuration, not a failure.
    pub exa_key: Option<String>,
}

/// What a session is filed under.
///
/// The window label alone was enough right up until the panel existed.
/// The editor is a modal in the *same* Tauri window as FigyCode, so both
/// surfaces would have been reading and writing one conversation — and
/// the symptom would have been the window answering a question typed into
/// the sidebar, which is a confusing thing to debug and an easy thing to
/// prevent.
fn key(label: &str, surface: Surface) -> String {
    format!(
        "{label}/{}",
        match surface {
            Surface::Window => "window",
            Surface::Panel => "panel",
        }
    )
}

#[derive(Default)]
pub struct AgentState {
    settings: Mutex<Option<AgentSettings>>,
    /// Per window *and surface* — see `key`. Two windows are two
    /// conversations, and so are the window and the panel inside one.
    sessions: Mutex<HashMap<String, Session>>,
    /// The turn in flight, so Escape can reach it. Keyed the same way:
    /// interrupting the panel must not stop the window's turn.
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Permission questions waiting on an answer, by tool-call id.
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /// Commands the user said not to ask about again, this session.
    remembered: Mutex<Vec<String>>,
    /// Opened once, on disk, and shared: two windows write to one file.
    ledger: Mutex<Option<Arc<Ledger>>>,
    /// The conversations, so a restart is an interruption rather than an
    /// ending. Same file as the ledger, different table.
    store: Mutex<Option<Arc<Store>>>,
    /// One shell per window, so its background commands die with it.
    shells: Mutex<HashMap<String, Arc<SystemShell>>>,
    /// One bridge per window, holding the questions it has outstanding.
    bridges: Mutex<HashMap<String, Arc<Bridge>>>,
}

pub fn forget_window(state: &AgentState, label: &str) {
    // Every surface of that window, since the key carries both.
    let mine = format!("{label}/");
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.retain(|k, _| !k.starts_with(&mine));
    }
    if let Ok(mut running) = state.running.lock() {
        running.retain(|k, _| !k.starts_with(&mine));
    }
    // Dropping the shell kills what it was running. A window's `npm run dev`
    // holding port 1420 against the next one, with nothing on screen to
    // blame, is the alternative.
    if let Ok(mut shells) = state.shells.lock() {
        shells.remove(label);
    }
    // Anything waiting on that window's editor will never be answered now.
    if let Ok(mut bridges) = state.bridges.lock() {
        if let Some(bridge) = bridges.remove(label) {
            bridge.abandon();
        }
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
/// Saves the settings, and answers with what actually stuck.
///
/// An empty key means "leave the one you have", so the form can be
/// reopened to change a model without retyping a token — and so a save
/// cannot silently blank the key by submitting a field that was never
/// filled in.
#[tauri::command]
pub fn agent_configure(
    app: AppHandle,
    state: State<AgentState>,
    settings: AgentSettings,
) -> Result<AgentStatus, String> {
    let existing = current(&app, &state)?;
    let mut next = settings;
    /*
      An empty key means "keep the one you have", for both of them.

      The form cannot show a stored key — it never comes back out — so a
      save after changing the model would otherwise blank whichever field
      the user did not retype.
    */
    let keep = |typed: Option<String>, stored: Option<String>| -> Option<String> {
        match typed.map(|k| k.trim().to_string()) {
            Some(k) if !k.is_empty() => Some(k),
            _ => stored,
        }
    };
    let old = existing.unwrap_or_default();
    next.api_key = keep(next.api_key, old.api_key);
    next.exa_key = keep(next.exa_key, old.exa_key);

    write_settings(&app, &next)?;
    *state.settings.lock().map_err(|e| e.to_string())? = Some(next.clone());
    Ok(status_of(&app, &next))
}

/// What the agent is actually set up with, as the backend knows it.
///
/// One question with one owner. The window used to assemble this from a
/// key check plus its own copy of the settings, which is two sources of
/// truth for "can I send a message" — and the one that refuses.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub has_key: bool,
    /// Whether the web tools will work. Shown, never the key itself.
    pub has_exa_key: bool,
    /// The settings as stored, with the key removed.
    pub settings: AgentSettings,
    /// Where they are written, which the window states when it saves.
    pub path: String,
}

#[tauri::command]
pub fn agent_status(app: AppHandle, state: State<AgentState>) -> Result<AgentStatus, String> {
    let settings = current(&app, &state)?.unwrap_or_default();
    Ok(status_of(&app, &settings))
}

fn status_of(app: &AppHandle, settings: &AgentSettings) -> AgentStatus {
    let mut public = settings.clone();
    public.api_key = None;
    public.exa_key = None;
    let present = |key: &Option<String>| key.as_ref().map(|k| !k.trim().is_empty()).unwrap_or(false);
    AgentStatus {
        has_key: present(&settings.api_key),
        has_exa_key: present(&settings.exa_key),
        settings: public,
        path: settings_path(app)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

/// The settings, from memory or from the file they were last written to.
///
/// Read through on a miss rather than at launch: a terminal that never
/// opens this window should not be reading its configuration.
fn current(app: &AppHandle, state: &AgentState) -> Result<Option<AgentSettings>, String> {
    let mut guard = state.settings.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = read_settings(app);
    }
    Ok(guard.clone())
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join(SETTINGS_FILE))
}

fn read_settings(app: &AppHandle) -> Option<AgentSettings> {
    let raw = std::fs::read_to_string(settings_path(app)?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_settings(app: &AppHandle, settings: &AgentSettings) -> Result<(), String> {
    let path = settings_path(app).ok_or_else(|| "No application data directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not save the settings: {e}"))?;

    // Narrowed to this account where the platform understands it. It does
    // not make a plaintext key safe; it keeps it from being readable by
    // every other account on a shared machine.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
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

/// The window's answer to an `agent://lsp-request`.
///
/// `result` on success, `error` when the editor could not ask — no server
/// for that language, the switch off, the server still starting. Both are
/// ordinary; the tool turns either into a sentence the model can act on.
#[tauri::command]
pub fn agent_lsp_reply(
    window: Window,
    state: State<AgentState>,
    id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let bridge = state
        .bridges
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
        .cloned();
    if let Some(bridge) = bridge {
        bridge.reply(
            &id,
            match error {
                Some(error) => Err(error),
                None => Ok(result.unwrap_or(Value::Null)),
            },
        );
    }
    Ok(())
}

/// Forgets this window's conversation.
///
/// The session, not the folder: a new conversation in the same project is
/// the commonest thing to want after a task is finished, and carrying the
/// last one's forty turns into it is paying for them again on every turn of
/// the next.
#[tauri::command]
pub fn agent_clear(
    window: Window,
    state: State<AgentState>,
    surface: Surface,
) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&key(window.label(), surface));
    Ok(())
}

/// Stops the turn this window is running.
#[tauri::command]
pub fn agent_cancel(
    window: Window,
    state: State<AgentState>,
    surface: Surface,
) -> Result<(), String> {
    if let Some(sender) = state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&key(window.label(), surface))
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

/// What one message carries, apart from the four things Tauri injects.
///
/// Grouped because the four of them are one thing — a turn, as the
/// surface asking for it describes it — and because `app`, `window` and
/// two states already use most of the arguments a function should have.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub prompt: String,
    pub mode: Mode,
    /// The preamble, which the surface owns: a different one is a
    /// different cache prefix, so the window's and the panel's must not
    /// be shared.
    pub system: String,
    pub surface: Surface,
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
    request: SendRequest,
) -> Result<(), String> {
    let SendRequest {
        prompt,
        mode,
        system,
        surface,
    } = request;
    let label = window.label().to_string();
    let session_key = key(&label, surface);

    /*
      Everything that can stop a turn before it starts, reported the same
      way a turn that fails half-way through is.

      These used to return `Err` and nothing else, which the window could
      only surface by inventing its own copy of the question — and did, by
      guessing from two round trips whether a key existed. A window that
      has to guess at the backend's state will eventually guess wrong and
      refuse to send a message the agent would have accepted.
    */
    let setup = (|| -> Result<(PathBuf, AgentSettings, String), String> {
        let root = workspace
            .root(&label)
            .ok_or_else(|| "No folder is open in FigyCode.".to_string())?;
        let settings = current(&app, &state)?
            .filter(|s| !s.base_url.trim().is_empty())
            .ok_or_else(|| "No model is set up yet — add one in /model.".to_string())?;
        if settings.model.trim().is_empty() {
            return Err("No model name is set — add one in /model.".into());
        }
        let key = settings
            .api_key
            .clone()
            .filter(|k| !k.trim().is_empty())
            .ok_or_else(|| "No API key is stored — add one in /model.".to_string())?;
        Ok((root, settings, key))
    })();

    let (root, settings, key) = match setup {
        Ok(ready) => ready,
        Err(error) => {
            let _ = window.emit(
                AGENT_EVENT,
                &TurnEvent::Failed {
                    error: error.clone(),
                },
            );
            return Err(error);
        }
    };

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
        .remove(&session_key)
        .unwrap_or_else(|| {
            Session::new(
                SessionConfig {
                    session_id: format!("{session_key}:{}", now_ms()),
                    surface,
                    model: settings.model.clone(),
                    price,
                    mode,
                    context_window: settings.context_window,
                    budget_usd: settings.budget_usd,
                },
                system,
            )
        });

    // Per message, not per session. The mode lives in the window — a
    // conversation started in `ask` and switched to `acceptEdits` with
    // shift+tab was still being run under `ask`, because a session only
    // ever read the mode it was built with.
    session.set_mode(mode);

    let (cancel_tx, cancel_rx) = oneshot::channel();
    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_key.clone(), cancel_tx);

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

    /*
      The bridge to this window's language-server client.

      Per window, because the event goes to that window and the answer
      comes back from it; a bridge shared between two would deliver one
      window's definition to the other's turn.
    */
    let bridge = {
        let mut bridges = state.bridges.lock().map_err(|e| e.to_string())?;
        Arc::clone(bridges.entry(label.clone()).or_insert_with(|| {
            let emitter = window.clone();
            Arc::new(Bridge::new(move |ask: &Ask| {
                emitter
                    .emit(AGENT_LSP_EVENT, ask)
                    .map_err(|e| format!("the window could not be reached: {e}"))
            }))
        }))
    };
    let lsp: Arc<dyn Lsp> = bridge;

    /*
      The web tools exist only when there is a key for them.

      Not a stub that fails on use: `ToolContext` without a `web` is how
      `search_web` knows to say "no Exa key is set" rather than attempting
      a request with an empty header and reporting a 401.
    */
    let web: Option<Arc<dyn Web>> = settings
        .exa_key
        .clone()
        .filter(|k| !k.trim().is_empty())
        .map(|key| Arc::new(Exa::new(key, tokio::runtime::Handle::current())) as Arc<dyn Web>);
    let ledger = ledger(&app, &state);
    // Kept, because `root` itself goes into the tool context below and the
    // snapshot after the turn needs to say where all this happened.
    let where_it_happened = root.to_string_lossy().to_string();
    let result = session
        .send(
            &prompt,
            Turn {
                provider: &provider,
                picker: &OfferEverything(surface),
                approver: &WindowApprover { state: &state },
                ctx: &{
                    let ctx = ToolContext::new(root).with_shell(shell).with_lsp(lsp);
                    match web {
                        Some(web) => ctx.with_web(web),
                        None => ctx,
                    }
                },
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
        .remove(&session_key);

    /*
      Written down after every turn, not at shutdown.

      The case this exists for is the one where there is no shutdown: a
      crash, a force quit, a machine that slept and did not come back. A
      failed write is not allowed to fail the turn — the answer is on
      screen and the conversation is in memory, and telling somebody
      their finished turn errored because a database was busy would be
      a lie about what happened.
    */
    if let Some(store) = store(&app, &state) {
        let _ = store.save(&session.snapshot(where_it_happened));
    }

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_key, session);

    result
}

/* ─── Conversations, between runs ────────────────────────────────────────── */

/// How many past conversations the list offers.
///
/// A number rather than all of them: the list is for picking up what you
/// were doing, and a conversation from six weeks ago is better found by
/// starting a new one.
const RESUME_LIST: usize = 30;

/// What was being worked on in this folder before.
#[tauri::command]
pub fn agent_conversations(
    app: AppHandle,
    window: Window,
    state: State<AgentState>,
    workspace: State<Workspace>,
    surface: Surface,
) -> Result<Vec<Conversation>, String> {
    let (Some(root), Some(store)) = (workspace.root(window.label()), store(&app, &state)) else {
        // No folder open, or no store yet. Nothing to offer is not an
        // error: it is a window that has not been used.
        return Ok(Vec::new());
    };
    store.list(&root.to_string_lossy(), surface, RESUME_LIST)
}

/// One message of a conversation being put back on screen.
///
/// Not `Message`: the window draws tool *rows*, so it needs the calls
/// parsed and the result matched to the call it answers. The raw
/// argument bytes stay in the store, where the cache depends on them —
/// this shape is for drawing, and nothing built from it goes back to
/// the provider.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastMessage {
    /// `user`, `assistant` or `tool`.
    pub role: String,
    pub content: String,
    pub calls: Vec<PastCall>,
    /// Tool results only: the call this answers.
    pub answers: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastCall {
    pub id: String,
    pub name: String,
    /// Parsed, because the window wants the path out of it. Malformed
    /// arguments become an empty object rather than a failed resume.
    pub arguments: Value,
}

/// A conversation handed back to the window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resumed {
    pub session_id: String,
    pub title: String,
    pub model: String,
    pub spent_usd: f64,
    pub messages: Vec<PastMessage>,
}

/// Picks a past conversation back up.
///
/// The session goes back into the map under this window's key, so the
/// next message continues it. What comes back is the transcript, for
/// the window to draw.
///
/// **It is not free.** The provider's cache is keyed on a prefix it saw
/// minutes ago, not days, so the first turn after this writes the whole
/// conversation again at full price. That is why resuming is something
/// you choose from a list rather than something that happens on launch.
#[tauri::command]
pub fn agent_resume(
    app: AppHandle,
    window: Window,
    state: State<AgentState>,
    workspace: State<Workspace>,
    surface: Surface,
    session_id: String,
) -> Result<Resumed, String> {
    let store = store(&app, &state).ok_or_else(|| "No conversations are stored.".to_string())?;
    let snapshot = store
        .load(&session_id)?
        .ok_or_else(|| "That conversation is no longer stored.".to_string())?;

    /*
      The folder has to match.

      A conversation is about a codebase: every path in it, every tool
      result, every "I changed src/main.rs" means something only in the
      folder it happened in. Resuming one into a different project would
      hand the model forty turns of confident, wrong context.
    */
    let root = workspace
        .root(window.label())
        .ok_or_else(|| "No folder is open in FigyCode.".to_string())?;
    if root.to_string_lossy() != snapshot.root {
        return Err(format!(
            "That conversation belongs to {} — open that folder to carry it on.",
            snapshot.root
        ));
    }

    let settings = current(&app, &state)?.unwrap_or_default();
    let messages = snapshot.history.iter().map(past).collect();
    let resumed = Resumed {
        session_id: snapshot.session_id.clone(),
        title: snapshot.title(),
        model: snapshot.model.clone(),
        spent_usd: snapshot.spent,
        messages,
    };

    let session = Session::resume(
        SessionConfig {
            session_id: snapshot.session_id.clone(),
            surface,
            model: settings.model.clone(),
            price: Price {
                input: settings.input_price.unwrap_or(0.0),
                cached_input: settings.cached_price.unwrap_or(0.0),
                output: settings.output_price.unwrap_or(0.0),
            },
            // The window sends the mode with every message now, so this
            // is only what applies if nothing is ever sent.
            mode: Mode::Ask,
            context_window: settings.context_window,
            budget_usd: settings.budget_usd,
        },
        snapshot,
    );
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key(window.label(), surface), session);

    Ok(resumed)
}

/// Removes a stored conversation. The live one, if it is this one, stays
/// — forgetting what was written down is not the same as clearing the
/// screen, and `/clear` is the one that does that.
#[tauri::command]
pub fn agent_forget_conversation(
    app: AppHandle,
    state: State<AgentState>,
    session_id: String,
) -> Result<(), String> {
    match store(&app, &state) {
        Some(store) => store.forget(&session_id),
        None => Ok(()),
    }
}

fn past(message: &crate::agent::message::Message) -> PastMessage {
    use crate::agent::message::Role;
    PastMessage {
        role: match message.role {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        }
        .into(),
        content: message.content.clone(),
        calls: message
            .tool_calls
            .iter()
            .map(|call| PastCall {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.parsed().unwrap_or_else(|_| Value::Object(Default::default())),
            })
            .collect(),
        answers: message.tool_call_id.clone(),
    }
}

/// What this window's session has spent.
#[tauri::command]
pub fn agent_usage(
    app: AppHandle,
    window: Window,
    state: State<AgentState>,
    surface: Surface,
) -> Result<Totals, String> {
    let session_id = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&key(window.label(), surface))
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
        *guard = Ledger::open(&database(app)?).ok().map(Arc::new);
    }
    guard.clone()
}

/// The conversation store, opened once and shared.
///
/// The same file as the ledger, a second connection to it. Two tables
/// with two meanings — the ledger is an append-only record of what
/// things cost and is never edited, this is a snapshot of right now and
/// is rewritten every turn — and one file to delete when somebody wants
/// none of it kept.
fn store(app: &AppHandle, state: &AgentState) -> Option<Arc<Store>> {
    let mut guard = state.store.lock().ok()?;
    if guard.is_none() {
        *guard = Store::open(&database(app)?).ok().map(Arc::new);
    }
    guard.clone()
}

fn database(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("figy-agent.db"))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
