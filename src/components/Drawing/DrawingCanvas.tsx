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
import { useAutosave } from "./useAutosave";

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

/** Everything one save needs, as `onChange` hands it over. */
interface SceneSnapshot {
  elements: SceneElements;
  appState: SceneAppState;
  files: SceneFiles;
}

/**
 * A cheap identity for a scene, so an unchanged one is not written twice.
 *
 * `hashElementsVersion` is Excalidraw's own — an integer that moves when the
 * scene does, instead of stringifying megabytes. (`getSceneVersion` does the
 * same and is deprecated in 0.18.) The file count catches a pasted image, and
 * the whitelisted `appState` catches someone changing the stroke colour and
 * nothing else.
 */
function sceneMark({ elements, appState, files }: SceneSnapshot): string {
  return [
    hashElementsVersion(elements as never),
    Object.keys(files).length,
    JSON.stringify(pickAppState(appState)),
  ].join("|");
}

export function DrawingCanvas({ projectId }: DrawingCanvasProps) {
  const theme = useThemeStore((s) => s.theme);
  const loadScene = useDrawingStore((s) => s.loadScene);
  const persistScene = useDrawingStore((s) => s.persistScene);

  /** Null while the scene is being read. Rendering waits on it — see rule 1. */
  const [initialData, setInitialData] = useState<Record<string, unknown> | null>(null);

  const apiRef = useRef<ExcalidrawApi>(null);

  // The project a scheduled write belongs to. A flush that fires after a switch
  // must write to the project it was scheduled for, never the one now on screen.
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  const autosave = useAutosave<SceneSnapshot>({
    mark: sceneMark,
    write: ({ elements, appState, files }) =>
      void persistScene(projectRef.current, elements, appState, files),
  });

  // ─── Load ────────────────────────────────────────────────────────────────
  //
  // Keyed remount means this runs once per project. `cancelled` guards the case
  // where someone switches away before a slow read lands.
  useEffect(() => {
    let cancelled = false;
    setInitialData(null);
    autosave.reset();

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
  }, [projectId, loadScene, autosave]);

  const handleChange = useCallback(
    (elements: SceneElements, appState: SceneAppState, files: SceneFiles) => {
      autosave.record({ elements, appState, files });
    },
    [autosave]
  );

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
