//! `bash`, `bash_output`, `bash_kill` — running things.
//!
//! The tool that makes an agent able to check its own work, and the one with
//! the largest blast radius. Three decisions shape it.
//!
//! **Output is capped from both ends.** A failing test run is forty thousand
//! lines of which the last fifty matter, and the first few hundred set the
//! scene. Keeping the head and the tail and saying how much was dropped is
//! worth more than either end alone — and it is the difference between a
//! turn that costs a few hundred tokens and one that costs twenty thousand
//! for the rest of the session.
//!
//! **Background is a first-class answer, not a workaround.** A dev server, a
//! watcher and a test runner all have to start and keep going while the
//! agent does something else. A `bash` that only returns on exit cannot
//! start any of them, and an agent that discovers this tends to discover it
//! by hanging for two minutes first.
//!
//! **The timeout is short and kills.** Two minutes, because a command that
//! needs longer is a command that should have been backgrounded.

use std::time::Duration;

use serde_json::json;

use super::output::{clip_line, truncation_note};
use super::{arg_bool, arg_str, arg_usize, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};

/// Seconds, when the caller does not say.
const DEFAULT_TIMEOUT: usize = 120;
const MAX_TIMEOUT: usize = 600;

/// Lines kept from the start of a long result, and from the end.
///
/// The tail is twice the head because the tail is where the error is. The
/// head is there because the first lines say what ran.
const HEAD: usize = 40;
const TAIL: usize = 80;

const MAX_LINE: usize = 400;

pub struct Bash;

impl Tool for Bash {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "bash",
            description: "Run a shell command in the project folder and return its output and \
                exit code. Output is trimmed to the first and last lines when it is long. \
                Use background=true for something you do not need to wait for — a dev \
                server, a watcher — and then `bash_wait` if you do need its result, or \
                `bash_output` to glance at it once.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "cmd": {
                        "type": "string",
                        "description": "The command line, run through `sh -c` (`cmd /C` on Windows)."
                    },
                    "timeout": {
                        "type": "integer",
                        "description":
                            "Seconds before it is killed. Default 120, maximum 600. If it \
                             needs longer than that, background it instead."
                    },
                    "background": {
                        "type": "boolean",
                        "description":
                            "Start it and return immediately with an id. Use for anything \
                             that does not exit on its own."
                    }
                },
                "required": ["cmd"],
                "additionalProperties": false
            }),
            class: Class::Exec,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let command = arg_str(args, "cmd", "bash")?;
        let why = arg_str(args, "why", "bash").unwrap_or_default();
        let shell = ctx.shell()?;

        if arg_bool(args, "background") {
            let id = shell
                .start(&command, ctx.root(), &ctx.surface)
                .map_err(|e| format!("bash: {e}"))?;
            return Ok(ToolOutput::text(format!(
                "Started `{command}` in the background as {id}. Poll it with \
                 bash_output(id: \"{id}\"), stop it with bash_kill."
            ))
            .with_detail(json!({
                "id": id,
                "cmd": command,
                "why": why,
                "background": true
            })));
        }

        let seconds = arg_usize(args, "timeout", DEFAULT_TIMEOUT, MAX_TIMEOUT);

        /*
          Watched rather than run.

          The only difference is that each line is handed to the
          window as it arrives. A two-minute build used to be a
          spinner and then two hundred lines at once — the output
          existed the whole time and there was no way to be given it.

          What the *model* gets is unchanged: the whole thing, once,
          trimmed, when the command exits. Streaming a build into the
          conversation would be two hundred lines in the prefix of
          every turn after it, which is the opposite of what the
          trimming below is for.
        */
        let done = shell
            .watch(
                &command,
                ctx.root(),
                Duration::from_secs(seconds as u64),
                &|line| ctx.progress(line),
            )
            .map_err(|e| format!("bash: {e}"))?;

        let total = done.output.len();
        let (kept, dropped) = head_and_tail(&done.output, HEAD, TAIL);

        /*
          The outcome first, then the command, then the output.

          It used to be the command first, which put it on the row as
          the one-line summary — beside the row's own copy of it, and
          above the body's. Three times for one `docker build`, and
          the row was taken up by a string the person had already
          read instead of by what happened to it.

          The outcome is the line worth having there: `exit 0 in 27s`
          is what you look for after waiting, and the command is a
          keystroke away under it.
        */
        let outcome = if done.timed_out {
            format!("killed after {seconds}s")
        } else if done.ms >= 1000 {
            format!("exit {} in {:.1}s", done.status, done.ms as f64 / 1000.0)
        } else {
            format!("exit {} in {}ms", done.status, done.ms)
        };
        let mut text = format!("{outcome}\n$ {command}\n");
        for line in &kept {
            text.push_str(&clip_line(line, MAX_LINE));
            text.push('\n');
        }
        if dropped > 0 {
            text.push_str(&truncation_note(
                dropped,
                "line",
                "re-run with `| grep …` or `| tail -50` for the part you want",
            ));
            text.push('\n');
        }

        Ok(ToolOutput::text(text).with_detail(json!({
            "cmd": command,
            "why": why,
            "status": done.status,
            "timedOut": done.timed_out,
            "ms": done.ms,
            "lines": total,
        })))
    }
}

/// The head and the tail of a long result, and how many went missing.
///
/// The middle is what gets dropped because the middle is the repetition:
/// nine hundred passing tests between the summary at the top and the
/// failure at the bottom.
pub fn head_and_tail(lines: &[String], head: usize, tail: usize) -> (Vec<String>, usize) {
    if lines.len() <= head + tail {
        return (lines.to_vec(), 0);
    }
    let mut kept: Vec<String> = lines[..head].to_vec();
    kept.extend_from_slice(&lines[lines.len() - tail..]);
    (kept, lines.len() - head - tail)
}

pub struct BashOutput;

impl Tool for BashOutput {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "bash_output",
            description: "Glance once at what a background command has written, and whether \
                it has finished. To wait for one to finish, use `bash_wait` — it returns \
                when the command is done. Do not call this in a loop.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The id `bash` returned when it started the command."
                    },
                    "from": {
                        "type": "integer",
                        "description":
                            "Line to read from. Pass the `total` from the last call to see \
                             only what is new. Defaults to 0."
                    }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
            // Reading a buffer this session already owns. Asking permission
            // to look at output of a command that was itself approved would
            // be a prompt about nothing.
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let id = arg_str(args, "id", "bash_output")?;
        let from = args
            .get("from")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .min(usize::MAX as u64) as usize;

        let state = ctx
            .shell()?
            .poll(&id, from)
            .map_err(|e| format!("bash_output: {e}"))?;

        let (kept, dropped) = head_and_tail(&state.lines, HEAD, TAIL);
        let status = match (state.finished, state.status) {
            (true, Some(code)) => format!("finished, exit {code}"),
            (true, None) => "finished".into(),
            (false, _) => "still running".into(),
        };

        let mut text = format!("{id} — {status}, {} lines so far\n", state.total);
        for line in &kept {
            text.push_str(&clip_line(line, MAX_LINE));
            text.push('\n');
        }
        if dropped > 0 {
            text.push_str(&truncation_note(dropped, "line", "ask again with a later `from`"));
            text.push('\n');
        }
        if kept.is_empty() {
            text.push_str("(nothing new)\n");
        }

        Ok(ToolOutput::text(text).with_detail(json!({
            "id": id,
            "total": state.total,
            "finished": state.finished,
            "status": state.status,
        })))
    }
}

/// `bash_wait(id)` — block until a background command finishes.
///
/// ## The round trip this removes
///
/// Without it a model asked to "build the image and tell me when it is
/// done" has only `bash_output`, so it calls it, reads "still running,
/// 7 lines", and calls it again. Each of those is a full round trip —
/// request, tool call, result, request — and each request re-sends the
/// whole conversation. A four-minute build came back as forty rows
/// that each said nothing and forty times the input bill, and the
/// transcript was unreadable.
///
/// Waiting belongs on this side. The backend holds the process, polls
/// its buffer every fifteen milliseconds already, and can block a
/// thread for four minutes for free. One call in, one answer out.
///
/// ## Why it still has a deadline
///
/// A command that never exits — a dev server, a watcher — would
/// otherwise hold the turn open until the person pressed Escape. The
/// deadline turns that into an answer: *not finished yet, here is what
/// it has said, decide*. Timing out is not failing, and the two get
/// different sentences.
///
/// Escape reaches this: the turn loop selects on the cancel channel
/// around every tool call, so a wait is interruptible even though the
/// child it is waiting on keeps running.
pub struct BashWait;

/// Long enough for a Docker build or a cold `cargo build`, short
/// enough that a dev server does not hold a turn open until somebody
/// notices.
const MAX_WAIT: u64 = 600;

/// What to wait when nothing was asked for. Most builds are inside it,
/// and the ones that are not say so and can be waited on again.
const DEFAULT_WAIT: u64 = 300;

impl Tool for BashWait {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "bash_wait",
            description: "Wait for a background command to finish and return its exit code \
                and output. Returns as soon as it is done — use this instead of calling \
                `bash_output` over and over, which costs a whole request each time and \
                tells the person nothing. If it is still running when the wait is up, you \
                are told so and can wait again.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The id `bash` returned when it started the command."
                    },
                    "seconds": {
                        "type": "integer",
                        "description":
                            "How long to wait before answering anyway. Defaults to 300, \
                             and 600 is the most. A build is usually worth the full wait."
                    },
                    "from": {
                        "type": "integer",
                        "description":
                            "Line to report from. Pass the `total` from an earlier call to \
                             get only what is new. Defaults to 0."
                    }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
            // Waiting on a command that was already approved. A second
            // permission card for *watching* it would be a prompt about
            // nothing.
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let id = arg_str(args, "id", "bash_wait")?;
        let from = args.get("from").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let seconds = args
            .get("seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_WAIT)
            .clamp(1, MAX_WAIT);

        /*
          Every line, as it arrives, onto the row.

          This is the half that makes a four-minute wait bearable to
          watch: one row that says what the build is doing now, rather
          than forty rows that each say "still running". The progress
          sink is the same one `bash` streams through.
        */
        let state = ctx
            .shell()?
            .wait(&id, from, Duration::from_secs(seconds), &|line| {
                ctx.progress(line);
            })
            .map_err(|e| format!("bash_wait: {e}"))?;

        let (kept, dropped) = head_and_tail(&state.lines, HEAD, TAIL);

        /*
          Three outcomes, and the model has to tell them apart: it
          worked, it failed, or it is still going. A single "done"
          would make a build that exited 1 look like a success.
        */
        let headline = match (state.finished, state.status) {
            (true, Some(0)) => format!("{id} — finished, exit 0, after {seconds}s at most"),
            (true, Some(code)) => format!("{id} — FAILED, exit {code}"),
            (true, None) => format!("{id} — finished, no exit code reported"),
            (false, _) => format!(
                "{id} — still running after {seconds}s. Wait again, or leave it and say so"
            ),
        };

        let mut text = format!("{headline}, {} lines total\n", state.total);
        for line in &kept {
            text.push_str(&clip_line(line, MAX_LINE));
            text.push('\n');
        }
        if dropped > 0 {
            text.push_str(&truncation_note(dropped, "line", "ask again with a later `from`"));
            text.push('\n');
        }
        if kept.is_empty() {
            text.push_str("(no output)\n");
        }

        Ok(ToolOutput::text(text).with_detail(json!({
            "id": id,
            "total": state.total,
            "finished": state.finished,
            "status": state.status,
            "waitedSeconds": seconds,
            "why": arg_str(args, "why", "bash_wait").unwrap_or_default(),
        })))
    }
}

pub struct BashKill;

impl Tool for BashKill {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "bash_kill",
            description: "Stop a background command started with background=true. Its \
                output so far stays readable with `bash_output`.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The id `bash` returned when it started the command."
                    }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
            class: Class::Exec,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let id = arg_str(args, "id", "bash_kill")?;
        ctx.shell()?
            .kill(&id)
            .map_err(|e| format!("bash_kill: {e}"))?;
        Ok(ToolOutput::text(format!("Stopped {id}.")).with_detail(json!({ "id": id })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::shell::{Finished, Running, Shell};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    /// A shell that answers from a script, so the tools can be tested
    /// without spawning anything.
    #[derive(Default)]
    struct FakeShell {
        finished: Mutex<Option<Finished>>,
        running: Mutex<Option<Running>>,
        killed: Mutex<Vec<String>>,
        started: Mutex<Vec<String>>,
    }

    impl Shell for FakeShell {
        fn run(&self, _cmd: &str, _cwd: &Path, _timeout: Duration) -> Result<Finished, String> {
            self.finished
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "nothing scripted".to_string())
        }
        fn start(&self, cmd: &str, _cwd: &Path, _owner: &str) -> Result<String, String> {
            self.started.lock().unwrap().push(cmd.to_string());
            Ok("bg_1".into())
        }
        fn poll(&self, _id: &str, _from: usize) -> Result<Running, String> {
            self.running
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "no background task `x`".to_string())
        }
        fn kill(&self, id: &str) -> Result<(), String> {
            self.killed.lock().unwrap().push(id.to_string());
            Ok(())
        }
        fn running(&self) -> Vec<(String, String)> {
            Vec::new()
        }
    }

    fn ctx_with(shell: Arc<FakeShell>) -> ToolContext {
        ToolContext::new(PathBuf::from(std::env::temp_dir())).with_shell(shell)
    }

    fn lines(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("line {i}")).collect()
    }

    /// A job that finishes on the nth look, writing a line each time.
    ///
    /// The point of `bash_wait` is that *it* does the looking, so a
    /// fake that was finished on the first poll would pass whatever
    /// the tool did.
    struct Eventually {
        polls: Mutex<usize>,
        finishes_on: usize,
        status: i32,
    }

    impl Shell for Eventually {
        fn run(&self, _c: &str, _w: &Path, _t: Duration) -> Result<Finished, String> {
            unreachable!("the wait never runs a command")
        }
        fn start(&self, _c: &str, _w: &Path, _owner: &str) -> Result<String, String> {
            Ok("bg_1".into())
        }
        fn poll(&self, _id: &str, from: usize) -> Result<Running, String> {
            let mut polls = self.polls.lock().unwrap();
            *polls += 1;
            let done = *polls >= self.finishes_on;
            let total = *polls;
            Ok(Running {
                id: "bg_1".into(),
                lines: (from..total).map(|i| format!("step {}", i + 1)).collect(),
                total,
                finished: done,
                status: done.then_some(self.status),
            })
        }
        fn kill(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        fn running(&self) -> Vec<(String, String)> {
            Vec::new()
        }
    }

    fn eventually(finishes_on: usize, status: i32) -> Arc<Eventually> {
        Arc::new(Eventually {
            polls: Mutex::new(0),
            finishes_on,
            status,
        })
    }

    /* ─── Waiting, rather than polling ──────────────────────────────── */

    #[test]
    fn waiting_returns_when_the_job_is_done_and_not_before() {
        /*
          The whole point. Without this the model polls `bash_output`
          in a loop — each call a full round trip that re-sends the
          conversation — and a four-minute build arrives as forty rows
          that each say "still running".
        */
        let shell = eventually(4, 0);
        let out = BashWait
            .call(
                &ToolContext::new(std::env::temp_dir()).with_shell(Arc::clone(&shell) as Arc<dyn Shell>),
                &json!({ "id": "bg_1", "seconds": 30 }),
            )
            .unwrap();

        assert!(*shell.polls.lock().unwrap() >= 4, "it returned before the job finished");
        assert!(out.text.contains("finished, exit 0"), "{}", out.text);
        let detail = out.detail.unwrap();
        assert_eq!(detail["finished"], true);
        assert_eq!(detail["status"], 0);
    }

    #[test]
    fn a_build_that_failed_is_not_reported_as_done() {
        // "finished" for a build that exited 1 is how a model tells
        // somebody their image built when it did not.
        let out = BashWait
            .call(
                &ToolContext::new(std::env::temp_dir()).with_shell(eventually(2, 1) as Arc<dyn Shell>),
                &json!({ "id": "bg_1", "seconds": 30 }),
            )
            .unwrap();
        assert!(out.text.contains("FAILED, exit 1"), "{}", out.text);
        assert_eq!(out.detail.unwrap()["status"], 1);
    }

    #[test]
    fn a_job_that_outlives_the_wait_is_not_a_failure() {
        /*
          A dev server never exits. Saying so — with what it has
          printed — is an answer; holding the turn open until somebody
          presses Escape is not. Not finished and failed are different
          sentences.
        */
        let out = BashWait
            .call(
                &ToolContext::new(std::env::temp_dir())
                    .with_shell(eventually(100_000, 0) as Arc<dyn Shell>),
                &json!({ "id": "bg_1", "seconds": 1 }),
            )
            .unwrap();
        assert!(out.text.contains("still running after 1s"), "{}", out.text);
        assert!(out.text.contains("Wait again"), "it says what to do next");
        assert_eq!(out.detail.unwrap()["finished"], false);
    }

    #[test]
    fn the_wait_is_capped_however_long_it_was_asked_for() {
        // An hour-long wait is a turn nobody can get out of except by
        // closing the window.
        let out = BashWait
            .call(
                &ToolContext::new(std::env::temp_dir())
                    .with_shell(eventually(1, 0) as Arc<dyn Shell>),
                &json!({ "id": "bg_1", "seconds": 99_999 }),
            )
            .unwrap();
        assert_eq!(out.detail.unwrap()["waitedSeconds"], MAX_WAIT);
    }

    #[test]
    fn output_arrives_on_the_row_while_the_wait_is_in_flight() {
        /*
          One row that says what the build is doing now, instead of
          forty that say nothing. Without this a four-minute wait is a
          spinner, which is the thing the polling loop was at least
          honest about.
        */
        #[derive(Default)]
        struct Seen(Mutex<Vec<String>>);
        impl crate::agent::tools::Progress for Seen {
            fn line(&self, line: &str) {
                self.0.lock().unwrap().push(line.to_string());
            }
        }

        let seen = Arc::new(Seen::default());
        let ctx = ToolContext::new(std::env::temp_dir())
            .with_shell(eventually(3, 0) as Arc<dyn Shell>)
            .with_progress(Arc::clone(&seen) as Arc<dyn crate::agent::tools::Progress>);

        BashWait.call(&ctx, &json!({ "id": "bg_1", "seconds": 30 })).unwrap();
        let lines = seen.0.lock().unwrap();
        assert!(lines.len() >= 3, "nothing reached the row: {lines:?}");
        assert_eq!(lines[0], "step 1");
    }

    #[test]
    fn an_unknown_id_says_so_rather_than_waiting_out_the_clock() {
        let shell = Arc::new(FakeShell::default());
        let error = BashWait
            .call(&ctx_with(shell), &json!({ "id": "nope", "seconds": 30 }))
            .unwrap_err();
        assert!(error.contains("no background task"), "{error}");
    }

    #[test]
    fn a_command_reports_its_exit_code_and_its_output() {
        let shell = Arc::new(FakeShell::default());
        *shell.finished.lock().unwrap() = Some(Finished {
            output: vec!["ok".into()],
            status: 0,
            timed_out: false,
            ms: 12,
        });
        let out = Bash.call(&ctx_with(shell), &json!({ "cmd": "npm test" })).unwrap();
        assert!(out.text.contains("$ npm test"));
        assert!(out.text.contains("exit 0"));
        assert!(out.text.contains("ok"));
    }

    #[test]
    fn a_failure_is_an_answer_rather_than_an_error() {
        // The model has to see the exit code and the message; a tool error
        // would hide both behind "the tool failed".
        let shell = Arc::new(FakeShell::default());
        *shell.finished.lock().unwrap() = Some(Finished {
            output: vec!["error[E0277]: mismatched types".into()],
            status: 101,
            timed_out: false,
            ms: 900,
        });
        let out = Bash.call(&ctx_with(shell), &json!({ "cmd": "cargo build" })).unwrap();
        assert!(out.text.contains("exit 101"));
        assert!(out.text.contains("E0277"));
    }

    #[test]
    fn a_long_result_keeps_both_ends_and_says_what_went() {
        let shell = Arc::new(FakeShell::default());
        *shell.finished.lock().unwrap() = Some(Finished {
            output: lines(5_000),
            status: 1,
            timed_out: false,
            ms: 4_000,
        });
        let out = Bash.call(&ctx_with(shell), &json!({ "cmd": "cargo test" })).unwrap();

        assert!(out.text.contains("line 1"), "the head is where what ran is said");
        assert!(out.text.contains("line 5000"), "the tail is where the error is");
        assert!(!out.text.contains("line 2500"));
        assert!(out.text.contains("4880 more lines"));
        assert!(out.text.contains("tail -50"));
    }

    #[test]
    fn a_timeout_says_it_was_killed_rather_than_that_it_failed() {
        let shell = Arc::new(FakeShell::default());
        *shell.finished.lock().unwrap() = Some(Finished {
            output: vec![],
            status: -1,
            timed_out: true,
            ms: 120_000,
        });
        let out = Bash
            .call(&ctx_with(shell), &json!({ "cmd": "npm run dev", "timeout": 120 }))
            .unwrap();
        assert!(out.text.contains("killed after 120s"));
    }

    #[test]
    fn background_returns_an_id_and_how_to_use_it() {
        let shell = Arc::new(FakeShell::default());
        let out = Bash
            .call(
                &ctx_with(Arc::clone(&shell)),
                &json!({ "cmd": "npm run dev", "background": true }),
            )
            .unwrap();
        assert_eq!(shell.started.lock().unwrap().len(), 1);
        assert!(out.text.contains("bg_1"));
        assert!(out.text.contains("bash_output"));
    }

    #[test]
    fn polling_says_whether_it_is_still_going() {
        let shell = Arc::new(FakeShell::default());
        *shell.running.lock().unwrap() = Some(Running {
            id: "bg_1".into(),
            lines: vec!["ready in 412 ms".into()],
            total: 12,
            finished: false,
            status: None,
        });
        let out = BashOutput
            .call(&ctx_with(shell), &json!({ "id": "bg_1" }))
            .unwrap();
        assert!(out.text.contains("still running"));
        assert!(out.text.contains("12 lines so far"));
        assert!(out.text.contains("ready in 412 ms"));
    }

    #[test]
    fn polling_a_quiet_task_says_nothing_new_rather_than_nothing() {
        let shell = Arc::new(FakeShell::default());
        *shell.running.lock().unwrap() = Some(Running {
            id: "bg_1".into(),
            lines: vec![],
            total: 12,
            finished: true,
            status: Some(0),
        });
        let out = BashOutput
            .call(&ctx_with(shell), &json!({ "id": "bg_1", "from": 12 }))
            .unwrap();
        assert!(out.text.contains("finished, exit 0"));
        assert!(out.text.contains("(nothing new)"));
    }

    #[test]
    fn killing_passes_the_id_through() {
        let shell = Arc::new(FakeShell::default());
        BashKill
            .call(&ctx_with(Arc::clone(&shell)), &json!({ "id": "bg_1" }))
            .unwrap();
        assert_eq!(shell.killed.lock().unwrap().as_slice(), ["bg_1"]);
    }

    #[test]
    fn a_context_with_no_shell_says_so_instead_of_panicking() {
        // How the editor panel gets a narrower tool set: by construction.
        let ctx = ToolContext::new(PathBuf::from("/tmp"));
        let err = Bash.call(&ctx, &json!({ "cmd": "ls" })).unwrap_err();
        assert_eq!(err, "Commands cannot be run from here.");
    }

    #[test]
    fn the_middle_is_what_gets_dropped() {
        let (kept, dropped) = head_and_tail(&lines(1000), 10, 20);
        assert_eq!(dropped, 970);
        assert_eq!(kept.len(), 30);
        assert_eq!(kept[0], "line 1");
        assert_eq!(kept[10], "line 981");
        assert_eq!(kept[29], "line 1000");
    }

    #[test]
    fn a_short_result_is_not_trimmed_at_all() {
        let (kept, dropped) = head_and_tail(&lines(5), 10, 20);
        assert_eq!(dropped, 0);
        assert_eq!(kept.len(), 5);
    }

    #[test]
    fn running_a_command_is_an_exec_and_reading_its_output_is_not() {
        // The class decides what a permission prompt says, and asking about
        // reading a buffer this session already owns would be a prompt about
        // nothing.
        assert_eq!(Bash.spec().class, Class::Exec);
        assert_eq!(BashKill.spec().class, Class::Exec);
        assert_eq!(BashOutput.spec().class, Class::Read);
    }
}
