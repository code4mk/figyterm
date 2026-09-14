# Drawing Projects — Plan and Task List

The working checklist for the embedded Excalidraw drawing tool with projects.
The *argument* — why IndexedDB rather than `localStorage`, why the old code is
replaced rather than repaired, what a project is — lives in
[`DRAWING.md`](./DRAWING.md) and is not repeated here. This
document is what gets built, in what order, and how far along it is.

Status: `[x]` done · `[~]` built but unproven at runtime · `[ ]` todo

Pairs with [`DRAWING.md`](./DRAWING.md) the way
[`CLAUDE-CODE-TASKS.md`](./CLAUDE-CODE-TASKS.md) pairs with
[`CLAUDE-CODE.md`](./CLAUDE-CODE.md): rationale there, checkboxes here.

**Starting point: nothing exists.** An earlier single-canvas attempt and all of
its app-shell wiring were removed from the branch before this list was written.
The only thing left behind is the `@excalidraw/excalidraw` dependency in
`package.json`, kept so no reinstall is needed. Everything below is new code.

---

## The shape of it

```
┌──────────────────────────── webview ─────────────────────────────┐
│  DrawingModal           frame, drag/resize/pip/fullscreen,       │
│    │                    rail + canvas layout, status bar         │
│    ├─ DrawingRail       search · favourites · rename · delete    │
│    ├─ DrawingEmpty      no projects / no selection               │
│    └─ DrawingCanvas     one <Excalidraw>, keyed by project id,   │
│                         owns autosave and theme sync             │
│                                                                  │
│  stores/drawingStore.ts      projects, activeId, query, actions  │
│  services/drawing-project.ts pure: names, sort, search   ← TESTED│
│  services/drawing-db.ts      IndexedDB plumbing                  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │  structured clone, async
                      ┌──────────▼──────────┐
                      │ IndexedDB           │
                      │  "figy-drawing" v1  │
                      │   ├ projects  (id)  │  ← the rail reads only this
                      │   └ scenes (projectId)
                      └─────────────────────┘

        No Rust. No Tauri plugin. No capability grant.   (until Phase 5)
```

**The store layer knows about projects; the canvas knows about one scene.**
`DrawingCanvas` is handed a project id and a scene and reports changes back; it
has no idea a list exists. That is what makes switching projects a remount
rather than a state reconciliation.

---

## Phase 1 — Foundation

No UI. Ends with `npm test` and `npx tsc --noEmit` green.

- [x] `src/services/drawing-project.ts` — pure, so `npm test` runs it under
      plain Node (the `claude-project.ts` rule). `./fuzzy` is the one import,
      and it is pure scoring for the same reason
  - [x] `DrawingProject` and `DrawingScene` types — `elements`/`files` held as
        `unknown`, so Excalidraw's types stay out of the Node test; the canvas
        casts at that one boundary
  - [x] `normalizeName(raw)` — trim; `null` for blank
  - [x] `nextUntitledName(existing)` — reuses the first free number rather than
        going one past the highest
  - [x] `duplicateName(name, existing)` — `x` → `x copy` → `x copy 2`, and
        duplicating a copy does not give `x copy copy`
  - [x] `sortProjects(projects)` — favourites first, then `updatedAt` desc,
        stable, and a copy rather than in place
  - [x] `searchProjects(projects, query)` — `fuzzyFilter` over `name`; an empty
        query is rail order, not a filter
  - [x] `visibleElementCount(elements)` — excludes `isDeleted`
  - [x] `PERSISTED_APP_STATE_KEYS` — the whitelist, with `theme` deliberately
        **not** in it
  - [x] `pickAppState(appState)` — narrows to the whitelist
  - [x] `createProject(name)` / `newId()` — `crypto.randomUUID` with a fallback
        for non-secure contexts (a LAN dev server)
- [x] `src/services/drawing-project.test.ts` — names, order, search, elements,
      appState. Asserts `theme` is not persisted and that `collaborators` is
      dropped
- [x] `src/services/drawing-db.ts`
  - [x] `openDrawingDb()` — `figy-drawing` v1, both stores, memoised promise,
        `onversionchange` so a second connection is not deadlocked
  - [x] `listProjects()` / `putProject()`
  - [x] `readScene(id)` / `writeScene(scene, projectRow)` — one transaction
        spanning both stores, so the row and the scene cannot disagree
  - [x] `deleteProjectAndScene(id)` — likewise one transaction
  - [x] Resolves on transaction `complete`, not on the last request's `success`
        — the difference is whether the write is durable
  - [x] Every entry point survives a failed open (private mode, corrupt db) by
        degrading to an in-memory store rather than throwing into React;
        `isEphemeral()` lets the status bar admit it
- [x] `src/stores/drawingStore.ts` (zustand)
  - [x] `projects`, `activeId`, `query`, `ready`, `railCollapsed`,
        `lastSavedAt`, `saveError`
  - [x] `hydrate()` — re-entrant, so opening the modal twice cannot double the
        list
  - [x] `create()` · `rename(id, name)` · `toggleFavorite(id)` · `select(id)` ·
        `setQuery(q)` · `toggleRail()`
  - [x] `remove(id)` — reselects the next most recent; the last one leaves the
        empty state
  - [x] `duplicate(id)` — copies the scene under a new id
  - [x] `persistScene(...)` — autosave's single entry point. Derives
        `updatedAt` and `elementCount` here rather than taking them, so the row
        can only ever describe the scene written beside it
  - [x] The store owns persistence; nothing outside it touches `drawing-db.ts`

## Phase 2 — Canvas

One implicit project, no rail yet. Ends with a drawing that survives a restart.

- [x] `src/components/Drawing/DrawingCanvas.tsx`
  - [x] `import "@excalidraw/excalidraw/index.css"` — inside the lazy chunk, so
        the CSS is not paid for until the modal is first opened (**defect #3**)
  - [x] Set `window.EXCALIDRAW_ASSET_PATH` before mount
  - [x] Scene is **awaited before `<Excalidraw>` renders**; a spinner holds the
        frame until then, so `initialData` is right on the mounting render
        (**defect #4**)
  - [x] `key={projectId}` — switching projects remounts
  - [x] `theme` from `useThemeStore`, applied at render and never persisted
  - [x] Autosave: 800 ms idle debounce, 5 s ceiling, gated on
        `hashElementsVersion()` (0.18 deprecates `getSceneVersion`) plus a
        files count and the whitelisted appState
  - [x] Flush on: project switch, modal close, `visibilitychange`,
        `beforeunload`
  - [x] Flush reads the live API, never storage (**the Export-stale bug**)
  - [x] `UIOptions.canvasActions` — hide `loadScene` / `export` /
        `saveToActiveFile` until Phase 5 makes them real
- [x] `scripts/copy-excalidraw-assets.mjs` — plain Node, no dependency; copies
      `dist/prod/fonts` → `public/excalidraw-assets/fonts/`
- [x] `package.json` — wire it to `postinstall` and `prebuild`
- [x] `.gitignore` — `public/excalidraw-assets/`
- [x] `src/components/Drawing/DrawingModal.tsx`
  - [x] Frame built on the shared modal primitives the browser and editor already
        use: `useDraggableModal`, `OverlayPortal`, the overlay-stack
        claim/release, pip and fullscreen
  - [x] **No Save / Load / Export / Clear toolbar.** Saving is automatic, and
        the file actions need Rust (**defects #1, #2**) — Phase 5 owns them
  - [x] **No `window.location.reload()` anywhere** (**defect #5**)
  - [x] Title bar shows the active project's name
  - [x] Status bar: element count · last-saved time
- [x] App-shell wiring, all of it new
  - [x] `AppShell.tsx` — `lazy()` import, `drawingOpen` + `drawingMounted`
        latch, `closeDrawing` returning focus to the pane, `toggleDrawing`,
        `OverlayBoundary`, command-palette entry
  - [x] `src/services/shortcuts.ts` — `drawing: ⌘⇧X / Ctrl+Shift+X` (`X` is free
        in both schemes; `D` is taken by split)
  - [x] `src-tauri/src/menu.rs` — `MENU_DRAWING`, `EVENT_DRAWING`
        (`menu://drawing`), menu item, and the `handle_menu_event` arm
  - [x] `AppShell.tsx` — `listen("menu://drawing", …)`

## Phase 3 — Projects

The feature as asked for.

- [x] `src/components/Drawing/DrawingRail.tsx`
  - [x] Search box, `fuzzyFilter` over `name`
  - [x] `★ Favourites` / `All projects` headings; one ranked list while querying
  - [x] Row: name over `N items · <relative time>`; star, rename, duplicate and
        delete as icons revealed on hover — not a `⋯` popover, which would be a
        second focus trap and an outside-click listener to get wrong
  - [x] `+` new project → created, selected, row in rename mode, text selected
  - [x] Inline rename: `Enter` commits, `Escape` reverts, blur commits, blank
        reverts
  - [x] Delete confirms **in the row**, not via a native dialog
  - [x] Duplicate
- [x] `src/components/Drawing/DrawingEmpty.tsx` — no projects (offers *New
      drawing*) and no search results
- [x] Styling — **Tailwind utilities over the existing `--ft-*` tokens**, not a
      hand-written `.drawing-*` block as the plan first said. The tokens already
      carry both themes, so a parallel stylesheet would have been a second place
      to keep light mode correct. `styles.css` keeps only what utilities cannot
      express: the canvas height chain Excalidraw sizes itself from
  - [x] Rows, selected/hover, star on/off, search, headings, inline rename
        input, delete confirm, empty states
  - [x] Light theme falls out of the tokens — no `.light` overrides needed

## Phase 4b — Notes

A second pane in the same project: Lexical beside Excalidraw, so an idea can be
written down next to the picture of it.

- [x] `lexical` + `@lexical/react` and the node packages it needs
      (`rich-text`, `list`, `link`, `markdown`, `code`, `utils`)
- [x] `src/components/Drawing/useAutosave.ts` — the saving contract extracted
      from the canvas so both panes share one copy. Idle debounce, ceiling,
      flush on unmount/hide/close, and **nothing written until something is
      recorded**, which is the rule that stops an untouched pane writing its
      empty initial state over stored work
  - [x] Returns a memoised object: callers put it in effect dependency arrays
- [x] `drawing-db.ts` — version 2 adds the `docs` store; the upgrade only
      creates missing stores, so existing drawings survive it
  - [x] `readDoc` / `writeDoc`, the doc and its row in one transaction
  - [x] `deleteProjectAndScene` → `deleteProjectData`, now all three stores
- [x] `drawing-project.ts` — `DrawingDoc`, `DrawingPane`, `noteChars`
- [x] `drawingStore.ts` — `pane` / `setPane`, `loadDoc`, `persistDoc`
  - [x] Notes do **not** bump `updatedAt`: it is the rail's sort key and reads
        as "when did this drawing last change"
  - [x] `duplicate` copies the notes as well as the scene
- [x] `src/components/Drawing/DrawingNotes.tsx`
  - [x] Document awaited before the composer mounts — Lexical reads
        `initialConfig.editorState` once, with no second chance (**defect #4's
        shape, in a different editor**)
  - [x] Markdown shortcuts, history, lists, links, tab indentation
  - [x] Typing does not reach the shell's shortcuts; Escape still closes
  - [x] A document that will not deserialise logs and opens empty rather than
        taking the window down
- [x] `DrawingModal` — segmented control in the title bar, keyed by pane so
      switching flushes the outgoing one
- [x] `DrawingRail` — a mark on projects that have notes
- [x] Status bar counts items or characters, following the pane
- [x] `.drawing-note-*` styles over the `--ft-*` tokens

## Phase 4c — A Notion-shaped notes editor

Everything below is a Lexical plugin wired up, not an editor written by hand.

- [x] `@lexical/selection` for `$setBlocksType`
- [x] `notes/SlashMenu.tsx` — `LexicalTypeaheadMenuPlugin` on `/`
  - [x] Text, H1–H3, to-do, bulleted, numbered, quote, code, divider
  - [x] Filtered by name and by synonyms (`/todo`, `/hr`, `/snippet`)
  - [x] Does not trigger mid-word — `and/or` is not a command
  - [x] Grouped into Basic / Lists / Advanced, with headings derived from runs
        in the list so a filtered menu shows only the groups it still has
        anything in
  - [x] The menu body is a component, not markup inside `menuRenderFn`: keeping
        the selected row in view needs a ref and an effect, and hooks cannot
        live in a callback
  - [x] Footer names the keys, because the menu is driven from the keyboard and
        saying so is what stops people reaching for the mouse
  - [x] Icon tiles give every row the same optical left edge whatever the
        icon's width, so mixed icons read as a column and not a ragged stack
  - [x] `color-mix` on the selected tile has a plain-accent fallback ahead of
        it — an engine that does not know it drops one declaration, not the rule
  - [x] `mousedown`, not `click`: a click moves focus first and collapses the
        selection the insertion depends on
  - [x] The typed `/heading` is removed before the block is replaced, or it
        becomes the first line of the block it asked for
- [x] `notes/FloatingToolbar.tsx` — bold, italic, strikethrough, code, link
  - [x] Positioned against the scrolling pane, clamped to its edges
  - [x] `preventDefault` on mousedown, or pressing a button collapses the
        selection it is about to format
  - [x] Listens to both `SELECTION_CHANGE_COMMAND` and `selectionchange`:
        the first misses a drag that ends outside the editor
- [x] `notes/DragHandle.tsx` — `DraggableBlockPlugin_EXPERIMENTAL`
  - [x] Kept behind one small wrapper, since the upstream API may move
  - [x] Grip appears on pane hover only; drop target is an accent line
- [x] `CheckListPlugin` + `HorizontalRulePlugin`, and their nodes registered
- [x] Checkbox and tick drawn in CSS — scales with the text, needs no font
- [x] Left gutter on the prose so the grip has a margin to live in

## Phase 4d — Tables, and a three-way pane

- [x] `@lexical/table` + `TablePlugin`, nodes registered, `/table` inserts a
      3 x 3 with a header row
  - [x] `hasCellMerge` and `hasCellBackgroundColor` off — notes table, not a
        spreadsheet
  - [x] Cell paragraphs lose their block margin, or every row grows a gap
- [x] `notes/TableControls.tsx` — Notion's table chrome
  - [x] A grip over every column and beside every row, `+` on the right and
        bottom edges; grips open a menu (insert either side, delete, delete
        table), the `+` edges add at the end without one
  - [x] An overlay measured from the table's DOM — nothing is injected into the
        document, so a saved note holds a plain table
  - [x] Actions are node- and index-addressed (`$insertTableColumnAtNode`,
        `$removeTableRowAtIndex`), because a grip acts on the row or column you
        pointed at, not the one the cursor is in
  - [x] Column delete goes via the selection: `$deleteTableColumn(table, i)`
        says it directly but is deprecated in 0.50
  - [x] `$getNearestNodeFromDOMNode` to get from `<table>` back to the node,
        rather than reading the `__lexicalKey_` property Lexical stamps on
        elements — that is an implementation detail, keyed by editor instance
  - [x] **`editor.read()`, never `editor.getEditorState().read()`.** The latter
        makes an editor *state* active but no editor, and
        `$getNearestNodeFromDOMNode` calls `getActiveEditor()` to map a DOM node
        back to a key. It throws "Unable to find an active editor", which the
        overlay boundary turns into a closed window. The same correction was
        applied to the formatting toolbar
  - [x] Bands measured with rectangles, not `offsetLeft`: a `<td>`'s offset
        parent is not reliably the table, and the difference is silent
  - [x] Pointer moving onto the chrome does not read as leaving the table
  - [x] The reveal is not a `:hover` rule on the layer — the table is not inside
        the layer, so that rule could only fire once you had found a grip
  - [x] The table's top margin doubles as the column grips' gutter, and a
        leading table is exempt from the `:first-child` margin reset that would
        otherwise clip them out of the pane
- [x] Table design
  - [x] Rounded outer corners via `border-collapse: separate` — collapsed
        borders cannot be rounded
  - [x] Inner rules lighter than the outer border: drawn at one weight
        throughout, the grid reads as heavy, because the outline is the object
        and the inner lines are texture
  - [x] Header row quiet — medium weight, muted colour. It labels a column; it
        is not a heading in the document, and the first row should not be the
        loudest thing on the page
  - [x] Neutral-grey hover and header tints rather than tokens, so they lift in
        both themes — no single token colour does
  - [x] Doubled edge borders removed; empty cells keep a minimum height
  - [x] Grips drawn as thickened gridlines in the table's border colour, inset
        a pixel so neighbours read as separate bars. Colour signals live, not
        weight — a button-sized grip is a toolbar parked against the edge
  - [x] Corner `+` where the two strips meet, adding a row and a column at once

## Phase 4 — Polish

- [x] Collapsible rail, state persisted
- [x] `↑`/`↓`/`Enter` through the rail from the search box
- [x] Relative timestamps that refresh while open
- [x] Restore the active project on launch
- [x] Command palette: *New drawing* alongside *Open Drawing*

## Phase 5 — Files (separate; needs Rust)

Held back deliberately — the only phase that cannot be verified without a Tauri
build, and the only one that touches Rust.

- [ ] `src-tauri/src/lib.rs` — register `tauri_plugin_fs`
- [ ] `src-tauri/Cargo.toml` — add `tauri-plugin-fs`
- [ ] `src-tauri/capabilities/default.json` — `dialog:allow-save` and the `fs:`
      write scopes
- [ ] Export the active project to `.excalidraw`
- [ ] Export PNG / SVG, from the live canvas
- [ ] Import `.excalidraw` **as a new project** — never over the open one
- [ ] Re-enable the matching `UIOptions.canvasActions`

---

## What the branch already has

- [x] `@excalidraw/excalidraw` `^0.18.1` in `package.json` — the one thing kept
      from the removed attempt, so no reinstall is needed

Nothing else. `src/components/Drawing/` does not exist, and `AppShell.tsx`,
`services/shortcuts.ts`, `src-tauri/src/menu.rs` and
`src-tauri/capabilities/default.json` are all at their pre-drawing state. The
first three are edited in Phase 2, the last in Phase 5.

Existing machinery this leans on, none of it needing changes:

| What | Where | Used for |
|---|---|---|
| `useDraggableModal` | `src/hooks/` | drag, resize, pip and fullscreen rects |
| `OverlayPortal` · `OverlayBoundary` | `src/components/Overlay/` | portalling and error containment |
| `overlay-stack` | `src/services/` | `claimFront` / `isCovered` z-ordering |
| `fuzzyFilter` | `src/services/fuzzy.ts` | ranking the rail's search |
| `useThemeStore` | `src/stores/` | dark/light sync |
| `scripts/run-ts-tests.mjs` | — | runs `drawing-project.test.ts` under Node |

---

## Verification

`npm test` and `npx tsc --noEmit` after every phase. The app itself is run by
the user, so anything below is a request, not a step this checklist performs.

- [ ] `⌘⇧X` opens; Escape closes; the terminal keeps the keyboard
- [ ] Excalidraw is **styled**, and text uses the hand-drawn font (defects #3 and
      the font path)
- [ ] Draw · close the modal · reopen → the drawing is there (defect #4)
- [ ] Draw · quit the app · relaunch → still there
- [ ] Two projects, switch between them → each keeps its own scene and scroll
- [ ] Rename · favourite · search · duplicate · delete
- [ ] Delete the active project → the next one is selected
- [ ] Delete the last project → empty state, no blank canvas
- [ ] Paste a large image → saves without a quota error (the `localStorage` case)
- [ ] Toggle the theme with a project open → chrome and canvas both follow, and
      reopening later does not resurrect the old theme
- [ ] Nothing in the drawing tool ever reloads the window (defect #5)
