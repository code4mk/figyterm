//! Every language server that is currently running.
//!
//! The same shape as `terminal/manager.rs`: a map of live children behind a
//! `Mutex`, and a callback that turns reads into events. The one thing it adds
//! is a **cap** — a terminal that has quietly started six language servers on a
//! large repository is no longer a terminal, and refusing loudly is better than
//! discovering it in Activity Monitor.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::server::{ExitHandler, MessageHandler, Server, ServerInfo};

/// How many servers may run at once.
///
/// Six, raised from three when companion servers arrived. A React project with
/// Tailwind is already four before anything unusual happens —
/// `typescript-language-server`, `tailwindcss-language-server`, and the CSS and
/// JSON servers — and a cap that refuses the ordinary case is a cap that just
/// looks broken.
///
/// It is still a cap rather than no cap, because the failure it guards against
/// is real: these are heavyweight children, and `rust-analyzer` alone can hold
/// more memory than the rest of the app. A seventh is refused rather than
/// queued, because the honest answer to "this is too much" is a message, not a
/// wait.
const MAX_SERVERS: usize = 6;

#[derive(Default)]
pub struct Registry {
    servers: HashMap<String, Arc<Server>>,
}

impl Registry {
    /// Starts a server under `id`, or hands back the one already running there.
    ///
    /// Idempotent on purpose: the client asks for a server every time a buffer
    /// of that language opens, and the second ask should be free rather than a
    /// second `rust-analyzer`.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &mut self,
        id: String,
        language: String,
        program: String,
        args: Vec<String>,
        root: String,
        on_message: MessageHandler,
        on_exit: ExitHandler,
    ) -> Result<ServerInfo, String> {
        // A server that died while nobody was looking is cleared out first, so
        // its slot doesn't count against the cap and asking again restarts it.
        self.servers.retain(|_, server| server.is_alive());

        if let Some(existing) = self.servers.get(&id) {
            return Ok(existing.info());
        }

        if self.servers.len() >= MAX_SERVERS {
            return Err(format!(
                "already running {MAX_SERVERS} language servers — stop one before starting {program}"
            ));
        }

        let server = Server::start(id.clone(), language, program, args, root, on_message, on_exit)?;
        let info = server.info();
        self.servers.insert(id, Arc::new(server));
        Ok(info)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Server>> {
        self.servers.get(id).cloned()
    }

    /// Stops one server and forgets it. Unknown ids are not an error: the client
    /// may be tidying up after something that already died.
    pub fn stop(&mut self, id: &str) {
        if let Some(server) = self.servers.remove(id) {
            server.stop();
        }
    }

    pub fn status(&self) -> Vec<ServerInfo> {
        let mut all: Vec<ServerInfo> = self.servers.values().map(|s| s.info()).collect();
        // Stable order, so the settings panel doesn't reshuffle on every poll.
        all.sort_by(|a, b| a.id.cmp(&b.id));
        all
    }

    /// Ends every server, blocking until they are gone.
    ///
    /// Called on `RunEvent::Exit`, where `lib.rs` already reaps the PTYs for
    /// exactly this reason. A `rust-analyzer` that outlives the app is a
    /// gigabyte of resident memory belonging to a window that is no longer on
    /// screen.
    pub fn shutdown_all(&mut self) {
        for (_, server) in self.servers.drain() {
            server.stop_blocking();
        }
    }
}

/// The Tauri-managed handle. `Mutex` rather than `RwLock` because every
/// interesting operation mutates.
#[derive(Default)]
pub struct LspState {
    pub registry: Mutex<Registry>,
}
