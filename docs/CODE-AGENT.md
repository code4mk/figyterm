# Figy Code — our own coding agent

**Status: draft for argument, nothing built — except the window's design.** The
front end of phase 5 exists as a prototype you can open: ⌘⇧G, or "Open
FigyCode" in the palette. Every transcript in it is scripted from
`src/services/figycode-demo.ts`; nothing reads a file or runs a command. The
**folder is real** — chosen through the OS dialog or the terminal's own
history, remembered across restarts (`services/figycode-projects.ts`) — which
is also where the first real problem shows up: `fs_set_roots` is per window
and the editor replaces the whole list when it opens a folder, so the two
windows cannot both hold a root as things stand. Decide that before the read
tool exists. The screens the window was built from are in
[`figycode-design/`](./figycode-design).

A proposal to disagree with, in
the shape [`CLAUDE-CODE.md`](./CLAUDE-CODE.md) had before that feature existed.
Facts about Rig and OpenRouter were checked on **2026-11-22** against `rig`
0.47.0 (published 2026-11-20) and OpenRouter's caching docs; facts about
FigyTerm against this repository. Everything else is argument.

---

## The brief

1. A coding agent of our own, built from scratch — **like Claude Code**: reads,
   edits and runs things in a repository, over many turns.
2. **Two surfaces**: a **Figy Code window**, and an **agent inside the code
   editor**.
3. On [Rig](https://rig.rs), in Rust, through **OpenRouter** so the model is a
   configuration value.
4. **Token cost is a first-class requirement.**

Point 2 is the one that shapes the architecture, and it is not "the same panel
twice". Point 4 is why most of this document is about tokens.

---

## First: we are reversing a decision, deliberately

`CLAUDE-CODE.md` says, in bold, **"Embed the CLI. Do not build a chat UI."**
Its reasoning deserves quoting against ourselves:

> Reimplementing that … means owning a second front-end for a product that ships
> changes weekly, and being a version behind forever. Every feature Anthropic
> adds would land in FigyTerm as a regression.

**That argument was about hosting somebody else's product.** We do not control
Claude Code's prompt box, its permission dialogs or its release cadence, so
wrapping it is the only honest option there. For an agent we write there is no
upstream to lag behind, and the failure it protected against cannot happen.

What carries over is the size warning underneath it. A chat UI is streaming,
permission prompts, plan mode, diffs, todo lists, interrupt — **a product, not a
feature** — and we are now signing up for two of them. Keep the Claude Code
window: it will be better than ours for a long time, and it answers a different
question.

---

## Second: FigyTerm is a better starting position than a CLI

A fresh agent project spends its first month building what `src-tauri` already
has:

| Already in the repo | What the agent needs it for |
|---|---|
| `fs_read_text`, `fs_list_dir`, `fs_stat` | the read tool |
| `fs_search` (streamed, cancellable) | the grep tool |
| `fs_list_files` | the glob tool |
| `fs_set_roots` | **the sandbox** — the agent reaches only granted roots |
| `fs_write_text`, `fs_create`, `fs_rename` | write and edit |
| `execute_shell_command` | the shell tool, output captured |
| `git_status`, `git_file_diff`, `git_discard`, `git_commit` | review, revert, commit |
| `lsp_start` / `lsp_send` / `lsp_detect` | **the differentiator — see below** |
| `rusqlite` (bundled) | sessions and the token ledger |
| `keyring` | the OpenRouter key, in the OS keychain |
| `reqwest` + `tokio` with `select!` | cancellable streaming requests |
| Diff viewer, editor, markdown preview | showing what the agent did |

`fs_set_roots` earns its own line: **the sandbox already exists and is already
enforced.** An agent confined to the roots the user granted is a different risk
proposition from one running as your shell user behind no fence.

### The LSP tools are the real reason to build it here

FigyTerm hosts language servers. **No CLI coding agent does**, because warming
one per invocation is not viable. That gives us tools nobody else can offer, and
they are dramatically cheaper in tokens:

| Question | grep answers with | LSP answers with |
|---|---|---|
| "Where is `claimFront` used?" | ~200 matches, comments and strings included | **the 7 real references** |
| "What is this symbol?" | read the file to find out | **the definition, one range** |
| "Did my edit break anything?" | run the whole build | **diagnostics for the file, instantly** |

A `find_references` returning 7 ranges instead of 200 grep hits is not a 2×
saving but closer to 30×, **on the operation an agent performs most often.** And
`diagnostics` closes the agent's slowest loop — edit, build, read errors, fix —
into a few hundred tokens instead of a build log.

> If one idea here is worth building first, it is this. It is the thing we can
> do that Claude Code cannot.

---

## Two surfaces, one core

**The agent is one implementation in Rust. Both front-ends are thin clients of
it.** The loop, the tools, the context policy, the ledger and the session store
live in `src-tauri/src/agent/`; the two UIs send messages and render events. If
either front-end ever contains a turn loop, the design has failed.

```
  src/components/FigyCode/        src/components/Editor/AgentPanel.tsx
   the window                      the panel beside your code
        └───────────────┬────────────────┘
                invoke / events
                        ▼
              src-tauri/src/agent/        ← one loop, one tool registry,
                        │                   one ledger, one session store
                        ▼
                   OpenRouter
```

### They are not the same session, and that is a cost decision

It is tempting to make the editor panel "the window, docked". Don't:

> **A different system prompt is a different cache prefix.** The window's
> preamble describes a repo-wide agent; the panel's describes a file-focused
> one. Sharing a session between them would re-write the cache on every switch —
> paying 1.25× to destroy something that was saving 10×.

Two sessions, two caches, one core. They differ in almost every policy:

| | **Figy Code window** | **Editor agent panel** |
|---|---|---|
| The question it answers | "do this across the repo" | "fix *this*, here" |
| Context seed | project root, `AGENTS.md`, repo tree | the open file, the selection, its diagnostics |
| Typical length | 20–60 turns | 1–5 turns |
| Compaction | essential | **should never trigger** — if it does, see below |
| Cache | critical: 4 breakpoints, 1-hour TTL | small prefix, 5-minute TTL is fine |
| Model | the good one | may be faster and cheaper |
| Tools | the full set | read / edit / diagnostics / references — a narrow set |
| How edits land | diff review in the window | **hunks inline in the buffer** |
| Interrupt | a button | Escape, because you are typing anyway |

**The panel's whole value is that it is cheap and instant.** A twenty-turn
conversation in it is a symptom, not a success — the context it does not have is
the context it needed. So the panel should notice and say so:

```
This is getting long (12 turns, 28K context).
Open in Figy Code →     ← carries the conversation across
```

**Promotion is one-way.** Panel → window works because the window's context
policy is a superset. Window → panel does not, and should not be offered.

---

## The Figy Code window

A sixth window, in the language the Claude and Draw windows now share: a 44px
title bar in three zones, a navigator down the left, a status bar stating what
the agent can reach and what it has spent.

- **Overlay stack.** `claimFront("figy-code")`, `useOverlayZSync("figy-code", …)`
  and a rectangle for `isCovered`. It does not pick its own z-index — see
  `overlay-stack.ts` for why that stopped being allowed.
- **Navigator**: projects on the bench, conversations under each — the shape
  `ClaudeNavigator` arrived at, and for the same reason: several projects alive
  at once is the thing the feature exists for.
- **Status bar**: the folders the agent can reach, and **live cost** (see
  Lever 5). We have a UI; a CLI agent cannot show you the meter running.
- **The body is ours**, not a pty. This is the whole reversal: streamed
  assistant text, tool calls as collapsible rows, diffs rendered by the diff
  viewer we already have, permission prompts as real dialogs.

Reuse before building: `useDraggableModal`, `OverlayPortal`, the dialog classes,
`ConfirmDialog`, the diff viewer, `editor-resize-handle`.

## The editor agent panel

### Where it goes

The editor already has a side column with a mode switcher — the code's own
comment calls them *"the three things the side column can be, as one switcher …
the same kind of choice — which mode the one column is in"*. There are two
candidate homes:

| Option | Against |
|---|---|
| A fourth mode of the explorer column | You lose the file tree while talking to the agent, which is exactly when you want it |
| **The opposite column, beside the preview** | Needs that column to grow a mode switcher of its own |

**Lean: the opposite column.** It already exists (`previewWidth`, its own
divider, the side opposite `panelSide`) and it is empty unless you are on a
markdown file, so the space is free most of the time. Give it the same two-mode
switcher the explorer column has — {Preview, Agent} — and the editor ends up
with one symmetric idea: two columns, each with modes, flanking the buffer.

### What it can do that the window cannot

This is the point of having it at all. It sits inside the editor, so:

- **The selection is the context.** Highlight, `⌘K`, "make this return a
  Result" — no path, no line numbers, no explaining where you are.
- **A diagnostic is a prompt.** Click the squiggle, "fix this". The LSP already
  produced the error; the agent gets it for free, and that is the cheapest
  possible turn.
- **Edits arrive as hunks in the buffer**, accepted or rejected per hunk with
  the change-gutter marks that already exist. No separate review step.
- **It knows what you are looking at** — open tabs, cursor, recent edits. Seed
  context from that instead of making the model search for it.

### The cost shape that follows

Because the panel is short and file-scoped, its economics invert the window's:

- The prefix is small, so **cache matters less** — a 5-minute TTL is enough, and
  a provider with free automatic caching is a sensible default here.
- Latency matters more than depth. A faster, cheaper model is defensible **for
  the panel specifically**, and because it is a separate session there is no
  cache to forfeit by choosing one.
- Keep the tool set narrow. Every definition sits in the cached prefix of every
  request in that session, and the panel does not need `glob` or `shell`.

---

## Where the money goes

> **A coding agent pays for its entire conversation again on every turn.**

The API is stateless. Turn 20 re-sends turns 1–19. Output tokens cost more each,
but you generate a few hundred and re-send tens of thousands, so **input
dominates and grows quadratically.**

A 30-turn window session, context growing 5K → 60K:

```
input   ≈ 30 turns × ~32K average  ≈  975,000 tokens
output  ≈ 30 turns × ~700          ≈   21,000 tokens
```

Input is **97%** of the volume. At a Sonnet-class $3/M that is about **$2.90 a
session, of which roughly $2.80 is re-reading what the model has already seen.**

Consequences:

1. **Caching is not an optimisation, it is the business model.**
2. **Everything that enters the context is paid for every turn until the session
   ends.** A tool that dumps a 2,000-line file on turn 3 is still charging for
   it on turn 30 — about 27 more times.

---

## Lever 1 — Caching, and the discipline it demands

OpenRouter's multipliers against base input price (verified 2026-11-22):

| Provider | Cache write | Cache read | Mode |
|---|---|---|---|
| **Anthropic, 5-min TTL** | 1.25× | **0.1×** | automatic or explicit |
| **Anthropic, 1-hour TTL** | 2× | **0.1×** | automatic or explicit |
| OpenAI (GPT-5.6+) | 1.25× | 0.25×–0.5× | automatic |
| Gemini (implicit) | free | 0.25× | automatic |
| DeepSeek | 1× | **0.1×** | automatic |
| Groq | free | 0.5× | automatic |
| Grok / Moonshot | free | 0.25× | automatic |

Anthropic uses explicit breakpoints, **four maximum**; `"ttl": "1h"` doubles the
write to buy an hour — worth it in the window, not in the panel.

### The one rule

**Caching is a prefix match: any byte that changes invalidates everything after
it.** Order is `tools` → `system` → `messages`. So:

- **The system prompt is frozen.** No timestamp, no session id, no "current
  branch: …", no `cwd`. Volatile facts go in the first user message, after the
  breakpoint. This is easy to get wrong in a desktop app, where the workspace,
  the branch and the open file are all right there and tempting.
- **The tool list is byte-identical every turn.** Our set varies by capability —
  LSP tools exist only when a server is up for that language — and **that is an
  invalidator.** Decide the tool set once at session start and keep it fixed
  even if a server comes up later.
- **History is append-only.** Rewriting turn 3 invalidates turns 3..N. Agents
  break this constantly and it fails silently.

### Verify it

Record the cached-read count **per turn, from day one**. Zero across turns with
an identical prefix means something is invalidating.

> A hit rate below ~70% in a long session is a bug, not a tuning opportunity.

### The four breakpoints (window)

```
[1] system prompt + tool definitions        ← frozen for the session
[2] repo constitution (AGENTS.md, tree)     ← frozen per session
[3] last compaction boundary                ← moves rarely
[4] rolling, a few turns behind the head    ← moves often
```

Leave the last turn or two uncached: they change anyway, and a write never read
is money for nothing. The panel needs one breakpoint, after its preamble.

---

## Lever 2 — Tool output is what actually ruins you

Caching is a one-time piece of engineering. **Tool design is the lever you keep
pulling**, and it separates agents by 5× on the same task with the same model.

> **A tool result is a permanent subscription.** 3,000 tokens on turn 3 of a
> 30-turn session costs ~81,000 input tokens over that session.

**Never return a whole file.** `fs_read_text` reads the lot; the agent needs a
ranged wrapper, `read(path, offset, limit)`, default ~200 lines.

**Search returns locations, not content.** `fs_search` already streams matches —
give the agent `path:line: matched line` and let it read the ranges it chooses.

**Cap everything, and say that you capped it.**

```
[shell] cargo test  (exit 101)
… 40 lines …
--- truncated: 1,847 more lines. re-run with `| tail -50`, or grep it ---
```

A silent truncation makes the model re-run the command; an explicit one tells it
what to do instead.

**Edits are diffs, not rewrites.** `edit(path, old, new)`, never
`write(whole_file)`. This cuts *output* tokens, the expensive ones: a 500-line
rewrite is ~6K output at ~5× the input rate, against ~80 for the changed hunk.
It is also safer — a failed exact match is a visible error, where a rewrite
silently drops whatever the model forgot to repeat.

**Errors are short and actionable.** `no such file: src/mian.rs — did you mean
src/main.rs?` beats fifty lines of backtrace.

**Track what has been read.** Keep `path → (ranges, mtime)`. Asked for a range
it already has, unchanged, answer `already in context (lines 40–120)` — ~8
tokens instead of 800.

### The tool surface

| Tool | Backed by | Window | Panel |
|---|---|---|---|
| `read(path, offset, limit)` | `fs_read_text` + ranging | ✓ | ✓ |
| `grep(pattern, glob, limit)` | `fs_search` | ✓ | ✓ |
| `glob(pattern)` | `fs_list_files` | ✓ | — |
| `edit(path, old, new)` | **the editor's atomic-save path** | ✓ | ✓ |
| `write(path, content)` | `fs_create` | ✓ | — |
| `shell(cmd, timeout)` | `execute_shell_command` | ✓ | — |
| `definition(path, line, col)` | `lsp_send` | ✓ | ✓ |
| `references(path, line, col)` | `lsp_send` | ✓ | ✓ |
| `diagnostics(path)` | `lsp_send` | ✓ | ✓ |

**Edits must go through the editor's save path, not `fs_write_text`.** That
machinery already does atomic saves with conflict detection, CRLF and BOM
preservation and crash-safe drafts — and a file rewritten under an open tab is
exactly the conflict it exists for. Writing around it would make the agent the
one thing in the app that can silently destroy unsaved work.

---

## Lever 3 — Context management, and the trap in it

1. **Don't grow.** Everything in Lever 2 — the cheapest, because context never
   added costs nothing to remove.
2. **Prune.** Drop old tool results, keep the reasoning about them. Tool results
   are ~80% of a coding agent's context.
3. **Compact.** Summarise turns 1..N and continue from the summary.

### The trap

**Pruning and compaction both destroy the cache.** You edited the prefix, so
everything cached after the edit is gone and the next turn rewrites it at 1.25×.
The arithmetic is often *negative*: dropping 20K tokens to save 2K/turn while
forfeiting a cache saving 25K/turn.

> Let the context grow with cache behind it. Near the real limit, compact
> **once**, decisively, to a small summary — then rebuild and run again.

Compact at a task boundary, never mid-edit. **Never compact away** the system
prompt, the repo constitution, the original request, the file-state map, or the
last two turns. And in the panel, never: offer promotion instead.

---

## Lever 4 — Routing, and when it backfires

> **Caches are keyed per model.** A turn routed elsewhere forfeits the cached
> prefix *and* writes a second cache. Routing inside the main loop loses money.

Route only work that is **off the main thread** — a short separate context whose
result returns as a few hundred tokens:

| Off-thread job | Model class |
|---|---|
| "Which of these 40 files are relevant?" | cheap, automatic-cache |
| Summarise a file for the index | cheap |
| Draft a commit message | cheap |
| **The main window loop** | **the good model, always** |
| The editor panel | its own session, so a faster model is free to choose |

Before a cascade, measure the simpler thing: **the better model thinking less.**
Judge on **cost per completed task** — a cheap model needing three more turns is
not cheap.

---

## Lever 5 — Measure it, in the UI

The advantage of an app over a CLI: **we can show the cost while it is spent.**
Build the ledger before the features.

Per turn, into SQLite (`rusqlite` is already a dependency):

```
session_id, surface, turn, model, input_tokens, cached_read, cache_write,
output_tokens, cost_usd, tool_calls, largest_tool_result, context_total, wall_ms
```

`surface` is `window` or `panel`, because the two will have very different
shapes and the comparison is how you find out whether the panel is paying for
itself.

In the window's status bar:

- **cache hit rate** — 70–95% in a healthy long session
- **$ this session** and **$ per completed task** — the second is the honest one
- **largest tool result** — the early warning; a spike means a tool misbehaving

OpenRouter can return usage accounting on the response, and `/generation` gives
authoritative per-call cost (confirm both against current docs). Reconcile
weekly: a silent provider-routing change moves unit cost with nothing on our
side changing.

**Set a hard per-session budget and stop at it.** An agent looping on a broken
test spends real money fast, and "a few cents a turn" stops being true at turn
200.

---

## On Rig, specifically

Rig's value is the provider abstraction — **30 provider modules in 0.47.0,
`openrouter` among them** — plus message and tool types we would otherwise
hand-roll.

**Depend on `rig-core` with `default-features = false`.** The `rig` facade pulls
in `rig-agent`, the derive macros, the reqwest/rustls stack and, on native
targets, `rig-cli` — a whole Bevy-based terminal coding agent. We are building
our own loop: we want the provider clients and the types, not a second agent
framework and an ECS inside a Tauri binary.

```rust
use rig_core::providers::openrouter;

let client = openrouter::Client::new(&key_from_keychain()?);
let model = client.completion_model(&settings.model_id);
// our loop, our context policy, our cache breakpoints
```

Signatures to check against the version you pin. **Rig moves fast and breaks**:
the OpenRouter provider has existed since 0.10, the crate is at 0.47, and the
workspace was restructured on the way. 0.47.0 is two days old. Pin an exact
version, commit the lockfile, treat a bump as a change needing its own testing —
this binary ships on macOS, Linux and Windows, and a dependency that breaks on
one of them breaks a release.

The honest alternative: we already have `reqwest`, `tokio` and `serde`, and
OpenRouter speaks one HTTP API. Writing the call ourselves is perhaps 300 lines
and no dependency risk. **Decide in week one** — try Rig, and if its types fight
the `cache_control` placement we need, drop it without regret.

---

## Decisions to make before writing code

| Question | My lean |
|---|---|
| One core or two? | **One**, in Rust. Front-ends never hold a loop |
| Shared session between surfaces? | **No** — different preamble, different cache |
| Promotion? | **Panel → window only** |
| Where does the panel live? | The **column opposite the explorer**, with a mode switcher |
| Our own loop or `rig-agent`? | **Ours.** The cost levers live in the loop |
| `rig-core` or raw HTTP? | **`rig-core`, `default-features = false`** — revisit in week one |
| OpenRouter or direct? | **OpenRouter**, behind a trait |
| Explicit or automatic caching? | **Explicit** in the window; automatic is fine in the panel |
| Prune continuously? | **No.** Grow with cache behind; compact once, hard, late |
| Where do edits go? | **Through the editor's atomic-save path**, never around it |
| Sandbox | **`fs_set_roots`.** It exists and is enforced |
| Secrets | **Keychain** via `keyring` |
| Sessions | **SQLite** from day one |
| Keep the Claude Code window? | **Yes.** Different question, better than ours for a while |
| Data policy | **Decide before the first real repo** — the agent reads proprietary source |

---

## Phases

1. **Spike — one week.** `rig-core` + OpenRouter, streaming into a scratch
   window. Answer the Rig question. Prove cancellation through
   `tokio::select!`, as the API client's send path already does.
2. **The core.** `src-tauri/src/agent/`: loop, three tools (`read`, `grep`,
   `edit`), **and the ledger**. Phase 2, not phase 7.
3. **Cache discipline.** Breakpoints, frozen prefix, hit rate on screen. Do not
   move on below 70% over a 20-turn session.
4. **Tool hygiene.** Caps, truncation notices, the file-state map, diff edits,
   edits through the editor's save path. Measure $/task either side — the 5×
   lives here.
5. **The Figy Code window.** Navigator, conversation, diff review, permission
   prompts, interrupt, the overlay stack done properly.
6. **The LSP tools.** `definition`, `references`, `diagnostics`. Needs 2–4 under
   it to be worth anything.
7. **The editor panel.** Only now — it is the *second* front-end, and building
   it before the core is settled means building it twice. Selection context,
   inline hunks, fix-this-diagnostic, promotion.
8. **Context policy.** Compaction at a boundary, budget ceiling, resume.

Phases 2–4 are unglamorous and are the entire product. An agent that is correct
and cheap beats one that is clever and expensive, because the expensive one
stops getting used.

---

## Honest risks

- **Two front-ends is twice the product.** `CLAUDE-CODE.md` declined one for
  good reasons; the reasons don't apply, but the size does. Phase 7 exists to
  stop us building the panel on a core that is still moving.
- **The panel can become a worse window.** Its value is being short and cheap.
  If it grows compaction, a shell tool and thirty-turn sessions, we have built
  the window twice and made the cheap one expensive.
- **Rig's API churn**, in a binary shipping on three platforms.
- **The agent can destroy unsaved work** if edits bypass the editor's save path.
  The one failure here that costs data rather than money.
- **Cache discipline is invisible when broken.** Without the ledger in phase 2
  we will not notice a 5× regression until the bill arrives.
- **We are competing with Claude Code.** The honest reasons are control, cost,
  models we choose, and the LSP tools nobody else can offer. Scope to those.
