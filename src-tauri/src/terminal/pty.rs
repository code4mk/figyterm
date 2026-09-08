use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{BufReader, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use super::session::{SessionStatus, TerminalSession};

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

pub struct PtyInstance {
    pub session: TerminalSession,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// PID of the login shell itself. When the tty's foreground process group
    /// leader differs from this, the user is running something. Unread on
    /// Windows, where there are no process groups to compare it against.
    #[cfg_attr(windows, allow(dead_code))]
    shell_pid: Option<u32>,
    shutdown: Arc<Mutex<bool>>,
}

impl PtyInstance {
    pub fn new(
        session_id: String,
        shell: String,
        cwd: String,
        cols: u16,
        rows: u16,
        output_callback: Arc<dyn Fn(String, Vec<u8>) + Send + Sync>,
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

        let mut cmd = CommandBuilder::new(&shell);
        for arg in LOGIN_ARGS {
            cmd.arg(arg);
        }
        cmd.cwd(&cwd);
        configure_environment(&mut cmd, &shell);

        // The child handle is dropped as before (dropping it does not kill the
        // process); only its pid is kept, to tell an idle prompt from a running
        // command later.
        let shell_pid = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?
            .process_id();

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
        });

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let session = TerminalSession {
            id: session_id,
            shell: shell.clone(),
            cwd,
            title: shell.split('/').last().unwrap_or("terminal").to_string(),
            created_at: now,
            status: SessionStatus::Running,
        };

        Ok(Self {
            session,
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            shell_pid,
            shutdown,
        })
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
        let master = self.master.lock().ok()?;
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
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer.write_all(data).map_err(|e| format!("Write failed: {}", e))?;
        writer.flush().map_err(|e| format!("Flush failed: {}", e))?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|e| e.to_string())?;
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
    }
}

impl Drop for PtyInstance {
    fn drop(&mut self) {
        self.shutdown();
    }
}
