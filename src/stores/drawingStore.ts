/**
 * The drawing tool's state: which projects exist, which one is open, and what
 * the rail is filtering by.
 *
 * The store owns persistence. Components call actions and read state; nothing
 * outside this file talks to `drawing-db.ts`. That is what lets the canvas be a
 * component that knows about exactly one scene — it is handed a project id and
 * hands back changes, and has no idea a list exists.
 *
 * Every action is optimistic: state moves first and the write follows, because
 * a rename that waits for IndexedDB is a rename you can watch happen. The one
 * thing that is *not* optimistic is deletion, which reselects only after the
 * row is gone.
 */

import { create } from "zustand";
import {
  DrawingDoc,
  DrawingPane,
  DrawingProject,
  DrawingScene,
  createProject,
  duplicateName,
  insertProject,
  nextUntitledName,
  normalizeName,
  pickAppState,
  sortProjects,
  visibleElementCount,
} from "../services/drawing-project";
import {
  deleteProjectData,
  isEphemeral,
  listProjects,
  putProject,
  readDoc,
  readScene,
  writeDoc,
  writeScene,
} from "../services/drawing-db";

const RAIL_KEY = "figy-term-drawing-rail";
/**
 * Which drawing to reopen.
 *
 * In `localStorage` rather than beside the projects in IndexedDB: it is a
 * pointer, not a drawing, it is read before the database is open, and losing it
 * costs you one click. The scenes themselves never go near this store — that is
 * the whole point of `drawing-db.ts`.
 */
const ACTIVE_KEY = "figy-term-drawing-active";

interface DrawingState {
  projects: DrawingProject[];
  /** Which project the canvas is showing. Null before the first hydrate, and
   * whenever the list is empty. */
  activeId: string | null;
  query: string;
  /** Which half of the project is on screen. A view mode, not a property of the
   * project: both halves exist whether or not you are looking at them. */
  pane: DrawingPane;
  /** False until `hydrate()` has finished, so the modal can hold its frame. */
  ready: boolean;
  railCollapsed: boolean;
  /** When autosave last committed, for the status bar. */
  lastSavedAt: number | null;
  /** Set when a write fails — a full disk, or a database that would not open. */
  saveError: string | null;

  hydrate: () => Promise<void>;
  create: () => Promise<string>;
  select: (id: string) => void;
  rename: (id: string, name: string) => void;
  toggleFavorite: (id: string) => void;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<string | null>;
  setQuery: (query: string) => void;
  setPane: (pane: DrawingPane) => void;
  toggleRail: () => void;
  loadScene: (projectId: string) => Promise<DrawingScene | null>;
  loadDoc: (projectId: string) => Promise<DrawingDoc | null>;
  persistDoc: (projectId: string, state: string, text: string) => Promise<void>;
  persistScene: (
    projectId: string,
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>
  ) => Promise<void>;
}

/**
 * The read in flight, shared by every caller of `hydrate()`.
 *
 * Checking `ready` is not enough on its own: two callers can both see it false
 * and both start a read, and the slower one then writes its already-stale list
 * over anything created in between — which is exactly what the palette's *New
 * Drawing* does to a window that is mounting at the same moment. Sharing the
 * promise means the list is read once and everyone waits on that.
 */
let hydrating: Promise<void> | null = null;

/** The rail's collapsed state is a UI preference, so it stays in localStorage —
 * it is a boolean, not a drawing. */
function storedRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

function storedActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

/** Remembers the open drawing. Silent on failure — it is a convenience. */
function rememberActive(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // A preference that will not persist is not worth failing over.
  }
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
  projects: [],
  activeId: null,
  query: "",
  pane: "draw",
  ready: false,
  railCollapsed: storedRailCollapsed(),
  lastSavedAt: null,
  saveError: null,

  /**
   * Reads the project list once, on the modal's first open.
   *
   * Re-entrant by design: opening the modal twice before the first read lands
   * must not produce two lists.
   */
  hydrate: async () => {
    if (get().ready) return;
    if (hydrating) return hydrating;

    hydrating = (async () => {
      const projects = sortProjects(await listProjects());
      // The drawing you were last on, if it is still there — a remembered id
      // pointing at a deleted project falls back to the most recent rather
      // than opening nothing.
      const remembered = storedActiveId();
      const restored = projects.some((p) => p.id === remembered) ? remembered : null;

      set((state) => ({
        projects,
        // A project chosen while the read was in flight wins over the stored one.
        activeId: state.activeId ?? restored ?? projects[0]?.id ?? null,
        ready: true,
        saveError: isEphemeral() ? "Drawings are not being saved on this device" : null,
      }));
    })();

    try {
      await hydrating;
    } finally {
      hydrating = null;
    }
  },

  /**
   * `hydrate()` first, always.
   *
   * Creating before the list has been read would put the new project into a
   * state that the in-flight read is about to replace wholesale — it would
   * survive in the database and vanish from the rail. `hydrate` is re-entrant
   * and returns immediately once ready, so this costs nothing after the first
   * call. It is what lets the command palette create a drawing in a window that
   * has never been opened.
   */
  create: async () => {
    await get().hydrate();
    const { projects } = get();
    const project = createProject(nextUntitledName(projects.map((p) => p.name)));
    set({ projects: insertProject(projects, project), activeId: project.id, query: "" });
    rememberActive(project.id);
    await putProject(project);
    return project.id;
  },

  select: (id) => {
    rememberActive(id);
    set({ activeId: id });
  },

  /**
   * A blank name reverts rather than erroring: there is no state in which a
   * project has no name, and an empty rename box is someone changing their mind.
   */
  rename: (id, name) => {
    const clean = normalizeName(name);
    if (!clean) return;
    let updated: DrawingProject | undefined;
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== id || p.name === clean) return p;
        updated = { ...p, name: clean };
        return updated;
      }),
    }));
    if (updated) void putProject(updated);
  },

  toggleFavorite: (id) => {
    let updated: DrawingProject | undefined;
    set((state) => ({
      projects: sortProjects(
        state.projects.map((p) => {
          if (p.id !== id) return p;
          updated = { ...p, favorite: !p.favorite };
          return updated;
        })
      ),
    }));
    if (updated) void putProject(updated);
  },

  /** Deleting the open project selects the next most recent; deleting the last
   * one leaves nothing selected, which is the empty state. */
  remove: async (id) => {
    await deleteProjectData(id);
    set((state) => {
      const projects = state.projects.filter((p) => p.id !== id);
      const activeId = state.activeId === id ? projects[0]?.id ?? null : state.activeId;
      if (activeId !== state.activeId) rememberActive(activeId);
      return { projects, activeId };
    });
  },

  duplicate: async (id) => {
    const { projects } = get();
    const source = projects.find((p) => p.id === id);
    if (!source) return null;

    // A duplicate is the whole project, both halves of it — copying the drawing
    // and silently dropping the notes beside it would be a trap.
    const [scene, doc] = await Promise.all([readScene(id), readDoc(id)]);
    const copy: DrawingProject = {
      ...createProject(duplicateName(source.name, projects.map((p) => p.name))),
      elementCount: source.elementCount,
      noteChars: source.noteChars,
    };

    set((state) => ({ projects: insertProject(state.projects, copy), activeId: copy.id }));
    rememberActive(copy.id);

    if (scene) await writeScene({ ...scene, projectId: copy.id }, copy);
    if (doc) await writeDoc({ ...doc, projectId: copy.id }, copy);
    if (!scene && !doc) await putProject(copy);

    return copy.id;
  },

  setQuery: (query) => set({ query }),

  setPane: (pane) => set({ pane }),

  toggleRail: () =>
    set((state) => {
      const railCollapsed = !state.railCollapsed;
      try {
        localStorage.setItem(RAIL_KEY, railCollapsed ? "1" : "0");
      } catch {
        // A preference that will not persist is not worth failing over.
      }
      return { railCollapsed };
    }),

  loadScene: (projectId) => readScene(projectId),

  loadDoc: (projectId) => readDoc(projectId),

  /**
   * The notes' autosave, mirroring `persistScene`.
   *
   * `noteChars` is derived here rather than passed in, for the same reason the
   * element count is: the row must describe the document being written beside
   * it and cannot be given a number that disagrees.
   *
   * Notes deliberately do **not** bump `updatedAt`. That is the rail's sort key
   * and its subtitle, and both read as "when did this drawing last change".
   */
  persistDoc: async (projectId, state, text) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    const updated: DrawingProject = { ...project, noteChars: text.trim().length };
    const ok = await writeDoc({ projectId, state, text }, updated);

    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
      lastSavedAt: ok ? Date.now() : s.lastSavedAt,
      saveError: ok ? null : "Could not save — the drawing store is full or unavailable",
    }));
  },

  /**
   * Autosave's one entry point.
   *
   * `updatedAt` and `elementCount` are derived here rather than passed in, so
   * the row can only ever describe the scene being written beside it. The
   * project is re-sorted because saving makes it the most recent.
   */
  persistScene: async (projectId, elements, appState, files) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    const updated: DrawingProject = {
      ...project,
      updatedAt: Date.now(),
      elementCount: visibleElementCount(elements as readonly { isDeleted?: boolean }[]),
    };
    const scene: DrawingScene = {
      projectId,
      elements,
      appState: pickAppState(appState),
      files,
    };

    const ok = await writeScene(scene, updated);

    set((state) => ({
      // Replaced in place, deliberately **not** re-sorted. `updatedAt` is the
      // rail's sort key, so sorting here would make the row you are drawing on
      // climb to the top every second or two and shove the rest of the list
      // down under your cursor. The order is settled when the window opens and
      // when you favourite something; it does not shift while you work.
      projects: state.projects.map((p) => (p.id === projectId ? updated : p)),
      lastSavedAt: ok ? updated.updatedAt : state.lastSavedAt,
      saveError: ok ? null : "Could not save — the drawing store is full or unavailable",
    }));
  },
}));
