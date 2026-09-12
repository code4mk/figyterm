# Code intelligence without a language server

**Status: a plan, not built.**

[`LSP.md`](./LSP.md) sets out what a language server would take. It is a lot —
a process manager, a protocol client, a per-language install story, and
`rust-analyzer` sitting on a gigabyte of RAM while a terminal tries to start
fast. This document is the answer to *"is there a cheaper way?"*, and the answer
is **most of the way, yes** — by using things this app already has and a
language server does not.

The honest framing: nobody wants "LSP". They want to know what a symbol is,
where it came from, what they just broke, and to stop typing the same
identifier by hand. Those are four separate problems with four different
prices, and only one of them really needs a language server.

---

## The four tiers

| Tier | What it gives | What it costs | Needs a server? |
|---|---|---|---|
| **0. The syntax tree** | Outline, in-file go-to-definition, scope-aware completion, same-symbol highlight | Nothing — already parsed | No |
| **1. A project index** | Cross-file go-to-definition, find references, workspace symbols | One Rust module, milliseconds, a few MB | No |
| **2. The terminal's own output** | Real diagnostics, in the gutter | Almost nothing — the parser exists | No |
| **3. One-shot tools** | Format on save | One process that exits | No |
| **4. LSP** | Types, type-aware rename and completion | [`LSP.md`](./LSP.md) | Yes |

Tiers 0–3 are a few weeks and no daemons. Tier 4 is a project. The point of
this document is that **the first three cover most of the daily value**, and
the fourth should only happen if, having shipped them, the gap is still felt.

---

## Tier 0 — the syntax tree is already there

CodeMirror parses every open buffer with **Lezer**, incrementally, on every
keystroke. It is already paid for: that is what draws the highlighting, the
folds and the bracket-aware indent. Right now nothing else reads it.

`syntaxTree(state)` from `@codemirror/language` — already a dependency —
hands over that tree. Four things fall out of it:

- **An outline per file.** The Markdown preview already has one
  (`services/markdown-outline.ts`, parsed from text); a code outline is the
  same panel fed from the tree instead. Functions, classes, methods.
- **Go to definition, within the file.** Walk up from the identifier under the
  cursor to the nearest declaration of that name. For a file you opened from a
  stack trace to understand one function, this answers the question most of the
  time.
- **Completion that knows about scope.** Today's word completion offers every
  word in the document, including ones in a function you are not in and in
  comments. The tree can offer *declared identifiers visible from here*, ranked
  by proximity. Same UI, same cost, a much better list.
- **Highlight every use of the symbol under the cursor.** `highlightSelectionMatches`
  already does this for *text*; doing it for a tree node stops it lighting up
  the `id` inside `width`.

**Limits, stated plainly:** one file, no types, no imports followed. It does not
know that `User` came from `./models`. It is the difference between a good
editor and an IDE, and it is free.

---

## Tier 1 — a project index, the way ctags always did it

Cross-file navigation does not need type inference. It needs a list of where
things are declared, which is a regex over a file walk.

Everything needed is already in the tree:

- **`ignore`**, ripgrep's walker, is already a dependency — it is what makes
  project search skip `node_modules` and honour `.gitignore`.
- **`fs_search`** already streams matches out as events with a generation
  counter, capped and cancellable.
- **Quick open** already keeps a fast, `.gitignore`-aware file list.

So a `symbols` module is mostly composition: walk once, apply a per-language
declaration pattern (`fn NAME`, `function NAME`, `class NAME`, `def NAME`,
`const NAME =`), keep `{ name, kind, path, line }`, refresh on the watcher.
A large repository is tens of thousands of symbols — single-digit megabytes,
and the walk is the same one search already does in well under a second.

That gives:

- **Go to definition, across files.** One candidate, jump; several, show them
  and let the user pick. `openPath(path, line, column)` already exists.
- **Find references.** This is *already* `fs_search` with word boundaries. It is
  arguably a two-hour feature today.
- **Workspace symbol search** — `⌘T`-style "go to symbol", over the same fuzzy
  scorer quick open uses.

**And if `universal-ctags` is on `PATH`, use it instead.** Better parsing, no
patterns of ours to maintain, and exactly the philosophy already applied to
`git`: the user's toolchain is installed, and a tool that has been getting this
right since 1992 beats a regex we wrote last week. Fall back to the regex when
it is not there.

**Limits:** it does not understand shadowing, overloads, re-exports or aliases.
Ask it where `get` is defined and it will offer forty answers. That is the ctags
bargain, and a generation of people shipped a lot of software on it.

---

## Tier 2 — the diagnostics are already on your screen

This is the one that is unique to a terminal, and the reason this document
exists.

**You already run the compiler.** `cargo check`, `tsc --noEmit --watch`,
`eslint`, `ruff`, `go vet`, `pytest` — in a pane, three inches from the editor.
That output contains every diagnostic a language server would tell you, except
it is the *actual build* rather than a second implementation's opinion of it.

And the editor **already parses it**. `Terminal.tsx`'s link provider runs
`FILE_PATH` over every output line and `parsePathTarget` pulls out
`{ path, line, column }` — that is what makes a `tsc` error clickable today.
It throws away everything except the path.

So: keep the rest. A line that matched a path *and* carries `error` or
`warning` is a diagnostic. Collect them per pane, key them by absolute path,
and hand them to `@codemirror/lint` — which already draws the squiggle, the
gutter marker and the tooltip.

```
src/components/Editor/EditorModal.tsx:214:8 - error TS2322: Type 'string' is not …
└────────── already parsed ─────────┘   └──── one more capture group ────┘
```

What this buys that a language server does not:

- **It is the truth.** Your `tsconfig`, your feature flags, your `cargo` target.
  No second type-checker to disagree with CI.
- **It costs nothing.** No process we started, no memory we hold, no indexing
  wait. You were going to run the build anyway.
- **No configuration.** It is whatever command you typed.
- **It works for every language at once**, including ones no server exists for,
  and for tools that are not type-checkers at all — a test runner's failures
  land in the gutter too.

**Limits:** it is as fresh as your last build. With a `--watch` mode — which is
how most people already work — that is continuously. Without one, the squiggles
are from whenever you last ran it, so they must be **labelled with their age**
and cleared when the file changes underneath them. A stale diagnostic presented
as current is worse than none.

The work is: a second regex layer over lines the link provider already matched,
a per-workspace store, and `@codemirror/lint`. It is small, and it is the single
highest-value item in this document.

---

## Tier 3 — one-shot tools, no daemon

Some of what a language server offers is a program that runs once and exits.

- **Format on save** — `prettier`, `rustfmt`, `black`, `gofmt`. Detected from
  the project, run on the buffer's text, result applied as one undoable edit.
  No persistent process, no protocol.
- **Organise imports, lint fixes** — the same shape where the tool supports it.

This has to go through the editor's existing save discipline: the formatter's
output replaces the buffer, then the buffer saves atomically with the mtime
check and the line endings preserved. Formatting is the one place a tool
rewrites the whole file, so it is the one place a mistake costs the lot.

---

## What is actually left for a language server

Having done the above, the gap is narrower than it looks — and it is all one
thing: **types**.

- Hover showing an inferred type.
- Completion on `foo.` that knows what `foo` is.
- Rename that is correct rather than textual.
- Diagnostics without running a build, as you type.

Real value, and worth having eventually. But it is the *last* 20% of the use,
at roughly 95% of the cost, and it is the part that makes a terminal slow. If
tiers 0–3 are shipped and this list still stings, [`LSP.md`](./LSP.md) is
waiting and unchanged — and by then the editor will have an outline, an index,
a diagnostics store and a formatter hook, which are most of the pieces an LSP
client would have needed anyway.

---

## Suggested order

1. **Tier 2, diagnostics from the terminal.** Highest value, smallest change,
   and it is the thing no other editor can do because no other editor is
   sitting inside the terminal.
2. **Tier 0, scope-aware completion and in-file go-to-definition.** Free, and
   it makes the editor feel like it understands the file.
3. **Tier 1, the project index.** Find-references first — it is nearly there
   already — then go-to-definition, then workspace symbols.
4. **Tier 3, format on save.** Small and self-contained; slot it in whenever.
5. **Tier 4, LSP.** Only after living with the above.

---

## Verification

Per tier, the thing that would prove it is real rather than demoed:

- **Tier 0** — open a 3,000-line file: completion is still instant, and the
  suggestions are from the enclosing scope rather than the whole document.
- **Tier 1** — index a large repository: under a second, and the memory it
  holds is visible somewhere. Renaming a file updates it without a restart.
- **Tier 2** — run `tsc --watch` in a pane, break a type: the squiggle appears
  in the editor without touching anything. Fix it: the squiggle goes. Edit the
  file without re-running: the diagnostic is marked stale, not silently wrong.
- **Tier 3** — format a file with CRLF line endings and a BOM: both survive.
