//! The handshake, against language servers that actually exist.
//!
//! Every other test in this crate checks a piece in isolation: the framing
//! decodes what the framing encoded, `find_program` finds `sh`. None of them
//! would catch the transport being wrong end to end — a reader thread that never
//! starts, stdio that isn't piped, a server that rejects our `initialize`
//! because we sent it something malformed. This one spawns real servers, talks
//! to them, and reads what they say back.
//!
//! **Skipped when nothing is installed**, rather than failing: this has to pass
//! on a machine that has never had a language server on it, and a test that
//! fails for a missing optional tool is a test people learn to ignore. Which
//! servers were used, and which were skipped and why, is printed — a silent
//! skip is how a test like this quietly stops testing anything.
//!
//! One case is worth knowing about because it is common and looks like a bug in
//! *us*: `rust-analyzer` on `PATH` is often rustup's shim rather than the
//! program, and the shim exits immediately with "Unknown binary 'rust-analyzer'
//! in official toolchain" when the component was never installed. That is
//! reported here as a skip with the server's own words — which is the same
//! thing `lsp/server.rs` captures stderr for.

use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use my_terminal_lib::lsp::server::Server;
use my_terminal_lib::spawn;

/// Generous: a cold server has a whole toolchain to find before it answers, and
/// this runs on whatever machine happens to be building.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(45);

/// Everything from the table in `services/lsp/servers.ts` that speaks stdio
/// without a Node runtime to find first.
///
/// All of them are tried, not just the first: they disagree about the
/// interesting parts. `clangd` answers `initialize` at once and negotiates
/// UTF-16; `rust-analyzer` asks for UTF-8, which is the byte-walking path in
/// `position.ts`. A test that stopped at the first one found would silently
/// never exercise whichever came second.
const CANDIDATES: &[(&str, &[&str])] = &[
    ("clangd", &[]),
    ("rust-analyzer", &[]),
    ("gopls", &[]),
    ("typescript-language-server", &["--stdio"]),
    ("pyright-langserver", &["--stdio"]),
    // A .NET apphost: proves `DOTNET_ROOT` is derived, not just that it exists.
    ("csharp-ls", &[]),
];

enum Outcome {
    /// It answered, and the answer was well formed.
    Completed { encoding: String },
    /// It exited before answering — a broken install, not necessarily our bug.
    Died { reason: String },
    /// It answered, correlated to our id, and said no — because of the
    /// workspace rather than because of the request. See [`is_our_fault`].
    Rejected { reason: String },
    /// It neither answered nor exited inside the deadline.
    Silent,
}

/// Whether a JSON-RPC error code means *we* sent something wrong.
///
/// The distinction this test lives or dies by. A reply that came back at all —
/// framed, parseable, and carrying our id — has already proven everything this
/// test is for: the spawn, the pipes, the `Content-Length` framing, the reader
/// thread and the correlation. Whether the server then likes the *workspace* is
/// a different question, and on a bare temp directory the answer is often no:
/// `typescript-language-server` refuses one with no TypeScript installed, and
/// `gopls` has opinions about a directory with no module.
///
/// These three codes are the ones that indicate a malformed request instead,
/// and those must fail rather than being waved through — they are exactly what
/// a regression in the framing or the handshake would look like.
fn is_our_fault(code: i64) -> bool {
    matches!(
        code,
        -32700 // Parse error — the server couldn't read what we framed.
        | -32600 // Invalid Request — not a well-formed JSON-RPC message.
        | -32602 // Invalid params — our `initialize` params were wrong.
    )
}

fn initialize_message(root: &str) -> String {
    // The same shape `services/lsp/client.ts` sends, trimmed to what the
    // handshake requires. `positionEncodings` is the part worth exercising: it
    // is what makes a server answer "utf-8" rather than defaulting.
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": null,
            "clientInfo": { "name": "FigyTerm" },
            "rootUri": format!("file://{root}"),
            "capabilities": {
                "general": { "positionEncodings": ["utf-16", "utf-8"] },
                "textDocument": {
                    "synchronization": { "dynamicRegistration": false },
                    "hover": { "contentFormat": ["markdown", "plaintext"] }
                }
            }
        }
    })
    .to_string()
}

#[test]
fn every_installed_server_completes_the_handshake() {
    let installed: Vec<_> = CANDIDATES
        .iter()
        .filter(|(program, _)| spawn::find_program(program).is_some())
        .collect();

    if installed.is_empty() {
        eprintln!("skipped: no language server on PATH");
        return;
    }

    let mut completed = 0;
    for (program, args) in &installed {
        let args = args.iter().map(|arg| arg.to_string()).collect();
        match handshake(program, args) {
            Outcome::Completed { encoding } => {
                completed += 1;
                eprintln!("{program}: handshake ok, position encoding {encoding}");
            }
            Outcome::Died { reason } => {
                eprintln!("{program}: SKIPPED — exited before answering: {reason}");
            }
            Outcome::Rejected { reason } => {
                // The transport worked; the server just doesn't like a bare
                // temp directory as a workspace. Counted as a pass for what
                // this test measures, and said out loud so it isn't mistaken
                // for coverage it isn't.
                completed += 1;
                eprintln!("{program}: replied, declined this workspace — {reason}");
            }
            Outcome::Silent => {
                panic!("{program} neither answered nor exited within {HANDSHAKE_TIMEOUT:?}")
            }
        }
    }

    // A server that dies on startup is an install problem and is skipped above.
    // Every one of them dying is a different thing entirely — far more likely
    // that we are writing something no server will accept — so it is not
    // allowed to pass as a clean run.
    assert!(
        completed > 0,
        "{} server(s) were installed and none completed the handshake",
        installed.len()
    );
    eprintln!("{completed} of {} server(s) completed", installed.len());
}

/// Starts one server, completes the handshake, and shuts it down again.
fn handshake(program: &str, args: Vec<String>) -> Outcome {
    let root = std::env::temp_dir().join("figyterm-lsp-test");
    std::fs::create_dir_all(&root).expect("temp workspace");
    let root = root.to_string_lossy().into_owned();

    let (messages, inbox) = mpsc::channel::<String>();
    let (exits, exited) = mpsc::channel::<String>();

    let server = Server::start(
        "test".into(),
        "test".into(),
        program.into(),
        args,
        root.clone(),
        Arc::new(move |_, body| {
            // A send that fails means the test already finished; not a problem.
            let _ = messages.send(body);
        }),
        Arc::new(move |info| {
            // The server's own last words are the only useful thing to say
            // about a startup failure — "it exited" on its own is not a report.
            let reason = info
                .stderr
                .last()
                .cloned()
                .unwrap_or_else(|| format!("exit code {:?}", info.code));
            let _ = exits.send(reason);
        }),
    )
    .unwrap_or_else(|error| panic!("{program} should start: {error}"));

    server
        .send(&initialize_message(&root))
        .expect("initialize should be written");

    // Servers emit log notifications and progress before the reply, so the
    // answer is the first message carrying our id rather than the first message.
    // The exit channel is watched alongside, so a server that dies is noticed
    // now rather than at the deadline.
    let until = Instant::now() + HANDSHAKE_TIMEOUT;
    let mut reply = None;

    while Instant::now() < until {
        if let Ok(reason) = exited.try_recv() {
            return Outcome::Died { reason };
        }
        let Ok(body) = inbox.recv_timeout(Duration::from_millis(250)) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) else {
            panic!("{program} sent something that isn't JSON: {body}");
        };
        if parsed.get("id").and_then(|id| id.as_i64()) == Some(1) {
            reply = Some(parsed);
            break;
        }
    }

    let Some(reply) = reply else {
        // One last look: the exit may have landed between the checks above.
        if let Ok(reason) = exited.try_recv() {
            return Outcome::Died { reason };
        }
        return Outcome::Silent;
    };

    if let Some(error) = reply.get("error") {
        let code = error.get("code").and_then(|code| code.as_i64()).unwrap_or(0);
        let message = error
            .get("message")
            .and_then(|message| message.as_str())
            .unwrap_or("no message");
        assert!(
            !is_our_fault(code),
            "{program} rejected the request itself ({code}): {message}"
        );
        server.stop_blocking();
        return Outcome::Rejected {
            reason: format!("{message} (code {code})"),
        };
    }

    let capabilities = reply
        .get("result")
        .and_then(|result| result.get("capabilities"))
        .unwrap_or_else(|| panic!("{program}'s reply carried no capabilities: {reply}"));

    // Something must be announced, or we have parsed an empty object and called
    // it success.
    assert!(
        capabilities.as_object().is_some_and(|caps| !caps.is_empty()),
        "{program} announced no capabilities at all"
    );

    let encoding = capabilities
        .get("positionEncoding")
        .and_then(|value| value.as_str())
        .unwrap_or("utf-16 (unstated)")
        .to_string();

    // The polite exit, then the guarantee behind it.
    server.send(r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#).ok();
    server.send(r#"{"jsonrpc":"2.0","id":2,"method":"shutdown"}"#).ok();
    server.send(r#"{"jsonrpc":"2.0","method":"exit"}"#).ok();

    server.stop_blocking();
    assert!(!server.is_alive(), "{program} should be gone");

    Outcome::Completed { encoding }
}
