/// The agent's IPC surface. The agent itself is in `src/agent/`.
pub mod agent;
pub mod api;
pub mod autocomplete;
pub mod browser;
/// Linux needs its own container to position child webviews; see the module docs.
#[cfg(target_os = "linux")]
pub mod browser_layout;
pub mod claude;
/// Figy Code's own file index, kept apart from the editor's roots on purpose.
pub mod figy_files;
pub mod fs;
pub mod fs_watch;
pub mod git;
pub mod lsp;
pub mod shell_exec;
pub mod specs;
pub mod sync;
pub mod system;
pub mod terminal;
pub mod window;
