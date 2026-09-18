//! Finding and starting the user's own tools.
//!
//! Two callers, one set of rules: `commands::shell_exec` runs autocomplete
//! generators, and `lsp` starts language servers. Both spawn programs the user
//! installed rather than programs we ship, and both hit the same two problems.
//!
//! **Windows doesn't consult `PATHEXT`.** `CreateProcessW` — and so
//! `std::process::Command` — searches for the bare name and for the name plus
//! `.exe`, and stops. Every Node tool installs its entry point as a `.cmd` shim,
//! so `typescript-language-server` is really `typescript-language-server.cmd`
//! and spawning it fails with "program not found".
//!
//! **A GUI app's `PATH` is not the user's `PATH`.** Launched from Finder or a
//! `.desktop` file, the process inherits a minimal environment: no
//! `~/.cargo/bin`, so no `rust-analyzer`; no `~/go/bin`, so no `gopls`; no nvm
//! shim directory, so none of the Node-based servers. The user's shell profile
//! is where those were added, and nothing has sourced it. [`search_path`]
//! rebuilds what they would have had.
//!
//! **Windows has the same problem for a different reason.** Its `PATH` is not
//! assembled by a profile but held in the registry, and a process is handed a
//! *copy* of it at launch: install a server with winget while the app is open
//! and it stays invisible until the app is restarted, because nothing tells a
//! running process that the environment moved. So the registry is read
//! directly, and the directories each installer is known to write to are added
//! whether or not anybody put them on `PATH` — winget's shim directory, npm's
//! global prefix, scoop's shims, Chocolatey's bin, `.cargo\bin`, `go\bin`.
//!
//! Everything here is cached for the life of the process except where it says
//! otherwise, and costs nothing on machines where the directories don't exist.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Prefixes prepended when the inherited `PATH` looks truncated. `/opt/homebrew`
/// only exists on Apple Silicon macOS, so it stays out of the Linux list rather
/// than sitting there as a dead entry.
#[cfg(target_os = "macos")]
const SYSTEM_PREFIXES: &str =
    "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// Linux, where `/snap/bin` is the one people are surprised by: a snap puts
/// its commands there and adds it to `PATH` from `/etc/profile.d`, which a
/// `.desktop` launch never reads.
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const SYSTEM_PREFIXES: &str =
    "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/games:/snap/bin:/var/lib/flatpak/exports/bin";

/// Per-toolchain bin directories, relative to `$HOME`.
///
/// These are where the language servers in the table actually land:
/// `rustup component add rust-analyzer` writes to `.cargo/bin`, `go install`
/// to `go/bin`, `npm i -g` to whichever of the Node ones is in play. A user who
/// has them on their `PATH` put them there in their shell profile, which a GUI
/// launch never reads — so they are added here regardless, and cost nothing when
/// they don't exist.
#[cfg(not(target_os = "windows"))]
const HOME_PREFIXES: &[&str] = &[
    ".local/bin",
    ".cargo/bin",
    "go/bin",
    // `dotnet tool install --global` lands here, which is where `csharp-ls`
    // ends up. Without it a GUI launch never finds the C# server.
    ".dotnet/tools",
    ".bun/bin",
    ".deno/bin",
    ".volta/bin",
    ".yarn/bin",
    ".npm-global/bin",
    // pnpm's global bin, which is where `pnpm add -g` puts a server.
    ".local/share/pnpm",
    // Nix, per-user.
    ".nix-profile/bin",
    ".local/state/nix/profile/bin",
    // Flatpak's per-user exports, the counterpart to the system one above.
    ".local/share/flatpak/exports/bin",
    /*
      Version-manager shim directories.

      The login shell below is the real answer for these — a shim directory is
      useless without the manager's own environment — but it is not always
      reachable: a `.desktop` launch may have no `SHELL`, and a profile that
      hangs is given up on. A shim found here still resolves to the right
      version through the manager's config, so it is a better fallback than
      nothing.
    */
    ".asdf/shims",
    ".local/share/mise/shims",
    ".rbenv/shims",
    ".pyenv/shims",
];

/// How long the login shell gets to report its `PATH` before we give up on it.
///
/// A profile that blocks — waiting on a network mount, or on a prompt framework
/// fetching something — must not hang the first "is this server installed?"
/// check. Two seconds is far more than a profile should take and far less than
/// a user will sit through.
#[cfg(not(target_os = "windows"))]
const LOGIN_SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// How to ask a shell for its `PATH`, which is not the same question everywhere.
///
/// `printf %s "$PATH"` is the POSIX answer and is wrong in two shells people
/// actually use:
///
/// - **fish** keeps `PATH` as a *list*, and quoting one joins it with spaces.
///   The reply comes back `/usr/bin /bin /opt/homebrew/bin` — which passes a
///   naive "looks like a path" check, splits on `:` into a single nonsense
///   entry, and quietly finds nothing. `string join` is fish's own way to
///   produce the colon-separated form.
/// - **nushell** is not POSIX at all: no `-lic`, no `$PATH` string, and `$env.PATH`
///   is a list. It gets its own spelling too.
///
/// `-l` sources the profile, which is the point of asking. `-i` as well, because
/// on zsh — the macOS default — `PATH` additions overwhelmingly live in
/// `.zshrc`, which only an interactive shell reads.
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn probe_script(shell: &str) -> (&'static str, &'static str) {
    let name = Path::new(shell)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    match name.as_str() {
        "fish" => ("-lic", "string join : $PATH"),
        "nu" | "nushell" => ("-lc", "$env.PATH | str join (char esep)"),
        _ => ("-lic", "printf %s \"$PATH\""),
    }
}

/// Whether what a shell printed is a `PATH` rather than a greeting.
///
/// Profiles print things — version notices, fortunes, a prompt framework's
/// first run. What comes back has to look like a list of absolute directories
/// before it is searched: colon-separated, or a single absolute path with no
/// spaces around it. A line of prose passes neither test.
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn usable_path(text: &str) -> Option<&str> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }

    // The last line only: anything a profile printed came before it.
    let candidate = text.lines().next_back()?.trim();
    if candidate.is_empty() {
        return None;
    }

    if candidate.contains(':') {
        /*
          Colon-separated, so this is the shape being asked for. At least one
          entry has to be an absolute directory — that is what separates a
          `PATH` from a sentence that happens to contain a colon — but not all
          of them, because a `.` or a relative entry in somebody's `PATH` is
          their business and no reason to throw the rest away.

          Spaces inside an entry are fine and deliberate: `/Applications/My
          App/bin` is a real directory on a real Mac.
        */
        let any_absolute = candidate
            .split(':')
            .any(|entry| entry.starts_with('/') && entry.len() > 1);
        return any_absolute.then_some(candidate);
    }

    // No colon: either a single directory, or fish having joined its list with
    // spaces. ` /` is what tells those apart — one directory has no second one
    // starting inside it.
    let single_directory = candidate.starts_with('/') && !candidate.contains(" /");
    single_directory.then_some(candidate)
}

/// The `PATH` the user's login shell would have, asked for once.
///
/// This is the only way to find a tool installed by a version manager: nvm, asdf,
/// rbenv and friends work by *prepending to `PATH` in your profile*, and there is
/// no fixed directory to guess at. Running the login shell and reading back what
/// it ended up with is what every editor that gets this right does.
///
/// `None` when the shell couldn't be run, timed out, or produced nothing —
/// callers fall back to the static prefixes, which is the pre-existing behaviour.
#[cfg(not(target_os = "windows"))]
fn login_path() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();

    CACHE
        .get_or_init(|| {
            let shell = std::env::var("SHELL").ok()?;
            if shell.is_empty() {
                return None;
            }

            let (flags, script) = probe_script(&shell);
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let output = Command::new(&shell).args([flags, script]).output();
                // The receiver is gone on timeout; nothing to do about it here.
                let _ = sender.send(output);
            });

            let output = receiver.recv_timeout(LOGIN_SHELL_TIMEOUT).ok()?.ok()?;
            if !output.status.success() {
                return None;
            }

            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            usable_path(&path).map(str::to_string)
        })
        .as_deref()
}

/// Every directory a program might be found in, in search order.
///
/// The inherited `PATH` comes first — a user who set one deliberately, or a
/// development run from a terminal, should not be second-guessed — then the
/// login shell's, then the static fallbacks.
#[cfg(not(target_os = "windows"))]
pub fn search_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut push = |dir: &str| {
        if !dir.is_empty() && !parts.iter().any(|seen| seen == dir) {
            parts.push(dir.to_string());
        }
    };

    if let Ok(inherited) = std::env::var("PATH") {
        inherited.split(':').for_each(&mut push);
    }
    if let Some(login) = login_path() {
        login.split(':').for_each(&mut push);
    }
    SYSTEM_PREFIXES.split(':').for_each(&mut push);

    if let Ok(home) = std::env::var("HOME") {
        for suffix in HOME_PREFIXES {
            push(&format!("{home}/{suffix}"));
        }
    }

    parts.join(":")
}

/// Where each Windows installer puts the things it installs.
///
/// Every one of these is a real answer to "I installed it and the editor still
/// says it isn't there". They are tried whether or not they are on `PATH`,
/// because the `PATH` this process was handed is a snapshot from launch time
/// and an install that happened since is not in it.
///
/// `{L}` is `LOCALAPPDATA`, `{A}` is `APPDATA`, `{U}` is `USERPROFILE`, `{D}`
/// is `ProgramData` and `{P}` is `ProgramFiles` — spelled short here because
/// the table is the point, not the expansion.
#[cfg(target_os = "windows")]
const WINDOWS_PREFIXES: &[&str] = &[
    // winget's shim directory. Added to the user `PATH` by the installer,
    // which only helps processes started afterwards.
    r"{L}\Microsoft\WinGet\Links",
    // `npm i -g`, which is how most of the servers in the table are installed.
    r"{A}\npm",
    // scoop, per-user and global.
    r"{U}\scoop\shims",
    r"{D}\scoop\shims",
    // Chocolatey.
    r"{D}\chocolatey\bin",
    // rustup, for rust-analyzer.
    r"{U}\.cargo\bin",
    // `go install`, for gopls.
    r"{U}\go\bin",
    // `dotnet tool install --global`, for csharp-ls.
    r"{U}\.dotnet\tools",
    // The Node-adjacent runtimes, each of which installs global binaries.
    r"{U}\.bun\bin",
    r"{U}\.deno\bin",
    r"{L}\Volta\bin",
    r"{L}\Yarn\bin",
    r"{L}\pnpm",
    // The MSI installers, for node itself and for clangd.
    r"{P}\nodejs",
    r"{P}\LLVM\bin",
];

/// Directories to look inside for a `Scripts` folder, `pip --user` style.
///
/// Python's user install location carries the version in its name —
/// `Python311\Scripts` — so it cannot be written as a fixed string. These are
/// the two parents worth enumerating.
#[cfg(target_os = "windows")]
const WINDOWS_PYTHON_PARENTS: &[&str] = &[r"{A}\Python", r"{L}\Programs\Python"];

/// How long `reg.exe` gets to answer before the registry is given up on.
#[cfg(target_os = "windows")]
const REG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The `Path` value out of `reg query` output.
///
/// Its shape is `    Path    REG_EXPAND_SZ    C:\…;C:\…`, with the value free
/// to contain spaces — so it is split off after the type rather than by
/// counting columns. Parsed as its own function, and compiled — and tested —
/// on every platform: this is Windows-only logic, and the machine writing it is
/// not a Windows machine. A test that only runs where the bug cannot be
/// reproduced is the one worth having.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_reg_path(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim_start();
        // `continue`, never `?`: `reg query` opens with a blank line and then
        // the key's own name, neither of which has a second column. Giving up
        // on the first of them would mean never reading the value at all.
        let Some((name, rest)) = trimmed.split_once(char::is_whitespace) else {
            continue;
        };
        if !name.eq_ignore_ascii_case("Path") {
            continue;
        }
        let rest = rest.trim_start();
        let Some((kind, value)) = rest.split_once(char::is_whitespace) else {
            continue;
        };
        if !kind.starts_with("REG_") {
            continue;
        }
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// Expands `%NAME%` references the way the registry's `REG_EXPAND_SZ` means them.
///
/// An unknown name is left exactly as written: a `PATH` entry naming a variable
/// this process doesn't have is a directory that doesn't exist, and a wrong
/// guess would be a directory that does.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn expand_windows_vars(value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;

    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match lookup(name) {
                    Some(expanded) => out.push_str(&expanded),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            // An unpaired `%` is literal text, not the start of anything.
            None => {
                out.push('%');
                out.push_str(after);
                return out;
            }
        }
    }

    out.push_str(rest);
    out
}

/// The `PATH` the registry holds, user and system, asked for once.
///
/// This is what a *newly started* program would be given, which is exactly what
/// a running one cannot see. Reading it is how an install that happened while
/// the app was open becomes visible without a restart.
#[cfg(target_os = "windows")]
fn registry_path() -> Vec<String> {
    {
        const KEYS: [&str; 2] = [
            r"HKCU\Environment",
            r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ];

        KEYS.iter()
            .filter_map(|key| {
                // Through a thread with a deadline: `reg.exe` is ordinarily
                // instant, but it talks to a service, and a machine where that
                // is wedged must not take the editor's startup with it.
                let key = key.to_string();
                let (sender, receiver) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    let mut command = Command::new("reg");
                    command.args(["query", &key, "/v", "Path"]);
                    {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                        command.creation_flags(CREATE_NO_WINDOW);
                    }
                    let _ = sender.send(command.output());
                });

                let output = receiver.recv_timeout(REG_TIMEOUT).ok()?.ok()?;
                if !output.status.success() {
                    return None;
                }
                let raw = String::from_utf8_lossy(&output.stdout);
                let value = parse_reg_path(&raw)?;
                Some(expand_windows_vars(&value, &|name| std::env::var(name).ok()))
            })
            .collect()
    }
}

/// How long a computed Windows search path is reused for.
///
/// Long enough that one detection pass — two dozen programs, each asking —
/// reads the registry and the Python directories once. Short enough that
/// "Check again", pressed after installing something, actually checks again:
/// nobody installs a language server in ten seconds.
#[cfg(target_os = "windows")]
const SEARCH_PATH_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// Every directory a program might be found in, in search order.
///
/// The inherited `PATH` leads — it is what the user's shell would use, and a
/// development run from a terminal should not be second-guessed — then the
/// registry, then the places installers write to.
#[cfg(target_os = "windows")]
pub fn search_path() -> String {
    use std::sync::Mutex;
    use std::time::Instant;

    static CACHE: Mutex<Option<(Instant, String)>> = Mutex::new(None);

    if let Ok(cache) = CACHE.lock() {
        if let Some((at, path)) = cache.as_ref() {
            if at.elapsed() < SEARCH_PATH_TTL {
                return path.clone();
            }
        }
    }

    let mut parts: Vec<String> = Vec::new();
    let mut push = |dir: &str| {
        let dir = dir.trim_end_matches('\\');
        if !dir.is_empty() && !parts.iter().any(|seen| seen.eq_ignore_ascii_case(dir)) {
            parts.push(dir.to_string());
        }
    };

    if let Ok(inherited) = std::env::var("PATH") {
        inherited.split(';').for_each(&mut push);
    }
    for value in registry_path() {
        value.split(';').for_each(&mut push);
    }

    let expand = |template: &str| -> Option<String> {
        let mut out = template.to_string();
        for (token, var) in [
            ("{L}", "LOCALAPPDATA"),
            ("{A}", "APPDATA"),
            ("{U}", "USERPROFILE"),
            ("{D}", "ProgramData"),
            ("{P}", "ProgramFiles"),
        ] {
            if out.contains(token) {
                out = out.replace(token, &std::env::var(var).ok()?);
            }
        }
        Some(out)
    };

    for template in WINDOWS_PREFIXES {
        if let Some(dir) = expand(template) {
            push(&dir);
        }
    }

    // `…\Python313\Scripts`, whichever versions are installed.
    for template in WINDOWS_PYTHON_PARENTS {
        let Some(parent) = expand(template) else {
            continue;
        };
        let Ok(entries) = std::fs::read_dir(&parent) else {
            continue;
        };
        for entry in entries.flatten() {
            let scripts = entry.path().join("Scripts");
            if scripts.is_dir() {
                push(&scripts.to_string_lossy());
            }
        }
    }

    let joined = parts.join(";");
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), joined.clone()));
    }
    joined
}

/// Whether `path` is a file this platform would agree to execute.
///
/// The executable bit is checked on POSIX because `PATH` contains plenty of
/// directories holding non-executable files, and handing `Command` one of those
/// turns "not installed" into a confusing `EACCES` at spawn time.
#[cfg(not(target_os = "windows"))]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Finds what `command` actually names on disk, the way a shell would.
///
/// `None` means nothing matched. Callers spawning a program pass the bare name
/// through in that case, so the error they get is the ordinary one; callers
/// *asking whether it is installed* read `None` as the answer.
pub fn find_program(command: &str) -> Option<PathBuf> {
    // `~` is the shell's, not the filesystem's, and a path typed into the
    // settings panel never passed through one. Expanded here so that pasting
    // `~/dev/tools/my-server` means what it looks like it means.
    let expanded = expand_home(command);
    let command = expanded.as_deref().unwrap_or(command);

    // An explicit path is already an answer, give or take the extension.
    let has_separator = command.contains('/') || command.contains('\\');

    #[cfg(target_os = "windows")]
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| ext.to_string())
        .collect();

    // A name that already carries one of those extensions is used as written.
    #[cfg(target_os = "windows")]
    let already_extended = Path::new(command)
        .extension()
        .map(|ext| {
            let ext = format!(".{}", ext.to_string_lossy());
            extensions.iter().any(|known| known.eq_ignore_ascii_case(&ext))
        })
        .unwrap_or(false);

    let candidates = |dir: &Path| -> Option<PathBuf> {
        let direct = dir.join(command);
        #[cfg(target_os = "windows")]
        {
            if already_extended {
                return is_executable(&direct).then_some(direct);
            }
            return extensions.iter().find_map(|ext| {
                let candidate = dir.join(format!("{command}{ext}"));
                is_executable(&candidate).then_some(candidate)
            });
        }
        #[cfg(not(target_os = "windows"))]
        is_executable(&direct).then_some(direct)
    };

    if has_separator {
        return candidates(Path::new(""));
    }

    let path = search_path();
    std::env::split_paths(&path).find_map(|dir| candidates(&dir))
}

/// `~/…` against the user's home, or `None` when there is no `~` to expand.
///
/// Only a leading `~/` (or `~\\` on Windows): a bare `~` is a directory nobody
/// means to execute, and `~other/bin` is another user's home, which this has no
/// business guessing at.
fn expand_home(command: &str) -> Option<String> {
    let rest = command.strip_prefix('~')?;
    let rest = rest.strip_prefix('/').or_else(|| rest.strip_prefix('\\'))?;

    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())?;
    Some(format!("{}/{rest}", home.trim_end_matches(['/', '\\'])))
}

/// The directory holding a `.NET` runtime, for tools that cannot find one.
///
/// A .NET "tool" installed by `dotnet tool install --global` is an **apphost**:
/// a small native launcher that has to locate a runtime before it can run
/// anything. It looks at `DOTNET_ROOT`, then at a couple of fixed system paths,
/// then at `/etc/dotnet/install_location`. It does *not* look next to the
/// `dotnet` on your `PATH`, and that is the gap this fills:
///
/// - **Homebrew installs to its own prefix** — `/opt/homebrew/opt/dotnet/libexec`
///   — and does not set `DOTNET_ROOT`. The `dotnet` CLI works anyway because it
///   knows where it is; an apphost has no such luxury.
/// - **`/etc/dotnet/install_location` outlives the install it points at.** A
///   machine that once had the official installer keeps a file naming
///   `/usr/local/share/dotnet` long after that directory is gone.
///
/// The result is `csharp-ls` failing with "You must install .NET to run this
/// application — .NET location: Not found", on a machine where `dotnet
/// --list-runtimes` prints a perfectly good runtime.
///
/// Deriving the root from the `dotnet` binary we would actually run is correct
/// for Homebrew, for a tarball unpacked anywhere, and for the official
/// installer, because in every one of them the runtime sits beside the SDK.
fn dotnet_root() -> Option<&'static Path> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();

    CACHE
        .get_or_init(|| {
            let binary = find_program("dotnet")?;
            // Through any symlinks: Homebrew's `bin/dotnet` is a link into the
            // versioned Cellar directory, and the layout is only visible there.
            let real = std::fs::canonicalize(&binary).unwrap_or(binary);
            root_beside(&real)
        })
        .as_deref()
}

/// Finds the directory containing `shared/Microsoft.NETCore.App` near `binary`.
///
/// Three layouts, in the order they are worth trying:
/// - `<root>/dotnet` — the official installer and most tarballs.
/// - `<prefix>/bin/dotnet` with the runtime under `<prefix>/libexec` — Homebrew.
/// - `<prefix>/bin/dotnet` with the runtime under `<prefix>` — some distros.
fn root_beside(binary: &Path) -> Option<PathBuf> {
    let holding = binary.parent()?;
    let above = holding.parent();

    let candidates = [
        Some(holding.to_path_buf()),
        above.map(|dir| dir.join("libexec")),
        above.map(|dir| dir.to_path_buf()),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|dir| dir.join("shared").join("Microsoft.NETCore.App").is_dir())
}

/// Starts a `Command` for a program the user installed.
///
/// Resolved through [`find_program`] so Windows shims work, and handed the
/// repaired `PATH` so anything the program itself shells out to — `tsserver`
/// from `typescript-language-server`, `cargo` from `rust-analyzer` — is found
/// the same way.
pub fn command(program: &str) -> Command {
    let resolved = find_program(program).unwrap_or_else(|| PathBuf::from(program));
    let mut cmd = Command::new(resolved);

    // Without this every spawn flashes a console window on screen. There is no
    // console to show: the output is read, not displayed.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    /*
      The repaired `PATH` goes to the child on every platform, and on Windows
      that is not decoration.

      A Node-based server is a `.cmd` shim whose first act is to run `node`, and
      `rust-analyzer` shells out to `cargo`. Resolving the shim while handing it
      the *unrepaired* environment means the thing we just found starts and then
      fails to find its own runtime — which surfaces as a language server that
      exits immediately for no visible reason, on exactly the machines this
      module exists for.
    */
    cmd.env("PATH", search_path());

    #[cfg(not(target_os = "windows"))]
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }

    // Only when the user hasn't decided for themselves. Someone who set
    // `DOTNET_ROOT` deliberately — to pin a runtime, or to point at a private
    // build — must not be second-guessed.
    if std::env::var_os("DOTNET_ROOT").is_none() {
        if let Some(root) = dotnet_root() {
            cmd.env("DOTNET_ROOT", root);
        }
    }

    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
      The tests below cover Windows and fish, neither of which this is being
      written on. That is the point: the logic they check is precisely the
      logic nobody here can reproduce a bug in, so it is kept as pure functions
      compiled everywhere rather than hidden behind a `cfg` that would make
      them unrunnable.
    */

    #[test]
    fn a_registry_path_is_read_from_after_its_type() {
        // `reg query` output, verbatim: a blank line, the key, then the value
        // — whose own spaces must not be mistaken for column separators.
        let output = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Users\\Sam\\AppData\\Local\\Microsoft\\WinGet\\Links;C:\\Program Files\\nodejs\r\n\r\n";
        assert_eq!(
            parse_reg_path(output).as_deref(),
            Some("C:\\Users\\Sam\\AppData\\Local\\Microsoft\\WinGet\\Links;C:\\Program Files\\nodejs")
        );
    }

    #[test]
    fn a_registry_read_survives_the_lines_that_are_not_values() {
        // The bug this test exists for: the key's own name has no second
        // column, and giving up there meant never reading the value below it.
        assert_eq!(parse_reg_path("\r\nHKEY_CURRENT_USER\\Environment\r\n"), None);
        assert_eq!(parse_reg_path(""), None);
        // A different value in the same key is not the one being asked for.
        assert_eq!(parse_reg_path("    TEMP    REG_SZ    C:\\Temp"), None);
    }

    #[test]
    fn registry_variables_expand_and_unknown_ones_are_left_alone() {
        let lookup = |name: &str| match name {
            "USERPROFILE" => Some("C:\\Users\\Sam".to_string()),
            _ => None,
        };
        assert_eq!(
            expand_windows_vars("%USERPROFILE%\\.cargo\\bin", &lookup),
            "C:\\Users\\Sam\\.cargo\\bin"
        );
        // Unknown: kept as written, so it resolves to a directory that does not
        // exist rather than to the wrong one.
        assert_eq!(expand_windows_vars("%NOPE%\\bin", &lookup), "%NOPE%\\bin");
        // A lone `%` is literal text.
        assert_eq!(expand_windows_vars("100%", &lookup), "100%");
        assert_eq!(expand_windows_vars("C:\\bin", &lookup), "C:\\bin");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn each_shell_is_asked_in_its_own_language() {
        assert_eq!(probe_script("/bin/zsh").1, "printf %s \"$PATH\"");
        assert_eq!(probe_script("/bin/bash").1, "printf %s \"$PATH\"");
        // fish joins a quoted list with spaces, so it is asked for colons.
        assert_eq!(probe_script("/opt/homebrew/bin/fish").1, "string join : $PATH");
        assert_eq!(probe_script("/usr/local/bin/nu").0, "-lc");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn a_shell_reply_is_only_used_when_it_looks_like_a_path() {
        assert_eq!(
            usable_path("/usr/bin:/bin:/opt/homebrew/bin"),
            Some("/usr/bin:/bin:/opt/homebrew/bin")
        );
        // A directory with a space in it is a real directory.
        assert_eq!(
            usable_path("/Applications/My App/bin:/usr/bin"),
            Some("/Applications/My App/bin:/usr/bin")
        );
        // A profile that greets you, and then answers.
        assert_eq!(usable_path("Welcome back!\n/usr/bin:/bin"), Some("/usr/bin:/bin"));
        // fish's space-joined list, which used to be accepted and searched as
        // a single directory nobody has.
        assert_eq!(usable_path("/usr/bin /bin /opt/homebrew/bin"), None);
        // Prose with a colon in it is not a PATH.
        assert_eq!(usable_path("note: nothing to do"), None);
        assert_eq!(usable_path(""), None);
        // One directory, which is a legitimate if unusual answer.
        assert_eq!(usable_path("/usr/bin"), Some("/usr/bin"));
    }

    /// The one program POSIX guarantees, at the one path it guarantees it at.
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn finds_a_program_on_the_path() {
        assert!(find_program("sh").is_some());
    }

    #[test]
    fn a_pasted_tilde_path_resolves_against_home() {
        let home = std::env::var("HOME").expect("HOME is set on every platform this runs on");
        assert_eq!(expand_home("~/dev/tools/server"), Some(format!("{home}/dev/tools/server")));
        // Not a home reference, and not ours to guess at.
        assert_eq!(expand_home("~"), None);
        assert_eq!(expand_home("~other/bin/server"), None);
        assert_eq!(expand_home("/usr/bin/server"), None);
        assert_eq!(expand_home("server"), None);
    }

    #[test]
    fn missing_programs_are_none() {
        assert!(find_program("figyterm-definitely-not-installed").is_none());
    }

    /// A directory is not a program, however much it looks like one to `is_file`'s
    /// absence.
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn a_directory_is_not_a_program() {
        assert!(!is_executable(Path::new("/usr")));
    }

    #[test]
    fn the_search_path_is_not_empty() {
        assert!(!search_path().is_empty());
    }

    /// Builds a fake install and checks the runtime is found beside the binary.
    fn layout(prefix: &Path, binary_dir: &str, runtime_dir: &str) -> PathBuf {
        let bin = prefix.join(binary_dir);
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("dotnet"), b"").unwrap();
        std::fs::create_dir_all(
            prefix
                .join(runtime_dir)
                .join("shared")
                .join("Microsoft.NETCore.App"),
        )
        .unwrap();
        bin.join("dotnet")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("figyterm-dotnet-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The official installer: the runtime sits beside the binary.
    #[test]
    fn finds_a_runtime_in_the_same_directory() {
        let prefix = scratch("flat");
        let binary = layout(&prefix, "dotnet-home", "dotnet-home");
        assert_eq!(root_beside(&binary), Some(prefix.join("dotnet-home")));
    }

    /// Homebrew: `bin/dotnet`, runtime under `libexec`. This is the layout that
    /// broke `csharp-ls`.
    #[test]
    fn finds_a_runtime_under_libexec() {
        let prefix = scratch("brew");
        let binary = layout(&prefix, "bin", "libexec");
        assert_eq!(root_beside(&binary), Some(prefix.join("libexec")));
    }

    /// Some distributions put the runtime one level above `bin`.
    #[test]
    fn finds_a_runtime_above_bin() {
        let prefix = scratch("distro");
        let bin = prefix.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("dotnet"), b"").unwrap();
        std::fs::create_dir_all(prefix.join("shared").join("Microsoft.NETCore.App")).unwrap();
        assert_eq!(root_beside(&bin.join("dotnet")), Some(prefix.clone()));
    }

    /// A `dotnet` with no runtime anywhere near it yields nothing, rather than
    /// a directory that would make the apphost fail more confusingly.
    #[test]
    fn no_runtime_nearby_is_none() {
        let prefix = scratch("bare");
        let bin = prefix.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("dotnet"), b"").unwrap();
        assert_eq!(root_beside(&bin.join("dotnet")), None);
    }
}
