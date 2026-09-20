/**
 * The API client window.
 *
 * The frame, the URL bar and the keyboard. Everything that outlives the window
 * — the tree, the tabs, the drafts, the history — is in `stores/apiStore.ts`,
 * and everything that goes on the wire is in Rust. What is left here is layout
 * and which key does what.
 *
 * Built on the same primitives as the browser, editor and drawing windows
 * (`useDraggableModal`, `OverlayPortal`, the overlay stack), so it stacks and
 * behaves like they do.
 *
 * See `docs/API-CLIENT.md` for the phases; `docs/API-CLIENT-TASKS.md` for what
 * is and isn't built.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
  PictureInPicture2,
  Save,
  Send,
  TriangleAlert,
  X,
} from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, releaseFront } from "../../services/overlay-stack";
import {
  fullscreenRect,
  pictureInPictureRect,
  useDraggableModal,
} from "../../hooks/useDraggableModal";
import { onApiProgress } from "../../services/api/client";
import { isSendableUrl } from "../../services/api/url";
import { formatBytes } from "../../services/api/format";
import { isDirty, useApiStore } from "../../stores/apiStore";
import { useEditorStore } from "../../stores/editorStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { ancestry, authChain } from "../../services/api/scopes";
import { effectiveAuth } from "../../services/api/auth";
import { collectScripts } from "../../services/api/scripts/events";
import { emptyScope } from "../../services/api/scope";
import { crumbsOf, isWithin } from "../../services/api/tree";
import { onSync } from "../../services/api/sync";
import * as syncService from "../../services/api/sync";
import { ApiRail } from "./ApiRail";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { EditorDialog } from "../Editor/EditorDialog";
import { EmptyState } from "./EmptyState";
import { ExamplePane } from "./ExamplePane";
import { ConnectionPanel } from "./ConnectionPanel";
import { ConsolePanel } from "./ConsolePanel";
import { EnvironmentPane } from "./EnvironmentPane";
import { EnvironmentPeek } from "./EnvironmentPeek";
import { ImportReport } from "./ImportReport";
import { RunnerPanel } from "./RunnerPanel";
import { VariableStrip } from "./VariableStrip";
import { RequestTabs } from "./RequestTabs";
import { VariableInput, VariableInputHandle } from "./VariableInput";
import { MethodSelect } from "./MethodSelect";
import { Breadcrumb } from "./Breadcrumb";
import { SyncPane } from "./SyncPane";
import { SaveVariableDialog, VariableTarget } from "./SaveVariableDialog";
import { RequestPane } from "./RequestPane";
import { ScopePane } from "./ScopePane";
import { ResponsePane } from "./ResponsePane";

export interface ApiModalProps {
  visible: boolean;
  onClose: () => void;
}

const MIN_SIZE = { w: 820, h: 520 };
const MAX_SIZE = { w: 2400, h: 1600 };
const DEFAULT_SIZE = { w: 1180, h: 760 };

export function ApiModal({ visible, onClose }: ApiModalProps) {
  const [pipMode, setPipMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<VariableInputHandle>(null);

  const ready = useApiStore((s) => s.ready);
  const storeError = useApiStore((s) => s.storeError);
  const collections = useApiStore((s) => s.collections);
  const tabs = useApiStore((s) => s.tabs);
  const activeTabId = useApiStore((s) => s.activeTabId);
  const hydrate = useApiStore((s) => s.hydrate);
  const openScratch = useApiStore((s) => s.openScratch);
  const closeTab = useApiStore((s) => s.closeTab);
  const closeTabs = useApiStore((s) => s.closeTabs);
  const history = useApiStore((s) => s.history);
  const openHistory = useApiStore((s) => s.openHistory);
  const importFiles = useApiStore((s) => s.importFiles);
  const setActiveTab = useApiStore((s) => s.setActiveTab);
  const patchDraft = useApiStore((s) => s.patchDraft);
  const setParams = useApiStore((s) => s.setParams);
  const patchTab = useApiStore((s) => s.patchTab);
  const toggleRail = useApiStore((s) => s.toggleRail);
  const split = useApiStore((s) => s.split);
  const splitSizes = useApiStore((s) => s.splitSizes);
  const setSplit = useApiStore((s) => s.setSplit);
  const setSplitSize = useApiStore((s) => s.setSplitSize);
  const patchScope = useApiStore((s) => s.patchScope);
  const saveScope = useApiStore((s) => s.saveScope);
  const openItem = useApiStore((s) => s.openItem);
  const openScope = useApiStore((s) => s.openScope);
  const renameItem = useApiStore((s) => s.renameItem);
  const applyScriptChanges = useApiStore((s) => s.applyScriptChanges);

  /** A piece of a response on its way to becoming a variable. */
  const [savingVariable, setSavingVariable] = useState<string | null>(null);
  const saveTab = useApiStore((s) => s.saveTab);
  const saveTabInto = useApiStore((s) => s.saveTabInto);
  const createCollection = useApiStore((s) => s.createCollection);
  const send = useApiStore((s) => s.send);
  const cancel = useApiStore((s) => s.cancel);
  const pasteCurl = useApiStore((s) => s.pasteCurl);
  const report = useApiStore((s) => s.report);
  const dismissReport = useApiStore((s) => s.dismissReport);
  const items = useApiStore((s) => s.items);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useApiStore((s) => s.setActiveEnvironment);
  const openEnvironment = useApiStore((s) => s.openEnvironment);
  const patchEnv = useApiStore((s) => s.patchEnv);
  const saveEnvTab = useApiStore((s) => s.saveEnvTab);
  const deleteEnvironment = useApiStore((s) => s.deleteEnvironment);
  const scopesFor = useApiStore((s) => s.scopesFor);
  const syncStatus = useApiStore((s) => s.sync);
  const connecting = useApiStore((s) => s.connecting);
  const syncing = useApiStore((s) => s.syncing);
  const syncStopping = useApiStore((s) => s.syncStopping);
  const refreshSync = useApiStore((s) => s.refreshSync);
  const openConnection = useApiStore((s) => s.openConnection);
  const syncNow = useApiStore((s) => s.syncNow);
  const stopSync = useApiStore((s) => s.stopSync);
  const openSync = useApiStore((s) => s.openSync);
  const syncFinished = useApiStore((s) => s.syncFinished);
  const run = useApiStore((s) => s.run);
  const openRunner = useApiStore((s) => s.openRunner);
  const setRunOptions = useApiStore((s) => s.setRunOptions);
  const startRun = useApiStore((s) => s.startRun);
  const stopRun = useApiStore((s) => s.stopRun);
  const loadRunData = useApiStore((s) => s.loadRunData);
  const clearRunData = useApiStore((s) => s.clearRunData);
  const exportRun = useApiStore((s) => s.exportRun);
  const saveExample = useApiStore((s) => s.saveExample);
  const deleteExample = useApiStore((s) => s.deleteExample);
  const renameExampleTab = useApiStore((s) => s.renameExampleTab);
  const saveExampleTab = useApiStore((s) => s.saveExampleTab);
  const consoleEntries = useApiStore((s) => s.console);
  const consoleOpen = useApiStore((s) => s.consoleOpen);
  const toggleConsole = useApiStore((s) => s.toggleConsole);
  const clearConsole = useApiStore((s) => s.clearConsole);
  const syncError = useApiStore((s) => s.syncError);
  const setSyncError = useApiStore((s) => s.setSyncError);

  /** What is about to be deleted, and what to do if it is confirmed. Nothing
   * in this window deletes without asking; there is no undo behind any of it. */
  const [confirming, setConfirming] = useState<{
    title: string;
    message: string;
    run: () => void;
  } | null>(null);

  const tab = tabs.find((row) => row.id === activeTabId) ?? null;

  /**
   * What the response body is drawn with.
   *
   * The editor's settings rather than this window's, because the whole point of
   * putting the body in CodeMirror is that a response and a file look like the
   * same application. The same sentinel rule the editor uses: a blank face or a
   * zero size means "follow the terminal", so somebody who never chose one
   * still moves when the terminal does.
   */
  const theme = useThemeStore((s) => s.theme);
  const settings = useSettingsStore((s) => s.settings);
  const editorSettings = useEditorStore((s) => s.settings);
  /**
   * The chain the active request sits in.
   *
   * Computed once and shared by the URL bar, the header table and the strip:
   * `scopesFor` rebuilds the array on every call, and handing a fresh one to
   * the fields each render would have them re-decorating continuously.
   */
  const scopes = useMemo(
    () => (tab ? scopesFor(tab.id) : []),
    // `scopesFor` reads the tree and the environments out of the store, so the
    // things it depends on are listed rather than the function alone.
    [scopesFor, tab?.id, items, collections, environments, activeEnvironmentId]
  );

  const bodyFont = useMemo(
    () => ({
      family: editorSettings.fontFamily || settings.fontFamily,
      size: editorSettings.fontSize || settings.fontSize,
    }),
    [editorSettings.fontFamily, editorSettings.fontSize, settings.fontFamily, settings.fontSize]
  );

  /**
   * What the active request would inherit, for the Auth tab's one-line answer.
   *
   * Computed here rather than in the panel: the chain needs the whole tree, and
   * a panel that reached into the store to answer a question about its own
   * props would be a panel that cannot be reused.
   *
   * The request's own link is dropped first — inheriting means taking what the
   * folder or collection says, so its own block is not an answer to "what would
   * I get if I had none".
   */
  // The row the tab is on: a request, or the folder a folder tab is editing.
  // A collection tab finds nothing here, which is correct — there is no level
  // above a collection for it to inherit from.
  const chainId = tab?.itemId ?? tab?.scopeId ?? null;
  const chainItem = chainId ? items.find((row) => row.id === chainId) ?? null : null;
  const chainInput = {
    item: chainItem,
    items,
    collections,
    environments,
    activeEnvironmentId,
  };
  const above = authChain(chainInput).slice(1);
  const inherited = effectiveAuth(above);
  const answered = above.findIndex((block) => block !== null);
  const ancestors = ancestry(chainItem, items).slice(1);
  const inheritedFrom =
    answered === -1
      ? null
      : answered < ancestors.length
        ? ancestors[answered]!.name
        : collections.find((row) => row.id === chainItem?.collectionId)?.name ?? null;

  /**
   * The scripts that run around this request without belonging to it.
   *
   * The item is passed with its own events blanked, so the walk still covers the
   * folders and the collection while the request's own script — which the panel
   * has in an editor two lines below — is not also listed as something it
   * inherits.
   */
  const scriptItem = chainItem ? { ...chainItem, events: null } : null;
  const inheritedBefore = collectScripts({
    item: scriptItem,
    items,
    collections,
    kind: "prerequest",
  });
  const inheritedAfter = collectScripts({
    item: scriptItem,
    items,
    collections,
    kind: "test",
  });

  const { style, onDragStart, onResizeStart, place, reset } = useDraggableModal({
    defaultSize: DEFAULT_SIZE,
    minSize: MIN_SIZE,
    maxSize: MAX_SIZE,
    elementRef: modalRef,
  });

  // ─── Stacking ────────────────────────────────────────────────────────────

  const [frontZ, setFrontZ] = useState<number | null>(null);
  const raise = useCallback(() => setFrontZ(claimFront("api")), []);

  useEffect(() => {
    if (visible) {
      raise();
      return;
    }
    releaseFront("api");
    setFrontZ(null);
  }, [visible, raise]);

  // ─── Opening ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return;
    void hydrate();
    void refreshSync();
  }, [visible, hydrate, refreshSync]);

  /**
   * A pass that finished anywhere — the interval, another window, a manual
   * sync — reloads the tree here. The timer runs in Rust whether or not this
   * window is open, so the first thing it does on opening may be to find work
   * that arrived while it was closed.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dropped = false;
    void onSync((outcome) => void syncFinished(outcome)).then((off) => {
      if (dropped) off();
      else unlisten = off;
    });
    return () => {
      dropped = true;
      unlisten?.();
    };
  }, [syncFinished]);

  /** Syncing when the window comes back is how a second machine's work shows
   * up without anybody pressing anything. */
  useEffect(() => {
    if (!visible) return;
    const onFocus = () => {
      const status = useApiStore.getState().sync;
      // An automatic pass, so it asks `auto` as well as whether a database is
      // connected: "only when I press Sync" has to mean this too.
      if (status?.config.enabled && status.config.auto && status.config.syncOnFocus) {
        void syncNow();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, syncNow]);

  useEffect(() => {
    if (visible) setTimeout(() => urlRef.current?.focus(), 50);
  }, [visible]);

  /**
   * Download progress, routed to whichever tab is waiting for it.
   *
   * Registered once for the window rather than per tab: several requests can be
   * in flight at once, and the event carries the id that says which is which.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dropped = false;
    void onApiProgress((progress) => {
      const target = useApiStore
        .getState()
        .tabs.find((row) => row.sendingId === progress.id);
      if (target) patchTab(target.id, { received: progress.received });
    }).then((off) => {
      if (dropped) off();
      else unlisten = off;
    });
    return () => {
      dropped = true;
      unlisten?.();
    };
  }, [patchTab]);

  // ─── Saving ──────────────────────────────────────────────────────────────

  /**
   * ⌘S on a scratch tab has to put it somewhere.
   *
   * Rather than a dialog, it goes into the first collection — making one if
   * there are none — and starts a rename in the rail. A save that asks three
   * questions is a save people stop pressing.
   */
  /** The same picker the sidebar's Import button opens. */
  const importPicked = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "Collections and environments", extensions: ["json"] }],
      title: "Import collections",
    });
    if (picked) await importFiles(Array.isArray(picked) ? picked : [picked]);
  }, [importFiles]);

  const save = useCallback(async () => {
    if (!tab) return;
    // A folder or collection tab already has a row; there is nothing to choose
    // a home for, so it never reaches the "save into a collection" path below.
    if (tab.kind !== "request") {
      await saveTab(tab.id);
      return;
    }
    if (tab.itemId) {
      await saveTab(tab.id);
      return;
    }
    let collectionId = collections[0]?.id;
    if (!collectionId) {
      await createCollection("My collection");
      collectionId = useApiStore.getState().collections[0]?.id;
    }
    if (collectionId) await saveTabInto(tab.id, collectionId, null);
  }, [tab, collections, saveTab, saveTabInto, createCollection]);

  // ─── Window modes ────────────────────────────────────────────────────────

  const toggleFullscreen = useCallback(() => {
    setPipMode(false);
    setFullscreen((prev) => {
      if (prev) {
        reset();
      } else {
        const rect = fullscreenRect();
        place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
      }
      return !prev;
    });
  }, [place, reset]);

  useEffect(() => {
    if (!fullscreen) return;
    const follow = () => {
      const rect = fullscreenRect();
      place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
    };
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [fullscreen, place]);

  const togglePip = useCallback(() => {
    setFullscreen(false);
    setPipMode((prev) => {
      if (prev) {
        reset();
      } else {
        const rect = pictureInPictureRect();
        place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
      }
      return !prev;
    });
  }, [place, reset]);

  /**
   * The window's own chords. Escape closes, ⌘Enter sends, ⌘S saves, ⌘W closes
   * the tab — all stopped here rather than bubbling to the shell, which would
   * otherwise read them as terminal input.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        // The report is on top of the window, so it takes Escape first — the
        // same rule the rest of the app's overlays follow.
        if (report) dismissReport();
        else if (run.open) openRunner(null);
        else onClose();
        return;
      }
      if (mod && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (tab && !tab.sendingId) void send(tab.id);
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void save();
        return;
      }
      if (mod && e.key.toLowerCase() === "w" && tab) {
        e.preventDefault();
        e.stopPropagation();
        closeTab(tab.id);
        return;
      }
      // The same key the editor window uses for its own sidebar. Shift is
      // excluded deliberately: ⌘⇧B is the browser window, and swallowing it
      // here would make that shortcut dead wherever this window has focus.
      if (mod && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        e.stopPropagation();
        toggleRail();
        return;
      }
      // ⌘J for the panel at the bottom, as in most editors.
      if (mod && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        e.stopPropagation();
        toggleConsole();
        return;
      }
      // ⌘T for a new one — and the way back from an empty window, which is
      // reachable now that closing the last tab leaves it empty.
      if (mod && !e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        e.stopPropagation();
        openScratch();
      }
    },
    [
      onClose,
      send,
      save,
      closeTab,
      tab,
      report,
      dismissReport,
      openEnvironment,
      run.open,
      openRunner,
      toggleRail,
      toggleConsole,
      openScratch,
    ]
  );

  if (!visible) return null;

  const sending = tab?.sendingId != null;
  const canSend = tab ? isSendableUrl(tab.draft.url) : false;
  const dirty = tab ? isDirty(tab) : false;

  const modal = (
    <div
      ref={modalRef}
      className={`api-modal flex flex-col overflow-hidden bg-ft-bg border border-ft-border shadow-2xl ${
        fullscreen ? "rounded-none" : "rounded-xl"
      }`}
      style={pipMode ? { ...style, zIndex: frontZ ?? undefined } : style}
      onPointerDownCapture={raise}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      /*
        No browser context menu anywhere in this window.

        The places worth right-clicking have menus of their own — the tree, the
        tab strip — and they call `preventDefault` before this ever runs. What
        is left is everywhere else, where the webview's own menu offered Back,
        Reload and Inspect for a window that has no pages to go back to.

        A text field is the exception: cut, copy, paste and the spelling
        suggestions are the platform's to provide, and reimplementing them would
        be worse than the menu this removes.
      */
      onContextMenu={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
      tabIndex={-1}
    >
      {/* Title bar — also the drag handle, and the same chrome the browser and
          drawing windows use so the three line up. */}
      <div
        className="browser-chrome browser-tabstrip api-titlebar flex items-center gap-1 px-2 pt-1.5 pb-1.5 select-none cursor-grab active:cursor-grabbing"
        onPointerDown={onDragStart}
      >
        <div className="browser-brand flex items-center gap-2 pl-1 pr-2.5 mr-1 shrink-0">
          <img src="/logo.png" alt="" className="h-4 w-auto shrink-0" />
          <span className="browser-brand-title text-[11px] font-semibold whitespace-nowrap">
            Figy API
          </span>
        </div>

        <div className="flex-1 min-w-0" />

        <div className="flex items-center gap-1 shrink-0">
          {/* Shows the layout it would switch to, not the one in use: a button
              that pictures the current state reads as a label, and people press
              it expecting nothing to happen. */}
          <button
            className="p-1.5 rounded text-ft-text-muted hover:bg-ft-surface hover:text-ft-text"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setSplit(split === "bottom" ? "right" : "bottom")}
            title={
              split === "bottom"
                ? "Put the response beside the request"
                : "Put the response below the request"
            }
            aria-label={
              split === "bottom"
                ? "Put the response beside the request"
                : "Put the response below the request"
            }
          >
            {split === "bottom" ? <PanelRight size={14} /> : <PanelBottom size={14} />}
          </button>
          <button
            className={`p-1.5 rounded hover:bg-ft-surface ${pipMode ? "text-ft-accent" : "text-ft-text-muted"}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={togglePip}
            title={pipMode ? "Exit picture-in-picture" : "Picture-in-picture"}
            aria-label={pipMode ? "Exit picture-in-picture" : "Picture-in-picture"}
          >
            <PictureInPicture2 size={14} />
          </button>
          <button
            className={`p-1.5 rounded hover:bg-ft-surface ${fullscreen ? "text-ft-accent" : "text-ft-text-muted"}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleFullscreen}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="p-1.5 rounded text-ft-text-muted hover:bg-red-500/20 hover:text-red-400"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
            title="Close API client"
            aria-label="Close API client"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {storeError && (
        <div className="px-3 py-1.5 shrink-0 text-[11px] text-ft-error border-b border-ft-border">
          Collections could not be opened: {storeError}
        </div>
      )}

      {/* Sync is the one thing here that can fail without anything being wrong
          locally — no network, a keychain prompt dismissed, a project moved.
          It gets its own line, in the warning colour rather than the error
          one, and it says what still works. */}
      {syncError && (
        <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[11px] text-ft-warning border-b border-ft-border">
          <TriangleAlert size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={syncError}>
            Syncing is paused: {syncError}
          </span>
          <span className="shrink-0 text-ft-text-muted">
            Your collections are on this machine and open as usual.
          </span>
          <button className="api-chip-action" onClick={() => openConnection(true)}>
            Connection
          </button>
          <button className="api-chip-action" onClick={() => setSyncError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="relative flex-1 min-h-0 flex">
        {report && <ImportReport report={report} onDismiss={dismissReport} />}

        {connecting && (
          <ConnectionPanel
            status={syncStatus}
            busy={syncing}
            onClose={() => openConnection(false)}
            onChanged={() => void refreshSync()}
            onSyncNow={() => void syncNow()}
            onRestore={() => {
              void syncService
                .restore()
                .then(() => openConnection(false))
                .catch(() => undefined);
            }}
          />
        )}

        {run.open && (
          <RunnerPanel
            run={run}
            onClose={() => openRunner(null)}
            onOptions={setRunOptions}
            onStart={() => void startRun()}
            onStop={stopRun}
            onLoadData={(path) => void loadRunData(path)}
            onClearData={clearRunData}
            onExport={(path) => void exportRun(path)}
          />
        )}

        {/* The rail sets its own width: it is 11 columns of icon strip when
            collapsed and that plus the section when it is not, which is a
            number only it knows. */}
        <ApiRail />

        <div className="flex-1 min-w-0 flex flex-col">
          <RequestTabs
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTab}
            onClose={closeTab}
            onCloseMany={closeTabs}
            onNew={openScratch}
            // On this row because it applies to the tab that is open: the
            // request below resolves with whatever is selected here. In the
            // title bar it read as a property of the window.
            trailing={
              <EnvironmentPeek
                environments={environments}
                activeId={activeEnvironmentId}
                onSelect={setActiveEnvironment}
                onEdit={openEnvironment}
              />
            }
          />

          {!tab ? (
            <EmptyState
              ready={ready}
              hasCollections={collections.length > 0}
              history={history}
              onNew={openScratch}
              onImport={() => void importPicked()}
              onNewCollection={() => void createCollection("New collection")}
              onOpenHistory={(id) => void openHistory(id)}
            />
          ) : tab.kind === "sync" ? (
            <SyncPane
              status={syncStatus}
              syncing={syncing}
              stopping={syncStopping}
              onSyncNow={() => void syncNow()}
              onStopSync={() => void stopSync()}
              onOpenConnection={() => openConnection(true)}
              onRefresh={() => void refreshSync()}
            />
          ) : tab.kind === "environment" ? (
            <EnvironmentPane
              draft={tab.env ?? { name: "", isGlobal: false, variables: [] }}
              onChange={(patch) => patchEnv(tab.id, patch)}
              onSave={() => void saveEnvTab(tab.id)}
              dirty={dirty}
              scopes={scopes}
              active={tab.scopeId !== null && tab.scopeId === activeEnvironmentId}
              onUse={() =>
                setActiveEnvironment(
                  tab.scopeId === activeEnvironmentId ? null : tab.scopeId
                )
              }
              // Nothing to delete until it has been saved once.
              onDelete={
                tab.scopeId && tab.scopeId !== "new"
                  ? () =>
                      setConfirming({
                        title: "Delete this environment?",
                        message: `"${tab.env?.name ?? tab.name}" and its ${
                          tab.env?.variables.length ?? 0
                        } variable${
                          (tab.env?.variables.length ?? 0) === 1 ? "" : "s"
                        } will be deleted. Anything using them will stop resolving.`,
                        run: () => {
                          const id = tab.scopeId!;
                          closeTab(tab.id);
                          void deleteEnvironment(id);
                        },
                      })
                  : null
              }
            />
          ) : tab.kind === "example" ? (
            <ExamplePane
              onSaveVariable={setSavingVariable}
              example={tab.example}
              name={tab.exampleName}
              onNameChange={(name) => renameExampleTab(tab.id, name)}
              onSave={() => void saveExampleTab(tab.id)}
              dirty={dirty}
              onOpenRequest={
                tab.exampleOwner ? () => void openItem(tab.exampleOwner!) : null
              }
              onDelete={() =>
                setConfirming({
                  title: "Delete this example?",
                  message: `"${tab.exampleName}" is a saved response. The request it belongs to is not affected.`,
                  run: () => {
                    const id = tab.example?.id;
                    if (id) void deleteExample(id);
                  },
                })
              }
            />
          ) : tab.kind === "folder" || tab.kind === "collection" ? (
            // A folder or collection has no URL bar and no response, so it
            // takes the whole pane rather than sitting in the request's frame
            // with two thirds of it disabled.
            <ScopePane
              kind={tab.kind}
              draft={tab.scope ?? emptyScope()}
              tab={tab.scopeTab}
              onTabChange={(value) => patchTab(tab.id, { scopeTab: value })}
              onChange={(patch) => patchScope(tab.id, patch)}
              onSave={() => void saveScope(tab.id)}
              dirty={dirty}
              contents={
                tab.kind === "collection"
                  ? items.filter((row) => row.collectionId === tab.scopeId)
                  : items.filter(
                      (row) => tab.scopeId !== null && isWithin(items, tab.scopeId, row.id) && row.id !== tab.scopeId
                    )
              }
              inherited={inherited}
              inheritedFrom={inheritedFrom}
              inheritedBefore={inheritedBefore}
              inheritedAfter={inheritedAfter}
              scopes={scopes}
              onOpenItem={(id) => void openItem(id)}
            />
          ) : (
            <>
              {/* Where this request lives. Nothing is drawn for one that has
                  not been saved anywhere — it has no trail, and a row of
                  chevrons around "Untitled" is furniture. */}
              <Breadcrumb
                crumbs={crumbsOf(items, collections, tab.itemId)}
                onOpen={(crumb) =>
                  openScope(crumb.kind === "collection" ? "collection" : "folder", crumb.id)
                }
                onRename={
                  tab.itemId ? (name) => void renameItem(tab.itemId!, name) : undefined
                }
              />

              {/* URL bar */}
              <div className="flex items-center gap-2 px-2 pb-2 pt-1 border-b border-ft-border shrink-0">
                {/* One box, not two. The method and the URL are one thing —
                    `POST /users` — and two bordered controls side by side read
                    as two unrelated settings. The border and the focus ring
                    live on the wrapper, so typing in the URL lights the whole
                    control the way a single field would. */}
                <div className="api-urlbar flex-1 min-w-0">
                  <MethodSelect
                    value={tab.draft.method}
                    onChange={(method) => patchDraft(tab.id, { method })}
                  />
                  <span className="api-urlbar-divider" />

                <VariableInput
                  className="api-url-bare flex-1 min-w-0"
                  value={tab.draft.url}
                  scopes={scopes}
                  placeholder="api.example.com/v1/users  ·  localhost:3000/health"
                  onChange={(url) => {
                    patchDraft(tab.id, { url });
                    // A new target is a new trust decision.
                    if (!tab.verifyTls) patchTab(tab.id, { verifyTls: true });
                  }}
                  onEnter={() => {
                    if (!sending) void send(tab.id);
                  }}
                  // A pasted cURL command becomes the whole request rather
                  // than a very long URL. Anything else pastes as usual.
                  onPaste={(text) => pasteCurl(tab.id, text)}
                  ariaLabel="URL"
                />
                </div>

                <button
                  className={`api-icon-button ${dirty ? "text-ft-accent" : "text-ft-text-muted"}`}
                  onClick={() => void save()}
                  title={tab.itemId ? "Save (⌘S)" : "Save to a collection (⌘S)"}
                  aria-label="Save request"
                >
                  <Save size={13} />
                </button>

                {sending ? (
                  <button
                    className="api-button api-button-cancel"
                    onClick={() => cancel(tab.id)}
                    title="Cancel"
                  >
                    <Ban size={13} />
                    Cancel
                  </button>
                ) : (
                  <button
                    className="api-button"
                    disabled={!canSend}
                    onClick={() => void send(tab.id)}
                    title="Send (⌘↵)"
                  >
                    <Send size={13} />
                    Send
                  </button>
                )}
              </div>

              <VariableStrip
                unresolved={tab.unresolved}
                onSendAnyway={() => void send(tab.id, { force: true })}
                onOpenEnvironments={() => openEnvironment(activeEnvironmentId ?? "new")}
              />

              <div className="flex-1 min-h-0">
                {/* Keyed by layout so the group remounts when it is switched:
                    `defaultLayout` is read once, and without the remount the
                    new orientation would open on the old one's proportions. */}
                <Group
                  key={split}
                  orientation={split === "bottom" ? "vertical" : "horizontal"}
                  className="h-full w-full"
                  defaultLayout={splitSizes[split]}
                  onLayoutChanged={(layout, meta) => {
                    // Only a drag or a resize key. The library also reports the
                    // layout on mount and on a constraint recompute, and saving
                    // those would overwrite the position somebody chose.
                    if (meta.isUserInteraction) setSplitSize(split, layout);
                  }}
                >
                  <Panel id="request" minSize="20%">
                    <RequestPane
                      tab={tab.requestTab}
                      onTabChange={(value) => patchTab(tab.id, { requestTab: value })}
                      headers={tab.draft.headers}
                      onHeadersChange={(headers) => patchDraft(tab.id, { headers })}
                      params={tab.params}
                      onParamsChange={(params) => setParams(tab.id, params)}
                      body={tab.draft.body}
                      onBodyChange={(body) => patchDraft(tab.id, { body })}
                      draft={tab.draft}
                      codeTarget={tab.codeTarget}
                      onCodeTargetChange={(codeTarget) => patchTab(tab.id, { codeTarget })}
                      onAuthChange={(auth) => patchDraft(tab.id, { auth })}
                      onSettingsChange={(settings) => patchDraft(tab.id, { settings })}
                      onScriptsChange={(scripts) => patchDraft(tab.id, { scripts })}
                      inheritedBefore={inheritedBefore}
                      inheritedAfter={inheritedAfter}
                      savable={Boolean(tab.itemId)}
                      inherited={inherited}
                      inheritedFrom={inheritedFrom}
                      scopes={scopes}
                    />
                  </Panel>
                  <Separator
                    className={`api-split-handle ${split === "bottom" ? "row" : ""}`}
                  />
                  <Panel id="response" minSize="20%">
                    <ResponsePane
                      response={tab.response}
                      error={tab.error}
                      sending={sending}
                      received={tab.received}
                      tab={tab.responseTab}
                      onTabChange={(value) => patchTab(tab.id, { responseTab: value })}
                      pretty={tab.pretty}
                      onPrettyChange={(pretty) => patchTab(tab.id, { pretty })}
                      wrap={tab.wrap}
                      onWrapChange={(wrap) => patchTab(tab.id, { wrap })}
                      dark={theme === "dark"}
                      fontFamily={bodyFont.family}
                      fontSize={bodyFont.size}
                      lineHeight={editorSettings.lineHeight}
                      onRetryWithoutTls={() => void send(tab.id, { verifyTls: false })}
                      examples={tab.examples}
                      viewingExample={tab.viewingExample}
                      // A request that is not in a collection has nowhere to
                      // keep an example, so the button is not offered rather
                      // than offered and then refusing.
                      onSaveExample={
                        tab.itemId ? () => void saveExample(tab.id, "") : null
                      }
                      onSaveVariable={setSavingVariable}
                      scripts={tab.scripts}
                    />
                  </Panel>
                </Group>
              </div>
            </>
          )}
        </div>
      </div>

      {/* A piece of a response on its way into an environment.

          Written through `applyScriptChanges`, which is the same path a
          `pm.environment.set()` takes — so a token saved by hand and one saved
          by a script land in the same column, the current value, and neither
          is ever exported or synced. */}
      {savingVariable !== null && (
        <SaveVariableDialog
          value={savingVariable}
          environmentName={
            environments.find((row) => row.id === activeEnvironmentId)?.name ?? null
          }
          // The current value, not the initial one: that is the column this
          // writes to, so it is the one worth showing beside each name.
          existing={{
            environment: (
              environments.find((row) => row.id === activeEnvironmentId)?.variables ?? []
            ).map((row) => ({ name: row.key, value: row.currentValue ?? row.value })),
            globals: (environments.find((row) => row.isGlobal)?.variables ?? []).map(
              (row) => ({ name: row.key, value: row.currentValue ?? row.value })
            ),
          }}
          onSave={(name, target: VariableTarget) => {
            const change = { [name]: savingVariable };
            void applyScriptChanges(
              {
                globals: target === "globals" ? change : {},
                environment: target === "environment" ? change : {},
                collection: {},
              },
              null
            );
          }}
          onClose={() => setSavingVariable(null)}
        />
      )}

      {confirming && (
        <EditorDialog
          title={confirming.title}
          message={confirming.message}
          onCancel={() => setConfirming(null)}
          actions={[
            {
              label: "Delete",
              danger: true,
              primary: true,
              onClick: () => {
                confirming.run();
                setConfirming(null);
              },
            },
            { label: "Cancel", onClick: () => setConfirming(null) },
          ]}
        />
      )}

      {/* The console sits between the work and the status bar: below
          everything it reports on, above the line that says how the window
          itself is doing. */}
      <ConsolePanel
        entries={consoleEntries}
        open={consoleOpen}
        onToggle={() => toggleConsole()}
        onClear={clearConsole}
        onOpenTab={setActiveTab}
      />

      {/* Status bar */}
      <div className="api-statusbar flex items-center justify-between gap-2 px-3 h-6 bg-ft-surface border-t border-ft-border text-[10px] text-ft-text-muted shrink-0">
        {/* To the tab, not the connection panel.

            The panel answers "where is the database"; this light is about
            what syncing is *doing*, and the tab is where that is. The panel
            is one click further on, from inside it. */}
        <button
          className="shrink-0 flex items-center gap-1.5 hover:text-ft-text"
          onClick={openSync}
          title={
            syncStatus?.config.enabled
              ? "Open the sync tab"
              : "Not syncing — open the sync tab to connect a database"
          }
        >
          <span
            className={`api-sync-dot ${
              syncing
                ? "working"
                : syncStatus?.last?.error
                  ? "failed"
                  : syncStatus?.config.enabled
                    ? "on"
                    : ""
            }`}
          />
          {syncing
            ? "Syncing…"
            : syncStatus?.config.enabled
              ? (syncStatus.pending > 0 ? `${syncStatus.pending} to send` : "Synced")
              : "Not syncing"}
          {(syncStatus?.conflicts ?? 0) > 0 && (
            <span className="text-ft-warning">{syncStatus!.conflicts} conflicted</span>
          )}
        </button>

        <span className="flex-1 truncate">
          {sending
            ? tab && tab.received > 0
              ? `Sending · ${formatBytes(tab.received)} received`
              : "Sending…"
            : tab && !tab.verifyTls
              ? "Certificate verification is off for this request"
              : // A folder, collection or environment tab already has a row —
                // "Not in a collection" is about a request and nothing else,
                // and saying it here sent people looking for a Save As.
                tab && tab.kind !== "request"
                ? dirty
                  ? "Unsaved changes · ⌘S to save"
                  : "Saved"
                : tab?.itemId
                  ? dirty
                    ? "Unsaved changes · ⌘S to save"
                    : "Saved"
                  : "Not in a collection · ⌘S to save"}
        </span>
        <div
          className="cursor-se-resize p-1 shrink-0"
          onPointerDown={(e) => onResizeStart(e, "se")}
          title="Resize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-ft-text-muted">
            <path
              d="M9 1L1 9M9 5L5 9"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );

  if (pipMode) return <OverlayPortal>{modal}</OverlayPortal>;

  return (
    <OverlayPortal>
      <div
        className="fixed inset-0 z-[250] flex items-start justify-center pt-[6vh]"
        style={{ zIndex: frontZ ?? undefined }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        {modal}
      </div>
    </OverlayPortal>
  );
}
