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
//! - [`shell`] — running commands, in the foreground and out of it. Behind a
//!   trait, and absent from a context that should not have one.
//! - [`code`] — the bridge to the language server the app is already
//!   running, which is the one thing a CLI agent cannot have.
//! - [`ask`] — the same shape with a person on the other end: a question
//!   the run stops on, answered with a number rather than a paragraph.
//! - [`delegate`] — a whole conversation inside one tool call, whose
//!   context is thrown away and whose answer is a paragraph.
//! - [`web`] — Exa, for the questions whose answer is not in the project.
//! - [`store`] — the conversation on disk, so a restart is an
//!   interruption rather than an ending.
//! - [`rules`] — the project's own instructions, read into the prefix at
//!   session start from a file the user can review in a diff.
//!
//! What is not written: the dirty-buffer handshake before an edit, the
//! agent's own rules file, and the rest of the tool surface.
//! `docs/figy-code-plan/TASKS.md` is the order they arrive in.

pub mod ask;
pub mod code;
pub mod delegate;
pub mod ledger;
pub mod message;
pub mod policy;
pub mod provider;
pub mod rules;
pub mod session;
pub mod shell;
pub mod store;
pub mod tools;
pub mod web;
pub mod workspace;
