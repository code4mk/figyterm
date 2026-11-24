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
//!
//! The loop, the provider client and the ledger are not written.
//! `docs/figy-code-plan/TASKS.md` is the order they arrive in, and the ledger
//! is deliberately early in it: without per-turn token accounting from the
//! start, a five-fold cost regression is invisible until the bill arrives.

pub mod tools;
pub mod workspace;
