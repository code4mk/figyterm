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

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Prefixes prepended when the inherited `PATH` looks truncated. `/opt/homebrew`
/// only exists on Apple Silicon macOS, so it stays out of the Linux list rather
/// than sitting there as a dead entry.
#[cfg(target_os = "macos")]
const SYSTEM_PREFIXES: &str =
    "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const SYSTEM_PREFIXES: &str = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/games";

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
];

/// How long the login shell gets to report its `PATH` before we give up on it.
///
/// A profile that blocks — waiting on a network mount, or on a prompt framework
/// fetching something — must not hang the first "is this server installed?"
/// check. Two seconds is far more than a profile should take and far less than
/// a user will sit through.
#[cfg(not(target_os = "windows"))]
const LOGIN_SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

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

            // `-l` sources the profile, which is the whole point. `-i` as well,
            // because on zsh — the macOS default — `PATH` additions overwhelmingly
            // live in `.zshrc`, which only an interactive shell reads.
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let output = Command::new(&shell)
                    .args(["-lic", "printf %s \"$PATH\""])
                    .output();
                // The receiver is gone on timeout; nothing to do about it here.
                let _ = sender.send(output);
            });

            let output = receiver.recv_timeout(LOGIN_SHELL_TIMEOUT).ok()?.ok()?;
            if !output.status.success() {
                return None;
            }

            // Profiles print things. Anything that isn't a plausible PATH — no
            // separator and no leading slash — is somebody's greeting, not an
            // answer, and is better ignored than searched.
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let plausible = path.contains(':') || path.starts_with('/');
            (!path.is_empty() && plausible).then_some(path)
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

/// Windows inherits a usable `PATH` — there is no "launched from Finder with a
/// stripped environment" equivalent, and no profile to source — so it is used
/// exactly as it arrives.
#[cfg(target_os = "windows")]
pub fn search_path() -> String {
    std::env::var("PATH").unwrap_or_default()
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

    #[cfg(not(target_os = "windows"))]
    {
        cmd.env("PATH", search_path());
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
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

    /// The one program POSIX guarantees, at the one path it guarantees it at.
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn finds_a_program_on_the_path() {
        assert!(find_program("sh").is_some());
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
