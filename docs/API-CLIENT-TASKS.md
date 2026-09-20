# FigyMan — Plan and Task List

The working checklist for building the API client. The *argument* — why
requests are sent from Rust, why the local store is SQLite, why sync is last
writer wins — lives in [`API-CLIENT.md`](./API-CLIENT.md) and is not repeated
here. This document is what gets built, in what order, and how far along it is.

Status: `[x]` done · `[~]` done but unproven · `[ ]` todo

**Phases 0 to 6 are built**, with one caveat that matters: nothing in phases 4
or 5 has been run against a real server. Everything from phase 7 on is open.

---

## Phase 0 — Send something

The smallest thing that proves the architecture: a request leaves the machine
from Rust and its response is readable in the modal. No persistence.

- [x] `src-tauri/src/http/mod.rs` — a shared `reqwest::Client` pool, keyed by
      the TLS options that force a distinct client; the in-flight registry
      that makes cancellation possible
- [x] `http/send.rs` — build, send, follow redirects by hand, read the body in
      chunks, cancel at any point, truncate rather than exhaust memory
- [x] Timing: wait, download, total. **Not** DNS/connect/TLS — see the
      correction in [`API-CLIENT.md`](./API-CLIENT.md#decisions)
- [x] Errors classified (`timeout`, `tls`, `connect`, `body`, `cancelled`, …)
      rather than stringified, so the UI can offer the remedy
- [x] Credentials stripped on a cross-origin redirect
- [x] `commands/api.rs` — `api_send`, `api_cancel`; `api://progress` events
- [x] `src/types/api.ts` — the wire types shared with Rust
- [x] `src/services/api/client.ts` — the invoke wrapper
- [x] `src/services/api/request.ts` — editor state → what goes on the wire
- [x] `src/services/api/url.ts` — what a half-typed URL means
- [x] `src/services/api/format.ts` — sizes, durations, content kinds, pretty
- [x] 26 tests across the three pure modules, under `npm test`
- [x] `src/components/Api/ApiModal.tsx` — modal frame, `useDraggableModal`,
      `overlay-stack` claim, lazy-loaded on first open, latched mounted
- [x] `RequestPane` + `HeaderTable` — method, URL, headers, raw body
- [x] `ResponsePane` — status, time, size, body (pretty/raw), headers, the
      request as sent, timing and the redirect chain
- [x] Shortcut `⌘⇧H` / `Ctrl+Shift+H`, command palette entry, menu entry
- [x] Cancel in flight; a second Send cancels the first
- [~] TLS failure offers "send again without verifying", for this send only —
      written, not yet tried against a real bad certificate

## Phase 1 — Keep it

**Built.** SQLite via `rusqlite` (bundled), in the app data directory, opened
lazily on first use so a terminal that never opens the window pays nothing.

- [x] `store/schema.rs` — versioned through `PRAGMA user_version`, applied on
      open, append-only; WAL, foreign keys on, `synchronous = NORMAL`
- [x] Tables: `workspaces`, `collections`, `items`, `requests`, `history`,
      `meta`. **Not** `examples`, `environments`, `variables` or `outbox` — they
      arrive with the phases that read them. A schema full of tables nothing
      touches lies about what the app does, and adding one later is three lines
- [x] Sync columns on every synced table from the start: `updated_at`,
      `deleted_at`, `rev`, `device_id`
- [x] Deletes are tombstones; a folder's subtree and its requests go in one
      transaction
- [x] `store/queries.rs` + 17 store commands in `commands/api.rs`
- [x] `services/api/rank.ts` — fractional indexes, with tests that subdivide
      one gap two hundred times
- [x] `services/api/tree.ts` — the rail's rows, and search that reveals
      ancestors rather than filtering them away; tested
- [x] `stores/apiStore.ts` — tree, tabs, drafts, sending, history
- [x] `ApiRail` — tree, drag to reorder and reparent (three drop zones per
      row), inline rename, duplicate, delete with a confirmation for anything
      that takes children with it
- [x] Request tabs with a dirty dot, restored from the session on open
- [x] Drafts written to the session (debounced), so nothing is lost; saving
      into a collection stays explicit, exactly as the code editor behaves
- [x] History list, response bodies spilled to files under app data, capped at
      500 entries per workspace and pruned with their files
- [x] Clicking a history entry reopens the request *and* its response
- [x] Rail search across names, URLs and methods
- [x] The rail draws a method chip: `items` carries `method` and `url` from a
      join, so there is no query per row
- [x] 13 Rust tests over the store, 24 more TypeScript ones over ranks and the
      tree

## Phase 2 — Interoperate

**Built.** The phase the feature exists for. Reading and writing the format is
pure TypeScript over JSON, so it is all tested under Node; Rust does the two
things TypeScript cannot — a whole tree in one transaction, and a file at a path
the native dialog just returned.

- [x] `interchange/schema.ts` — the format's constants, shapes and detection.
      (Named `interchange/`, not `format/`: `format.ts` is already the response
      formatter, and two things called format is one too many)
- [x] `interchange/import.ts` — the reader: collections, environments, and
      whole-account backups holding several of each
- [x] `interchange/upgrade.ts` — v2.0.0 → v2.1.0, isolated and tested. The
      substantive difference is auth parameters: an object there, a list here
- [x] `interchange/export.ts` — the writer, byte-stable, unknown keys merged
      back from each row's stored original
- [x] `interchange/environment.ts` — environments and globals, in and out
- [x] `interchange/curl.ts` — a pasted cURL command becomes the request, with a
      shell-accurate tokenizer
- [x] `interchange/codegen.ts` — cURL, fetch, axios, Python requests, Go, PHP
- [x] `services/api/url.ts` — full parse ⇄ serialise, template-tolerant: a URL
      in a collection is rarely a URL, it is `{{base_url}}/users/{{id}}`
- [x] Migration 2: `items.raw`, plus `environments` and `variables` — an import
      that silently dropped somebody's environment file would do it at the
      worst possible moment
- [x] `api_import_collection` — the whole tree in one transaction, all or
      nothing, because a partial import looks exactly like a complete one
- [x] `api_export_collection` — every row with the document it came from
- [x] File reading and writing for dialog-chosen paths, deliberately *not*
      through `fs_read_text`, which is scoped to the editor's workspace roots
- [x] Import from files, or from a folder of them (right-click the button)
- [x] Export a collection or an environment from the rail
- [x] The Code tab in the request pane, with a copy button
- [x] cURL pasted into the URL bar becomes the whole request
- [x] Import report: what came in, and what was preserved but not understood
- [x] 41 tests, including the one that matters — import, export, and a deep
      comparison against the document that went in

**Bodies.** What converts exactly, converts: a urlencoded body *is* a raw body
with a particular content type, and a GraphQL body *is* the JSON one that goes
on the wire. What does not — multipart, and file bodies — is imported without a
body, preserved whole for export, and named in the import report. A request that
silently sends nothing is the one outcome worth ruling out.

- [~] **Fixtures are hand-built against the published schema, not captured from
      a real export.** They cover the parts most likely to be dropped — a
      vendor-prefixed id, a disabled header, a disabled query parameter, a path
      variable with a description, pre-request and test scripts, an auth block,
      a saved example response, a multipart body and a
      `protocolProfileBehavior` block. Running this against a genuine export
      from another tool is the one check still outstanding, and it needs a file
      only you can provide.

## Phase 3 — Make it real

**Built.** Variables resolve, auth is inherited, every body mode sends, and a
response can be kept.

- [x] `services/api/template.ts` — `{{var}}` across the chain, with tests. A
      value may itself contain variables; a cycle stops rather than hanging
- [x] Dynamic values: `$guid`, `$randomUUID`, `$timestamp`, `$isoTimestamp`,
      `$epoch`, `$randomInt`, `$randomAlphaNumeric`. Injected, so the
      substitution is testable without the clock
- [x] `services/api/scopes.ts` — the chain: request → folders → collection →
      environment → globals, for variables *and* for auth, with tests
- [x] Migration 3 adds `items.variables`, so a folder's own variables are a
      column rather than something to re-parse out of the stored document
- [x] Environment selector in the title bar; an editor panel with the same
      spreadsheet the headers use; environments listed and switchable in the rail
- [x] **Unresolved variables stop the send.** The strip under the URL bar names
      them, offers to open the environment, and offers to send anyway for the
      rare case where the braces are meant literally
- [x] The same strip is the hover peek: every variable the request uses, its
      value and which scope it came from
- [x] `services/api/auth.ts` — none, basic, bearer, API key (header or query),
      with tests, including that auth replaces an `Authorization` header rather
      than adding a second
- [x] Inheritance: an absent block inherits, an explicit `noauth` stops. The
      Auth tab says what it *would* inherit and from where
- [x] A type this cannot apply (OAuth, digest, SigV4) is kept, exported and
      named in the response pane rather than silently sending nothing
- [x] Auth values are resolved like everything else, so a token lives in an
      environment rather than in fifty requests
- [x] Body modes: raw, form, multipart (with file pickers), file, GraphQL —
      built in Rust at send time, and rebuilt per redirect hop, because a
      multipart form cannot be cloned once it is a request
- [x] **The interchange is now faithful for bodies**: a form stays a form and a
      multipart upload keeps its parts and their paths, rather than being
      converted to raw text as phase 2 did. cURL's `-F` imports as multipart,
      and code generation covers every mode in all six languages
- [x] Per-request settings — redirects, TLS verification, timeout, maximum
      redirects — stored as absent when they match the default, so a request is
      not pinned to today's defaults for ever
- [x] Migration 4 adds `examples`; a response can be kept against its request,
      renamed, deleted and viewed, and examples import and export with the
      collection
- [x] 68 more tests: 29 TypeScript over templates and auth, 11 over the chain,
      and the rest across bodies, examples and the store

**Not done in this phase**, and worth naming:

- [ ] Folder and request variables are read and resolved, but only a
      collection's and an environment's can be *edited* — the rest are edited
      where they came from, which for now means the document
- [ ] A secret variable keeps its mark through import and export, but the
      editor does not offer the tick. It matters when sync lands, not before

## Phase 4 — Remote

**Built, and unproven.** Every part that can be checked without a server is
tested — the decision table, the row codec, the outbox, the request
construction, the generated schema. The live path has never run. That is the
headline, and it is why the last item below is the one that matters.

- [x] Migration 5: the `outbox`, and `conflicted_at` on the rows that can hold
      a conflicted copy
- [x] **The outbox is written by triggers**, not by the thirty functions that
      already existed. A trigger fires in the same transaction as the write by
      definition, which is exactly the guarantee the design asked for, and the
      one that a writer which forgot to enqueue would silently break
- [x] `outbox_suspended`, so applying a pull does not queue every row that
      arrived straight back for pushing
- [x] `sync/merge.rs` — the whole conflict policy in one function, tested
      exhaustively, including that a deletion never becomes a conflicted copy
- [x] `sync/rows.rs` — one generic codec driven by a table description, rather
      than seven readers and seven writers that must agree
- [x] `sync/hosted.rs` — the REST layer, with URL and header construction split
      out so it can be tested without a server
- [x] `sync/schema.rs` — the Postgres setup SQL, generated for a schema name,
      with the server-side `updated_at` trigger that makes last-writer-wins
      mean anything, and optional row-level security
- [x] `sync/worker.rs` — push, pull, apply, watermark; one pass at a time
- [x] `secrets/` — the OS keychain, with **no fallback to a file**
- [x] Conflict copies, marked with a column and badged in the rail
- [x] A request that conflicts is kept under an item of its own, so the local
      body is still reachable
- [x] `ConnectionPanel` — URL, schema, key, optional sign-in, test-before-save,
      the setup SQL with a copy button, the interval, and the status
- [x] Pre-sync snapshot (`VACUUM INTO`), and a button to go back to it
- [x] A pass runs on an interval in Rust, on window focus, and on demand —
      whether or not the API window is open
- [x] 24 more Rust tests across the merge, the codec, the outbox triggers, the
      generated schema and the request construction

**Deviations from the plan, and why:**

- **The remote is an enum, not a trait.** The set of implementations is closed —
  hosted and, next phase, direct — so an enum is the same seam without
  `async_trait` or a box per call.
- **The merge table is not mirrored in TypeScript.** The plan asked for it; a
  second copy of the rule with nothing calling it would be a second thing to
  get wrong. The decision is made in Rust, where the database is.
- **Secrets are half done.** A variable marked secret is never pushed — the row
  travels with an empty value — which is the half that matters for sync. The
  other half, keeping its value in the keychain rather than in SQLite, is not
  done; the keychain holds the project's credentials only.

- [~] **Nothing has talked to a real project.** The request construction is
      tested, the merge is tested, the schema SQL is tested — and the first
      time this sends a row to Postgres will be the first time anyone finds out
      whether the REST dialect, the upsert header, the schema profile and the
      server-side timestamp all behave as written. Point it at a scratch
      project before a real one, and the "restore the copy from before syncing"
      button is there for the same reason.
- [ ] Token refresh on a 401. A sign-in is stored and used; an access token
      that expires mid-pass currently fails the pass rather than refreshing and
      retrying.
- [ ] `sync_history` is stored and honoured as "off", but there is no switch
      for it yet — history is simply never pushed.

## Phase 5 — Direct Postgres

**Built, and unproven**, like the phase before it. Every statement it builds is
tested as a string; no connection has been made.

- [x] `sync/direct.rs` — Postgres over the wire, behind the same seam as the
      hosted mode
- [x] Connection fields: host, port, database, user, password, schema,
      `application_name`, connect timeout, statement timeout
- [x] All five `sslmode` settings, spelled as a connection string spells them:
      `disable`, `prefer` (with a real fallback to plaintext), `require`,
      `verify-ca`, `verify-full`
- [x] A CA bundle, and a client certificate as either a PKCS#12 bundle or a PEM
      pair — the latter is refused by Windows' TLS, and the message says so
      rather than failing at the handshake
- [x] Migrations applied on connect: the setup SQL is all `IF NOT EXISTS`, and
      a direct connection can run it itself rather than asking somebody to
      paste it into a console
- [x] Test connection reports the server version, the latency, and which tables
      are missing — and does **not** create them, because a test that changed
      the database would not be a test
- [x] The connection panel gained a mode switch and the direct fields
- [x] 9 more Rust tests over the generated SQL, the ssl modes and the config

**Postgres does the JSON.** `to_jsonb(row)` out, `jsonb_populate_recordset` in,
so a row crosses in the shape the hosted mode already speaks and one codec
serves both. Reading every column by its type OID would have been a second codec
that has to agree with the first about seven tables.

**Deviations, and why:**

- **A connection per pass, not a pool.** The plan asked for a pool size. A pass
  runs every few minutes; a pool for that is machinery with no user, and it
  would have to answer for a connection that went stale between passes.
- **The TLS is the platform's, through `native-tls`**, which `reqwest` already
  pulls in — no second crypto stack and nothing new to compile on three
  platforms. The deciding point is that its knobs *are* the five `sslmode`
  settings: "encrypt but do not check the certificate" and "check the chain but
  not the hostname" are one call each, where the rustls route wanted a
  hand-written certificate verifier.

**A bug this phase found in the last one:** SQLite has no boolean type and
stores `enabled` as 0 or 1, so every row was crossing with `"enabled": 1` —
which Postgres refuses for a boolean column, in *either* mode. The codec now
converts by column kind, from the one table that both the schema generator and
the codec read.

- [~] **No connection has been made.** The SQL is tested as text, the ssl modes
      are tested for which ones build a connector, the schema generator is
      tested — and the first `SELECT to_jsonb(t)` anybody runs will be the first
      real test of any of it.
- [ ] A PKCS#12 bundle with a password needs a field of its own; only an
      unprotected one is read today.
- [ ] SSH tunnelling, which the design document named as a later addition and
      still is.

## Phase 6 — Scripts and the runner

**Built.** This one is testable offline in a way phases 4 and 5 were not: a
script is a pure function of the request, the response and the variables, and
all three can be handed to it from a test.

- [x] **Sandbox decision, made and argued below: a locked-down Web Worker.**
- [x] `scripts/worker.ts` — the sandbox: a worker per job, a `FORBIDDEN` list
      of globals pinned to `undefined` and non-configurable down the prototype
      chain, `postMessage` captured before the lock-down so the worker can
      still answer after it has taken its own network away
- [x] `scripts/assert.ts` — the assertion library the format's scripts expect,
      to the subset they actually use: `to.be`, `to.have`, `to.eql`, `to.include`,
      `.status`, `.json`, `.property`, negation
- [x] `scripts/pm.ts` — `pm.test`, `pm.expect`, `pm.response` (`.json()`,
      `.text()`, `.code`, `.headers`, `.responseTime`), `pm.request` including
      `headers.upsert`, `pm.environment` / `pm.collectionVariables` /
      `pm.globals` / `pm.variables`, `pm.iterationData`, `console`
- [x] `scripts/events.ts` — which scripts run and in what order: the
      collection's, then each folder's from the top down, then the request's
      own, and `eventsWith` to write two editors back into the format's
      `event[]` without disturbing a listener some other tool added
- [x] `scripts/run.ts` — one job, one worker, a 5 s wall clock enforced by
      `terminate()`, which is the only kind of timeout a `while (true)` cannot
      argue with
- [x] `execute.ts` — **one send path**: pre-request scripts, resolve, auth,
      send, test scripts. The window and the runner both call it
- [x] Tests tab in the response pane: assertions, console output, script errors
- [x] **Scripts tab** in the request pane — the request's own two scripts, and
      a collapsible list of what it inherits and from where
- [x] `runner/run.ts` — selection (collection or folder), iterations, delay,
      stop at the first failure, stop checked *between* requests so the button
      works within one request rather than at the end of the run
- [x] `runner/data.ts` — CSV and JSON data files, one iteration per row;
      quoting handled properly, because a column holding `{"a":1,"b":2}` has a
      comma in it and a naive split shifts every column after it
- [x] Run report, exportable as JSON
- [x] `queries::save_item_events` + `api_item_events_save`, so a script written
      here is stored on the item and exports with it
- [x] 57 tests across the assertions, the `pm` surface, the event chain, the
      data reader and the walk

**Why a worker, not an engine in Rust.** The alternative was embedding a JS
engine (Boa, QuickJS) on the Rust side. Three things decided it:

- **Scripts run against the response, and the response is already here.** A
  Rust engine would need the body, the headers and every variable scope
  marshalled in, and the changes marshalled back out — a serialisation boundary
  in the middle of the hot path, for code whose whole job is to read and write
  those values.
- **The dangerous capabilities are removable.** A worker starts with `fetch`,
  `XMLHttpRequest`, `WebSocket`, `importScripts`, caches and storage; all of
  them can be pinned to `undefined` before a line of script runs, and a worker
  has no DOM and no Tauri `invoke` to begin with. What is left is arithmetic
  over values we handed it.
- **A runaway script can be killed.** `terminate()` stops a worker mid-loop
  from outside. An embedded engine needs interrupt support and a host that
  remembers to check it — the same guarantee, with more that can be forgotten.

The honest cost: this is not a security boundary against a *hostile* script, it
is a boundary against a careless one. A script in a collection somebody imported
runs with whatever the worker still has. That is the same trust model as the
tool the format comes from, and it is why the forbidden list is a list in one
file rather than scattered through the setup.

**Deviations, and why:**

- **A worker per job, not a pooled one.** A reused worker carries the last
  script's globals into the next one, which turns "it passes when I run the
  whole collection but not on its own" into a real class of bug. Spawning is
  sub-millisecond; correctness is worth more than that here.
- **The Scripts tab is a textarea, not the code editor.** CodeMirror is behind
  the editor window's lazy import; pulling it into this window for a ten-line
  script would undo that.
- **Assertions are a subset, not chai.** Bundling chai for `to.have.status`
  would be most of a library for a handful of matchers. What is there covers
  the assertions real collections use; anything missing throws a message that
  says which matcher, rather than reading as a failed test.

- [ ] `pm.sendRequest` — a script that sends its own request needs the send
      path back from inside the sandbox, which is a message round trip that is
      not written yet.
- [ ] `pm.visualizer`, `pm.cookies`, `require` of the bundled npm modules.
- [ ] A collection's own scripts are read but not editable here — they are
      stored in the imported document and the editor is per request.

## Phase 7 — The long tail

- [ ] OAuth 2 flows (authorisation code + PKCE, client credentials, refresh)
- [ ] Digest, AWS SigV4, OAuth 1, NTLM, Hawk
- [ ] Cookie jar with a UI, isolated from the embedded browser
- [ ] Proxy settings, client certificates per host
- [ ] Large bodies streamed to disk and paged in the viewer
- [ ] The full timing breakdown — DNS, connect, TLS — which needs a connector
      and a resolver of our own. Decide first whether anyone actually wants it
- [ ] OpenAPI 3 and HAR import
- [ ] Response diffing between two history entries
- [ ] Keyboard-first flow: send, next tab, focus URL, without the mouse

---

## Decisions still open

These want an answer before the phase that depends on them starts, not during.

- [x] **SQLite or IndexedDB.** **Answered: SQLite**, bundled `rusqlite`. It is
      the first Rust-side persistence in the app.
- [ ] **Hosted or direct first.** Recommended: hosted, because it adds no
      dependency and its access control is the server's problem. Blocks phase 4.
- [ ] **Does history ever sync?** Recommended: off by default, opt-in per
      workspace, with a retention cap.
- [ ] **Does the modal dock as a pane?** The editor answered no to the same
      question. Same answer is assumed here unless argued otherwise.
- [x] **Script sandbox host.** **Answered: a locked-down Web Worker**, one per
      job, killed by `terminate()` at 5 s. The argument is in phase 6.

---

## Verification

`npm test` and `tsc` are the gates. The app is not run or built as part of
checking this work. Pure modules — import/export, URL, templates, ranks, merge
— must stay free of DOM and Tauri imports so the Node test runner can load
them, which is a constraint on how they are written, not an afterthought.
