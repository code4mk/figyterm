//! Sending an API request, and the types the webview sees.
//!
//! **Why this is in Rust at all.** A request typed into an API client is not a
//! browser request. It needs to set `Host`, `Origin`, `Referer`, `Connection`
//! and `Content-Length` — all of which the fetch specification exists to stop a
//! page from touching. It needs to reach a server that has never heard of CORS.
//! It needs the redirect chain hop by hop, the option not to follow it at all,
//! a self-signed certificate accepted on purpose, and timings that `fetch` does
//! not report. None of that is reachable from the webview; all of it is three
//! lines of `reqwest`. The argument in full is in `docs/API-CLIENT.md`.
//!
//! The webview still renders: pretty-printing, highlighting and previewing are
//! its job. This module's job ends at bytes and numbers.
//!
//! Two things here are deliberately *not* what the plan said:
//!
//! - **Timing is three numbers, not six.** `reqwest` gives no hook into DNS,
//!   TCP connect or the TLS handshake; getting those means a custom connector
//!   and a custom resolver, which is a project of its own. What can be measured
//!   honestly is measured: time to the response head, time spent downloading,
//!   and the total. A fake breakdown would be worse than none.
//! - **Redirects are followed by hand** (`Policy::none` and a loop) rather than
//!   by the client. That is the only way to report each hop's status and
//!   `Location`, and the only way for "don't follow" to mean it.

pub mod send;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// What the server is told we are. Deliberately honest — an API client that
/// lies about its identity makes server logs useless to the person reading
/// them, who is usually the same person who sent the request.
const USER_AGENT: &str = concat!("FigyMan/", env!("CARGO_PKG_VERSION"));

/// How long to wait for a connection, regardless of the request's own timeout.
/// A host that is not listening should say so in seconds, not sit there for the
/// whole of a generous body timeout.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// The options that cannot be varied per request because they are baked into
/// the connection pool. Everything else — timeout, redirects, headers — is set
/// on the request and shares one client.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClientKey {
    pub verify_tls: bool,
}

/// One HTTP request the webview asked for.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendInput {
    /// The webview's id for this send, and the handle `api_cancel` takes.
    pub id: String,
    pub method: String,
    /// Already normalised and template-free: the webview owns the URL bar, and
    /// deciding what `localhost:3000` means is a pure function that belongs
    /// next to its tests, not here.
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderInput>,
    #[serde(default)]
    pub body: Option<BodyInput>,
    #[serde(default)]
    pub options: Options,
}

#[derive(Deserialize)]
pub struct HeaderInput {
    pub name: String,
    pub value: String,
}

/// Every shape a body can take.
///
/// The three that are not just bytes are here for one reason each: a form is
/// what an HTML page would send, a multipart upload needs a boundary nobody
/// should hand-roll, and a file body is larger than the webview should ever
/// hold. All three are built in Rust, at send time, for each hop of a redirect.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum BodyInput {
    None,
    Raw {
        text: String,
    },
    /// `a=1&b=2`, percent-encoded here rather than in the editor.
    Urlencoded {
        fields: Vec<BodyField>,
    },
    /// A multipart upload. Text parts and file parts, in the order given.
    FormData {
        fields: Vec<BodyField>,
    },
    /// The whole of one file as the body.
    File {
        path: String,
    },
    /// The query and its variables, sent as the JSON the wire expects.
    Graphql {
        query: String,
        #[serde(default)]
        variables: String,
    },
}

/// One field of a form or multipart body.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BodyField {
    pub key: String,
    #[serde(default)]
    pub value: String,
    /// Set for a file part; `value` is then ignored.
    #[serde(default)]
    pub file_path: Option<String>,
    /// The type sent for this part, when it should not be guessed.
    #[serde(default)]
    pub content_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// Whole-request budget in milliseconds; 0 means no limit.
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    pub max_redirects: u32,
    pub verify_tls: bool,
    /// Above this, the body is truncated and flagged rather than held whole.
    /// Streaming a large response to disk is a later phase; being killed by the
    /// allocator is not an acceptable stand-in for it.
    pub max_body_bytes: u64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            timeout_ms: 30_000,
            follow_redirects: true,
            max_redirects: 10,
            verify_tls: true,
            max_body_bytes: 32 * 1024 * 1024,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyOut {
    /// Set when the bytes are valid UTF-8, which is almost always.
    pub text: Option<String>,
    /// Set otherwise, so an image or a protobuf still reaches the webview
    /// intact rather than as replacement characters.
    pub base64: Option<String>,
    pub bytes: u64,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    /// From the first byte written to the last byte read.
    pub total_ms: u64,
    /// Until the response head arrived — the number people mean by "how slow is
    /// this endpoint", since it excludes the size of the answer.
    pub wait_ms: u64,
    pub download_ms: u64,
}

/// One hop of a redirect chain, whether or not it was followed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub status: u16,
    pub from: String,
    pub to: String,
    pub elapsed_ms: u64,
}

/// The request as it actually went out, which is the tab people live in when
/// something is wrong. These are the headers the client assembled, not the ones
/// the editor holds: `Content-Length`, `User-Agent` and anything a redirect
/// dropped are all visible here and only here.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderPair>,
    pub body_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutput {
    pub id: String,
    pub status: u16,
    pub status_text: String,
    pub http_version: String,
    pub headers: Vec<HeaderPair>,
    pub body: BodyOut,
    pub timing: Timing,
    /// Where the response actually came from, after redirects.
    pub final_url: String,
    pub remote_address: Option<String>,
    pub redirects: Vec<Hop>,
    pub sent: SentRequest,
}

/// Why a send did not produce a response.
///
/// Classified rather than stringified, because the UI says different things for
/// each: a timeout offers a longer one, a certificate failure offers to stop
/// verifying, and a cancellation says nothing at all.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    /// The request could not be built — a bad method, URL, or header.
    InvalidRequest,
    Connect,
    Tls,
    Timeout,
    TooManyRedirects,
    Cancelled,
    /// The connection was made and then failed while reading.
    Body,
    Other,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendError {
    pub kind: ErrorKind,
    pub message: String,
}

impl SendError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidRequest, message)
    }
}

/// Progress while a body is downloading. `total` is absent when the server sent
/// no `Content-Length`, which is common enough that the UI must not depend on
/// it — it shows bytes received and no bar.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub received: u64,
    pub total: Option<u64>,
}

/// Clients, keyed by the options that force a distinct pool, and the sends
/// currently in flight.
#[derive(Default)]
pub struct ApiState {
    clients: Mutex<HashMap<ClientKey, Client>>,
    /// Dropping the sender is what cancels: the receiver in `send::execute`
    /// resolves either way, so `api_cancel` only has to take the entry out.
    inflight: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl ApiState {
    /// The client for these options, built once and then reused so connections
    /// are kept alive between sends.
    pub fn client(&self, key: ClientKey) -> Result<Client, SendError> {
        let mut clients = self
            .clients
            .lock()
            .map_err(|e| SendError::new(ErrorKind::Other, e.to_string()))?;

        if let Some(client) = clients.get(&key) {
            return Ok(client.clone());
        }

        let mut builder = Client::builder()
            // Followed by hand in `send::execute`; see the module docs.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT);

        if !key.verify_tls {
            builder = builder.danger_accept_invalid_certs(true);
        }

        let client = builder
            .build()
            .map_err(|e| SendError::new(ErrorKind::Other, e.to_string()))?;
        clients.insert(key, client.clone());
        Ok(client)
    }

    /// Registers a send so it can be cancelled, returning the receiver the
    /// send loop watches.
    pub fn register(&self, id: &str) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut inflight) = self.inflight.lock() {
            // An id already in flight is replaced, which cancels the old one.
            // That is the right behaviour for a Send button pressed twice.
            inflight.insert(id.to_string(), tx);
        }
        rx
    }

    /// Takes the entry out, whether the send finished or is being cancelled.
    pub fn finish(&self, id: &str) -> bool {
        match self.inflight.lock() {
            Ok(mut inflight) => inflight.remove(id).is_some(),
            Err(_) => false,
        }
    }
}
