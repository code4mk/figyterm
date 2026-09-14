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
