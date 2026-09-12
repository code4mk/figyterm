use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{BufReader, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use super::session::{PtyCommand, SessionStatus, TerminalSession};
use crate::spawn;

/// Arguments that make the shell re-read the user's profile, so a new tab
/// behaves like a freshly opened terminal.
///
/// Windows has no equivalent: PowerShell loads its profile unconditionally and
/// `cmd.exe -l` means nothing, so passing `-l` there would just be an unknown
/// argument to the one program that has to start for anything to work.
#[cfg(not(target_os = "windows"))]
const LOGIN_ARGS: &[&str] = &["-l"];

#[cfg(target_os = "windows")]
const LOGIN_ARGS: &[&str] = &[];

/// Variables inherited verbatim by the login shell when they are set.
///
/// The POSIX spawn clears the environment on purpose, to match how Terminal.app
/// starts a shell. On macOS nothing is lost — the window server and launchd are
/// reachable without any of this. On Linux these variables *are* the session:
/// clear them and the shell can no longer find the display, the session bus or
/// the user runtime dir, so `xdg-open`, GUI editors, clipboard tools,
/// `notify-send` and `systemctl --user` all fail inside FigyTerm while working
/// in every other terminal.
#[cfg(target_os = "linux")]
const SESSION_PASSTHROUGH: &[&str] = &[
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_SESSION_CLASS",
    "XDG_CURRENT_DESKTOP",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "DBUS_SESSION_BUS_ADDRESS",
];

#[cfg(all(not(target_os = "linux"), not(target_os = "windows")))]
const SESSION_PASSTHROUGH: &[&str] = &[];

/// Builds the child shell's environment.
///
/// Two implementations rather than one threaded with `#[cfg]`s, because the two
/// models are opposites: POSIX starts from nothing and adds back what a shell
/// needs, while Windows must start from the inherited environment and keep
/// nearly all of it.
#[cfg(not(target_os = "windows"))]
fn configure_environment(cmd: &mut CommandBuilder, shell: &str) {
    // Start with a clean environment like Terminal.app does.
    // Only pass essential vars — the login shell will source user config.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
    let lang = std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string());

    cmd.env_clear();
    cmd.env("HOME", &home);
    cmd.env("USER", &user);
    cmd.env("SHELL", shell);
    cmd.env("PATH", build_path(&home));
    cmd.env("LANG", &lang);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Figyterm");
    cmd.env("LOGNAME", &user);
    cmd.env(
        "TMPDIR",
        std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string()),
    );
    // Suppress the '%' mark zsh shows when previous output lacks trailing newline
    cmd.env("PROMPT_EOL_MARK", "");

    for key in SESSION_PASSTHROUGH {
        if let Ok(value) = std::env::var(key) {
            cmd.env(key, value);
        }
    }

    // Ask bash to state its working directory outright, rather than leaving
    // the UI to scrape it back out of the prompt.
    //
    // bash imports PROMPT_COMMAND from the environment and runs it before
    // each prompt, which is how VTE's own shell integration does this. It's
    // bash-only on purpose: zsh has no PROMPT_COMMAND (it needs a `precmd`
    // defined in shell code, which would mean writing to the user's config),
    // and macOS's default zsh prompt scrapes cleanly already. Ubuntu's bash
    // is where scraping actually fell over — its default PS1 sets a window
    // title *and* colours the prompt.
    //
    // A user whose own config sets PROMPT_COMMAND replaces this; the UI's
    // prompt-scraping fallback still covers that case.
    if shell.rsplit('/').next() == Some("bash") {
        cmd.env(
            "PROMPT_COMMAND",
            r#"printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-}" "$PWD""#,
        );
    }
}

#[cfg(target_os = "windows")]
fn configure_environment(cmd: &mut CommandBuilder, _shell: &str) {
    // Deliberately no `env_clear()`. A Windows process started without
    // SYSTEMROOT/windir frequently fails outright, and PATHEXT, COMSPEC,
    // USERPROFILE, APPDATA, LOCALAPPDATA and TEMP are all load-bearing for
    // ordinary commands. There is also no "the login shell will rebuild this"
    // step to rely on the way `path_helper` and `/etc/profile` provide on
    // POSIX — so the inherited environment *is* the environment, and this only
    // layers on what identifies the terminal.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Figyterm");
}

/// The PATH a login shell starts with. User config is sourced afterwards and can
/// extend it, so this only has to cover the system defaults.
///
/// Linux additionally keeps whatever the desktop session already had: Nix,
/// Homebrew-on-Linux and distro-specific prefixes all live there and no fixed
/// list can predict them. macOS doesn't need the same treatment — its login
/// shell runs `path_helper`, which rebuilds PATH from `/etc/paths` regardless.
///
/// POSIX-only: Windows inherits its PATH rather than being handed one.
#[cfg(not(target_os = "windows"))]
fn build_path(home: &str) -> String {
    let mut path = String::from("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");

    #[cfg(not(target_os = "macos"))]
    path.push_str(":/usr/games");

    path.push_str(&format!(":{}/.local/bin", home));

    #[cfg(not(target_os = "macos"))]
    if let Ok(inherited) = std::env::var("PATH") {
        for entry in inherited.split(':').filter(|entry| !entry.is_empty()) {
            if !path.split(':').any(|existing| existing == entry) {
                path.push(':');
                path.push_str(entry);
            }
        }
    }

    path
}

/// The two handles onto the pty, held together because **the order they close
/// in matters** and struct fields drop in declaration order.
///
/// `writer` owns the pty's input side; dropping it is what tells the shell its
/// stdin has ended. `master` owns the pty itself. Closing input first gives the
/// shell the chance to notice and exit on its own; closing the pty first asks
/// the platform to tear down a console that still has a live writer attached.
///
/// On Windows the difference is not cosmetic. `master`'s drop reaches
/// `PsuedoCon::drop`, which calls `ClosePseudoConsole` — a **blocking** call
/// that waits for the attached client to exit and for the console's output to
/// drain. Called with the shell still running and its stdin still open, it can
/// wait a very long time, or forever. POSIX has no equivalent: dropping the
/// master there is `close(fd)`, the shell gets SIGHUP, and nothing blocks —
/// which is why this only ever went wrong on Windows.
struct PtyHandles {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
}

pub struct PtyInstance {
    pub session: TerminalSession,
    /// `Option` only so `Drop` can move the handles out — see the impl.
    handles: Option<PtyHandles>,
    /// Lets us terminate the shell without holding the whole `Child`. Only
    /// Windows needs it — see `shutdown` — but it is cheap to carry everywhere
    /// rather than splitting the struct in two.
    #[cfg_attr(not(windows), allow(dead_code))]
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// PID of the login shell itself. When the tty's foreground process group
    /// leader differs from this, the user is running something. Unread on
    /// Windows, where there are no process groups to compare it against.
    #[cfg_attr(windows, allow(dead_code))]
    shell_pid: Option<u32>,
    shutdown: Arc<Mutex<bool>>,
}

impl PtyInstance {
    /// Opens a pty and starts something in it.
    ///
    /// `command` is the whole of the difference between a terminal pane and the
    /// Claude window. `None` runs the user's login shell, exactly as this has
    /// always done. `Some` runs a named program with an argv, resolved and
    /// given a `PATH` the way `spawn.rs` resolves a language server — because
    /// the problem is identical: a GUI launch inherits a stripped environment,
    /// and the tool the user installed lives somewhere only their profile knows
    /// about.
    pub fn new(
        session_id: String,
        shell: String,
        command: Option<PtyCommand>,
        cwd: String,
        cols: u16,
        rows: u16,
        output_callback: Arc<dyn Fn(String, Vec<u8>) + Send + Sync>,
        exit_callback: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        /*
          The program actually spawned, which is the shell unless a command was
          asked for. Kept as a string because it is also what the session
          reports back to the UI, and what the title is derived from.
        */
        let program = match &command {
            Some(spec) => spawn::find_program(&spec.program)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| spec.program.clone()),
            None => shell.clone(),
        };

        let mut cmd = CommandBuilder::new(&program);
        match &command {
            Some(spec) => {
                for arg in &spec.args {
                    cmd.arg(arg);
                }
            }
            None => {
                for arg in LOGIN_ARGS {
                    cmd.arg(arg);
                }
            }
        }
        cmd.cwd(&cwd);
        configure_environment(&mut cmd, &shell);

        /*
          A login shell rebuilds `PATH` by sourcing the user's profile. A program
          started directly sources nothing, so it would inherit the minimal
          `PATH` `configure_environment` sets — enough to find the program we
          already resolved by absolute path, and not enough for anything *it*
          shells out to. Claude Code runs `git`, `rg` and `node`; a session whose
          `PATH` is missing them is subtly broken rather than obviously so.
        */
        if command.is_some() {
            cmd.env("PATH", spawn::search_path());
        }

        // The `Child` itself is still dropped — dropping it does not kill the
        // process — but a killer is split off it first. Dropping the pty is
        // enough to end the shell on POSIX, where it gets SIGHUP; Windows has
        // no such signal, and `ClosePseudoConsole` waits for the client to go
        // away, so there it has to be asked directly. The pid is kept as before,
        // to tell an idle prompt from a running command.
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;
        let shell_pid = child.process_id();
        let killer = child.clone_killer();

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        let shutdown = Arc::new(Mutex::new(false));
        let shutdown_clone = shutdown.clone();
        let session_id_clone = session_id.clone();

        thread::spawn(move || {
            let mut buf_reader = BufReader::new(reader);
            let mut buf = [0u8; 4096];

            loop {
                if *shutdown_clone.lock().unwrap() {
                    break;
                }

                match buf_reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        output_callback(session_id_clone.clone(), data);
                    }
                    Err(_) => break,
                }
            }

            /*
              The pty has closed, which means the child is gone.

              A terminal pane doesn't care — a shell that exits takes its pane
              with it, and the UI finds out because the user asked for that. The
              Claude window does: a conversation whose process has ended is
              still a readable buffer and still resumable, and it has to stop
              being drawn as live. Nothing reads this unless it asks to.

              Not emitted for a session we shut down ourselves; the caller
              already knows, and a closing tab does not need to hear back.
            */
            if !*shutdown_clone.lock().unwrap() {
                exit_callback(session_id_clone);
            }
        });

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        // Reported as the shell, because from the UI's side it is whatever this
        // session is running — a pane says `zsh`, a Claude conversation says
        // `claude`.
        let title = program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("terminal")
            .to_string();

        let session = TerminalSession {
            id: session_id,
            shell: program,
            cwd,
            title,
            created_at: now,
            status: SessionStatus::Running,
        };

        Ok(Self {
            session,
            handles: Some(PtyHandles {
                writer: Arc::new(Mutex::new(writer)),
                master: Arc::new(Mutex::new(pair.master)),
            }),
            killer: Mutex::new(killer),
            shell_pid,
            shutdown,
        })
    }

    /// The handles, while the instance is alive. Only `Drop` ever takes them.
    fn handles(&self) -> Result<&PtyHandles, String> {
        self.handles
            .as_ref()
            .ok_or_else(|| "the pty is shutting down".to_string())
    }

    /// PID of the tty's foreground process group when it is something other than
    /// the shell sitting at its prompt — i.e. a command the user is running.
    ///
    /// `None` means idle (or undeterminable, which is treated as idle: a false
    /// "busy" would block updating forever, while a false "idle" only costs the
    /// user a confirmation they'd have clicked through anyway).
    #[cfg(unix)]
    pub fn foreground_pid(&self) -> Option<u32> {
        let shell_pid = self.shell_pid?;
        let master = self.handles().ok()?.master.lock().ok()?;
        let leader = master.process_group_leader()? as u32;
        (leader != shell_pid).then_some(leader)
    }

    /// Always `None` on Windows.
    ///
    /// The question doesn't exist there: ConPTY has no process groups, and
    /// `portable-pty` reflects that by declaring `process_group_leader` only
    /// under `#[cfg(unix)]` — so this isn't a stub for something unimplemented,
    /// it's the whole answer the platform can give.
    ///
    /// Callers read `None` as idle, which errs the safe way: the update flow
    /// simply won't name a running command before restarting.
    #[cfg(windows)]
    pub fn foreground_pid(&self) -> Option<u32> {
        None
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self.handles()?.writer.lock().map_err(|e| e.to_string())?;
        writer.write_all(data).map_err(|e| format!("Write failed: {}", e))?;
        writer.flush().map_err(|e| format!("Flush failed: {}", e))?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.handles()?.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {}", e))?;
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(mut s) = self.shutdown.lock() {
            *s = true;
        }

        // POSIX doesn't need this: closing the pty hangs up the terminal and
        // the shell takes SIGHUP. Windows has no hangup, and the shell staying
        // alive is precisely what makes `ClosePseudoConsole` wait, so there the
        // client is asked to go first. Failure is not interesting — the usual
        // reason is that it has already exited.
        #[cfg(windows)]
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }
}

impl Drop for PtyInstance {
    fn drop(&mut self) {
        self.shutdown();

        let Some(handles) = self.handles.take() else {
            return;
        };

        // Closing the pty is not allowed to block whoever is dropping this.
        //
        // On Windows that close is `ClosePseudoConsole`, which waits for the
        // console to drain and the client to exit. `close_session` runs on the
        // main thread, so a shell that was slow to die took the whole UI down
        // with it — the window stopped painting and stopped answering its close
        // button, which is what "the app hangs and I can't close it" was. The
        // shell has already been killed above, so this should return promptly;
        // it goes to its own thread so that "should" isn't load-bearing.
        //
        // Nothing waits on the thread. If the process exits first the OS
        // reclaims the handles, which is the same cleanup by a shorter route.
        #[cfg(windows)]
        {
            thread::spawn(move || drop(handles));
        }

        // Elsewhere the close is a couple of `close(2)` calls; a thread would
        // cost more than it saves, and dropping in place keeps the ordering
        // (writer, then master) plain to read.
        #[cfg(not(windows))]
        drop(handles);
    }
}
