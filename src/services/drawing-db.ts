/**
 * Where drawings live: IndexedDB, database `figy-drawing`.
 *
 * **Not `localStorage`.** An Excalidraw scene carries its images inline as
 * base64 data URLs, so one pasted screenshot is comfortably a megabyte of
 * string. `localStorage` is a single ~5 MB budget for the whole origin, already
 * shared with the terminal session, the editor session, the Claude project list
 * and the settings — overflowing it is not "the drawing did not save", it is
 * `setItem` throwing in whichever writer goes next, which may be the terminal's.
 * IndexedDB is asynchronous, structured-clone (no stringify of a megabyte on
 * the main thread) and its quota is a share of free disk. The reasoning is in
 * `docs/DRAWING.md`.
 *
 * Three stores, because the rail lists fifty projects and must not deserialise
 * fifty scenes to do it — and because opening the canvas should not read the
 * prose, nor the notes the drawing:
 *
 *   projects  keyPath "id"         ← the rail reads only this
 *   scenes    keyPath "projectId"  ← the drawing; read on open, written by autosave
 *   docs      keyPath "projectId"  ← the notes; likewise, and independently
 *
 * A write and the row it describes go in **one** transaction, so a crash cannot
 * leave a row claiming twelve elements over a scene holding three.
 *
 * Nothing here throws into React. A store that will not open (private mode, a
 * corrupt database, a browser that has disabled it) degrades to an in-memory
 * one: the session works, and it is not persisted. That is a much better
 * failure than a modal that will not open.
 */

import { DrawingDoc, DrawingProject, DrawingScene } from "./drawing-project";

const DB_NAME = "figy-drawing";
/** 2 added `docs`. The upgrade only ever creates missing stores, so an existing
 * database gains the new one and keeps every drawing already in it. */
const DB_VERSION = 2;
const PROJECTS = "projects";
const SCENES = "scenes";
const DOCS = "docs";

/**
 * The fallback store, used only when IndexedDB is unavailable.
 *
 * Module-level rather than per-call so that a session which loses the database
 * at least stays coherent with itself until it is closed.
 */
const memory = {
  projects: new Map<string, DrawingProject>(),
  scenes: new Map<string, DrawingScene>(),
  docs: new Map<string, DrawingDoc>(),
  /** Set once opening has failed, so we stop retrying on every keystroke. */
  active: false,
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Opens (and on first run creates) the database. Memoised; never throws. */
export function openDrawingDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let idb: IDBFactory | undefined;
    try {
      idb = globalThis.indexedDB;
    } catch {
      idb = undefined;
    }
    if (!idb) {
      memory.active = true;
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch {
      memory.active = true;
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS)) {
        db.createObjectStore(PROJECTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SCENES)) {
        db.createObjectStore(SCENES, { keyPath: "projectId" });
      }
      if (!db.objectStoreNames.contains(DOCS)) {
        db.createObjectStore(DOCS, { keyPath: "projectId" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // A second tab (or a future version of this app) asking to upgrade must
      // not be deadlocked by this connection holding the old version open.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      memory.active = true;
      resolve(null);
    };
    request.onblocked = () => {
      memory.active = true;
      resolve(null);
    };
  });

  return dbPromise;
}

/** Wraps one transaction as a promise that resolves on `complete`, not on the
 * last request's `success` — the difference is whether the write is durable. */
function commit(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/** Every project row. The rail's only read. */
export async function listProjects(): Promise<DrawingProject[]> {
  const db = await openDrawingDb();
  if (!db) return [...memory.projects.values()];
  try {
    const tx = db.transaction(PROJECTS, "readonly");
    const rows = await request<DrawingProject[]>(
      tx.objectStore(PROJECTS).getAll() as IDBRequest<DrawingProject[]>
    );
    return rows ?? [];
  } catch {
    return [...memory.projects.values()];
  }
}

/** Writes one row. Used by rename, favourite and create — never by autosave,
 * which goes through `writeScene` so the row and the scene move together. */
export async function putProject(project: DrawingProject): Promise<boolean> {
  memory.projects.set(project.id, project);
  const db = await openDrawingDb();
  if (!db) return false;
  try {
    const tx = db.transaction(PROJECTS, "readwrite");
    tx.objectStore(PROJECTS).put(project);
    return await commit(tx);
  } catch {
    return false;
  }
}

export async function readScene(projectId: string): Promise<DrawingScene | null> {
  const db = await openDrawingDb();
  if (!db) return memory.scenes.get(projectId) ?? null;
  try {
    const tx = db.transaction(SCENES, "readonly");
    const scene = await request<DrawingScene>(
      tx.objectStore(SCENES).get(projectId) as IDBRequest<DrawingScene>
    );
    return scene ?? null;
  } catch {
    return memory.scenes.get(projectId) ?? null;
  }
}

/**
 * Autosave's write: the scene and its row, together or not at all.
 *
 * The row carries `updatedAt` and `elementCount`, which are facts *about* the
 * scene. Writing them in a second transaction would open a window in which the
 * rail says one thing and the canvas another, and a crash in that window makes
 * it permanent.
 */
export async function writeScene(scene: DrawingScene, project: DrawingProject): Promise<boolean> {
  memory.scenes.set(scene.projectId, scene);
  memory.projects.set(project.id, project);
  const db = await openDrawingDb();
  if (!db) return false;
  try {
    const tx = db.transaction([SCENES, PROJECTS], "readwrite");
    tx.objectStore(SCENES).put(scene);
    tx.objectStore(PROJECTS).put(project);
    return await commit(tx);
  } catch {
    // A `QuotaExceededError` lands here. The caller reports it; the in-memory
    // copy above means the session itself keeps working.
    return false;
  }
}

/**
 * Everything belonging to one project, removed in a single transaction.
 *
 * The row, the scene and the notes go together or not at all — a half-deleted
 * project would leave a drawing nothing can reach and storage nothing can free.
 */
export async function deleteProjectData(projectId: string): Promise<boolean> {
  memory.projects.delete(projectId);
  memory.scenes.delete(projectId);
  memory.docs.delete(projectId);
  const db = await openDrawingDb();
  if (!db) return false;
  try {
    const tx = db.transaction([SCENES, DOCS, PROJECTS], "readwrite");
    tx.objectStore(SCENES).delete(projectId);
    tx.objectStore(DOCS).delete(projectId);
    tx.objectStore(PROJECTS).delete(projectId);
    return await commit(tx);
  } catch {
    return false;
  }
}

export async function readDoc(projectId: string): Promise<DrawingDoc | null> {
  const db = await openDrawingDb();
  if (!db) return memory.docs.get(projectId) ?? null;
  try {
    const tx = db.transaction(DOCS, "readonly");
    const doc = await request<DrawingDoc>(
      tx.objectStore(DOCS).get(projectId) as IDBRequest<DrawingDoc>
    );
    return doc ?? null;
  } catch {
    return memory.docs.get(projectId) ?? null;
  }
}

/**
 * The notes and their row, together — the same rule `writeScene` follows.
 *
 * The row carries `noteChars`, which is a fact about the document beside it;
 * writing them separately would open a window in which the rail marks a project
 * as having notes that are not there, and a crash in that window makes it
 * permanent.
 */
export async function writeDoc(doc: DrawingDoc, project: DrawingProject): Promise<boolean> {
  memory.docs.set(doc.projectId, doc);
  memory.projects.set(project.id, project);
  const db = await openDrawingDb();
  if (!db) return false;
  try {
    const tx = db.transaction([DOCS, PROJECTS], "readwrite");
    tx.objectStore(DOCS).put(doc);
    tx.objectStore(PROJECTS).put(project);
    return await commit(tx);
  } catch {
    return false;
  }
}

/** Whether drawings are actually being persisted, for the status bar to say so. */
export function isEphemeral(): boolean {
  return memory.active;
}
