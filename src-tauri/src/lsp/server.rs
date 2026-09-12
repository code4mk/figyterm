//! One language server: its process, its pipes, and its death.
//!
//! Nothing here knows what LSP *is*. It starts a program, frames bytes on and
//! off its stdio, and hands each complete message to a callback as an opaque
//! string. That line is deliberate — adding a new request type is a TypeScript
//! change, and this file keeps one job it can be tested on.
//!
//! The lifetime follows `terminal/pty.rs`, for the same reasons: a reader thread
//! owns the pipe, the child is reaped without blocking whoever asked for it, and
//! a process that will not die is killed rather than left for nobody to find.

use std::collections::VecDeque;
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::framing::{encode, Decoder};
use crate::spawn;

/// How much of a server's stderr is kept.
///
/// A server that dies almost always explains why on stderr, and that explanation
/// is the only useful thing to show the user — "rust-analyzer exited" on its own
/// is not a bug report. The tail is bounded because servers also log freely
/// while perfectly healthy.
const STDERR_LINES: usize = 40;

/// A single stderr line longer than this is truncated. Some servers log an
/// entire JSON blob per line when a flag is set.
const STDERR_LINE_BYTES: usize = 2_000;

/// How long a polite shutdown gets before the process is killed.
///
/// The client sends `shutdown` and `exit` before asking for this, so by the time
/// we are here the server has already been told twice. `git_network` in
/// `git/operations.rs` has the same shape and the lesson is the same one: a
/// child that will not die must not become a process nobody can see.
const EXIT_DEADLINE: Duration = Duration::from_millis(1_500);

/// How often the reaper looks while waiting out that deadline. Short enough that
/// the usual case — a server that exits at once — is not made to feel slow.
const REAP_INTERVAL: Duration = Duration::from_millis(20);

/// What the UI is told about a running server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub id: String,
    pub language: String,
    pub program: String,
    /// The resolved path, which is what the user needs to see when the wrong
    /// one is on `PATH`.
    pub resolved: Option<String>,
    pub root: String,
    pub pid: Option<u32>,
    /// Epoch millis, for "how long has this been indexing".
    pub started_at: u64,
    pub alive: bool,
    /// The tail of stderr, newest last.
    pub stderr: Vec<String>,
}

/// What a server's death is reported as.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub id: String,
    /// `None` when the process was signalled rather than exiting on its own.
    pub code: Option<i32>,
    /// Whether we asked for this. An unexpected exit is what triggers a restart.
    pub expected: bool,
    pub stderr: Vec<String>,
}

/// Called once per complete message, from the reader thread.
pub type MessageHandler = Arc<dyn Fn(&str, String) + Send + Sync>;

/// Called exactly once, when the server's stdout closes.
pub type ExitHandler = Arc<dyn Fn(ExitInfo) + Send + Sync>;

pub struct Server {
    id: String,
    language: String,
    program: String,
    resolved: Option<String>,
    root: String,
    pid: Option<u32>,
    started_at: u64,
    /// Taken and dropped by [`Server::stop`]: closing stdin is what most servers
    /// treat as "we are done", and it is what unblocks their read loop.
    stdin: Mutex<Option<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    /// Set before a deliberate stop, so the reader thread can tell an exit we
    /// asked for from one we need to report.
    stopping: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    stderr: Arc<Mutex<VecDeque<String>>>,
}

impl Server {
    /// Starts `program`, wires up its pipes, and returns once it is running.
    ///
    /// `on_message` is called from the reader thread, once per complete message.
    /// `on_exit` is called exactly once, when the server's stdout closes.
    pub fn start(
        id: String,
        language: String,
        program: String,
        args: Vec<String>,
        root: String,
        on_message: MessageHandler,
        on_exit: ExitHandler,
    ) -> Result<Self, String> {
        let resolved = spawn::find_program(&program);
        if resolved.is_none() {
            // Said plainly here rather than left to `spawn` to fail with an OS
            // error, because "not installed" is a first-class state the settings
            // panel renders differently from "crashed".
            return Err(format!("{program} is not on your PATH"));
        }

        let mut command = spawn::command(&program);
        command
            .args(&args)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|e| format!("could not start {program}: {e}"))?;

        let pid = Some(child.id());
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("{program} has no stdout"))?;
        let stderr = child.stderr.take();

        let stopping = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_LINES)));
        let child = Arc::new(Mutex::new(child));

        // stderr on its own thread, never merged into stdout. Merging them is
        // how a log line ends up being parsed as a `Content-Length` header.
        if let Some(stderr) = stderr {
            let tail = tail.clone();
            let label = id.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                // Bytes rather than lines: a server is free to emit invalid
                // UTF-8, and `BufRead::lines` gives up on the whole stream when
                // it does.
                for line in split_lines(reader) {
                    let line = truncate(line, STDERR_LINE_BYTES);
                    log::warn!("lsp[{label}]: {line}");
                    if let Ok(mut tail) = tail.lock() {
                        if tail.len() == STDERR_LINES {
                            tail.pop_front();
                        }
                        tail.push_back(line);
                    }
                }
            });
        }

        {
            let id = id.clone();
            let stopping = stopping.clone();
            let exited = exited.clone();
            let tail = tail.clone();
            let child = child.clone();

            thread::spawn(move || {
                let mut decoder = Decoder::new();
                let mut reader = BufReader::new(stdout);
                let mut buffer = [0u8; 16 * 1024];

                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            decoder.feed(&buffer[..read]);
                            loop {
                                match decoder.next_message() {
                                    Ok(Some(message)) => on_message(&id, message),
                                    Ok(None) => break,
                                    Err(error) => {
                                        // Every byte after a desync is garbage,
                                        // so the only honest thing left is to
                                        // stop and let the client restart.
                                        log::error!("lsp[{id}]: {error}");
                                        if let Ok(mut tail) = tail.lock() {
                                            tail.push_back(format!("protocol error: {error}"));
                                        }
                                        return finish(
                                            &id, &child, &stopping, &exited, &tail, &on_exit,
                                        );
                                    }
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }

                finish(&id, &child, &stopping, &exited, &tail, &on_exit);
            });
        }

        Ok(Self {
            id,
            language,
            program,
            resolved: resolved.map(|path| path.to_string_lossy().into_owned()),
            root,
            pid,
            started_at: now_millis(),
            stdin: Mutex::new(stdin),
            child,
            stopping,
            exited,
            stderr: tail,
        })
    }

    /// Frames one message and writes it to the server's stdin.
    pub fn send(&self, message: &str) -> Result<(), String> {
        if self.exited.load(Ordering::SeqCst) {
            return Err(format!("{} has exited", self.program));
        }
        let mut guard = self.stdin.lock().map_err(|e| e.to_string())?;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| format!("{} is shutting down", self.program))?;
        stdin
            .write_all(&encode(message))
            .map_err(|e| format!("could not write to {}: {e}", self.program))?;
        stdin
            .flush()
            .map_err(|e| format!("could not flush {}: {e}", self.program))
    }

    /// Closes stdin, waits out [`EXIT_DEADLINE`], then kills.
    ///
    /// The `shutdown` request and `exit` notification are the client's job and
    /// have already been sent by the time this runs — this is the part that
    /// makes "it should exit" not load-bearing.
    ///
    /// Returns without blocking the caller for the deadline: the wait happens on
    /// its own thread, because `stop` is reached from a Tauri command and from
    /// application teardown, and neither should stall on somebody's slow server.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);

        // Dropping the writer closes the pipe, which is what a well-behaved
        // server reads as end-of-input.
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }

        let child = self.child.clone();
        thread::spawn(move || {
            if reap(&child, EXIT_DEADLINE).is_none() {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                }
            }
        });
    }

    /// Blocks until the child is gone, killing it if it outstays the deadline.
    ///
    /// Only for application teardown, where the alternative is an orphan: the
    /// process is about to exit and there is nobody left to reap on a thread.
    pub fn stop_blocking(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        if reap(&self.child, EXIT_DEADLINE).is_none() {
            if let Ok(mut child) = self.child.lock() {
                let _ = child.kill();
                // Reaped so the child doesn't linger as a zombie for the moment
                // the process has left.
                let _ = child.wait();
            }
        }
    }

    pub fn info(&self) -> ServerInfo {
        ServerInfo {
            id: self.id.clone(),
            language: self.language.clone(),
            program: self.program.clone(),
            resolved: self.resolved.clone(),
            root: self.root.clone(),
            pid: self.pid,
            started_at: self.started_at,
            alive: !self.exited.load(Ordering::SeqCst),
            stderr: self
                .stderr
                .lock()
                .map(|tail| tail.iter().cloned().collect())
                .unwrap_or_default(),
        }
    }

    pub fn is_alive(&self) -> bool {
        !self.exited.load(Ordering::SeqCst)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        // A server dropped without `stop` — the registry evicting one, say —
        // must still not leave a process behind.
        if self.is_alive() {
            self.stop();
        }
    }
}

/// Marks the server dead and reports it, exactly once.
fn finish(
    id: &str,
    child: &Arc<Mutex<Child>>,
    stopping: &Arc<AtomicBool>,
    exited: &Arc<AtomicBool>,
    stderr: &Arc<Mutex<VecDeque<String>>>,
    on_exit: &ExitHandler,
) {
    // `swap` rather than `store`: the reader thread and a decode error can both
    // arrive here, and the exit must be reported once.
    if exited.swap(true, Ordering::SeqCst) {
        return;
    }

    // stdout has closed, so the process is exiting if it hasn't already; a short
    // wait turns "gone" into an actual status code most of the time.
    let code = reap(child, Duration::from_millis(500)).and_then(|status| status.code());

    on_exit(ExitInfo {
        id: id.to_string(),
        code,
        expected: stopping.load(Ordering::SeqCst),
        stderr: stderr
            .lock()
            .map(|tail| tail.iter().cloned().collect())
            .unwrap_or_default(),
    });
}

/// Waits for the child, up to `deadline`, without holding the lock while it
/// sleeps — so a concurrent `kill` is never blocked out by the waiter.
fn reap(child: &Mutex<Child>, deadline: Duration) -> Option<std::process::ExitStatus> {
    let until = Instant::now() + deadline;
    loop {
        match child.lock() {
            Ok(mut child) => match child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => {}
                Err(_) => return None,
            },
            Err(_) => return None,
        }
        if Instant::now() >= until {
            return None;
        }
        thread::sleep(REAP_INTERVAL);
    }
}

/// Splits a byte stream on newlines, tolerating invalid UTF-8 and CRLF.
///
/// `BufRead::lines` would be the obvious thing and is the wrong one: it yields
/// `Err` on a single invalid byte and callers typically stop there, losing the
/// rest of a server's diagnostics because one log line had a stray byte in it.
fn split_lines(mut reader: impl Read) -> impl Iterator<Item = String> {
    let mut pending: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut done = false;

    std::iter::from_fn(move || {
        loop {
            if let Some(index) = pending.iter().position(|&byte| byte == b'\n') {
                let mut line: Vec<u8> = pending.drain(..=index).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Some(String::from_utf8_lossy(&line).into_owned());
            }
            if done {
                if pending.is_empty() {
                    return None;
                }
                let line = String::from_utf8_lossy(&pending).into_owned();
                pending.clear();
                return Some(line);
            }
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => done = true,
                Ok(read) => pending.extend_from_slice(&buffer[..read]),
            }
        }
    })
}

/// Cuts a string to `limit` bytes without splitting a character in half.
fn truncate(mut text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push('…');
    text
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_on_both_endings() {
        let found: Vec<String> = split_lines(&b"one\ntwo\r\nthree"[..]).collect();
        assert_eq!(found, vec!["one", "two", "three"]);
    }

    /// One bad byte costs one character, not the rest of the stream.
    #[test]
    fn survives_invalid_utf8() {
        let found: Vec<String> = split_lines(&b"ok\n\xff\nafter"[..]).collect();
        assert_eq!(found.len(), 3);
        assert_eq!(found[0], "ok");
        assert_eq!(found[2], "after");
    }

    #[test]
    fn truncates_on_a_character_boundary() {
        // Four bytes, one character: cutting at 2 must not split it.
        let cut = truncate("👋".repeat(4), 6);
        assert!(cut.ends_with('…'));
        assert_eq!(cut.chars().filter(|&c| c == '👋').count(), 1);
    }

    #[test]
    fn leaves_short_strings_alone() {
        assert_eq!(truncate("short".to_string(), 100), "short");
    }

    #[test]
    fn a_missing_program_is_named_as_such() {
        let started = Server::start(
            "test".into(),
            "nothing".into(),
            "figyterm-definitely-not-installed".into(),
            vec![],
            ".".into(),
            Arc::new(|_, _| {}),
            Arc::new(|_| {}),
        );
        // Matched rather than `expect_err`, which would need `Server: Debug` —
        // and a `Debug` on a struct holding a live child process is a trap.
        match started {
            Ok(_) => panic!("a server that isn't installed must not start"),
            Err(error) => assert!(error.contains("not on your PATH"), "{error}"),
        }
    }
}
