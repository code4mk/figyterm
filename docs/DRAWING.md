# Drawing Projects (Excalidraw) — design

A drawing tool that lives in a modal beside the browser, the editor and the
Claude window. Unlike those three, it owns its documents: a **project** is a
named drawing that FigyTerm stores, lists, searches, favourites, renames and
deletes. Drawing is autosaved; there is no Save button and nothing to lose.

> **Nothing is being repaired here.** An earlier attempt — a single-canvas tool
> backed by `localStorage`, described in a `DRAWING-APP.md` that no longer
> exists — has been removed from the branch along with `src/components/Drawing/`
> and its wiring. The single-canvas model had no room for projects, and the code
> did not run. Only the `@excalidraw/excalidraw` dependency was kept.

---

## What the removed attempt got wrong

Five defects, four of them fatal at runtime, each verified against the repo
before the code was deleted. They are recorded because each one is a **rule for
the build** — the checklist in [`DRAWING-TASKS.md`](./DRAWING-TASKS.md) cites
them by number — not to litigate code that is already gone.

| # | Defect | Consequence |
|---|---|---|
| 1 | It imported `@tauri-apps/plugin-fs`, but `tauri_plugin_fs` is **not registered** in `src-tauri/src/lib.rs` — only `shell`, `dialog` and `updater` are — and no `fs:` permission exists in `src-tauri/capabilities/default.json`. | Save, Load and Export PNG all threw. |
| 2 | `dialog:allow-save` is absent from that same capability file, though `save()` was called. | The file dialogs never opened, independently of #1. |
| 3 | `@excalidraw/excalidraw/index.css` was imported nowhere in `src/`. | Excalidraw rendered unstyled — no toolbar, no panels. |
| 4 | `initialData` was filled in a `useEffect`, which runs *after* the render that mounts `<Excalidraw>`; the component reads that prop once, on mount. | Restoring a saved drawing silently never worked. |
| 5 | Load and Clear called `window.location.reload()`. | Reloaded the whole app: every terminal pane, the editor's unsaved buffers and the Claude window went with it. |

Two more were latent rather than immediate. `getDrawingData()` read back from
`localStorage`, so Export shipped whatever the 2-second debounce last flushed
rather than what was on screen. And Excalidraw resolves its hand-drawn fonts
against `window.EXCALIDRAW_ASSET_PATH` — confirmed in `dist/prod/chunk-K2UTITRG.js`,
which falls back to a remote fetch — and that global was never set, so the fonts
that make an Excalidraw drawing *look* like one were not loaded.

Note that #1 and #2 are statements about the repo as it stands today, not only
about the deleted code: Phase 5 is where they get fixed.

---

## Decisions

| Question | Decision | Why |
|---|---|---|
| Storage | **IndexedDB**, database `figy-drawing` | See below. Not `localStorage`. |
| Scene ↔ metadata | **Two object stores** | The picker lists 50 projects without deserialising 50 scenes. |
| Save model | **Autosave only.** No Save button, no dirty state in the title bar | The user asked for auto-save. A document store with a Save button is a document store with lost work in it. |
| Project identity | **Opaque `id`, user-visible `name`** | Renaming must not invalidate anything that points at the project. Unlike a Claude project, a drawing is not a folder and has a real name of its own. |
| One canvas or many | **One `<Excalidraw>`, keyed by project id** | Remount on switch is what makes `initialData` correct (defect #4). Per-project undo history falls out of it. |
| Where projects live in the UI | **A rail inside the modal**, not an overlay picker | A drawing app's project list is primary navigation, not a jump-to dialog. The editor's `WorkspacePicker` shape is wrong here. |
| Fonts | **Vendored into `public/`**, `EXCALIDRAW_ASSET_PATH` set | Works offline, no CDN fetch from inside a desktop app. |
| Export / import to disk | **A later phase, after the core lands** | It is the only part that needs Rust and capability changes, so it must not block the part that does not. |

### Why IndexedDB and not `localStorage`

An Excalidraw scene carries its images inline: `files` is a map of id →
base64 data URL. One pasted screenshot is comfortably a megabyte of string.

`localStorage` is a **single ~5 MB budget for the whole origin**, and this origin
already stores the terminal session, the editor session, the Claude project list
and the settings. A quota overflow there is not "the drawing did not save" — it
is `setItem` throwing in whichever writer happens to go next, which may be the
terminal's. It is also synchronous, on the main thread, and string-only, so every
save pays a full `JSON.stringify` of the scene.

IndexedDB is asynchronous, structured-clone (no stringify), and its quota is a
percentage of free disk rather than 5 MB. It needs no Tauri plugin, no Rust
change and no capability grant, and it behaves the same under `vite dev` in a
plain browser as it does in the packaged app. It is also what Excalidraw's own
web app uses for exactly this data.

---

## Data model

```ts
/** The row in the rail. Small, and never holds scene content. */
interface DrawingProject {
  id: string;            // crypto.randomUUID(), opaque and stable across renames
  name: string;          // what the user sees and edits
  favorite: boolean;
  createdAt: number;
  updatedAt: number;     // bumped by autosave; the rail's sort key
  elementCount: number;  // for the row's subtitle, so the rail needs no scene
}

/** The scene. One record per project, in its own store. */
interface DrawingScene {
  projectId: string;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;   // the persistable subset, see below
  files: BinaryFiles;
}
```

`appState` is stored as a whitelist, not wholesale: Excalidraw's runtime
`appState` contains transient things (the current selection, the pointer, open
dialogs, `collaborators`) that must not be restored and, in the case of
`collaborators`, is not structured-cloneable. The whitelist is the drawing
*preferences* — current stroke colour, fill style, font, grid — plus
`scrollX`/`scrollY`/`zoom`, so reopening a project puts you back where you were.

### Object stores

```
db "figy-drawing", version 1
├── "projects"  keyPath: "id"         ← the rail reads only this
└── "scenes"    keyPath: "projectId"  ← read on open, written by autosave
```

Deleting a project deletes from both, in one transaction spanning both stores,
so a crash cannot leave an orphan scene or a row pointing at nothing.

---

## Module layout

```
src/services/drawing-project.ts        Pure logic. Names, sorting, search. TESTED.
src/services/drawing-project.test.ts   Runs under plain node via `npm test`.
src/services/drawing-db.ts             IndexedDB: open, read, write, delete.
src/stores/drawingStore.ts             Zustand: project list, active id, actions.
src/components/Drawing/DrawingModal.tsx    Modal frame, rail + canvas layout.
src/components/Drawing/DrawingRail.tsx     Search, list, rename, favourite, delete.
src/components/Drawing/DrawingCanvas.tsx   <Excalidraw>, autosave, theme sync.
src/components/Drawing/DrawingEmpty.tsx    No-projects and no-selection states.
scripts/copy-excalidraw-assets.mjs         Vendors the fonts into public/.
```

The split follows `claude-project.ts` / `claude-session.ts`: everything that is
arithmetic over strings and arrays goes in `drawing-project.ts` with **no
imports**, which is what lets `npm test` run it under Node with no DOM and no
Tauri. Everything that touches IndexedDB goes in `drawing-db.ts` and is not
tested, because there is nothing in it but plumbing.

---

## Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ✏ Architecture diagram                              ⧉  ⤢  ×   ← drag bar  │
├──────────────────────┬─────────────────────────────────────────────────────┤
│ 🔍 Search…        + │                                                     │
│                      │                                                     │
│ ★ FAVOURITES         │                                                     │
│ │ Architecture   ★ ⋯ │            ┌─────────────┐                          │
│ │ 24 items           │            │  Excalidraw │                          │
│                      │            │   canvas    │                          │
│ ALL PROJECTS         │            └─────────────┘                          │
│ │ Sketches       ☆ ⋯ │                                                     │
│ │ 3 items · 2h ago   │                                                     │
│ │ Untitled       ☆ ⋯ │                                                     │
│ │ empty              │                                                     │
├──────────────────────┴─────────────────────────────────────────────────────┤
│ 12 items · saved 14:32                                                 ◢  │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Rail** — 220 px, collapsible to nothing so the canvas can have the whole
  modal. Collapsed state persists.
- **Row** — name over `N items · <relative time>`. The star toggles favourite.
  `⋯` opens Rename / Duplicate / Delete.
- **Title bar** — carries the *active project's name*, which is how you know
  what you are drawing on when the rail is collapsed.
- **Status bar** — element count and the last autosave time. This is the only
  save feedback there is, and it is enough precisely because saving is automatic.

Chrome uses the existing `--ft-*` tokens. The `.drawing-*` classes need writing:
`styles.css` currently contains exactly one occurrence of the string `drawing`.

---

## Autosave

The contract, in order of importance:

1. **Nothing is lost.** Every path out of a project flushes before it leaves:
   switching projects, closing the modal, `visibilitychange`, `beforeunload`.
2. **Idle-debounced, with a ceiling.** 800 ms after the last change, and at most
   5 s since the last write. The ceiling matters because Excalidraw's `onChange`
   fires continuously during a drag, and a two-minute drag must checkpoint.
3. **No write without a change.** Compared with `getSceneVersion(elements)`,
   which Excalidraw exports for exactly this, rather than by stringifying the
   scene. A version tick plus a dirty flag for `appState`/`files` decides it.
4. **The canvas is the source of truth, never storage.** Every flush reads
   `api.getSceneElementsIncludingDeleted()` and `api.getAppState()` at flush
   time. Nothing reads a saved copy back to find out what is on screen.

`updatedAt` and `elementCount` on the project row are written by the same
transaction as the scene, so the rail can never disagree with the canvas.

Deleted elements are kept (`…IncludingDeleted`) because Excalidraw's undo needs
them; they are filtered for `elementCount` so the subtitle counts what you see.

---

## Project operations

**New** — `crypto.randomUUID()`, name from `nextUntitledName(existing)`:
`Untitled drawing`, then `Untitled drawing 2`, `Untitled drawing 3`. Created
with an empty scene, selected immediately, and the rail row enters rename mode
with the text selected, so naming it is one gesture and skipping the naming is
also one gesture.

**Rename** — inline in the row, not a dialog. `Enter` commits, `Escape` reverts,
blur commits. An empty or whitespace-only name reverts rather than erroring:
there is no state in which a project has no name. Duplicate names are allowed —
they are labels, not keys, and the id is what anything points at.

**Favourite** — a boolean, and the primary sort key. Favourites are pinned to
the top under their own heading; unfavouriting drops the project back into date
order in place.

**Search** — filters the rail as you type, over `name`, via the existing
`fuzzyFilter` from `services/fuzzy.ts` so it ranks the way the command palette
and quick-open already do. While a query is active the two headings collapse
into one ranked list — relevance order beats favourites order, because you
searched. Escape clears the query; a second Escape closes the modal.

**Delete** — permanent, so it confirms. The confirmation is in-rail (the row
turns into "Delete *name*? · Delete · Cancel"), not a native dialog: a native
modal for deleting a sketch is out of proportion, and `dialog:allow-confirm` is
one more thing to be wrong. Deleting the active project selects the next most
recent; deleting the last one shows the empty state.

**Duplicate** — copies scene and appState under a new id, named
`<name> copy`. Cheap to build once the scene store exists, and it is the thing
people actually want before trying a variant.

---

## Theme

`useThemeStore`'s theme feeds Excalidraw's `theme` prop directly. The rule that
matters is that `theme` must **not** be baked into the stored
`appState`: a scene saved in dark mode and reopened in light mode has to come
back light. It is applied at render, never persisted.

---

## Fonts

Excalidraw resolves font URLs against `window.EXCALIDRAW_ASSET_PATH` and falls
back to fetching them remotely. A desktop app must not do that, so
`scripts/copy-excalidraw-assets.mjs` copies
`node_modules/@excalidraw/excalidraw/dist/prod/fonts` into
`public/excalidraw-assets/fonts/` and `DrawingCanvas` sets

```ts
window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
```

before the component mounts. The script is plain Node with no dependency, run
from `postinstall` and `prebuild`, in the spirit of `scripts/run-ts-tests.mjs`.

---

## Testing

`npm test` runs `src/services/drawing-project.test.ts` under Node. What it
covers is the logic that is wrong silently rather than loudly:

- `nextUntitledName` — numbering, gaps (`Untitled drawing 3` exists but not 2),
  and names the user has typed that happen to collide.
- `sortProjects` — favourites first, then `updatedAt` descending, stable.
- `searchProjects` — ranked while querying, grouped while not; an empty query is
  not a filter.
- `normalizeName` — trimming, and that a blank name is rejected rather than
  stored.
- `duplicateName` — `x` → `x copy` → `x copy 2`.

IndexedDB, React and Excalidraw are not tested; `npm test` has no DOM, and the
value is in the arithmetic.

---

## Phases

Each phase is independently landable and leaves the app working.

**Phase 1 — Foundation.** `drawing-project.ts` + its tests, `drawing-db.ts`,
`drawingStore.ts`. No UI. Ends with `npm test` and `tsc` green.

**Phase 2 — Canvas.** `DrawingModal.tsx` and `DrawingCanvas.tsx`, the app-shell
wiring they hang off (lazy mount, `⌘⇧X`, the menu item), Excalidraw's CSS, the
vendored fonts, autosave. One implicit project, no rail. Ends with a drawing
that persists across a restart.

**Phase 3 — Projects.** `DrawingRail.tsx`, `DrawingEmpty.tsx`, `.drawing-*`
styles. New, search, favourite, rename, duplicate, delete. This is the feature
as asked for.

**Phase 4 — Polish.** Collapsible rail, keyboard navigation in the rail,
relative timestamps, the status bar, session restore of the active project.

**Phase 5 — Files (separate, needs Rust).** Register `tauri_plugin_fs`, add
`dialog:allow-save` and the `fs:` scopes, then `.excalidraw` import/export and
PNG/SVG export. Held back deliberately: it is the only phase that cannot be
verified without a Tauri build.

---

## Non-goals

- **No collaboration.** Local tool.
- **No thumbnails in the rail.** Rendering a PNG per project per save is real
  cost for a 220 px strip; the element count and timestamp carry the row.
- **No folders or tags.** Favourite plus search is the whole taxonomy until
  there is evidence it is not enough.
- **No cross-device sync.**
