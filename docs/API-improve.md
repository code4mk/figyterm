# FigyMan — the window people actually work in

Phase 6 finished the engine: requests go out, scripts run, collections sync.
This phase is about the surface. Everything below is a thing somebody hit while
using it, not a feature somebody thought of — which is why it is a list of
eleven and not a redesign.

The bar is **production**: nothing half-drawn, nothing that works only in the
dark theme, nothing that needs a mouse when a keyboard would do, and no state
that looks saved and isn't.

Status: `[x]` done · `[~]` done but unproven · `[ ]` todo

---

## 1 · The sidebar has three sections, and says which one it is on

Today the three views — collections, environments, history — are three text
buttons in a row that also competes with the import and add buttons. At a
glance you cannot tell which is selected, and the environments button is an
icon with a number and no word.

- [x] A narrow **icon strip** down the far left: collections, environments,
      history. One icon each, the selected one marked with an accent bar, a
      tooltip and an `aria-label` on every one, and a count in the corner.
- [x] The panel beside it gets a **title row**: the section name and the
      actions *for that section only* (import and new collection; import and
      new environment; clear history). Today's row mixes them.
- [x] Search belongs to the section it searches, and says what it searches:
      environments filter by name *and* by variable name, history by URL and
      method. The text is shared across sections on purpose — switching to
      look for the same thing somewhere else is the common case.
- [x] Clicking the section you are already on collapses the sidebar, which is
      what every icon strip in every editor does.

## 2 · The collection tree reads as a tree

- [x] A **twisty in a fixed column** on every row that can hold children, so
      names line up whether or not a row has one. Today the column is there but
      the rows still drift, because the method chip is a different width per
      method.
- [x] Method chips: fixed width, uppercase, tabular figures, the same colours
      everywhere in the app. `DELETE` and `OPTIONS` are shortened rather than
      allowed to set the column width for everything else.
- [x] A folder shows an open or closed folder icon, so a folder and a request
      are distinguishable without reading either.
- [x] **Indent guides** — a hairline per level. A tree four deep with nothing
      but padding is a list you have to count.
- [x] Row actions on hover, not only on right-click: a `+` on a collection or
      folder, and a `⋯` that opens the same menu the right-click does. A
      right-click menu that is the only way to reach an action is an action
      most people never find.
- [x] Empty states per section that say what to do, not just that there is
      nothing, and a "nothing matches" that is distinguishable from "nothing
      here".

## 3 · A folder opens, not just expands

A folder in this format is a real thing: it carries auth, scripts, variables
and a description, all of which are inherited by everything under it. Today
none of that is reachable — a folder is a twisty.

- [x] Clicking a folder opens a **folder tab** and expands it. The twisty
      expands without opening — closing a folder to get it out of the way
      should not also bring its settings to the front.
- [x] The folder tab has: **Overview** (name, description with a markdown
      preview, and what is inside), **Authorization**, **Scripts**,
      **Variables**.
- [x] Auth and Scripts are the *same components the request tab uses*. They
      have to be: a folder's bearer token and a request's are the same block in
      the same format, and two editors for it would be two chances to write it
      differently.
- [x] Everything saves in **one write** (`api_item_scope_save`). Four writes
      would bump the row's revision four times and queue it for syncing four
      times for one save, and a failure partway would leave a folder holding
      its new auth beside its old scripts.
- [x] The tab survives a restart, rebuilt **from the row** rather than from the
      session — a copy saved before another window edited the folder would
      quietly reinstate the old values on the next save. A tab whose folder has
      since been deleted closes instead of restoring onto nothing.

**One thing was not already stored.** The plan said the description column
existed; it did not — `collections` had one from version 1, `items` never did,
and a folder's description survived a round trip only by riding along inside
`raw`. That is enough not to lose it and not enough to show one. So:

- [x] Migration 6 (`DESCRIBED`) adds `items.description`, `NOT NULL DEFAULT ''`
      to match the column collections already had, which means the sync codec
      needs no special case — it is a text column like any other.
- [x] The importer fills it, the exporter writes it back, and `items` is added
      to the sync table's column list.
- [x] **Folders only.** A request's description stays in `raw` where it has
      always been: nothing edits one, and reading it into a column that nothing
      writes back is two places for the same string to disagree.
- [x] A folder's `variable[]` now exports from its column too. The rule is
      careful about the null case: an empty list means somebody deleted the
      last variable and the key goes, but `null` means the column has never
      held them — true of a collection imported before the column existed — and
      there the original in `raw` is the only copy and is left alone.
- [x] 9 round-trip tests over folder descriptions and variables, including the
      typed `{content, type}` shape, and 3 Rust tests over the save, the export
      and what a duplicate reports.

## 4 · A collection opens too

- [x] Same idea, one level up, and the same component: the only difference
      between the two levels is that a collection is the outermost one.
- [x] Overview carries the description, and the description is markdown in the
      format — so it renders as markdown, not as a wall of asterisks. The
      renderer is the one the release notes and the editor preview already use,
      which builds React elements and never touches `dangerouslySetInnerHTML`.
- [x] The variables table is the collection's own scope, which until now was
      reachable only through a store action with no UI. The table itself is
      shared with the folder tab (`VariableTable`) — and the environment tab
      will take it too rather than growing a third.

## 5 · Saved examples hang under their request

An example is a response somebody kept. It is stored against a request, it
exports with it, and today it is only visible once you open the request.

- [x] A request row with examples gets a twisty of its own; its examples are
      rows under it, each with its status where the method chip would be —
      which is what tells a kept 200 from a kept 422 at a glance, and the whole
      reason for keeping both.
- [x] Clicking one opens the request with that example shown. An example on its
      own has no URL bar to belong to.
- [x] Rename in place and delete from the row or the menu. Delete asks nothing:
      an example takes nothing with it, which is the rule the rest of the rail
      already follows.
- [x] Examples are **not** dragged. They belong to their request and are
      ordered within it; there is nowhere else in the tree for one to go.
- [x] A **new** query, `example_index`, returns every example in the workspace
      *without its body*. A collection with two hundred kept responses is a
      megabyte nobody asked to see arriving on every start, and a query per
      request would be hundreds of round trips to draw one sidebar.
- [x] A search does not open every matching request's examples. Search reveals
      the path to a hit; examples are not searched, so expanding them would
      bury the matches in their own history.
- [x] `renameExample` and `deleteExample` became **id-scoped** rather than
      tab-scoped — the rail edits them too, and the same example can be on
      screen in two places at once. Both write to the rail's index *and* every
      open tab, because missing either leaves a row on screen that no longer
      exists.
- [x] 5 tree tests and 1 Rust test (which also pins that a deleted request's
      examples leave the index with it — they would otherwise have no row to
      hang under).

## 6 · The response goes at the bottom

Side by side wastes the shape of the window: a URL is wide and short, a JSON
body is narrow and tall, and at 1180px the response gets 54% of the width and
wraps everything.

- [x] Request above, response below, a draggable divider between, the split
      remembered — per layout, because a proportion that suits a vertical
      divider is not the one that suits a horizontal one.
- [x] A toggle in the title bar for the old side-by-side, because on a very
      wide screen it is the better one. Remembered too. The button pictures the
      layout it switches *to*: one that pictures the current state reads as a
      label, and people press it expecting nothing to happen.
- [x] The saved position is validated on the way back in (`services/api/
      layout.ts`, 8 tests). A zero or a `NaN` renders a pane with no height,
      and a pane with no height has no divider to grab — so a layout that is
      wrong anywhere is discarded everywhere rather than half-applied.

## 7 · The sidebar collapses

- [x] Collapse to the icon strip alone, on `⌘B` / `Ctrl+B` or the button at the
      foot of the strip, remembered across sessions along with which section
      was open. `⌘⇧B` is left alone — that is the browser window, and
      swallowing it here would make it dead wherever this window has focus.
- [x] A collection or folder collapses on its own twisty, which is unchanged.
      The environment list has no sections to collapse; if it grows a "shared
      with me" group it will need one.

## 8 · The response body is a real editor

A `<pre>` cannot fold a 4000-line JSON body, cannot search it, and cannot tell
you which line you are on. CodeMirror 6 is already in this app for the code
editor.

- [x] Read-only CodeMirror 6 for the response body: JSON, XML, HTML, plain
      (`BodyViewer.tsx`).
- [x] Folding, line numbers, find (`⌘F`), match highlighting, and a soft wrap
      toggle beside Pretty/Raw — remembered per tab, on by default, because a
      raw JSON body is one line and an unwrapped one is a horizontal scrollbar.
- [x] **Read-only, not `editable: false`.** `EditorState.readOnly` stops edits
      while leaving a caret, a selection and a working keymap. Turning off
      `editable` would also take away focus, and with it the ability to search
      or to select a line to copy.
- [x] The editor's own theme and font, both light and dark, so a response and a
      file look like the same application. It brings its own highlight style,
      so this adds none — a second one would win or lose by extension order
      rather than by intent.
- [x] Big bodies stay readable: above 512 KB the language extension is left
      out, so the body shows but is not parsed. Drawing is not the cost —
      CodeMirror renders only the visible lines at any size — the Lezer parse
      is. It says so on a line above the body, with a button to parse anyway.
- [x] Theme, wrap and language each live in their own `Compartment`, so
      changing one reconfigures rather than rebuilding the state, which would
      throw away the scroll position and the selection.
- [x] **A bug found on the way:** `prettyJson` was running on *every render* of
      the pane — a parse and a re-serialise of the whole body each time
      anything redrew, producing a string identical to the one already on
      screen. Now memoised on the text, and skipped above the same 512 KB.

## 9 · A console at the very bottom

Right now, when something goes wrong the only evidence is the response pane —
and if the request never went out there is nothing at all.

- [x] A console docked at the bottom, between the work and the status bar —
      below everything it reports on, above the line that says how the window
      itself is doing. `⌘J` / `Ctrl+J`, as in most editors.
- [x] Collapsed it is one line: the count, the error and warning tallies, and
      the newest line itself. A console that takes a third of the window when
      nothing is wrong is one people close and forget.
- [x] What goes in it: every request and its outcome (method, final URL,
      status, time, size), `console.log` from scripts, script errors, failed
      assertions, import counts and every import note, sync passes, runner
      start and finish, and **the reason a send was blocked** — the one case
      where nothing goes on the wire at all, and without a line here a blocked
      send looks like a send that vanished.
- [x] A 4xx or 5xx is coloured but is not called an error: the request worked
      and the server said no. It is still what somebody scanning the log is
      looking for.
- [x] The runner logs only what went wrong. A hundred passing requests would
      push everything else out of the buffer, and they are already listed in
      order in the runner panel.
- [x] Filter by level and by text, clear, copy one line or the whole filtered
      log, and jump from a line to the tab it came from. No level chosen means
      *all* levels — a filter that hides everything looks exactly like a
      console that stopped working.
- [x] It follows the log down **only when already at the bottom**. Scrolling
      back to read a failure and being yanked to the end by the next line is
      what makes a console unusable during a run.
- [x] Bounded at 500 lines (`services/api/console.ts`, 14 tests). The id comes
      from a counter, not the array length: the buffer drops its oldest line
      once full, and a length-derived id would start repeating and hand React
      two children with the same key.
- [x] One shared `logScripts` for the window and the runner, so a failure reads
      the same either way — a run that reports differently from a single send
      is a run nobody can compare against one.

## 10 · Variables look like variables

`{{base_url}}` typed into a plain `<input>` is grey text on grey, whether it
resolves or not. This is the single most-used feature of the whole client and
it has no affordance at all.

- [x] `{{name}}` **highlighted in place** in the URL, header values and auth
      fields, via one reusable single-line CodeMirror field
      (`VariableInput.tsx`).
- [x] **Four** states, not two. Resolved, missing, generated — and **defined as
      nothing**, which gets its own amber because it is the worst of them: the
      request goes out with an empty token and the window said the variable was
      fine.
- [x] A tinted chip rather than coloured text. The point is to see where the
      braces begin and end inside a URL that is otherwise one run of
      punctuation, and a hue change alone does not do that in a mono face.
      Missing is also underlined, so colour is never the only signal.
- [x] **Autocomplete** on `{{`: every name in scope, innermost first, with its
      value and which scope it came from. Accepting one writes the closing
      braces, and replaces them if they are already there — so completing
      inside `{{ba|}}` does not leave `{{base_url}}}}`.
- [x] **Hover** shows the value and the scope that won, and says so when the
      value is empty or the name is unset. Built with `textContent`, never
      HTML: that string is a variable's value out of a document somebody else
      wrote.
- [x] The scopes travel in a `StateField`, not a closure. A closure captures
      them as they were when the field was built and goes stale the moment
      somebody switches environment — which is exactly when the colours matter.
- [x] One line, enforced by a transaction filter, including on paste: a URL
      copied out of a terminal arrives with a newline and should paste as a URL
      rather than as two lines.
- [x] The strip under the URL bar stays: it answers "what will this send?" for
      the whole request at once, which a hover cannot.
- [x] The header **name** column keeps its plain input. A header is called
      `Authorization`, not `{{Authorization}}`, and an editor per cell in a
      table of thirty headers is thirty editors.
- [x] 21 tests in `services/api/highlight.ts` over the spans, the four states
      and the completion range — three separate pieces of editor machinery read
      those ranges, and an off-by-one colours the wrong half of a URL.

## 11 · Environments are a surface, not a dialog

- [x] Environments open as a **tab**, not a modal. Setting one up is something
      you do *while* looking at the request that needs it, and a sheet over the
      whole window is the one arrangement that makes that impossible. The old
      `EnvironmentEditor` is gone rather than left as a second way in.
- [x] The table: name, type (default or secret), **initial value** and
      **current value** as separate columns, with the difference spelled out
      under the table rather than hidden in a tooltip — this is the thing about
      environments people get wrong.
- [x] Globals in the same surface, named and marked as global.
- [x] A **quick look** from the title-bar selector: switch environment, read
      what every name is currently worth, reveal a secret, or open the tab. It
      shows what a request *would use* — current value where there is one —
      because that is the question being asked.
- [x] Secret values masked by default and revealed per row, never in a tooltip.
      What is revealed is never remembered: it lasts until the popover closes
      or the row is deleted.

**This needed a new column**, and it is the one piece of engine this phase
touched:

- [x] Migration 7 (`CURRENT`) adds `variables.current_value`. `value` keeps its
      meaning — the **initial** value, what exports, what syncs, what a
      colleague gets — and `current_value` is what this machine actually
      resolves with.
- [x] It is **absent from the sync table's column list**, which is the whole
      point, and a Rust test asserts that rather than leaving it to whoever
      next edits that list. A second test pins that an export writes the shared
      value and that `currentValue` appears nowhere in the document.
- [x] Null and empty are different: null means "use the initial", empty means
      somebody deliberately chose to send nothing. Resolution honours both
      (4 tests in `scopes.test.ts`).
- [x] **A script's `pm.environment.set` now writes the current value**, not the
      initial one. A token a pre-request script fetched belongs to this machine
      and this hour; writing it into the initial value would export it with the
      collection and push it to everyone.
- [x] **A bug found on the way:** `saveEnvironment` forced `secret: false` on
      every row, so the first save of an imported environment silently
      un-marked every secret in it. It now writes the flag it was given.

---

## What this does not change

The engine. Nothing here changes what goes on the wire, how a request is sent,
or how syncing decides anything.

It did need more Rust than the plan expected: **two** migrations
(`items.description` in §3, `variables.current_value` in §11), two commands to
save what the folder and collection tabs edit, one read-only query for the
example index (§5), and one column added to the sync table list. No new tables,
and no change to the merge.

One of those two does change what resolves: a variable with a current value now
sends that instead of the shared one. That is the feature, and it is the only
behavioural change to sending in the whole phase.

## Verification

The same gates as every phase: `npm test`, `npx tsc --noEmit`, `cargo test`,
`cargo clippy`. The app is not built or run here. Anything that is pure — the
tree walk, the template scanner, the console's ring buffer — gets tests next to
it; anything that is a drawing is checked by reading it, and is called that in
the task list rather than claimed as verified.

# ui change
1. 
variable hover popup is not working fine. need to proper z-index popperjs popper.
2. in environmnet tab why showing endpoints tabs? 
3. and collections tabs ui will be more professional as like <- -> and verygood ui. scroll properly
4. context menu moden and outside click hide
5. new and import title and icon.
6. when click example , nothing showing fix that.