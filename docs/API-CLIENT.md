# FigyMan — the API client

**Status: phases 0 to 5 built** — requests go out from Rust, collections and
history are kept in SQLite, collections import and export losslessly, variables
and auth resolve, and syncing to Postgres — hosted or direct — is written but
**has never run against a real server**. This document is the design and the
argument behind it;
[`API-CLIENT-TASKS.md`](./API-CLIENT-TASKS.md) is the checklist, and says how
far along each phase is.

An in-app REST client, the way `BrowserModal` is an in-app browser and
`EditorModal` an in-app editor. You keep collections of requests, fire them,
read the response, and — the part that decides whether anyone moves to it —
**your existing collections come in and go back out unharmed**, in the same
interchange format the rest of the industry already writes.

Storage is local first and a Postgres mirror second: everything works with the
network unplugged, and what changed while it was unplugged is pushed the moment
it comes back.

Related: [`CODE-EDITOR.md`](./CODE-EDITOR.md) for the modal, tab and
persistence conventions this follows; [`DRAWING.md`](./DRAWING.md) for the
local-storage precedent it deliberately departs from;
[`WINDOWS-SUPPORT.md`](./WINDOWS-SUPPORT.md) and
[`LINUX-SUPPORT.md`](./LINUX-SUPPORT.md) for the per-platform assumptions
anything touching the filesystem, a keychain or a socket has to respect.

Scope for v1 is **REST over HTTP/HTTPS only**. See [Non-goals](#non-goals).

---

## Decisions

Settled before any code, because each one closes off a direction the rest of
this document would otherwise keep re-opening.

| Question | Decision |
|---|---|
| Where requests execute | **Rust, never the webview.** `fetch` cannot set `Host`, `Origin`, `Referer`, `Connection` or `Content-Length`; it cannot see a redirect chain, a TLS handshake or a DNS lookup; and CORS would fail most real calls. See [Why Rust sends](#why-rust-sends). |
| Local source of truth | **SQLite in Rust** (`rusqlite`, bundled), not IndexedDB. The sync engine and the Postgres mirror want the *same relational shape*; a tree of thousands of requests with a change log is not the one-blob-per-project that `drawing-db.ts` stores. |
| Who owns state | **Rust owns the data, the webview owns the view.** Zustand holds what is on screen and nothing that must survive a crash. |
| Remote store | **Postgres over the wire** (`tokio-postgres` + `rustls`) — any server this machine can reach, managed or self-hosted. A second mode existed, a hosted project over its REST layer, and was removed: a REST layer is something one vendor puts in front of a database, and building against it meant building against that vendor. |
| Sync model | **Last writer wins per row**, with a server-assigned `updated_at`, a `rev` counter, tombstones and a durable outbox. Not a CRDT — see [Sync](#sync). |
| Conflicts | **Never silently dropped.** The loser is kept as a conflicted copy next to the winner. |
| Interchange format | **Collection Format v2.1.0** in and out, v2.0.0 in. Import is lossless: the original document is kept beside the normalised model so export round-trips. |
| Scripts | **Imported and preserved from day one, executed from phase 6.** Losing people's scripts on import was unacceptable before there was anything to run them. |
| Script sandbox | **A locked-down Web Worker, one per job**, not an embedded JS engine in Rust. The response and the variables are already in the webview, so a Rust engine would marshal them both ways for code whose whole job is reading and writing them; the dangerous globals are removable; and `terminate()` kills a runaway loop from outside. See [Scripts](#scripts). |
| Unresolved variables | **They stop the send.** An empty `Authorization` header is a 401 that looks like a server fault; the strip names what is missing and offers to send anyway. |
| Multipart bodies | **Built in Rust, rebuilt per redirect hop.** A form is consumed when the request is built, so a second hop would otherwise send nothing at all. |
| The outbox | **Written by SQLite triggers**, not by the writers. A trigger fires in the same transaction by definition; a writer that forgot to enqueue would produce a row that never syncs and never says why. |
| That seam | **An enum, not a trait.** Two implementations, ever, so an enum gives the same seam without `async_trait` or a box per call. |
| Direct TLS | **The platform's, through `native-tls`** — already in the build for `reqwest`. Its knobs *are* the five `sslmode` settings; the rustls route wanted a hand-written certificate verifier and a second crypto stack. |
| Rows on the wire | **Postgres does the JSON**: `to_jsonb` out, `jsonb_populate_recordset` in. One codec serves both modes, rather than a second one that decodes by type OID and has to agree with the first. |
| Secrets | **Never leave the machine.** A variable marked secret syncs as a name with an empty value. The project's own credentials live in the OS keychain, with no fallback to a file. *Half done*: a secret variable's value is still in SQLite rather than the keychain — see the tasks file. |
| UI shape | **A modal**, like every other big surface here, lazily loaded on first open so it costs nothing at launch. |
| Shortcut | `⌘⇧H` / `Ctrl+Shift+H` — H for HTTP. Every letter with a better claim (`A`, `P`, `R`) is taken. |

Three things the plan got wrong, corrected in the build:

- **Timing is three numbers, not six.** The plan promised a DNS / TCP / TLS /
  TTFB / download breakdown "via connection hooks". `reqwest` has no such hook:
  getting those means a custom connector and a custom resolver, which is a
  project of its own and belongs in phase 7 if it is worth anything at all.
  What is measured is measured honestly — time to the response head, time
  downloading, total — and the Timing tab says outright which numbers are
  missing and why. A fabricated breakdown would be worse than none.
- **Redirects are followed by hand.** `reqwest` will follow them, but it will
  not say what it followed. `Policy::none` plus a loop is what makes the hop
  list, the per-hop status and "don't follow" real, and it is also where
  credentials get stripped on a cross-origin hop.
- **The outbox writes itself.** The plan had every mutation enqueue alongside
  its write. Thirty functions already existed by the time sync arrived, and the
  one that forgot would have produced a row that never syncs and never says
  why. SQLite triggers fire inside the same transaction by definition, which is
  the guarantee the plan actually wanted, and they cost no changes at all.

---

## Why Rust sends

This is the decision everything else leans on, so the case is worth writing out.

A request typed into an API client is not a browser request. It routinely needs
things the fetch specification exists to *forbid* a page from doing:

- **Forbidden headers.** `Host`, `Origin`, `Referer`, `Cookie`, `Connection`,
  `Content-Length`, `User-Agent` — all silently dropped or overwritten by the
  webview. Half of debugging a gateway is setting `Host` by hand.
- **CORS.** A preflight the server never intended to answer turns "your API is
  broken" into "our client is broken". There is no opt-out from inside a page.
- **The redirect chain.** You need to see each hop, its status and its
  `Set-Cookie`, and to choose not to follow. `fetch` gives you the destination
  and hides the road.
- **Timing.** Time to the response head, separately from time spent
  downloading it — "how slow is this endpoint" and "how big is the answer" are
  different questions and `fetch` answers neither.
- **TLS and proxies per request**: self-signed certs, a CA bundle, client
  certificates, `HTTP(S)_PROXY`, disabling verification for a staging box.
- **Bodies that do not fit in memory.** A 400 MB response streams to a temp
  file and the viewer pages it; the webview would hold it as one string.
- **The cookie jar is ours**, not the webview's, so an auth cookie from an API
  call cannot leak into the embedded browser or vice versa.

`reqwest` is already a dependency (the updater uses it). The work is a
`src-tauri/src/http/` module, two commands and one event — not a new stack.

**The one thing the webview keeps** is rendering: pretty-printing JSON,
highlighting, and previewing HTML in a sandboxed `srcdoc` iframe with scripts
disabled.

---

## The shape of it

Built so far is marked `✓`; the rest is where it will go.

```
┌──────────────────────────────── webview ─────────────────────────────────┐
│  ApiModal                                                             ✓  │
│   ├─ ApiRail        tree · history · environments · search · drag     ✓  │
│   ├─ RequestTabs    open requests, dirty marks                        ✓  │
│   ├─ RequestPane    method · URL · headers · body · auth ·            ✓  │
│   │                 settings · code · params · scripts                   │
│   ├─ BodyPanel      raw · form · multipart · file · GraphQL           ✓  │
│   ├─ VariableStrip  what this request uses, and what it means         ✓  │
│   ├─ EnvironmentEditor  variables, edited in place                    ✓  │
│   ├─ ImportReport   what came in, and what was only preserved         ✓  │
│   ├─ ResponsePane   body (pretty/raw) · headers · request sent ·      ✓  │
│   │                 timing · redirects · preview · cookies               │
│   ├─ HeaderTable    the key/value spreadsheet                         ✓  │
│   └─ ConnectionModal   remote setup: hosted or direct Postgres           │
│                                                                          │
│  services/api/                                                           │
│    client.ts        invoke wrapper: send, cancel, progress events     ✓  │
│    request.ts       editor state → what goes on the wire               ✓  │
│    rank.ts          fractional indexes: where a row sits              ✓  │
│    tree.ts          the rail's rows, and search that reveals          ✓  │
│    store.ts         one function per store command                    ✓  │
│    url.ts           what a half-typed URL means; parse ⇄ serialise     ✓  │
│    format.ts        sizes, durations, content types, pretty-printing   ✓  │
│    template.ts      {{var}} resolution across the scope chain         ✓  │
│    scopes.ts        the chain: variables and auth, innermost first    ✓  │
│    auth.ts          apply an auth block to a prepared request         ✓  │
│    codegen.ts       curl · fetch · axios · requests · Go · PHP        ✓  │
│    interchange/                                                          │
│      import.ts      v2.1.0 / v2.0.0 · environments · backups          ✓  │
│      export.ts      v2.1.0, byte-stable, unknown keys preserved       ✓  │
│      schema.ts      the format's constants and type definitions       ✓  │
│      upgrade.ts     v2.0.0 → v2.1.0, in one place                     ✓  │
│      environment.ts  environments and globals, in and out             ✓  │
│      curl.ts        a pasted command becomes a request                ✓  │
└───────────────────────────────┬──────────────▲───────────────────────────┘
                     invoke     │              │   events
                api_send() …    │              │   api://progress, api://sync
┌───────────────────────────────▼──────────────┴───────────────────────────┐
│  commands/api.rs    api_send · api_cancel · 24 store commands         ✓  │
│    ├─ http/         client pool · manual redirects · cancellation ·   ✓  │
│    │                  truncation · error classification · bodies         │
│    │                cookie jar · proxy · client certs · streaming        │
│    ├─ store/        SQLite: schema, migrations, queries, outbox       ✓  │
│    ├─ sync/         worker · pull/push · merge · conflict copies      ✓  │
│    │                 remote.rs (enum) → hosted.rs · direct.rs        ✓  │
│    │                 rows.rs · schema.rs (the Postgres setup SQL)     ✓  │
│    └─ secrets/      OS keychain: the project's credentials            ✓  │
└──────────────────────────────────────────────────────────────────────────┘
```

Rust never interprets the interchange format, and TypeScript never talks to
Postgres. Import/export is pure TypeScript over JSON — which makes it testable
with `npm test` against fixture collections, and that is most of the risk in
this project.

---

## Data model

One shape, used by SQLite and by Postgres, so sync is a row copy and not a
translation.

```
workspaces     id · name · created_at
collections    id · workspace_id · name · description · auth · variables
                  · events · raw (the original document, for round-trip)
items          id · collection_id · parent_id · kind(folder|request)
                  · name · rank · auth · events
requests       item_id · method · url · headers · query · path_vars
                  · body_mode · body · settings
examples       id · item_id · name · status · headers · body   (saved responses)
environments   id · workspace_id · name · is_global
variables      id · scope_id · scope(global|env|collection|folder|request)
                  · key · value · type(default|secret) · enabled
history        id · workspace_id · item_id? · sent_at · request · response_meta
                  · body_path                              (local only by default)
```

Every synced table also carries: `updated_at` (server clock on push),
`deleted_at` (tombstone — rows are never hard-deleted while sync is on), `rev`
(monotonic per row), `device_id` (who wrote it last).

Three details that are easy to get wrong and expensive to change later:

- **`rank` is a fractional index**, a sortable string, not an integer position.
  Two machines each dragging a request into the same folder while offline must
  not have to renumber every sibling — with integers they produce two
  irreconcilable renumberings of the whole folder, with fractional ranks they
  produce two neighbouring keys and both survive.
- **`raw` on the collection** is the document exactly as imported. Anything the
  normalised model does not understand is re-emitted from here on export, so a
  round-trip through us is not a data-loss event for whoever sent it.
- **History is local by default.** It is the one table that grows without
  bound, it holds response bodies (tokens, personal data), and nobody wants
  their laptop's traffic log in a shared database. Syncing it is an explicit,
  per-workspace opt-in with a retention cap.

---

## Interchange: import and export

The point of the feature. It has to be boring and exact.

**In:** Collection Format **v2.1.0** and **v2.0.0** (upgraded on read),
environment and globals exports, a directory or archive of several of them, and
pasted cURL text. Later: OpenAPI 3 and HAR.

**Out:** **v2.1.0** only. One version emitted well beats three emitted
approximately.

### Mapping

| Their document | Ours |
|---|---|
| `info` (name, description, schema URL, vendor-prefixed id) | `collections` row; the schema URL is re-emitted from a constant, the vendor id preserved verbatim |
| `item[]`, recursive | `items` tree; an entry with `item[]` is a folder, one with `request` is a request |
| `request.url` — string *or* `{raw, protocol, host[], path[], query[], variable[], hash}` | parsed into `url` + `query` + `path_vars`; re-emitted in the object form with `raw` regenerated |
| `request.header[]` with `disabled` | `headers`, disabled rows kept, not dropped |
| `request.body.mode` — `raw`/`urlencoded`/`formdata`/`file`/`graphql` | `body_mode` + `body`; `raw.options.language` kept for the editor |
| `request.auth` | `auth` on the item, collection or folder; inheritance resolved at send time, never at import |
| `event[]` (`prerequest`, `test`) with `script.exec[]` | `events`, stored as written and run in the worker sandbox; a listener this app does not know is kept and written back untouched |
| `variable[]` | `variables` at the matching scope |
| `response[]` | `examples` |
| `protocolProfileBehavior` | `settings` (redirect following, body pruning, TLS, encoding) |
| unknown / vendor-prefixed keys anywhere | untouched in `raw`, merged back on export |

### The gotchas, written down before they cost a day each

- **`url.raw` and the parsed parts disagree** in real files. `raw` wins on
  import; everything else is regenerated from it.
- **`{{var}}` appears anywhere** — in the host, in a header name, inside a
  formdata filename. The URL parser must tolerate a template where a port or
  a scheme belongs and not "fix" it.
- **Disabled is not absent.** Disabled params and headers are part of the
  document and must survive a round-trip.
- **`formdata` file paths are absolute to someone else's machine.** Import
  them, show them as missing, never silently send an empty part.
- **Missing auth is not "no auth".** An absent `auth` inherits from the parent;
  an explicit no-auth block stops inheritance. Conflating them breaks every
  request in a folder.
- **v2.0.0 differences** (body shape, `event` naming, `_` keys) are handled in
  one upgrade function with fixtures, not scattered through the reader.
- **Export must be stable.** The same collection exported twice is byte
  identical: sorted keys where the format does not care, preserved order where
  it does. Otherwise every export is a noisy diff in someone's git repo.

Every row of both tables above gets a fixture test. Import a real collection,
export it, import the export, compare the models — that loop is the test that
matters and it runs under `npm test` with no browser.

---

## Variables, auth and sending

Resolution order, innermost first: **request → folder → collection →
environment → global**, plus dynamic values (`$guid`, `$timestamp`,
`$randomInt`, …) resolved per send. Unresolved templates are an error shown in
the URL bar before the request goes out, never an empty string on the wire.

Auth in v1: none, basic, bearer, API key (header or query), and inheritance.
Digest, OAuth 2 flows, OAuth 1, AWS SigV4, NTLM and Hawk are imported and
preserved from the start, and implemented in a later phase — with OAuth 2 first,
since it is the only one most people actually need.

Sending is: resolve templates → apply auth → build the `reqwest` request →
stream the response → record timing → write history → return a handle. Cancel
is a command; a dropped modal cancels everything in flight.

---

## Scripts

A collection can hang a script off any level of the tree, and they all run —
outermost first, so an inner one can see and override what the outer ones did.
That is the same rule as variables and as auth, which is not a coincidence:
three inheritance rules that disagree is three rules nobody can hold in their
head.

**The sandbox is a Web Worker, one per job.** Before a line of script runs, the
worker pins `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, the caches
and the storage APIs to `undefined`, non-configurably, down the prototype chain;
a worker has no DOM and no Tauri `invoke` to begin with. `postMessage` is
captured into a local before the lock-down, so the worker can still answer after
it has taken its own network away. A 5 second wall clock is enforced by
`terminate()` from outside — the only kind of timeout a `while (true)` cannot
argue with.

A worker per job rather than a pooled one: a reused worker carries the last
script's globals into the next, which turns "it passes in the run but not on its
own" into a real class of bug. Spawning costs under a millisecond.

**What this is and is not.** It is a boundary against a careless script, not a
hostile one — a script in a collection somebody imported still runs with
whatever the worker has left. That is the same trust model as the format's own
tool, and it is why the forbidden list is a list in one file rather than
scattered through the setup: raising the boundary later means editing one array,
not auditing a sandbox.

**One send path.** `services/api/execute.ts` is pre-request scripts → resolve →
auth → send → test scripts, and both the window's Send button and the collection
runner call it. A runner with a send path of its own would drift from the one
people press Send on, and the difference would surface as "it passes in the
runner but not in the window".

---

## Sync

**Local is always authoritative for writes.** Every mutation writes the row and
an `outbox` entry in the *same* SQLite transaction. The UI never waits on the
network, and there is no state in which a save appeared to work and did not.

A sync pass is:

1. **Push.** Drain the outbox oldest first. Each entry carries the row and the
   `rev` it was based on.
2. **Pull.** Ask for everything with `updated_at` greater than our last
   watermark, per table.
3. **Merge.** For each incoming row: unknown → insert; ours unchanged since the
   last sync → overwrite; ours changed too → **conflict**.
4. **Conflict.** Remote wins the identity; our version is re-inserted as a new
   row named `<name> (conflicted copy, <device>, <time>)` next to it, and the
   rail badges it. Nothing is lost and nobody has to answer a dialog mid-typing.
5. **Watermark** advances only after the whole pass commits.

Deletes are tombstones, so a delete on one machine does not get resurrected by
another machine's stale copy. Tombstones are reaped after 90 days.

Triggers: on connect, on window focus, after a mutation settles (debounced),
and on an interval. All of it is off until a remote is configured; with no
remote, FigyMan is a local app with no networking of its own at all.

**Why not a CRDT.** The editing pattern is one person, a few machines, rarely
simultaneous. The genuinely concurrent edit here is *reordering a tree*, which
fractional ranks already handle. Everything else is a document a human owns.
A CRDT would buy per-field merges of a body nobody is co-editing, and cost a
library, a new storage shape and a much harder debugging story.

---

## The Postgres connection modal

One modal, two modes, and it has to be complete enough that nobody edits a
config file afterwards.

**Hosted mode** (the default): project URL, publishable key, sign-in (email +
password or magic link), schema name (default `figyman`), and the migration
step. The keys go to the OS keychain, never to SQLite and never to a settings
file. Row-level security means the server enforces who sees what — this is the
mode that is safe to hand to a team.

**Direct mode** (self-hosted): host, port, database, user, password, SSL mode
(`disable` / `prefer` / `require` / `verify-ca` / `verify-full`), CA
certificate, client certificate and key, connect timeout, statement timeout,
schema, `application_name`, pool size. SSH tunnelling is noted as a later
addition, not smuggled into v1.

Both modes share:

- **Test connection** — reports server version, round-trip latency, whether the
  schema exists, and whether our migrations are applied. It runs before Save
  and Save is disabled until it passes.
- **Migrations** — versioned SQL we own, applied on connect in direct mode. In
  hosted mode the key usually cannot create tables, so we generate the SQL and
  offer copy-to-clipboard alongside a "run it for me" path when the credentials
  allow.
- **Sync settings** — what syncs (collections and environments on; history
  off), interval, sync-on-focus, and secret handling.
- **Status** — last successful sync, pending outbox count, conflicts, and a
  plain-language reason when it is failing. A sync feature that fails quietly
  is worse than one that does not exist.

---

## UI

Three columns inside the modal, following the editor's conventions (draggable,
resizable, picture-in-picture, z-order through `overlay-stack.ts`):

- **Rail** — collections tree with drag-to-reorder, environments, history,
  search. Badges for unsynced and conflicted rows.
- **Request** — method, URL bar with inline template highlighting, and tabs:
  Params, Headers, Body, Auth, Scripts, Settings. Send, and a split "Send and
  save as example".
- **Response** — status, time, size on one line; body in pretty / raw /
  preview; headers; cookies; timing breakdown; and the request as it actually
  went out, which is the tab people live in when something is wrong.

Open request tabs, the active environment and column widths persist per
workspace, exactly as the editor persists its tabs.

---

## Phases

Each phase is shippable and leaves the app in a coherent state.

| Phase | What lands |
|---|---|
| **0 · Send something** ✓ | Rust HTTP module, `api_send`/`api_cancel`, the modal, one request, a response. No persistence. |
| **1 · Keep it** ✓ | SQLite store, migrations, collections tree, tabs, history, search. |
| **2 · Interoperate** ✓ | v2.1.0 import and export, v2.0.0 import, environment import, cURL paste, code generation. Fixture suite. |
| **3 · Make it real** ✓ | Variables and scope chain, environments, auth (none/basic/bearer/API key) with inheritance, dynamic variables. |
| **4 · Remote** ✓ | Schema and migrations, hosted mode, the connection modal, outbox worker, conflict copies, status UI. |
| **5 · Direct Postgres** ✓ | `tokio-postgres` + `rustls`, SSL modes, certificates, pooling. |
| **6 · Scripts** ✓ | Sandboxed pre-request and test scripts, assertions, the collection runner with iterations and CSV/JSON data files. |
| **7 · The long tail** | OAuth 2, cookie jar UI, proxies, client certs, large-body streaming, OpenAPI and HAR import, response diffing. |

The order is deliberate: **interoperability before features.** A client that
imports your collections perfectly and only supports bearer auth is useful on
day one; one with every auth type and a lossy importer is not.

---

## Non-goals

For v1, and worth saying out loud so they do not creep in: WebSocket, gRPC,
GraphQL subscriptions and socket.io; mock servers; uptime monitors; published
API documentation; real-time multi-person editing of the same request; and a
CLI runner. The sync design does not preclude any of them.

---

## Risks

- **Import fidelity is the whole product.** Mitigated by fixture-driven
  round-trip tests from the first line of the reader, using real exported
  collections rather than hand-written samples.
- **SQLite is a new Rust dependency** and the first thing in this app that
  persists from Rust. Bundled `rusqlite` adds roughly 1.5 MB to a ~10 MB
  binary. If that is judged too much, the fallback is IndexedDB with the same
  schema and a worse sync story — decide now, not in phase 4.
- **Sync bugs lose work.** Mitigated by tombstones, conflict copies, an
  append-only outbox, and a pre-sync local snapshot that can be restored.
- **Secrets.** Keychain-only for secret variables, and the export path must ask
  before writing them into a file that people mail around.
- **Scope.** This is the largest feature in the app. The phase boundaries are
  the defence; each one ships or is abandoned on its own.

---

## Testing

Pure modules get `*.test.ts` files next to them and run under `npm test` — the
esbuild + Node runner, no framework, no DOM: import/export round-trips, the URL
parser, template resolution, the scope chain, fractional ranks, and the sync
merge decision table (which is a pure function of two rows and a watermark, and
should be kept that way precisely so it can be tested like this).

Rust side: unit tests for timing capture, redirect recording and the outbox
transaction; migrations tested against a temp database.

The app is not built or run as part of verification — `npm test` and `tsc`
are the gates here.
