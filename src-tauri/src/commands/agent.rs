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
use std::panic::AssertUnwindSafe;

use futures_util::future::FutureExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::sync::oneshot;

use crate::agent::ask::{Asker, Desk, Question};
use crate::agent::code::{Ask, Bridge, Lsp};
use crate::agent::delegate::{Delegate, SubAgent};
use crate::agent::ledger::{Ledger, Price, Surface, Totals};
use crate::agent::message::{Image, ToolCall};
use crate::agent::policy::{Mode, ModeCell};
use crate::agent::picker::Jev;
use crate::agent::provider::{OpenAiProvider, ProviderConfig};
use crate::agent::rules;
use crate::agent::shell::{Shell, SystemShell};
use crate::agent::web::{Exa, Web};
use crate::agent::session::{
    Approver, Breakdown, OfferEverything, Picker, Session, SessionConfig, Turn, TurnEvent,
};
use crate::agent::store::{Conversation, Store};
use crate::agent::tools::{self, ToolContext};
use crate::agent::workspace::Workspace;

/// The event every turn is narrated through.
/// The event every turn is narrated through — **per surface**.
///
/// The editor panel and the FigyCode window are two React trees in
/// one Tauri window, so a single channel is one both of them hear:
/// the panel would draw the window's tool rows and the window would
/// draw the panel's, each of them applying events for a
/// conversation it is not having. A name per surface is the whole
/// fix, and it is cheaper than a field every listener has to
/// remember to check.
pub fn agent_event(surface: Surface) -> String {
    format!("agent://event/{}", surface.as_str())
}

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

/// One model, where to reach it, and what it costs.
///
/// A list rather than a single setting, because the single setting was
/// wrong about how this is actually used: a cheap model for the panel
/// and an expensive one for a refactor, a local endpoint and a hosted
/// one, two providers while deciding between them. Switching meant
/// retyping a base URL and a key, which nobody does twice — they pick
/// one and stop comparing.
///
/// Every field that differs per model is here, prices included.
/// `CODE-AGENT.md` is firm that prices are data rather than a table in
/// the binary; a table that also assumed one model at a time would have
/// been wrong twice.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderModel {
    /// Stable across edits, minted by the window. What `active` points
    /// at, so renaming a model does not deselect it.
    pub id: String,
    /// What to call it here. Empty means the model name does.
    pub label: String,
    /// The part before `/chat/completions`.
    pub base_url: String,
    pub model: String,
    /// Stored, and never handed back to the webview: a window that can
    /// read a key is a window that can leak it into a screenshot, a log
    /// or a bug report.
    pub api_key: Option<String>,
    pub temperature: Option<f32>,
    /// Dollars per million tokens. The one certain thing about a price
    /// in a release is that it is out of date.
    pub input_price: Option<f64>,
    pub cached_price: Option<f64>,
    pub output_price: Option<f64>,
    /// Its context window in tokens. Nothing on the wire reports it, and
    /// it belongs to the model rather than to the session — which is
    /// why it moved here when there was more than one model.
    pub context_window: Option<u32>,
    /// Whether it can be sent pictures.
    ///
    /// A setting rather than something to find out, because finding
    /// out means sending one and reading a 400 — and the 400 arrives
    /// as "the turn failed" after somebody has attached a screenshot
    /// and typed a question. Off by default: a model that cannot see
    /// is the safe assumption, and the window can say so at the
    /// moment an image is attached rather than after it is sent.
    pub vision: bool,
}

impl ProviderModel {
    fn usable(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.model.trim().is_empty()
    }

    /// What the window shows in a list: the name somebody gave it, or
    /// the model's own.
    fn name(&self) -> &str {
        if self.label.trim().is_empty() {
            &self.model
        } else {
            &self.label
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSettings {
    /// Every model set up here, in the order the window shows them.
    pub models: Vec<ProviderModel>,
    /// Which one is used, by `id`. An id that is not in the list falls
    /// back to the first usable model rather than refusing to send:
    /// deleting the active model should not break the window.
    pub active: Option<String>,
    /// What one conversation may spend before it stops. Per session
    /// rather than per model — it is a limit on the work, not on the
    /// thing doing it.
    pub budget_usd: Option<f64>,
    /// Exa, for `search_web` and `fetch_url`. Absent means the agent has
    /// no web tools — which is a configuration, not a failure.
    pub exa_key: Option<String>,
    /// Whether typesafe.ai's Jev picks the tool list before the model
    /// sees it. Off unless this is on *and* there is a key.
    pub router: bool,
    pub router_key: Option<String>,
    /// Its model and price, as data for the same reason the chat
    /// model's are: a price in a binary is out of date on release.
    pub router_model: Option<String>,
    pub router_price: Option<f64>,
}

impl AgentSettings {
    /// The model a turn will use, if there is one.
    fn chosen(&self) -> Option<&ProviderModel> {
        self.active
            .as_deref()
            .and_then(|id| self.models.iter().find(|m| m.id == id && m.usable()))
            .or_else(|| self.models.iter().find(|m| m.usable()))
    }
}

/// The shape this file had when there was one model.
///
/// Read only when the new shape has none, and converted into a single
/// entry. A settings file that silently loses somebody's endpoint and
/// key because the struct changed is the worst kind of upgrade, and the
/// twenty lines to avoid it are worth more than the tidiness of
/// deleting them.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LegacySettings {
    base_url: String,
    model: String,
    api_key: Option<String>,
    temperature: Option<f32>,
    input_price: Option<f64>,
    cached_price: Option<f64>,
    output_price: Option<f64>,
    context_window: Option<u32>,
    budget_usd: Option<f64>,
    exa_key: Option<String>,
}

impl LegacySettings {
    fn forward(self) -> Option<AgentSettings> {
        if self.base_url.trim().is_empty() && self.model.trim().is_empty() {
            return None;
        }
        let one = ProviderModel {
            id: "migrated".into(),
            label: String::new(),
            base_url: self.base_url,
            model: self.model,
            api_key: self.api_key,
            temperature: self.temperature,
            input_price: self.input_price,
            cached_price: self.cached_price,
            output_price: self.output_price,
            context_window: self.context_window,
            // The old shape predates it, and a model nobody told us
            // about cannot be assumed to see.
            vision: false,
        };
        Some(AgentSettings {
            active: Some(one.id.clone()),
            models: vec![one],
            budget_usd: self.budget_usd,
            exa_key: self.exa_key,
            ..AgentSettings::default()
        })
    }
}

/// What a session — and a workspace root, and a file index — is
/// filed under.
///
/// The window label alone was enough right up until the panel existed.
/// The editor is a modal in the *same* Tauri window as FigyCode, so both
/// surfaces would have been reading and writing one conversation — and
/// the symptom would have been the window answering a question typed into
/// the sidebar, which is a confusing thing to debug and an easy thing to
/// prevent.
pub fn key(label: &str, surface: Surface) -> String {
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
    /// The mode of each turn in flight, reachable while it runs.
    ///
    /// Two answers change what the rest of a turn may do — "allow all
    /// edits this session" and an approved plan — and both are given
    /// after the turn has started. Without this they applied to the
    /// next message instead, which is a promise the card does not make.
    modes: Mutex<HashMap<String, ModeCell>>,
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
    /// One desk per window *and surface*, holding the questions
    /// `ask_user` has put to the person and not had answered yet. Keyed
    /// like the sessions rather than like the shell: the card is drawn
    /// in the conversation that asked it.
    desks: Mutex<HashMap<String, Arc<Desk>>>,
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
    if let Ok(mut modes) = state.modes.lock() {
        modes.retain(|k, _| !k.starts_with(&mine));
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
    /*
      And anything waiting on the person at it — on *either* surface.

      Keyed by window and surface like the sessions, rather than by
      window like the shell and the bridge, because the card is drawn
      in the conversation that asked: a panel's question answered into
      the window's transcript would be answering a question nobody
      there had been asked. Which makes this a prefix sweep and not a
      `remove`, and getting that wrong leaves a desk alive after its
      window is gone with somebody's `ask_user` waiting on it forever.
    */
    if let Ok(mut desks) = state.desks.lock() {
        for (_, desk) in desks.extract_if(|k, _| k.starts_with(&mine)) {
            desk.abandon();
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
    surface: Surface,
    name: String,
    args: Value,
) -> Result<ToolResult, String> {
    let root = workspace
        .root(&key(window.label(), surface))
        .ok_or_else(|| "No folder is open in FigyCode".to_string())?;
    let out = tools::call(&ToolContext::new(root), &name, &args)?;
    Ok(ToolResult {
        approx_tokens: tools::output::approx_tokens(&out.text),
        text: out.text,
        detail: out.detail,
    })
}

/* ─── Configuration ──────────────────────────────────────────────────────── */

/// Saves the settings, and answers with what actually stuck.
///
/// The whole shape, every time, rather than a command per field. There
/// is one form behind this and one file in front of it, and a handful of
/// narrower commands would have been three ways for the two to disagree.
///
/// **An empty key means "leave the one you have"**, per model and for
/// Exa. The form cannot show a stored key — it never comes back out — so
/// without this, saving after renaming a model would blank the token
/// nobody retyped.
#[tauri::command]
pub fn agent_configure(
    app: AppHandle,
    state: State<AgentState>,
    settings: AgentSettings,
) -> Result<AgentStatus, String> {
    let old = current(&app, &state)?.unwrap_or_default();
    let mut next = settings;

    let keep = |typed: Option<String>, stored: Option<String>| -> Option<String> {
        match typed.map(|k| k.trim().to_string()) {
            Some(k) if !k.is_empty() => Some(k),
            _ => stored,
        }
    };

    for model in &mut next.models {
        let stored = old
            .models
            .iter()
            .find(|m| m.id == model.id)
            .and_then(|m| m.api_key.clone());
        model.api_key = keep(model.api_key.take(), stored);
    }
    next.exa_key = keep(next.exa_key, old.exa_key);
    next.router_key = keep(next.router_key, old.router_key);

    // A list with nothing chosen, or pointing at a model that has been
    // deleted, picks the first that could work. The alternative is a
    // window that refuses to send with a perfectly good model in it.
    if next.chosen().is_none() {
        next.active = next.models.iter().find(|m| m.usable()).map(|m| m.id.clone());
    } else if let Some(chosen) = next.chosen() {
        next.active = Some(chosen.id.clone());
    }

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
    /// Whether the chosen model has a key — which, with a base URL and
    /// a model name, is the whole of "can I send a message".
    pub has_key: bool,
    /// Whether the web tools will work. Shown, never the key itself.
    pub has_exa_key: bool,
    /// Whether the tool router is on, and whether it could be.
    pub router: bool,
    pub has_router_key: bool,
    pub router_model: Option<String>,
    pub router_price: Option<f64>,
    /// The model a turn would use, by `id`, or none.
    pub active: Option<String>,
    /// Its name, for the footer. Empty when nothing is set up.
    pub model: String,
    /// Every model, with the keys replaced by whether there is one.
    pub models: Vec<PublicModel>,
    pub budget_usd: Option<f64>,
    /// Where they are written, which the window states when it saves.
    pub path: String,
}

/// A model as the window may see it: everything except the key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicModel {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub model: String,
    /// Not the key. A window that can read one can leak it into a
    /// screenshot, a log or a bug report.
    pub has_key: bool,
    pub temperature: Option<f32>,
    pub input_price: Option<f64>,
    pub cached_price: Option<f64>,
    pub output_price: Option<f64>,
    pub context_window: Option<u32>,
    pub vision: bool,
}

#[tauri::command]
pub fn agent_status(app: AppHandle, state: State<AgentState>) -> Result<AgentStatus, String> {
    let settings = current(&app, &state)?.unwrap_or_default();
    Ok(status_of(&app, &settings))
}

fn status_of(app: &AppHandle, settings: &AgentSettings) -> AgentStatus {
    let present = |key: &Option<String>| key.as_ref().map(|k| !k.trim().is_empty()).unwrap_or(false);
    let chosen = settings.chosen();
    AgentStatus {
        has_key: chosen.map(|m| present(&m.api_key)).unwrap_or(false),
        has_exa_key: present(&settings.exa_key),
        router: settings.router && present(&settings.router_key),
        has_router_key: present(&settings.router_key),
        router_model: settings.router_model.clone(),
        router_price: settings.router_price,
        active: chosen.map(|m| m.id.clone()),
        model: chosen.map(|m| m.name().to_string()).unwrap_or_default(),
        models: settings
            .models
            .iter()
            .map(|m| PublicModel {
                id: m.id.clone(),
                label: m.label.clone(),
                base_url: m.base_url.clone(),
                model: m.model.clone(),
                has_key: present(&m.api_key),
                temperature: m.temperature,
                input_price: m.input_price,
                cached_price: m.cached_price,
                output_price: m.output_price,
                context_window: m.context_window,
                vision: m.vision,
            })
            .collect(),
        budget_usd: settings.budget_usd,
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
    let settings: AgentSettings = serde_json::from_str(&raw).ok()?;
    if !settings.models.is_empty() {
        return Some(settings);
    }
    // No models in the new shape: either an empty file, or one written
    // before there could be more than one. The old shape is tried
    // before giving up, so an upgrade does not lose somebody's endpoint.
    serde_json::from_str::<LegacySettings>(&raw)
        .ok()
        .and_then(LegacySettings::forward)
        .or(Some(settings))
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
///
/// `mode` is how "Yes, allow all edits this session" keeps its promise.
/// It used to set the window's own mode and reach the agent on the
/// *next* message, so the rest of the turn it was granted in carried on
/// asking — which reads as the button not having worked.
#[tauri::command]
pub fn agent_approve(
    window: Window,
    state: State<AgentState>,
    id: String,
    allow: bool,
    remember: Option<String>,
    mode: Option<Mode>,
    surface: Option<Surface>,
) -> Result<(), String> {
    if let Some(mode) = mode {
        set_mode(&state, &key(window.label(), surface.unwrap_or(Surface::Window)), mode);
    }
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
    /*
      And `ask_user` is released rather than left parked.

      Its card is gone from the screen the moment the turn is cancelled;
      a tool thread still blocked on it would be a turn that never ends
      and a window that can never be asked anything again.
    */
    let desk = state
        .desks
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
        .cloned();
    if let Some(desk) = desk {
        desk.abandon();
    }
    Ok(())
}

/// The window's answer to an `ask_user` card.
///
/// One string, which is the option as the person picked it — or whatever
/// the window sends when they decline all of them. The tool puts it in
/// the conversation verbatim, so this is the model's own reading of what
/// was said.
#[tauri::command]
pub fn agent_answer(
    window: Window,
    state: State<AgentState>,
    id: String,
    answer: String,
    // An approved plan lifts plan mode, in the turn that proposed it.
    mode: Option<Mode>,
    surface: Option<Surface>,
) -> Result<(), String> {
    if let Some(mode) = mode {
        set_mode(&state, &key(window.label(), surface.unwrap_or(Surface::Window)), mode);
    }
    let desk = state
        .desks
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
        .cloned();
    if let Some(desk) = desk {
        desk.answer(&id, answer);
    }
    Ok(())
}

/// Changes the mode of a turn that is already running.
///
/// Silent when there is no turn: the commonest cause is an answer
/// arriving just after Escape, and there is nothing left to change.
fn set_mode(state: &AgentState, session_key: &str, mode: Mode) {
    if let Ok(modes) = state.modes.lock() {
        if let Some(cell) = modes.get(session_key) {
            cell.set(mode);
        }
    }
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
    /// Pictures attached to this message, if any.
    #[serde(default)]
    pub images: Vec<Image>,
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
        images,
        mode,
        system,
        surface,
    } = request;
    let label = window.label().to_string();
    let session_key = key(&label, surface);

    /*
      One turn at a time, per conversation.

      This is a guard against a sequence that silently destroyed work.
      A running turn *owns* its session — it is removed from the map for
      the duration and put back at the end, so that nothing has to hold
      a lock across a four-minute tool call. A second `agent_send` on
      the same key while that is happening finds no session, builds a
      **brand-new one with empty history**, and the two run side by
      side: both narrating into the same transcript, both inserting
      themselves back at the end so the slower one erases the other's
      whole conversation, and the second overwriting the first's cancel
      sender so Escape can no longer reach it.

      None of that reported anything. It was hard to hit while turns
      lasted seconds, and `bash_wait` made turns that legitimately sit
      for five minutes — which is exactly when somebody types the next
      thing.

      Refused here rather than only in the window, because this is the
      side that owns the session and a front end that has to remember a
      rule will eventually forget it. The window queues instead, so this
      is a backstop and not the usual path.
    */
    if state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&session_key)
    {
        return Err(
            "That conversation is still working. Wait for it, or press Escape to stop it."
                .into(),
        );
    }

    /*
      Everything that can stop a turn before it starts, reported the same
      way a turn that fails half-way through is.

      These used to return `Err` and nothing else, which the window could
      only surface by inventing its own copy of the question — and did, by
      guessing from two round trips whether a key existed. A window that
      has to guess at the backend's state will eventually guess wrong and
      refuse to send a message the agent would have accepted.
    */
    let setup = (|| -> Result<(PathBuf, AgentSettings, ProviderModel, String), String> {
        let root = workspace
            .root(&session_key)
            .ok_or_else(|| "No folder is open in FigyCode.".to_string())?;
        let settings = current(&app, &state)?.unwrap_or_default();
        if settings.models.is_empty() {
            return Err("No model is set up yet — add one in /model.".into());
        }
        let chosen = settings
            .chosen()
            .cloned()
            .ok_or_else(|| "The chosen model has no address or no name — see /model.".to_string())?;
        let key = chosen
            .api_key
            .clone()
            .filter(|k| !k.trim().is_empty())
            .ok_or_else(|| {
                format!("No API key is stored for {} — add one in /model.", chosen.name())
            })?;
        /*
          Refused here rather than by the provider.

          Sending a picture to a model that cannot see one comes back
          as a 400 with somebody's screenshot and question already
          spent. This is the same answer two seconds earlier and in a
          sentence that says what to do about it.
        */
        if !images.is_empty() && !chosen.vision {
            return Err(format!(
                "{} is not set up to read images. Tick \"reads images\" for it in \
                 /model if it can, or switch to a model that does.",
                chosen.name()
            ));
        }
        Ok((root, settings, chosen, key))
    })();

    let (root, settings, chosen, key) = match setup {
        Ok(ready) => ready,
        Err(error) => {
            let _ = window.emit(
                &agent_event(surface),
                &TurnEvent::Failed {
                    error: error.clone(),
                },
            );
            return Err(error);
        }
    };

    let price = Price {
        input: chosen.input_price.unwrap_or(0.0),
        cached_input: chosen.cached_price.unwrap_or(0.0),
        output: chosen.output_price.unwrap_or(0.0),
    };

    // Built twice rather than shared: the sub-agent in `task` talks to
    // the same endpoint with the same key, and a client is a config and
    // a connection pool rather than anything worth passing around.
    let settings_for_provider = ProviderConfig {
        base_url: chosen.base_url.clone(),
        api_key: key,
        model: chosen.model.clone(),
        temperature: chosen.temperature,
        timeout: Duration::from_secs(300),
    };
    let provider = OpenAiProvider::new(ProviderConfig {
        base_url: settings_for_provider.base_url.clone(),
        api_key: settings_for_provider.api_key.clone(),
        model: settings_for_provider.model.clone(),
        temperature: settings_for_provider.temperature,
        timeout: settings_for_provider.timeout,
    });

    // The session is taken out of the map for the turn and put back after,
    // so the lock is never held across an await — a turn is minutes long,
    // and holding it would freeze every other command on this state.
    /*
      The project's own instructions, read once, here.

      Once because this is the prefix: `tools → system → messages`, and
      a file the user can touch to invalidate the cache of a session
      thirty turns deep is a worse surprise than the one it fixes. An
      edit to `FIGY.md` applies to the next conversation. The read costs
      nothing when the session already exists, because the closure below
      only runs when one is being made.
    */
    // Read per turn, so a folder granted now is reachable now.
    let extra = workspace.extra(&session_key);
    let extra_names: Vec<String> = extra
        .iter()
        .filter_map(|dir| dir.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();

    let mut session = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_key)
        .unwrap_or_else(|| {
            /*
              The preamble, the project's rules, and the folders.

              All three are frozen together, because all three are the
              prefix. A folder granted mid-conversation reaches the
              *tools* immediately — the workspace is read per turn —
              and reaches the model's own description of where it is
              on the next conversation. The window says so when it
              grants one.
            */
            let system = match rules::folders(&extra_names) {
                Some(said) => format!("{system}\n\n{said}"),
                None => system.clone(),
            };
            let system = rules::attach(&system, rules::read(&root).as_ref());
            Session::new(
                SessionConfig {
                    session_id: format!("{session_key}:{}", now_ms()),
                    surface,
                    model: chosen.model.clone(),
                    price,
                    mode,
                    context_window: chosen.context_window,
                    budget_usd: settings.budget_usd,
                    max_steps: None,
                },
                system,
            )
        });

    // Per message, not per session. Both of these live in the window:
    // a conversation started in `ask` and switched to `acceptEdits`
    // with shift+tab was still being run under `ask`, and one switched
    // to another model went on being costed at the old model's prices.
    session.set_mode(mode);
    session.use_model(chosen.model.clone(), price, chosen.context_window);

    let (cancel_tx, cancel_rx) = oneshot::channel();
    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_key.clone(), cancel_tx);
    // Reachable for the length of the turn, so an answer given during it
    // changes what the rest of it may do.
    state
        .modes
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_key.clone(), session.mode_cell());

    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<TurnEvent>();
    let emitter = window.clone();
    let channel = agent_event(surface);
    let pump = tokio::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            let _ = emitter.emit(&channel, &event);
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
      The desk `ask_user` puts its questions on.

      Per *conversation*, not per window like the bridge: the card is
      drawn in the transcript that asked for it, and the editor panel
      is a second transcript in the same window. Keyed by window and
      surface, a panel's question cannot be answered out of the
      FigyCode window's card — which would be answering a question
      nobody there was asked.

      It emits on the turn's own event channel rather than one of its
      own, so each surface has one stream to render rather than two to
      interleave.
    */
    let desk = {
        let mut desks = state.desks.lock().map_err(|e| e.to_string())?;
        Arc::clone(desks.entry(session_key.clone()).or_insert_with(|| {
            let emitter = window.clone();
            let asking = agent_event(surface);
            Arc::new(Desk::new(move |question: &Question| {
                emitter
                    .emit(
                        &asking,
                        &TurnEvent::AskingUser {
                            id: question.id.clone(),
                            question: question.question.clone(),
                            options: question.options.clone(),
                            steps: question.steps.clone(),
                        },
                    )
                    .map_err(|e| format!("the window could not be reached: {e}"))
            }))
        }))
    };
    let asker: Arc<dyn Asker> = desk;

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
    /*
      The tool picker, which is the model's own unless one is set up.

      Off is the default and the right default: the whole tool set is
      about 3.8K tokens read from cache at a tenth of a cent, and tools
      are the first bytes of the request, so a router that changes the
      set rewrites everything after it. `agent/picker.rs` has the full
      argument and the three rules that make it safe to switch on
      anyway — the most important being that a router which fails
      offers everything, so a third-party outage costs a few hundred
      milliseconds rather than a turn.
    */
    let router: Option<Jev> = settings
        .router
        .then(|| settings.router_key.clone())
        .flatten()
        .filter(|key| !key.trim().is_empty())
        .map(|key| {
            Jev::new(key, surface)
                .with_model(settings.router_model.clone())
                .with_price(settings.router_price)
        });

    let ledger = ledger(&app, &state);
    // Kept, because `root` itself goes into the tool context below and the
    // snapshot after the turn needs to say where all this happened.
    let where_it_happened = root.to_string_lossy().to_string();


    /*
      The sub-agent `task` hands questions to.

      Same provider, same ledger rows, same budget ceiling — a different
      conversation. What makes it worth having is that its context is
      thrown away: the twenty files it read to answer one question never
      enter this session's prefix, so they are never paid for again.

      It gets the language server and the project, and neither the shell
      nor the person. `agent/delegate.rs` has the argument.
    */
    let delegate: Arc<dyn Delegate> = Arc::new(
        SubAgent::new(
            tokio::runtime::Handle::current(),
            Arc::new(OpenAiProvider::new(settings_for_provider)),
            session.id().to_string(),
            surface,
            chosen.model.clone(),
            price,
            root.clone(),
        )
        .with_limits(chosen.context_window, settings.budget_usd)
        .with_ledger(ledger.clone())
        .with_lsp(Arc::clone(&lsp)),
    );
    let everything = OfferEverything(surface);
    let picker: &dyn Picker = match &router {
        Some(jev) => jev,
        None => &everything,
    };
    /*
      A panic in a turn must not read as nothing happening.

      This is the second half of a bug worth remembering: the tool
      picker called `block_on` inside the turn's own async task, which
      panics on a runtime worker. The task died before emitting a
      single event, the command never returned, and the window sat
      with a disabled composer waiting for an answer that was never
      coming. From the outside, sending "hi" did nothing at all.

      The cause is fixed. The net stays, because the next panic will
      be somewhere else: it becomes a failed turn with the message in
      it, the history is sealed so the *next* message still has a
      conversation it can send, and the composer comes back.
    */
    let result = AssertUnwindSafe(session.send(
            &prompt,
            images,
            Turn {
                provider: &provider,
                picker,
                approver: &WindowApprover { state: &state },
                ctx: &{
                    let ctx = ToolContext::new(root)
                        .with_extra(extra)
                        .with_surface(surface.as_str())
                        .with_shell(shell)
                        .with_lsp(lsp)
                        .with_asker(asker)
                        .with_delegate(delegate);
                    match web {
                        Some(web) => ctx.with_web(web),
                        None => ctx,
                    }
                },
                ledger: ledger.as_deref(),
            },
            events_tx,
            cancel_rx,
        ))
    .catch_unwind()
    .await
    .unwrap_or_else(|panic| {
        let what = panic
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "something went wrong inside the turn".to_string());
        let dangling = session.seal();
        let error = format!(
            "The turn stopped unexpectedly: {what}{}",
            if dangling > 0 {
                format!(" ({dangling} tool call(s) left unfinished)")
            } else {
                String::new()
            }
        );
        let _ = window.emit(&agent_event(surface), &TurnEvent::Failed { error: error.clone() });
        Err(error)
    });

    // Dropped so the pump sees the channel close and finishes emitting
    // before the command returns; otherwise the last event can arrive after
    // the window has already re-enabled the composer.
    let _ = pump.await;

    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_key);
    state
        .modes
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

/* ─── Background jobs ────────────────────────────────────────────────────── */

/// One background command, as the window draws it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJob {
    pub id: String,
    pub command: String,
    /// Which conversation started it, so only that one reports it.
    pub owner: String,
    pub finished: bool,
    pub status: Option<i32>,
    pub ms: u64,
    pub lines: usize,
}

/// What this window has running in the background, and what has just
/// finished.
///
/// **Per window, not per surface.** The shell is one per window — the
/// FigyCode window and the editor panel share it — so a build started
/// from one is visible in the other. That is right: it is one machine
/// and one set of processes, and a job that vanished because you
/// looked at it from the wrong panel would be a worse lie than a
/// shared list.
///
/// The window polls this, which is the opposite of the rule
/// `bash_wait` exists to enforce — and the difference is the whole
/// point. A model polling spends a request that re-sends the entire
/// conversation; a window polling spends a mutex and a `Vec` clone.
/// The expensive loop is the one with a language model in it.
///
/// Finished jobs are included, because "it disappeared from the list"
/// is not an outcome. The window keeps what it last saw, notices what
/// has turned finished, and says so.
#[tauri::command]
pub fn agent_background(window: Window, state: State<AgentState>) -> Vec<BackgroundJob> {
    let shell = {
        let Ok(shells) = state.shells.lock() else {
            return Vec::new();
        };
        shells.get(window.label()).map(Arc::clone)
    };
    let Some(shell) = shell else {
        // No shell yet means nothing has ever been run from this
        // window, which is a shorter answer than an error.
        return Vec::new();
    };
    shell
        .jobs()
        .into_iter()
        .map(|job| BackgroundJob {
            id: job.id,
            command: job.command,
            owner: job.owner,
            finished: job.finished,
            status: job.status,
            ms: job.ms,
            lines: job.lines,
        })
        .collect()
}

/// What a background job has written, from `from` onwards.
///
/// Separate from [`agent_background`] because it is asked for far less
/// often and costs more: the list is polled once a second for every
/// job, and this is polled only while somebody has one *open*. A
/// hundred-line build log in every poll of the bar would be a hundred
/// lines serialised across IPC every second for a row showing a
/// pulsing dot.
///
/// `from` is a cursor, so an open log fetches each line once rather
/// than re-sending the whole buffer every second. A Docker build
/// writes a few thousand.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundOutput {
    pub lines: Vec<String>,
    /// How many exist in total, so the caller can advance its cursor.
    pub total: usize,
    pub finished: bool,
    pub status: Option<i32>,
}

#[tauri::command]
pub fn agent_background_output(
    window: Window,
    state: State<AgentState>,
    id: String,
    from: usize,
) -> Result<BackgroundOutput, String> {
    let shell = {
        let shells = state.shells.lock().map_err(|e| e.to_string())?;
        shells.get(window.label()).map(Arc::clone)
    };
    let running = shell
        .ok_or_else(|| "Nothing has been run from this window.".to_string())?
        .poll(&id, from)?;

    Ok(BackgroundOutput {
        lines: running.lines,
        total: running.total,
        finished: running.finished,
        status: running.status,
    })
}

/// Stops one, from the window's own chip rather than through the model.
#[tauri::command]
pub fn agent_background_kill(
    window: Window,
    state: State<AgentState>,
    id: String,
) -> Result<(), String> {
    let shell = {
        let shells = state.shells.lock().map_err(|e| e.to_string())?;
        shells.get(window.label()).map(Arc::clone)
    };
    shell
        .ok_or_else(|| "Nothing has been run from this window.".to_string())?
        .kill(&id)
}

/* ─── The project's own instructions ─────────────────────────────────────── */

/// What this project tells the agent, and what it costs to tell it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRules {
    pub name: String,
    pub path: String,
    /// Roughly, for the one line the window shows. These sit in the
    /// cached prefix of every request for the whole session, so the
    /// number is the point: rules are not free, and a window that hides
    /// the cost is a window that invites a thousand-line one.
    pub tokens: usize,
    pub truncated: bool,
}

/// Whether this folder has written any rules down.
///
/// Read live rather than from the session, so the first screen can say
/// what the *next* conversation will be given. A running session keeps
/// the copy it started with — the prefix is frozen, and `/clear` is how
/// an edit is picked up.
#[tauri::command]
pub fn agent_rules(
    window: Window,
    workspace: State<Workspace>,
    surface: Surface,
) -> Result<Option<ProjectRules>, String> {
    let Some(root) = workspace.root(&key(window.label(), surface)) else {
        return Ok(None);
    };
    Ok(rules::read(&root).map(|rules| ProjectRules {
        tokens: tools::output::approx_tokens(&rules.text),
        name: rules.name,
        path: rules.path,
        truncated: rules.truncated,
    }))
}

/* ─── Is the router actually running? ────────────────────────────────────── */

/// What one real call to the tool picker did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterCheck {
    pub ok: bool,
    /// What it chose, or everything, depending on `ok`.
    pub picked: Vec<String>,
    pub total: usize,
    pub cost_usd: f64,
    /// Why it did not work, when it did not.
    pub error: Option<String>,
}

/// Makes one real request to the tool picker and says what happened.
///
/// This exists because of a question nobody could answer from the
/// window: *is it working?* A router that falls back silently — which
/// is the right behaviour during a turn — is indistinguishable from
/// one that is switched off, one with a bad key, and one whose
/// endpoint has changed shape. The only honest way to tell is to make
/// a call on purpose and report the whole of it.
///
/// Deliberately a button rather than something automatic: it costs a
/// request and a fraction of a cent, and both belong to whoever
/// pressed it.
#[tauri::command(async)]
pub async fn agent_test_router(
    app: AppHandle,
    state: State<'_, AgentState>,
    surface: Surface,
) -> Result<RouterCheck, String> {
    let settings = current(&app, &state)?.unwrap_or_default();
    let total = tools::specs_for(surface).len();

    let Some(key) = settings
        .router_key
        .clone()
        .filter(|key| !key.trim().is_empty())
    else {
        return Ok(RouterCheck {
            ok: false,
            picked: Vec::new(),
            total,
            cost_usd: 0.0,
            error: Some("No typesafe.ai key is stored.".into()),
        });
    };

    let jev = Jev::new(key, surface)
        .with_model(settings.router_model.clone())
        .with_price(settings.router_price);

    /*
      A question with an obvious answer, so the result is readable.

      Editing a file and running a test should produce `edit` and
      `bash` and leave out every git tool. Anybody looking at the
      answer can tell at a glance whether the router understood the
      question or merely replied to it.
    */
    let probe = "add a timeout to the retry in the http client, then run the tests";
    match jev.check(probe).await {
        Ok(pick) => Ok(RouterCheck {
            ok: true,
            picked: pick.names,
            total,
            cost_usd: pick.cost_usd,
            error: None,
        }),
        Err(error) => Ok(RouterCheck {
            ok: false,
            picked: Vec::new(),
            total,
            cost_usd: 0.0,
            error: Some(error),
        }),
    }
}

/* ─── Where the window is going ──────────────────────────────────────────── */

/// What is in this conversation's context, and what it is made of.
///
/// Answered from the live session, so it is what the *next* request
/// will carry — not what the last one did. A conversation that has
/// just been compacted reads as small here and reads as large in the
/// ledger, and both are true.
#[tauri::command]
pub fn agent_context(
    window: Window,
    state: State<AgentState>,
    surface: Surface,
) -> Result<Option<Breakdown>, String> {
    let tools = tools::openai_tools_for(surface);
    let tool_tokens = tools::output::approx_tokens(&tools.to_string());
    Ok(state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&key(window.label(), surface))
        .map(|session| session.breakdown(tool_tokens)))
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
    let (Some(root), Some(store)) =
        (workspace.root(&key(window.label(), surface)), store(&app, &state))
    else {
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
        .root(&key(window.label(), surface))
        .ok_or_else(|| "No folder is open in FigyCode.".to_string())?;
    if root.to_string_lossy() != snapshot.root {
        return Err(format!(
            "That conversation belongs to {} — open that folder to carry it on.",
            snapshot.root
        ));
    }

    let settings = current(&app, &state)?.unwrap_or_default();
    let chosen = settings.chosen().cloned().unwrap_or_default();
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
            model: chosen.model.clone(),
            price: Price {
                input: chosen.input_price.unwrap_or(0.0),
                cached_input: chosen.cached_price.unwrap_or(0.0),
                output: chosen.output_price.unwrap_or(0.0),
            },
            // The window sends the mode with every message now, so this
            // is only what applies if nothing is ever sent.
            mode: Mode::Ask,
            context_window: chosen.context_window,
            budget_usd: settings.budget_usd,
            max_steps: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, host: &str, name: &str) -> ProviderModel {
        ProviderModel {
            id: id.into(),
            base_url: host.into(),
            model: name.into(),
            ..ProviderModel::default()
        }
    }

    #[test]
    fn the_chosen_model_is_the_one_active_points_at() {
        let settings = AgentSettings {
            models: vec![model("a", "http://one", "fast"), model("b", "http://two", "big")],
            active: Some("b".into()),
            ..AgentSettings::default()
        };
        assert_eq!(settings.chosen().unwrap().model, "big");
    }

    /// Deleting the model you were using should not break the window.
    #[test]
    fn an_active_id_that_is_gone_falls_back_rather_than_refusing() {
        let settings = AgentSettings {
            models: vec![model("a", "http://one", "fast")],
            active: Some("deleted".into()),
            ..AgentSettings::default()
        };
        assert_eq!(settings.chosen().unwrap().id, "a");
    }

    /// A half-filled row is a row somebody is still typing, not a model.
    #[test]
    fn a_model_with_no_address_or_no_name_is_not_chosen() {
        let settings = AgentSettings {
            models: vec![
                model("a", "http://one", ""),
                model("b", "", "big"),
                model("c", "http://three", "real"),
            ],
            active: Some("a".into()),
            ..AgentSettings::default()
        };
        assert_eq!(settings.chosen().unwrap().id, "c");

        let none = AgentSettings {
            models: vec![model("a", "http://one", "")],
            active: None,
            ..AgentSettings::default()
        };
        assert!(none.chosen().is_none());
    }

    #[test]
    fn a_model_is_named_by_its_label_and_falls_back_to_the_model_itself() {
        let mut one = model("a", "http://one", "glm-4.6");
        assert_eq!(one.name(), "glm-4.6");
        one.label = "GLM, self-hosted".into();
        assert_eq!(one.name(), "GLM, self-hosted");
    }

    /// The upgrade that must not lose anybody's endpoint and key.
    #[test]
    fn a_settings_file_from_before_the_list_becomes_one_model() {
        let old = r#"{
            "baseUrl": "https://example.modal.run/v1",
            "model": "glm-4.6",
            "apiKey": "sk-secret",
            "contextWindow": 200000,
            "inputPrice": 0.6,
            "budgetUsd": 5,
            "exaKey": "exa-secret"
        }"#;
        let forwarded = serde_json::from_str::<LegacySettings>(old)
            .unwrap()
            .forward()
            .expect("an endpoint is worth keeping");

        assert_eq!(forwarded.models.len(), 1);
        let one = &forwarded.models[0];
        assert_eq!(one.base_url, "https://example.modal.run/v1");
        assert_eq!(one.api_key.as_deref(), Some("sk-secret"));
        assert_eq!(one.context_window, Some(200_000));
        assert_eq!(one.input_price, Some(0.6));
        assert_eq!(forwarded.active.as_deref(), Some(one.id.as_str()));
        // The two that are not the model's keep their place.
        assert_eq!(forwarded.budget_usd, Some(5.0));
        assert_eq!(forwarded.exa_key.as_deref(), Some("exa-secret"));
    }

    #[test]
    fn an_empty_old_file_is_not_forwarded_as_a_blank_model() {
        let empty = serde_json::from_str::<LegacySettings>("{}").unwrap();
        assert!(empty.forward().is_none());
    }

    /// The new shape parses with fields the old one never had, and the
    /// old one's extra keys do not stop it.
    #[test]
    fn the_new_shape_reads_back_what_it_wrote() {
        let settings = AgentSettings {
            models: vec![ProviderModel {
                id: "m1".into(),
                label: "Fast".into(),
                base_url: "http://one".into(),
                model: "mini".into(),
                api_key: Some("sk".into()),
                temperature: Some(0.2),
                input_price: Some(0.25),
                cached_price: Some(0.03),
                output_price: Some(2.0),
                context_window: Some(128_000),
                vision: true,
            }],
            active: Some("m1".into()),
            budget_usd: Some(2.5),
            exa_key: Some("exa".into()),
            ..AgentSettings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let back: AgentSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.models[0].cached_price, Some(0.03));
        assert_eq!(back.chosen().unwrap().id, "m1");
    }

    /* ─── Closing a window ────────────────────────────────────────────── */

    #[test]
    fn a_turn_is_narrated_on_its_own_surface_and_not_the_other() {
        // One Tauri window holds both trees, so a single channel is one
        // both of them hear: the panel drawing the window's tool rows
        // and the window drawing the panel's.
        assert_ne!(agent_event(Surface::Window), agent_event(Surface::Panel));
        assert!(agent_event(Surface::Panel).ends_with("/panel"));
    }

    #[test]
    fn a_conversation_with_a_turn_in_flight_is_busy_and_the_other_surface_is_not() {
        /*
          A running turn owns its session: it is removed from the map
          for the duration, so nothing holds a lock across a
          four-minute tool call. That makes a second send on the same
          key dangerous — it would find no session, build an empty one,
          and the two would run side by side until the slower one put
          itself back over the other's whole history.

          The guard is a lookup in `running`, so what it has to get
          right is the *key*: busy on one surface must not mean busy on
          the other, or opening the editor's agent during a long window
          turn would refuse to work.
        */
        let state = AgentState::default();
        let (tx, _rx) = oneshot::channel();
        state
            .running
            .lock()
            .unwrap()
            .insert(key("main", Surface::Window), tx);

        let running = state.running.lock().unwrap();
        assert!(running.contains_key(&key("main", Surface::Window)), "the window is busy");
        assert!(
            !running.contains_key(&key("main", Surface::Panel)),
            "the panel in the same window is a different conversation"
        );
        assert!(
            !running.contains_key(&key("other", Surface::Window)),
            "another window is another conversation"
        );
    }

    #[test]
    fn closing_a_window_frees_the_person_waiting_at_every_surface_of_it() {
        /*
          The desks are keyed by window *and* surface, and the teardown
          used to `remove` by window alone — which found nothing, left
          both desks alive after their window was gone, and left
          anybody's `ask_user` waiting on a card that no longer exists
          until it timed out half an hour later.
        */
        let state = AgentState::default();
        {
            let mut desks = state.desks.lock().unwrap();
            for surface in [Surface::Window, Surface::Panel] {
                desks.insert(key("main", surface), Arc::new(Desk::new(|_| Ok(()))));
            }
            desks.insert(key("other", Surface::Window), Arc::new(Desk::new(|_| Ok(()))));
        }

        forget_window(&state, "main");

        let left: Vec<String> = state.desks.lock().unwrap().keys().cloned().collect();
        assert_eq!(left, vec![key("other", Surface::Window)]);
    }
}
