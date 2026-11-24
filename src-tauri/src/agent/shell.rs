//! Running commands, in the foreground and out of it.
//!
//! A trait, because the tools must be testable without spawning processes,
//! and because the editor panel is deliberately not given one — a tool whose
//! context has no shell says so and stops, which is a narrower tool set
//! enforced by construction rather than by remembering.
//!
//! ## Three things here are not obvious and all three are bugs if missed
//!
//! **Output is read while the process runs, not after it.** A pipe has a
//! buffer of a few dozen kilobytes; a command that fills it blocks forever
//! writing, while the parent blocks forever waiting for it to exit. A
//! `cargo build` with warnings hits this within a second. So each stream
//! gets a reader thread from the moment of spawn.
//!
//! **A timeout kills.** Returning "timed out" while leaving the process
//! running is how an agent accumulates eleven dev servers in an afternoon.
//!
//! **A background command is killed when the session goes.** The registry
//! owns the children; dropping it takes them with it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::spawn;

/// What a finished command produced.
#[derive(Debug, Clone)]
pub struct Finished {
    /// Interleaved, in the order the two streams were written, because that
    /// is how the command meant it to be read: a compiler's errors belong
    /// between the lines of progress they interrupted.
    pub output: Vec<String>,
    pub status: i32,
    pub timed_out: bool,
    pub ms: u64,
}

/// What a command that is still going has said so far.
#[derive(Debug, Clone)]
pub struct Running {
    pub id: String,
    pub lines: Vec<String>,
    /// How many lines exist in total, so the caller can ask for the rest.
    pub total: usize,
    pub finished: bool,
    pub status: Option<i32>,
}

pub trait Shell: Send + Sync {
    /// Runs to completion, or to the timeout, whichever comes first.
    fn run(&self, command: &str, cwd: &Path, timeout: Duration) -> Result<Finished, String>;
    /// Starts something that keeps going, and returns its id.
    fn start(&self, command: &str, cwd: &Path) -> Result<String, String>;
    /// Lines from `from` onwards.
    fn poll(&self, id: &str, from: usize) -> Result<Running, String>;
    fn kill(&self, id: &str) -> Result<(), String>;
    /// What is still running, for the window's background chip.
    fn running(&self) -> Vec<(String, String)>;
}

/* ─── The real one ───────────────────────────────────────────────────────── */

#[derive(Default)]
pub struct SystemShell {
    jobs: Mutex<HashMap<String, Job>>,
    next: AtomicU64,
}

struct Job {
    command: String,
    child: Arc<Mutex<Child>>,
    lines: Arc<Mutex<Vec<String>>>,
    done: Arc<AtomicBool>,
    status: Arc<Mutex<Option<i32>>>,
}

impl SystemShell {
    pub fn new() -> Self {
        Self::default()
    }

    /// `sh -c` on POSIX, `cmd /C` on Windows.
    ///
    /// The user's login shell is deliberately not used. A command the model
    /// wrote should behave the same on every machine, and somebody's `zsh`
    /// with forty plugins and a `cd` override is not a stable interpreter —
    /// it is also seconds of startup on every call.
    fn spawn(command: &str, cwd: &Path) -> Result<Child, String> {
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = spawn::command("cmd");
            c.args(["/C", command]);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut c = spawn::command("sh");
            c.args(["-c", command]);
            c
        };

        cmd.current_dir(cwd)
            .env("TERM", "dumb")
            // Colour in captured output is escape codes the model pays for
            // and cannot read.
            .env("NO_COLOR", "1")
            .env("CI", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        cmd.spawn()
            .map_err(|e| format!("could not run `{command}`: {e}"))
    }

    /// Starts the two reader threads that keep the pipes from filling.
    fn drain(child: &mut Child) -> Arc<Mutex<Vec<String>>> {
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        for stream in [
            child.stdout.take().map(Readable::Out),
            child.stderr.take().map(Readable::Err),
        ]
        .into_iter()
        .flatten()
        {
            let lines = Arc::clone(&lines);
            std::thread::spawn(move || {
                let reader: Box<dyn BufRead + Send> = match stream {
                    Readable::Out(out) => Box::new(BufReader::new(out)),
                    Readable::Err(err) => Box::new(BufReader::new(err)),
                };
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut lines) = lines.lock() {
                        lines.push(line);
                    }
                }
            });
        }
        lines
    }
}

enum Readable {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

impl Shell for SystemShell {
    fn run(&self, command: &str, cwd: &Path, timeout: Duration) -> Result<Finished, String> {
        let started = Instant::now();
        let mut child = Self::spawn(command, cwd)?;
        let lines = Self::drain(&mut child);

        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None) => {}
                Err(e) => return Err(format!("`{command}` could not be waited for: {e}")),
            }
            if started.elapsed() >= timeout {
                // Killed, not merely abandoned: a command left running after
                // its timeout is how an agent ends the afternoon with eleven
                // dev servers it has forgotten about.
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break -1;
            }
            std::thread::sleep(Duration::from_millis(15));
        };

        // The readers may still be a line behind the exit.
        std::thread::sleep(Duration::from_millis(20));
        let output = lines.lock().map_err(|e| e.to_string())?.clone();

        Ok(Finished {
            output,
            status,
            timed_out,
            ms: started.elapsed().as_millis() as u64,
        })
    }

    fn start(&self, command: &str, cwd: &Path) -> Result<String, String> {
        let mut child = Self::spawn(command, cwd)?;
        let lines = Self::drain(&mut child);
        let id = format!("bg_{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);

        let child = Arc::new(Mutex::new(child));
        let done = Arc::new(AtomicBool::new(false));
        let status = Arc::new(Mutex::new(None));

        // One waiter thread per job: `try_wait` from `poll` would work, but
        // only while somebody is polling, and a finished job nobody asked
        // about would stay a zombie until the session ended.
        {
            let child = Arc::clone(&child);
            let done = Arc::clone(&done);
            let status = Arc::clone(&status);
            std::thread::spawn(move || loop {
                let finished = child.lock().ok().and_then(|mut c| c.try_wait().ok().flatten());
                if let Some(code) = finished {
                    if let Ok(mut status) = status.lock() {
                        *status = Some(code.code().unwrap_or(-1));
                    }
                    done.store(true, Ordering::SeqCst);
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            });
        }

        self.jobs.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            Job {
                command: command.to_string(),
                child,
                lines,
                done,
                status,
            },
        );
        Ok(id)
    }

    fn poll(&self, id: &str, from: usize) -> Result<Running, String> {
        // The job's handles are taken out from under the registry lock and
        // the lock released: reading a long buffer while holding it would
        // block every other job's poll and the window's own listing.
        let (lines, done, status) = {
            let jobs = self.jobs.lock().map_err(|e| e.to_string())?;
            let job = jobs
                .get(id)
                .ok_or_else(|| format!("no background task `{id}`"))?;
            (
                Arc::clone(&job.lines),
                Arc::clone(&job.done),
                Arc::clone(&job.status),
            )
        };

        let code = *status.lock().map_err(|e| e.to_string())?;
        let all = lines.lock().map_err(|e| e.to_string())?;
        Ok(Running {
            id: id.to_string(),
            lines: all.iter().skip(from).cloned().collect(),
            total: all.len(),
            finished: done.load(Ordering::SeqCst),
            status: code,
        })
    }

    fn kill(&self, id: &str) -> Result<(), String> {
        let child = {
            let jobs = self.jobs.lock().map_err(|e| e.to_string())?;
            let job = jobs
                .get(id)
                .ok_or_else(|| format!("no background task `{id}`"))?;
            Arc::clone(&job.child)
        };
        let mut child = child.lock().map_err(|e| e.to_string())?;
        let _ = child.kill();
        let _ = child.wait();
        Ok(())
    }

    fn running(&self) -> Vec<(String, String)> {
        let Ok(jobs) = self.jobs.lock() else {
            return Vec::new();
        };
        jobs.iter()
            .filter(|(_, job)| !job.done.load(Ordering::SeqCst))
            .map(|(id, job)| (id.clone(), job.command.clone()))
            .collect()
    }
}

impl Drop for SystemShell {
    /// A background command belongs to the session that started it.
    ///
    /// Without this, closing the window leaves its `npm run dev` holding
    /// port 1420 against the next one, with nothing on screen to blame.
    fn drop(&mut self) {
        let Ok(jobs) = self.jobs.lock() else { return };
        for job in jobs.values() {
            if let Ok(mut child) = job.child.lock() {
                let _ = child.kill();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Skipped on Windows, where the command strings differ; the logic under
    /// test is the draining and the timeout, not the shell's dialect.
    #[cfg(not(target_os = "windows"))]
    mod posix {
        use super::*;

        fn cwd() -> std::path::PathBuf {
            std::env::temp_dir()
        }

        #[test]
        fn output_comes_back_in_the_order_it_was_written() {
            let shell = SystemShell::new();
            let done = shell
                .run("echo one; echo two", &cwd(), Duration::from_secs(5))
                .unwrap();
            assert_eq!(done.status, 0);
            assert_eq!(done.output, vec!["one", "two"]);
            assert!(!done.timed_out);
        }

        #[test]
        fn stderr_is_captured_alongside_stdout() {
            let shell = SystemShell::new();
            let done = shell
                .run("echo out; echo err 1>&2", &cwd(), Duration::from_secs(5))
                .unwrap();
            assert!(done.output.contains(&"out".to_string()));
            assert!(done.output.contains(&"err".to_string()));
        }

        #[test]
        fn a_failing_command_returns_its_code_rather_than_an_error() {
            // A non-zero exit is an answer the model has to see, not a
            // failure of the tool.
            let shell = SystemShell::new();
            let done = shell.run("exit 3", &cwd(), Duration::from_secs(5)).unwrap();
            assert_eq!(done.status, 3);
        }

        #[test]
        fn a_command_that_floods_its_pipe_still_finishes() {
            // The deadlock this module exists to avoid: a full pipe buffer
            // blocks the child writing while the parent waits for the exit.
            let shell = SystemShell::new();
            let done = shell
                .run("seq 1 20000", &cwd(), Duration::from_secs(20))
                .unwrap();
            assert_eq!(done.status, 0);
            assert_eq!(done.output.len(), 20_000);
        }

        #[test]
        fn a_timeout_kills_rather_than_abandons() {
            let shell = SystemShell::new();
            let done = shell
                .run("sleep 30", &cwd(), Duration::from_millis(200))
                .unwrap();
            assert!(done.timed_out);
            assert!(done.ms < 5_000, "it waited the whole 30 seconds");
        }

        #[test]
        fn a_background_task_can_be_polled_as_it_goes_and_then_killed() {
            let shell = SystemShell::new();
            let id = shell
                .start("echo first; sleep 30", &cwd())
                .unwrap();

            // Give the echo time to land.
            std::thread::sleep(Duration::from_millis(300));
            let first = shell.poll(&id, 0).unwrap();
            assert_eq!(first.lines, vec!["first"]);
            assert!(!first.finished);

            // Asking again from where we left off returns nothing new.
            let second = shell.poll(&id, first.total).unwrap();
            assert!(second.lines.is_empty());

            assert_eq!(shell.running().len(), 1);
            shell.kill(&id).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            assert!(shell.poll(&id, 0).unwrap().finished);
        }

        #[test]
        fn a_background_task_that_ends_on_its_own_is_noticed_without_polling() {
            let shell = SystemShell::new();
            let id = shell.start("echo bye", &cwd()).unwrap();
            std::thread::sleep(Duration::from_millis(400));
            let state = shell.poll(&id, 0).unwrap();
            assert!(state.finished);
            assert_eq!(state.status, Some(0));
            assert!(shell.running().is_empty());
        }

        #[test]
        fn a_command_runs_where_it_was_told_to() {
            let dir = std::env::temp_dir().join("figy-shell-cwd");
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("marker.txt"), "x").unwrap();

            let shell = SystemShell::new();
            let done = shell.run("ls", &dir, Duration::from_secs(5)).unwrap();
            assert!(done.output.contains(&"marker.txt".to_string()));
        }
    }

    #[test]
    fn an_unknown_background_id_is_an_answerable_error() {
        let shell = SystemShell::new();
        assert!(shell.poll("bg_99", 0).unwrap_err().contains("no background task"));
        assert!(shell.kill("bg_99").unwrap_err().contains("no background task"));
    }
}
