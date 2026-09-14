/**
 * One project's scene, and the autosave that keeps it.
 *
 * This component knows about exactly one drawing. It is handed a project id,
 * loads that project's scene, and reports changes back through the store — it
 * has no idea a project list exists, which is what makes switching projects a
 * remount rather than a state reconciliation.
 *
 * Three rules, each of which is a bug the previous attempt shipped:
 *
 * 1. **The scene is awaited before `<Excalidraw>` renders.** `initialData` is
 *    read once, on mount. Filling it in an effect — which runs *after* the
 *    mounting render — means it is always `undefined` when it is read, and
 *    restoring silently never works.
 * 2. **A flush writes what `onChange` last reported, never storage and never
 *    the API.** Reading storage back is how an export ships a drawing from ten
 *    seconds ago. Asking the API is worse: the most important flush of all
 *    happens on unmount — closing the window, or switching projects — and by
 *    then Excalidraw has torn itself down and answers with an empty scene,
 *    which then gets written over the drawing. `onChange` is Excalidraw's own
 *    notification and fires for every change, so the last thing it handed us
 *    *is* the live scene, and it survives the component that produced it.
 * 3. **Nothing here reloads the window.** There is a terminal behind this modal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, hashElementsVersion } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useThemeStore } from "../../stores/themeStore";
import { useDrawingStore } from "../../stores/drawingStore";
import { pickAppState } from "../../services/drawing-project";

/**
 * Where Excalidraw looks for its fonts.
 *
 * Set at module scope, which runs when the lazy drawing chunk is first
 * evaluated — before any canvas mounts, and well before the font loader asks.
 * `scripts/copy-excalidraw-assets.mjs` is what puts them there.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

/** How long after the last change to write. */
const IDLE_MS = 800;
/**
 * The longest a change may go unwritten.
 *
 * Excalidraw's `onChange` fires continuously while the pointer is down, so an
 * idle debounce alone would never fire during a long drag. This is the ceiling
 * that makes a two-minute drag checkpoint anyway.
 */
const CEILING_MS = 5000;

// Excalidraw's own types are not imported: they would pull the package into
// anything that touches a scene, and this is the one boundary that needs them.
/* eslint-disable @typescript-eslint/no-explicit-any */
type ExcalidrawApi = any;
type SceneElements = readonly any[];
type SceneAppState = Record<string, unknown>;
type SceneFiles = Record<string, unknown>;

interface DrawingCanvasProps {
  projectId: string;
}

/** What was last written, so an unchanged scene is not written again. */
interface SavedMark {
  version: number;
  files: number;
  appState: string;
}

function markOf(elements: SceneElements, appState: SceneAppState, files: SceneFiles): SavedMark {
  return {
    // Excalidraw exports this for exactly this purpose: a cheap integer that
    // changes when the scene does, instead of stringifying megabytes.
    // (`getSceneVersion` does the same and is deprecated in 0.18.)
    version: hashElementsVersion(elements as never),
    files: Object.keys(files).length,
    // Small — twenty-odd scalars — so comparing it by value is cheap, and it is
    // the only way to notice that someone changed the stroke colour and nothing
    // else.
    appState: JSON.stringify(pickAppState(appState)),
  };
}

function sameMark(a: SavedMark | null, b: SavedMark): boolean {
  return !!a && a.version === b.version && a.files === b.files && a.appState === b.appState;
}

export function DrawingCanvas({ projectId }: DrawingCanvasProps) {
  const theme = useThemeStore((s) => s.theme);
  const loadScene = useDrawingStore((s) => s.loadScene);
  const persistScene = useDrawingStore((s) => s.persistScene);

  /** Null while the scene is being read. Rendering waits on it — see rule 1. */
  const [initialData, setInitialData] = useState<Record<string, unknown> | null>(null);

  const apiRef = useRef<ExcalidrawApi>(null);
  /**
   * The scene as `onChange` last reported it, and the only thing a flush
   * writes.
   *
   * Null until the first change, which is what makes an unmount that happens
   * before anything was drawn a no-op rather than a write of `[]` over whatever
   * is already stored.
   */
  const latestRef = useRef<{
    elements: SceneElements;
    appState: SceneAppState;
    files: SceneFiles;
  } | null>(null);
  const savedRef = useRef<SavedMark | null>(null);
  const idleTimer = useRef<number | null>(null);
  const ceilingTimer = useRef<number | null>(null);

  // The id the timers belong to. A flush that fires after a project switch must
  // write to the project it was scheduled for, never to the one now on screen.
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  const clearTimers = useCallback(() => {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    if (ceilingTimer.current !== null) window.clearTimeout(ceilingTimer.current);
    idleTimer.current = null;
    ceilingTimer.current = null;
  }, []);

  /** Writes the last reported scene. The only thing that saves. */
  const flush = useCallback(() => {
    clearTimers();

    // Nothing has been reported, so nothing has changed since this scene was
    // loaded. Writing here would be writing an empty canvas over a real one.
    const latest = latestRef.current;
    if (!latest) return;

    const mark = markOf(latest.elements, latest.appState, latest.files);
    if (sameMark(savedRef.current, mark)) return;
    savedRef.current = mark;

    void persistScene(projectRef.current, latest.elements, latest.appState, latest.files);
  }, [clearTimers, persistScene]);

  /** Flush is stable, but the listeners below are registered once — they read
   * it through a ref so they never hold a stale closure. */
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // ─── Load ────────────────────────────────────────────────────────────────
  //
  // Keyed remount means this runs once per project. `cancelled` guards the case
  // where someone switches away before a slow read lands.
  useEffect(() => {
    let cancelled = false;
    setInitialData(null);
    savedRef.current = null;
    latestRef.current = null;

    void loadScene(projectId).then((scene) => {
      if (cancelled) return;
      setInitialData({
        elements: scene?.elements ?? [],
        appState: scene?.appState ?? {},
        files: scene?.files ?? {},
        scrollToContent: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, loadScene]);

  // ─── Flush on the way out ────────────────────────────────────────────────
  //
  // Unmount covers both closing the modal and switching projects, because the
  // component is keyed by project id. The window listeners cover the app being
  // hidden or quit with the modal still open.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };
    const onUnload = () => flushRef.current();

    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      flushRef.current();
    };
  }, []);

  const handleChange = useCallback(
    (elements: SceneElements, appState: SceneAppState, files: SceneFiles) => {
      // Recorded before the early return: even a change that does not warrant a
      // write is the freshest scene there is, and the flush on unmount reads it.
      // `elements` here includes deleted ones — Excalidraw's undo needs the
      // tombstones, and `visibleElementCount` filters them for the rail.
      latestRef.current = { elements, appState, files };

      const mark = markOf(elements, appState, files);
      if (sameMark(savedRef.current, mark)) return;

      // Idle: restarted by every change, so a burst writes once at the end.
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => flushRef.current(), IDLE_MS);

      // Ceiling: *not* restarted, so a change that never goes idle still lands.
      if (ceilingTimer.current === null) {
        ceilingTimer.current = window.setTimeout(() => flushRef.current(), CEILING_MS);
      }
    },
    []
  );

  useEffect(() => clearTimers, [clearTimers]);

  if (!initialData) {
    return (
      <div className="drawing-canvas-loading flex h-full w-full items-center justify-center text-ft-text-muted text-xs">
        Opening…
      </div>
    );
  }

  return (
    <div className="drawing-canvas-surface h-full w-full">
      <Excalidraw
        excalidrawAPI={(api: ExcalidrawApi) => {
          apiRef.current = api;
        }}
        initialData={initialData as never}
        // Applied at render and never persisted: the theme belongs to the app,
        // not to the drawing.
        theme={theme}
        onChange={handleChange as never}
        UIOptions={{
          canvasActions: {
            // These open file dialogs, which need a Tauri plugin that is not
            // registered and a capability that is not granted. Phase 5 makes
            // them real; until then they are hidden rather than broken.
            loadScene: false,
            export: false,
            saveToActiveFile: false,
          },
        }}
      />
    </div>
  );
}
