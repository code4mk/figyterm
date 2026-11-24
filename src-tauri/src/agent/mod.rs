//! Figy Code's agent: one loop, one tool registry, one workspace.
//!
//! The architecture `docs/CODE-AGENT.md` argues for, which is worth repeating
//! here because it is the thing most easily lost: **the agent is one
//! implementation in Rust, and both front ends are thin clients of it.** The
//! window and the editor panel send messages and render events. If either of
//! them ever contains a turn loop, this design has failed.
//!
//! ```text
//!   src/components/FigyCode/        src/components/Editor/AgentPanel.tsx
//!    the window                      the panel beside your code
//!         └───────────────┬────────────────┘
//!                 invoke / events
//!                         ▼
//!               src-tauri/src/agent/        ← here
//!                         │
//!                         ▼
//!              an OpenAI-compatible endpoint
//! ```
//!
//! ## What exists so far
//!
//! - [`workspace`] — the folder the agent is pointed at, and the fence that
//!   keeps every tool inside it.
//! - [`tools`] — the registry, the schema the model is offered, and the three
//!   tools that make an agent: `read`, `grep`, `edit`.
//! - [`message`] — the conversation, and the OpenAI form it is sent in.
//! - [`policy`] — which classes of tool may run in which permission mode.
//! - [`provider`] — one trait, and a client for any OpenAI-compatible
//!   endpoint, streaming and cancellable.
//! - [`session`] — the turn loop, and the frozen prefix it depends on.
//! - [`ledger`] — what every turn cost, written down at the time, because
//!   cache discipline is invisible when it breaks.
//!
//! What is not written: compaction, the dirty-buffer handshake before an
//! edit, and the rest of the tool surface.
//! `docs/figy-code-plan/TASKS.md` is the order they arrive in.

pub mod ledger;
pub mod message;
pub mod policy;
pub mod provider;
pub mod session;
pub mod tools;
pub mod workspace;
