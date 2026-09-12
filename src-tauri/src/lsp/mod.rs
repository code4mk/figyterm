//! The language-server transport.
//!
//! Rust owns the *process and the framing*; TypeScript owns the *protocol and
//! the editor integration*. See `docs/LSP.md` for why the split falls here, and
//! `docs/LSP-TASKS.md` for what is built.
//!
//! Nothing in this module parses a `textDocument/hover`. It parses a
//! `Content-Length` header and hands the body over as an opaque string.

pub mod framing;
pub mod registry;
pub mod server;
